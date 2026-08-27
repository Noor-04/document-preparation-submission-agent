/**
 * Multi-step dummy vendor-registration wizard for browser-agent testing.
 *
 * The flow is intentionally self-contained under /dummy and stores draft state
 * in a temporary directory so automation can fill ten stable pages, upload any
 * subset of the supported company documents, and finish on an explicit
 * acknowledgement page.
 */
import { Router, type Request, type Response, urlencoded } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

export const MAX_SELECTED_DOCUMENTS = 16;
export const ALLOWED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'docx'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVERY_COUNTRY = 'Every country';

interface DocTypeDef {
  key: string;
  name: string;
  expected_filename?: string;
  country: string;
  lead_days: number;
  grace_days: number;
  upload_only?: boolean;
}

const DOC_TYPES: DocTypeDef[] = [
  { key: 'sedar_cr', name: 'Commercial Registration Certificate', expected_filename: 'Sedar-BI-Group-CR.pdf', country: 'SA', lead_days: 30, grace_days: 0, upload_only: true },
  { key: 'sedar_vat', name: 'VAT Registration Certificate', expected_filename: 'Sedar-BI-Group-VAT-Certificate.pdf', country: 'SA', lead_days: 30, grace_days: 0, upload_only: true },
  { key: 'sedar_bank_iban', name: 'Official Bank Details / IBAN Certificate', expected_filename: 'Sedar-BI-Group-Bank-IBAN.pdf', country: 'SA', lead_days: 30, grace_days: 0, upload_only: true },
  { key: 'sedar_national_address', name: 'Saudi National Address Certificate', country: 'SA', lead_days: 30, grace_days: 0, upload_only: true },
  { key: 'commercial_registration', name: 'Commercial Registration', country: 'SA', lead_days: 30, grace_days: 0 },
  { key: 'company_profile', name: 'Company Profile', country: EVERY_COUNTRY, lead_days: 0, grace_days: 0, upload_only: true },
  { key: 'company_registration_certificate', name: 'Company Registration Certificate', country: 'SA', lead_days: 30, grace_days: 30 },
  { key: 'demo_expired_licence', name: 'Demo Expired Licence', country: 'AE', lead_days: 10, grace_days: 0 },
  { key: 'demo_near_expiry_licence', name: 'Demo Near-Expiry Licence', country: 'AE', lead_days: 10, grace_days: 0 },
  { key: 'gosi', name: 'GOSI', country: 'SA', lead_days: 30, grace_days: 30 },
  { key: 'iban', name: 'IBAN', country: EVERY_COUNTRY, lead_days: 30, grace_days: 30, upload_only: true },
  { key: 'iso_9001', name: 'ISO 9001', country: EVERY_COUNTRY, lead_days: 60, grace_days: 30, upload_only: true },
  { key: 'membership_certificate_riyadh_chamber', name: 'Membership Certificate Riyadh Chamber', country: 'SA', lead_days: 30, grace_days: 30 },
  { key: 'saudization_certificate_nitaqat', name: 'Saudization Certificate (Nitaqat Certificate)', country: 'SA', lead_days: 30, grace_days: 30 },
  { key: 'saudization_certificate_qiwa_nitaqat', name: 'Saudization Certificate (Qiwa / Nitaqat Certificate)', country: 'SA', lead_days: 30, grace_days: 30 },
  { key: 'trade_license', name: 'Trade License', country: 'AE', lead_days: 30, grace_days: 0 },
  { key: 'vat', name: 'VAT', country: EVERY_COUNTRY, lead_days: 30, grace_days: 30, upload_only: true },
  { key: 'vat_certificate', name: 'VAT Certificate', country: 'AE', lead_days: 30, grace_days: 0, upload_only: true },
  { key: 'zakat', name: 'ZAKAT', country: 'SA', lead_days: 30, grace_days: 30, upload_only: true },
  { key: 'legal_company_document', name: 'Legal company document', country: EVERY_COUNTRY, lead_days: 30, grace_days: 0, upload_only: true },
];

interface CompanyTemplate {
  key: string;
  portal_style: 'supplier' | 'compliance' | 'procurement' | 'onboarding';
  label: string;
  country_hint: string;
  entity_hint: string;
  city_hint: string;
  description: string;
}

const COMPANY_TEMPLATES: CompanyTemplate[] = [
  {
    key: 'sa_noor_logistics',
    portal_style: 'supplier',
    label: 'Saudi supplier portal',
    country_hint: 'SA',
    entity_hint: 'llc',
    city_hint: 'Riyadh',
    description: 'Blank Saudi supplier registration flow. The agent must enter all company details.',
  },
  {
    key: 'sa_riyadh_industrial',
    portal_style: 'compliance',
    label: 'Saudi compliance portal',
    country_hint: 'SA',
    entity_hint: 'branch',
    city_hint: 'Riyadh',
    description: 'Blank Saudi compliance flow with stricter portal wording.',
  },
  {
    key: 'ae_desert_falcon',
    portal_style: 'procurement',
    label: 'UAE procurement portal',
    country_hint: 'AE',
    entity_hint: 'llc',
    city_hint: 'Dubai',
    description: 'Blank UAE procurement flow for sourcing-oriented agent testing.',
  },
  {
    key: 'ae_marina_blue',
    portal_style: 'onboarding',
    label: 'UAE onboarding portal',
    country_hint: 'AE',
    entity_hint: 'sole_establishment',
    city_hint: 'Abu Dhabi',
    description: 'Blank UAE onboarding flow with upload-heavy document pages.',
  },
];

const DOCS_BY_KEY = new Map(DOC_TYPES.map((doc) => [doc.key, doc]));
const WIZARD_PAGES = [
  'Company details',
  'Registration profile',
  'Registered address',
  'Primary contact',
  'Business profile',
  'Document selection',
  'Documents batch 1',
  'Documents batch 2',
  'Review and declaration',
  'Acknowledgement',
] as const;

/**
 * What ONE REQUEST may weigh — a transport bound, never a document or package
 * limit. A file of any size arrives as a sequence of chunks under it.
 *
 * Pages 7 and 8 used to post a whole BATCH in one multipart body. On a
 * serverless deployment that body is rejected by the platform before the
 * handler runs — no 400, no error list, just an error page under the wizard's
 * own URL. That per-request limit belongs to the host and is immutable;
 * chunking is how a large document crosses it rather than arguing with it.
 *
 * ponytail: one fixed bound below the platform's documented 4.5 MB. Read it
 * from the deployment if that ever becomes queryable.
 *
 * KNOWN CEILING OF THIS DESIGN: the `.part` file is local to whichever
 * serverless instance answered. Chunks of one document must therefore reach
 * the same instance, which a single dev host guarantees and a scaled
 * deployment does not. Reliable large uploads on a real serverless host need
 * durable direct object storage (a signed upload straight to a bucket, with
 * the portal keeping only the ref) — that is the upgrade path, not more
 * chunking.
 */
const MAX_REQUEST_BYTES = 3_500_000;

const COUNTRIES = ['AE', 'SA', 'GB', 'NL', 'DE', 'US'];
const ENTITY_TYPES = ['llc', 'sole_establishment', 'branch', 'partnership'];
const SERVICE_CATEGORIES = ['it_services', 'logistics', 'consulting', 'facilities'];
const REVENUE_BANDS = ['under_1m', '1m_to_5m', '5m_to_25m', '25m_plus'];
const SEDAR_DRAFT_ID = '310d0528-da0e-4bb8-800b-84486e0dc7df';

// Static copy of the UAE / Abu Dhabi Jotform vendor form, served under /dummy
// so its URL matches the other registration flows.
const UAE_FORM_FILE = 'vendor-registration-form.html';
const uaeFormPath = (() => {
  const cwdPublic = join(process.cwd(), 'public', UAE_FORM_FILE);
  return existsSync(cwdPublic)
    ? cwdPublic
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', UAE_FORM_FILE);
})();

export interface StoredFile {
  field: string;
  original_name: string;
  stored_as: string;
  size: number;
  content_type: string;
}

interface DocumentDraft {
  number: string;
  issue_date: string;
  expiry_date: string;
  issuing_authority: string;
  notes: string;
  file?: StoredFile;
}

interface WizardState {
  id: string;
  created_at: string;
  updated_at: string;
  portal_style: 'supplier' | 'compliance' | 'procurement' | 'onboarding';
  company_name: string;
  trading_name: string;
  country: string;
  entity_type: string;
  registration_number: string;
  tax_number: string;
  incorporation_date: string;
  website: string;
  address_line: string;
  city: string;
  region: string;
  postal_code: string;
  contact_name: string;
  contact_title: string;
  contact_email: string;
  contact_phone: string;
  contact_mobile: string;
  employee_count: string;
  annual_revenue_band: string;
  notes: string;
  services: string[];
  selected_documents: string[];
  documents: Record<string, DocumentDraft>;
  declaration_name: string;
  declaration_role: string;
  declaration_confirmed: boolean;
  submitted_at?: string;
}

export interface Receipt {
  ok: true;
  id: string;
  acknowledgement_no: string;
  received_at: string;
  fields: Record<string, string | string[]>;
  selected_documents: string[];
  document_details: Record<string, DocumentDraft>;
  files: StoredFile[];
  file_count: number;
  stored_in: string;
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Strip every path component and unsafe character: the result can only land inside the target dir. */
export function safeFilename(raw: string): string {
  const cleaned = basename(raw.replace(/\\/g, '/'))
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned || 'file';
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

const CSS = `
  :root {
    --bg:#f3efe8; --panel:#fffdf9; --panel-strong:#fff; --ink:#1f2430; --muted:#6a6f7d;
    --line:#d9d4cb; --accent:#0f5f52; --accent-2:#b6862c; --ok:#0b7d4a; --bad:#b3261e;
    --shadow:0 22px 60px rgba(18, 25, 38, .08);
  }
  * { box-sizing:border-box; }
  body {
    margin:0;
    color:var(--ink);
    background:
      radial-gradient(circle at top right, rgba(182, 134, 44, .16), transparent 30%),
      linear-gradient(180deg, #f7f2eb 0%, #efe8dc 100%);
    font:15px/1.55 "Aptos", "Segoe UI", "Helvetica Neue", sans-serif;
  }
  header {
    padding:1.2rem 1.4rem 1rem;
    background:rgba(255,253,249,.86);
    border-bottom:1px solid rgba(15,95,82,.12);
    backdrop-filter:blur(12px);
    position:sticky;
    top:0;
    z-index:5;
  }
  header h1 {
    margin:0 0 .25rem;
    font:700 1.45rem/1.1 Georgia, "Times New Roman", serif;
    letter-spacing:.02em;
  }
  header p { margin:0; color:var(--muted); font-size:.95rem; }
  main { max-width:1120px; margin:0 auto; padding:1.4rem; }
  .shell { display:grid; grid-template-columns:290px minmax(0, 1fr); gap:1.2rem; align-items:start; }
  @media (max-width: 920px) { .shell { grid-template-columns:1fr; } }
  .card, .aside {
    background:rgba(255,253,249,.92);
    border:1px solid rgba(15,95,82,.12);
    border-radius:24px;
    box-shadow:var(--shadow);
  }
  .aside { padding:1rem; position:sticky; top:6.2rem; }
  .card { padding:1.2rem; }
  .eyebrow { color:var(--accent); font-size:.78rem; letter-spacing:.12em; text-transform:uppercase; font-weight:700; }
  .hero { display:flex; justify-content:space-between; gap:1rem; align-items:start; margin-bottom:1rem; }
  .hero h2 { margin:.2rem 0; font:700 1.25rem/1.2 Georgia, "Times New Roman", serif; }
  .hero p { margin:0; color:var(--muted); max-width:52ch; }
  .status {
    min-width:170px; padding:.85rem 1rem; border-radius:18px;
    background:linear-gradient(135deg, rgba(15,95,82,.1), rgba(182,134,44,.09));
    border:1px solid rgba(15,95,82,.16);
  }
  .status strong { display:block; font-size:1.15rem; }
  .progress { list-style:none; margin:0; padding:0; display:grid; gap:.55rem; }
  .progress li {
    display:grid; grid-template-columns:34px 1fr; gap:.7rem; align-items:center;
    padding:.62rem .72rem; border-radius:16px; border:1px solid transparent;
    background:rgba(15,95,82,.03);
  }
  .progress li.active { background:#fff; border-color:rgba(15,95,82,.18); }
  .progress li.done { background:rgba(11,125,74,.08); }
  .step-badge {
    width:34px; height:34px; border-radius:50%; display:grid; place-items:center;
    font-weight:700; color:#fff; background:var(--accent);
  }
  .progress li.done .step-badge { background:var(--ok); }
  .progress span small { display:block; color:var(--muted); }
  .banner {
    margin-bottom:1rem; padding:.9rem 1rem; border-radius:18px;
    background:rgba(182,134,44,.12); border:1px solid rgba(182,134,44,.24); color:#6d4f10;
  }
  .errors {
    margin-bottom:1rem; padding:1rem 1.1rem; border-radius:18px;
    border:1px solid rgba(179,38,30,.3); background:rgba(179,38,30,.08); color:var(--bad);
  }
  .grid { display:grid; gap:1rem; }
  .grid.two { grid-template-columns:repeat(2, minmax(0, 1fr)); }
  .grid.three { grid-template-columns:repeat(3, minmax(0, 1fr)); }
  @media (max-width: 820px) {
    .grid.two, .grid.three { grid-template-columns:1fr; }
  }
  .field { display:grid; gap:.35rem; }
  .field label { color:var(--muted); font-size:.86rem; font-weight:600; }
  input, select, textarea, button {
    width:100%; font:inherit; border-radius:14px; padding:.76rem .86rem;
    border:1px solid var(--line); background:#fff; color:var(--ink);
  }
  input:focus, select:focus, textarea:focus { outline:2px solid rgba(15,95,82,.14); border-color:var(--accent); }
  textarea { min-height:110px; resize:vertical; }
  .checkbox-grid { display:grid; gap:.7rem; grid-template-columns:repeat(2, minmax(0, 1fr)); }
  @media (max-width: 820px) { .checkbox-grid { grid-template-columns:1fr; } }
  .choice, .doc-card {
    display:block; padding:.95rem 1rem; border-radius:18px; background:#fff;
    border:1px solid rgba(15,95,82,.12);
  }
  .choice input, .doc-card input[type=checkbox] { width:auto; margin-right:.55rem; }
  .choice strong, .doc-card strong { display:block; font-size:.98rem; }
  .choice small, .doc-card small, .muted { color:var(--muted); }
  .doc-table { width:100%; border-collapse:collapse; font-size:.94rem; }
  .doc-table th, .doc-table td { text-align:left; padding:.72rem .6rem; border-bottom:1px solid rgba(15,95,82,.1); vertical-align:top; }
  .doc-table th { color:var(--muted); font-size:.76rem; text-transform:uppercase; letter-spacing:.09em; }
  .actions { display:flex; flex-wrap:wrap; gap:.7rem; justify-content:space-between; margin-top:1.2rem; }
  .actions .left, .actions .right { display:flex; gap:.7rem; flex-wrap:wrap; }
  button {
    width:auto; border:0; cursor:pointer; color:#fff;
    background:linear-gradient(135deg, var(--accent), #1e7b68);
    box-shadow:0 12px 24px rgba(15,95,82,.18);
  }
  button.secondary {
    background:#fff; color:var(--accent); border:1px solid rgba(15,95,82,.16); box-shadow:none;
  }
  .pill {
    display:inline-block; padding:.28rem .6rem; border-radius:999px; font-size:.8rem;
    background:rgba(15,95,82,.08); color:var(--accent); margin:.15rem .35rem .15rem 0;
  }
  .summary {
    display:grid; gap:.75rem; grid-template-columns:repeat(2, minmax(0, 1fr));
  }
  @media (max-width: 820px) { .summary { grid-template-columns:1fr; } }
  .summary .box, .file-box {
    border:1px solid rgba(15,95,82,.12); border-radius:18px; padding:.9rem 1rem; background:#fff;
  }
  .summary .box h3, .file-box h3 { margin:0 0 .5rem; font-size:1rem; }
  .file-box p, .summary .box p { margin:.18rem 0; }
  .ack {
    padding:1.2rem; border-radius:22px; background:linear-gradient(135deg, rgba(11,125,74,.1), rgba(15,95,82,.07));
    border:1px solid rgba(11,125,74,.22);
  }
  .ack strong { display:block; font-size:1.45rem; margin:.2rem 0 .45rem; }
  .mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; word-break:break-word; }
`;

const wantsJson = (req: Request): boolean =>
  req.query.format === 'json' || (req.header('accept') ?? '').includes('application/json');

function pageTitle(page: number): string {
  return WIZARD_PAGES[page - 1] ?? WIZARD_PAGES[0];
}

function initialState(id: string): WizardState {
  return {
    id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    portal_style: 'supplier',
    company_name: '',
    trading_name: '',
    country: '',
    entity_type: '',
    registration_number: '',
    tax_number: '',
    incorporation_date: '',
    website: '',
    address_line: '',
    city: '',
    region: '',
    postal_code: '',
    contact_name: '',
    contact_title: '',
    contact_email: '',
    contact_phone: '',
    contact_mobile: '',
    employee_count: '',
    annual_revenue_band: '',
    notes: '',
    services: [],
    selected_documents: [],
    documents: {},
    declaration_name: '',
    declaration_role: '',
    declaration_confirmed: false,
  };
}

function sedarDraft(): WizardState {
  const state = initialState(SEDAR_DRAFT_ID);
  state.selected_documents = ['sedar_cr', 'sedar_vat', 'sedar_bank_iban', 'sedar_national_address'];
  return state;
}

function applyTemplate(id: string, templateKey: string): WizardState {
  const state = initialState(id);
  const template = COMPANY_TEMPLATES.find((entry) => entry.key === templateKey);
  return template ? { ...state, ...template } : state;
}

function splitDocs(selected: string[]): [string[], string[]] {
  const midpoint = Math.ceil(selected.length / 2);
  return [selected.slice(0, midpoint), selected.slice(midpoint)];
}

function filteredDocsForCountry(country: string): DocTypeDef[] {
  return DOC_TYPES.filter((doc) => doc.country === EVERY_COUNTRY || !country || doc.country === country);
}

function validateFile(field: string, file: File, errors: string[]): boolean {
  if (!ALLOWED_EXTENSIONS.includes(extensionOf(file.name))) {
    errors.push(`${field}: file type "${extensionOf(file.name) || 'unknown'}" is not accepted`);
    return false;
  }
  if (file.size === 0) {
    errors.push(`${field}: file is empty`);
    return false;
  }
  return true;
}

/**
 * A multipart entry that carries a file, without touching the global `File` —
 * which does not exist before Node 20, so `instanceof File` threw
 * `File is not defined` on a runtime this ships to. Same duck test the quick
 * lane already used; it holds on every runtime.
 */
function isUpload(value: FormDataEntryValue | null): value is File {
  return Boolean(value && typeof value === 'object' && 'name' in value && 'arrayBuffer' in value);
}

async function readMultipart(req: Request): Promise<FormData> {
  const contentType = req.header('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new Error('expected a multipart/form-data body');
  }
  return await new Response(Readable.toWeb(req) as ReadableStream, {
    headers: { 'content-type': contentType },
  }).formData();
}

function inputValue(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '').trim();
}

function inputValues(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (Array.isArray(value)) return value.map(String);
  return value ? [String(value)] : [];
}

function fieldsForReceipt(state: WizardState): Record<string, string | string[]> {
  return {
    company_name: state.company_name,
    trading_name: state.trading_name,
    country: state.country,
    entity_type: state.entity_type,
    registration_number: state.registration_number,
    tax_number: state.tax_number,
    incorporation_date: state.incorporation_date,
    website: state.website,
    address_line: state.address_line,
    city: state.city,
    region: state.region,
    postal_code: state.postal_code,
    contact_name: state.contact_name,
    contact_title: state.contact_title,
    contact_email: state.contact_email,
    contact_phone: state.contact_phone,
    contact_mobile: state.contact_mobile,
    employee_count: state.employee_count,
    annual_revenue_band: state.annual_revenue_band,
    services: state.services,
    notes: state.notes,
    declaration_name: state.declaration_name,
    declaration_role: state.declaration_role,
  };
}

function acknowledgementNo(id: string, submittedAt: string): string {
  const stamp = submittedAt.slice(0, 10).replace(/-/g, '');
  return `ACK-${stamp}-${id.slice(0, 8).toUpperCase()}`;
}

function renderLayout(title: string, result: string, aside: string, body: string): string {
  const themeClass = 'theme-default';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body data-result="${esc(result)}" class="${themeClass}">
<header>
  <h1>Supplier Registration Portal</h1>
  <p>Multi-step legal entity onboarding for automation and human review.</p>
  ${result !== 'login' ? '<form method="post" action="/dummy/vendor-registration/logout" style="margin-left:auto"><button type="submit" class="secondary">Logout</button></form>' : ''}
</header>
<main>
  <div class="banner">Dummy portal for browser-agent testing. It behaves like a production form, but data is stored only in a temporary workspace.</div>
  <div class="shell">
    ${aside}
    ${body}
  </div>
</main>
</body></html>`;
}

function portalCopy(style: WizardState['portal_style']): { title: string; subtitle: string; banner: string; pickerLead: string } {
  switch (style) {
    case 'compliance':
      return {
        title: 'Vendor Compliance Gateway',
        subtitle: 'Due-diligence and statutory document intake for approved suppliers.',
        banner: 'Compliance-mode demo portal. Use this flow to test document-heavy onboarding with stricter wording.',
        pickerLead: 'Compliance-heavy Saudi supplier portal',
      };
    case 'procurement':
      return {
        title: 'Procurement Registration Desk',
        subtitle: 'Commercial supplier enrollment for purchasing and sourcing teams.',
        banner: 'Procurement-mode demo portal. Use this flow to test sourcing-oriented registration wording.',
        pickerLead: 'Procurement-oriented UAE trading portal',
      };
    case 'onboarding':
      return {
        title: 'Enterprise Onboarding Workspace',
        subtitle: 'New vendor activation workflow for business services partners.',
        banner: 'Onboarding-mode demo portal. Use this flow to test lighter service-partner registration wording.',
        pickerLead: 'Service-partner UAE onboarding portal',
      };
    default:
      return {
        title: 'Supplier Registration Portal',
        subtitle: 'Multi-step legal entity onboarding for automation and human review.',
        banner: 'Dummy portal for browser-agent testing. It behaves like a production form, but data is stored only in a temporary workspace.',
        pickerLead: 'Saudi and UAE company scenarios for external agent testing.',
      };
  }
}

function renderTemplatePicker(): string {
  const copy = portalCopy('supplier');
  return renderLayout(
    'Choose registration flow',
    'form',
    `<aside class="aside">
      <div class="eyebrow">Start here</div>
      <div class="hero" style="display:block; margin:.45rem 0 1rem;">
        <h2>Company presets</h2>
        <p>${esc(copy.pickerLead)}</p>
      </div>
      <div class="status"><small class="muted">Flows available</small><strong>${COMPANY_TEMPLATES.length + 4}</strong><small class="muted">10 pages each</small></div>
    </aside>`,
    `<section class="card">
      <div class="hero">
        <div>
          <div class="eyebrow">Registration templates</div>
          <h2>Pick a company to start</h2>
          <p>Each variant opens the same 10-page wizard with blank fields so the agent must fill the information itself. Some document pages are upload-only PDFs.</p>
        </div>
      </div>
      <div class="checkbox-grid">
        <div class="doc-card" style="border-color:var(--accent)">
          <strong>Quick Vendor Registration Portal</strong>
          <small>One page · reduced fields · shuffled details</small>
          <p class="muted">A shorter vendor form with company details and four required document filenames.</p>
          <a href="/dummy/vendor-registration/quick"><button type="button" style="margin-top:.8rem">Open one-page portal</button></a>
        </div>
        <div class="doc-card" style="border-color:var(--accent)">
          <strong>Sedar BI Group vendor registration</strong>
          <small>Saudi Arabia · LLC · 4 required documents</small>
          <p class="muted">Use this preconfigured form for Sedar BI Group with CR, VAT, IBAN and National Address documents.</p>
          <a href="/dummy/vendor-registration/${SEDAR_DRAFT_ID}/page/1"><button type="button" style="margin-top:.8rem">Open Sedar BI Group form</button></a>
        </div>
        <div class="doc-card" style="border-color:var(--accent)">
          <strong>Sedar Emirates vendor registration</strong>
          <small>UAE · Abu Dhabi · LLC · 5 required documents</small>
          <p class="muted">Single-page UAE form for Sedar Emirates Company LLC with Trade License, VAT, Bank Details, ICV and Supplier Authorisation attachments.</p>
          <a href="/dummy/vendor-registration/uae-abu-dhabi"><button type="button" style="margin-top:.8rem">Open Sedar Emirates form</button></a>
        </div>
        ${COMPANY_TEMPLATES.map((template) => `<form method="post" action="/dummy/vendor-registration/start" class="doc-card">
          <input type="hidden" name="template" value="${esc(template.key)}">
          <strong>${esc(template.label)}</strong>
          <small>${esc(template.country_hint)} · ${esc(template.entity_hint.replace(/_/g, ' '))} · ${esc(template.city_hint)} · ${esc(template.portal_style)}</small>
          <p class="muted">${esc(template.description)}</p>
          <button type="submit" id="start_${esc(template.key)}" style="margin-top:.8rem">Start this flow</button>
        </form>`).join('')}
        <form method="post" action="/dummy/vendor-registration/start" class="doc-card">
          <input type="hidden" name="template" value="">
          <strong>Blank application</strong>
          <small>Start with empty company details</small>
          <p class="muted">Useful when the external agent should fill everything from scratch.</p>
          <button type="submit" id="start_blank" style="margin-top:.8rem">Start blank flow</button>
        </form>
      </div>
    </section>`,
  );
}

function renderQuickVendor(errors: string[] = [], values: Record<string, string> = {}): string {
  const value = (key: string): string => esc(values[key] ?? '');
  const errorBlock = errors.length
    ? `<div class="errors"><strong>Please complete all required fields</strong><ul>${errors.map((error) => `<li>${esc(error)}</li>`).join('')}</ul></div>`
    : '';
  return renderLayout(
    'Quick Vendor Registration',
    'form',
    '<aside class="aside"><div class="eyebrow">One-page portal</div><h2>Vendor intake</h2><p class="muted">Reduced fields for a fast registration submission.</p></aside>',
    `<section class="card"><div class="hero"><div><div class="eyebrow">Vendor registration</div><h2>Register your company</h2><p>All fields below are required.</p></div></div>
      ${errorBlock}
      <form method="post" action="/dummy/vendor-registration/quick" enctype="multipart/form-data">
        <div class="grid two">
          <div class="field"><label for="contact_email">Contact email *</label><input id="contact_email" name="contact_email" type="email" value="${value('contact_email')}" required></div>
          <div class="field"><label for="entity_type">Entity type *</label><select id="entity_type" name="entity_type" required><option value="">Select entity type</option>${ENTITY_TYPES.map((type) => `<option value="${type}"${values.entity_type === type ? ' selected' : ''}>${esc(type.replace(/_/g, ' '))}</option>`).join('')}</select></div>
          <div class="field"><label for="company_name">Company legal name *</label><input id="company_name" name="company_name" value="${value('company_name')}" required></div>
          <div class="field"><label for="country">Country *</label><select id="country" name="country" required><option value="">Select country</option>${COUNTRIES.map((country) => `<option value="${country}"${values.country === country ? ' selected' : ''}>${country}</option>`).join('')}</select></div>
        </div>
        <h3 style="margin-top:1.2rem">Required documents</h3>
        <div class="grid two">
          <div class="field"><label for="cr_copy">CR copy PDF *</label><input id="cr_copy" name="cr_copy" type="file" accept=".pdf" required></div>
          <div class="field"><label for="vat_certificate">VAT certificate PDF *</label><input id="vat_certificate" name="vat_certificate" type="file" accept=".pdf" required></div>
          <div class="field"><label for="bank_iban">Bank / IBAN PDF *</label><input id="bank_iban" name="bank_iban" type="file" accept=".pdf" required></div>
          <div class="field"><label for="national_address">National Address PDF *</label><input id="national_address" name="national_address" type="file" accept=".pdf" required></div>
        </div>
        <button type="submit" style="margin-top:1rem">Submit registration</button>
      </form>
    </section>`,
  );
}
function renderLogin(error = '', returnTo = '/dummy/vendor-registration'): string {
  return renderLayout(
    'Sign in',
    'login',
    '<aside class="aside"><div class="eyebrow">Protected portal</div><h2>Vendor registration</h2><p class="muted">Sign in to begin the registration flow.</p></aside>',
    `<section class="card" style="max-width:420px"><div class="eyebrow">Authentication</div><h2>Sign in</h2>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <form method="post" action="/dummy/vendor-registration/login">
        <input type="hidden" name="return_to" value="${esc(returnTo)}">
        <label>Username<input name="username" autocomplete="username" value="admin" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit" style="margin-top:1rem">Login</button>
      </form>
    </section>`,
  );
}

function renderAside(state: WizardState, page: number): string {
  const selectedCount = state.selected_documents.length;
  const uploadedCount = state.selected_documents.filter((key) => state.documents[key]?.file).length;
  return `<aside class="aside">
    <div class="eyebrow">Registration draft</div>
    <div class="hero" style="display:block; margin:.45rem 0 1rem;">
      <h2>${esc(state.company_name || 'Untitled application')}</h2>
      <p class="mono">${esc(state.id)}</p>
    </div>
    <ul class="progress">
      ${WIZARD_PAGES.map(
        (label, index) => `<li class="${index + 1 === page ? 'active' : index + 1 < page ? 'done' : ''}">
          <div class="step-badge">${index + 1}</div>
          <span><strong>${esc(label)}</strong><small>${index + 1 === 10 ? 'Completion' : 'Page ' + (index + 1)}</small></span>
        </li>`,
      ).join('')}
    </ul>
    <div class="status" style="margin-top:1rem">
      <small class="muted">Selected documents</small>
      <strong>${selectedCount}</strong>
      <small class="muted">Uploaded files: ${uploadedCount}/${selectedCount}</small>
    </div>
  </aside>`;
}

function pageActions(state: WizardState, page: number, opts: { multipart?: boolean; submitLabel?: string; extraLeft?: string }): string {
  if (page === 10) {
    return `<div class="actions"><div class="left"><a href="/dummy/vendor-registration"><button type="button">Start another application</button></a></div></div>`;
  }
  const action = `/dummy/vendor-registration/${state.id}/page/${page}`;
  const enctype = opts.multipart ? ' enctype="multipart/form-data"' : '';
  return `${opts.extraLeft ?? ''}<div class="actions">
    <div class="left">
      ${page > 1 ? `<button class="secondary" type="submit" name="nav" value="back">Back</button>` : ''}
      <button class="secondary" type="submit" formnovalidate formmethod="post" formaction="/dummy/vendor-registration/${esc(state.id)}/clear" onclick="return window.confirm('Clear all information entered in this draft? Uploaded files will be detached from the form.')">Clear all information</button>
    </div>
    <div class="right">
      <button type="submit"${page === 9 ? ' id="submit-final"' : ' id="next-page"'}>${esc(opts.submitLabel ?? (page === 9 ? 'Submit registration' : 'Save and continue'))}</button>
    </div>
  </div>`;
}

/**
 * Each file uploads on its own the moment it is chosen, and the input's `name`
 * is dropped once it lands, so the page POST carries metadata only.
 *
 * The submit is HELD until every started upload has resolved: the extension
 * dispatches `change` and can click Save in the same tick, and without the
 * hold that Save posts the old oversized batch or navigates mid-save. A failed
 * upload marks the page blocked and lets no submit through at all.
 *
 * No bytes are altered, and with JavaScript off the inputs keep their names so
 * the original batch POST still works.
 */
function perFileUploadScript(draftId: string, page: number): string {
  const base = `/dummy/vendor-registration/${esc(draftId)}/page/${page}/upload/`;
  return `<script>
(function () {
  var base = ${JSON.stringify(base)};
  // Well under the platform's request-body limit, so a document of ANY size
  // and a package of ANY size cross it as a sequence of small requests.
  var CHUNK_BYTES = ${MAX_REQUEST_BYTES / 2};
  var form = document.querySelector('form[action$="/page/${page}"]');
  if (!form) return;
  // ONE REQUEST AT A TIME, in selection order. Every request reads and rewrites
  // the same draft JSON, so two in flight can each save one document and the
  // later write silently drops the earlier one.
  var queue = Promise.resolve();
  var inFlight = 0;
  // Per KEY, so a retry replaces its own failure instead of a counter nobody
  // can clear.
  var failures = {};
  var submitting = false;
  var status = document.createElement('p');
  status.id = 'd14-upload-status';
  status.className = 'muted';
  status.setAttribute('data-d14-upload-state', 'idle');
  form.appendChild(status);

  function state(next, text) {
    status.setAttribute('data-d14-upload-state', next);
    status.textContent = text;
  }

  function stillFailing() {
    for (var key in failures) {
      if (failures[key]) return true;
    }
    return false;
  }

  document.querySelectorAll('input[type="file"][name^="doc_file_"]').forEach(function (input) {
    var key = input.name.slice('doc_file_'.length);
    var note = document.createElement('p');
    note.className = 'muted';
    input.parentNode.appendChild(note);
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      note.textContent = 'Queued ' + file.name + '...';
      state('uploading', 'Uploading documents...');
      inFlight += 1;
      queue = queue.then(function () {
        note.textContent = 'Uploading ' + file.name + '...';
        // One bounded chunk per request, in order: a document of any size
        // crosses a platform request limit this way, and slice copies the
        // file's own bytes rather than transforming them.
        function sendFrom(at) {
          var end = Math.min(at + CHUNK_BYTES, file.size);
          var body = new FormData();
          body.append('offset', String(at));
          body.append('total', String(file.size));
          body.append('doc_file_' + key, file.slice(at, end), file.name);
          return fetch(base + encodeURIComponent(key), { method: 'POST', body: body, credentials: 'same-origin' })
            .then(function (response) { return response.json().then(function (json) { return json; }); })
            .then(function (json) {
              if (!json || !json.ok) {
                failures[key] = true;
                note.textContent = ((json && json.errors) || ['upload failed']).join(' ');
                return;
              }
              if (json.stored_as) {
                // The last chunk landed and the document is recorded.
                failures[key] = false;
                input.setAttribute('data-d14-uploaded', 'true');
                input.removeAttribute('name');
                note.textContent = 'Uploaded ' + json.original_name + ' (' + json.size + ' bytes).';
                return;
              }
              note.textContent = 'Uploading ' + file.name + ' (' + json.received + ' of ' + json.total + ')...';
              return sendFrom(json.received);
            });
        }
        return sendFrom(0)
          .catch(function () {
            failures[key] = true;
            note.textContent = 'Upload failed: the portal did not answer.';
          })
          .then(function () { inFlight -= 1; });
      });
    });
  });

  form.addEventListener('submit', function (event) {
    // Already waited and cleared: let this one through rather than recursing.
    if (submitting) return;
    if (inFlight === 0 && !stillFailing()) return;
    event.preventDefault();
    queue.then(function () {
      if (inFlight > 0) return;
      if (stillFailing()) {
        // Blocked, and visibly so: nothing is posted and nothing navigates.
        state('failed', 'An upload failed. Nothing was submitted - retry that document.');
        return;
      }
      state('ready', 'All documents uploaded.');
      submitting = true;
      form.submit();
    });
  });
})();
</script>`;
}

function docFields(state: WizardState, keys: string[], page: number): string {
  if (keys.length === 0) {
    return `<div class="file-box"><h3>No documents in this batch</h3><p class="muted">Nothing selected for page ${page}. Continue to the next page.</p></div>`;
  }
  return keys
    .map((key) => {
      const doc = DOCS_BY_KEY.get(key)!;
      const current = state.documents[key] ?? { number: '', issue_date: '', expiry_date: '', issuing_authority: '', notes: '' };
      const accept = doc.upload_only ? '.pdf' : ALLOWED_EXTENSIONS.map((ext) => `.${ext}`).join(',');
      const details = doc.upload_only
        ? `<div class="file-box" style="margin-bottom:.8rem"><strong>Upload-only document</strong><p class="muted">For ${esc(doc.name)}, the agent only needs to upload a PDF. No manual metadata is required on this form.</p></div>`
        : `<div class="grid two">
          <div class="field"><label for="doc_number_${key}">Document number / reference</label><input id="doc_number_${key}" name="doc_number_${key}" value="${esc(current.number)}"></div>
          <div class="field"><label for="issuing_authority_${key}">Issuing authority</label><input id="issuing_authority_${key}" name="issuing_authority_${key}" value="${esc(current.issuing_authority)}"></div>
          <div class="field"><label for="issue_date_${key}">Issue date</label><input id="issue_date_${key}" name="issue_date_${key}" type="date" value="${esc(current.issue_date)}"></div>
          <div class="field"><label for="expiry_date_${key}">Expiry date</label><input id="expiry_date_${key}" name="expiry_date_${key}" type="date" value="${esc(current.expiry_date)}"></div>
        </div>
        <div class="field" style="margin-top:.8rem"><label for="doc_notes_${key}">Notes</label><textarea id="doc_notes_${key}" name="doc_notes_${key}">${esc(current.notes)}</textarea></div>`;
      return `<section class="file-box">
        <h3>${esc(doc.name)}</h3>
        <p><span class="pill">${esc(doc.country)}</span><span class="pill">Lead ${doc.lead_days} days</span><span class="pill">Grace ${doc.grace_days} days</span></p>
        ${current.file ? `<p class="muted">Current file: <span class="mono">${esc(current.file.original_name)}</span></p>` : '<p class="muted">No file uploaded yet.</p>'}
        ${details}
        <div class="field" style="margin-top:.8rem"><label for="doc_file_${key}">Upload ${esc(doc.name)} file${current.file ? ' (leave blank to keep current file)' : ''}</label>${doc.expected_filename ? `<p class="muted">Required filename: <span class="mono">${esc(doc.expected_filename)}</span></p>` : ''}<input id="doc_file_${key}" name="doc_file_${key}" type="file" accept="${accept}"></div>
      </section>`;
    })
    .join('');
}

function reviewBlock(state: WizardState): string {
  const files = state.selected_documents
    .map((key) => ({ key, doc: DOCS_BY_KEY.get(key), current: state.documents[key] }))
    .filter((row): row is { key: string; doc: DocTypeDef; current: DocumentDraft } => Boolean(row.doc && row.current));
  return `<div class="summary">
    <section class="box">
      <h3>Company</h3>
      <p><strong>${esc(state.company_name)}</strong></p>
      <p>${esc(state.trading_name || 'No trading name supplied')}</p>
      <p>${esc(state.country)} · ${esc(state.entity_type.replace(/_/g, ' '))}</p>
      <p class="mono">${esc(state.registration_number)}</p>
    </section>
    <section class="box">
      <h3>Primary contact</h3>
      <p><strong>${esc(state.contact_name)}</strong></p>
      <p>${esc(state.contact_title || 'Contact')}</p>
      <p>${esc(state.contact_email)}</p>
      <p>${esc(state.contact_phone)}</p>
    </section>
    <section class="box">
      <h3>Selected documents</h3>
      ${state.selected_documents.length
        ? state.selected_documents.map((key) => `<span class="pill">${esc(DOCS_BY_KEY.get(key)?.name ?? key)}</span>`).join('')
        : '<p class="muted">No documents selected.</p>'}
    </section>
    <section class="box">
      <h3>Uploads ready</h3>
      <p>${files.length} of ${state.selected_documents.length} selected document(s) uploaded</p>
      ${files.map((row) => `<p class="mono">${esc(row.doc.name)} · ${esc(row.current.file?.original_name ?? 'missing')}</p>`).join('')}
    </section>
  </div>`;
}

function renderPage(state: WizardState, page: number, errors: string[]): string {
  const copy = portalCopy(state.portal_style);
  const aside = renderAside(state, page);
  const errorBlock = errors.length
    ? `<div class="errors" id="errors"><strong>${errors.length} problem(s)</strong><ul>${errors.map((error) => `<li>${esc(error)}</li>`).join('')}</ul></div>`
    : '';
  const hero = `<section class="card">
    <div class="hero">
      <div>
        <div class="eyebrow">Page ${page} of 10</div>
        <h2>${esc(pageTitle(page))}</h2>
        <p>${page === 10 ? 'Registration submitted. Save the acknowledgement number below.' : 'Complete each section and use the stable next/back actions to drive the wizard.'}</p>
      </div>
      <div class="status"><small class="muted">Draft ID</small><strong class="mono">${esc(state.id.slice(0, 8).toUpperCase())}</strong><small class="muted">${esc(state.country || 'Country pending')}</small></div>
    </div>
    ${errorBlock}`;
  const wrapper = (content: string): string => renderLayout(pageTitle(page), errors.length ? 'error' : page === 10 ? 'success' : 'form', aside, content)
    .replace('<h1>Supplier Registration Portal</h1>', `<h1>${esc(copy.title)}</h1>`)
    .replace('<p>Multi-step legal entity onboarding for automation and human review.</p>', `<p>${esc(copy.subtitle)}</p>`)
    .replace('Dummy portal for browser-agent testing. It behaves like a production form, but data is stored only in a temporary workspace.', esc(copy.banner));

  if (page === 1) {
    return wrapper(`${hero}
        <form method="post" action="/dummy/vendor-registration/${esc(state.id)}/page/1">
          <p class="muted">This portal variant starts blank. The agent must fill company details instead of relying on prefilled values.</p>
          <div class="grid two">
            <div class="field"><label for="company_name">Registered company name *</label><input id="company_name" name="company_name" value="${esc(state.company_name)}"></div>
            <div class="field"><label for="trading_name">Trading name</label><input id="trading_name" name="trading_name" value="${esc(state.trading_name)}"></div>
            <div class="field"><label for="country">Country *</label><select id="country" name="country"><option value="">Select country</option>${COUNTRIES.map((country) => `<option value="${country}"${state.country === country ? ' selected' : ''}>${country}</option>`).join('')}</select></div>
            <div class="field"><label for="entity_type">Entity type *</label><select id="entity_type" name="entity_type"><option value="">Select entity type</option>${ENTITY_TYPES.map((type) => `<option value="${type}"${state.entity_type === type ? ' selected' : ''}>${esc(type.replace(/_/g, ' '))}</option>`).join('')}</select></div>
          </div>
          ${pageActions(state, page, {})}
        </form>
      </section>`);
  }

  if (page === 2) {
    return wrapper(`${hero}
        <form method="post" action="/dummy/vendor-registration/${esc(state.id)}/page/2">
          <div class="grid two">
            <div class="field"><label for="registration_number">Commercial registration number *</label><input id="registration_number" name="registration_number" value="${esc(state.registration_number)}"></div>
            <div class="field"><label for="tax_number">Tax / VAT number</label><input id="tax_number" name="tax_number" value="${esc(state.tax_number)}"></div>
            <div class="field"><label for="incorporation_date">Incorporation date *</label><input id="incorporation_date" name="incorporation_date" type="date" value="${esc(state.incorporation_date)}"></div>
            <div class="field"><label for="website">Website</label><input id="website" name="website" type="url" value="${esc(state.website)}"></div>
          </div>
          ${pageActions(state, page, {})}
        </form>
      </section>`);
  }

  if (page === 3) {
    return wrapper(`${hero}
        <form method="post" action="/dummy/vendor-registration/${esc(state.id)}/page/3">
          <div class="grid two">
            <div class="field"><label for="address_line">Registered address *</label><input id="address_line" name="address_line" value="${esc(state.address_line)}"></div>
            <div class="field"><label for="city">City *</label><input id="city" name="city" value="${esc(state.city)}"></div>
            <div class="field"><label for="region">Region / state</label><input id="region" name="region" value="${esc(state.region)}"></div>
            <div class="field"><label for="postal_code">Postal code</label><input id="postal_code" name="postal_code" value="${esc(state.postal_code)}"></div>
          </div>
          ${pageActions(state, page, {})}
        </form>
      </section>`);
  }

  if (page === 4) {
    return wrapper(`${hero}
        <form method="post" action="/dummy/vendor-registration/${esc(state.id)}/page/4">
          <div class="grid two">
            <div class="field"><label for="contact_name">Primary contact name *</label><input id="contact_name" name="contact_name" value="${esc(state.contact_name)}"></div>
            <div class="field"><label for="contact_title">Primary contact title</label><input id="contact_title" name="contact_title" value="${esc(state.contact_title)}"></div>
            <div class="field"><label for="contact_email">Contact email *</label><input id="contact_email" name="contact_email" type="email" value="${esc(state.contact_email)}"></div>
            <div class="field"><label for="contact_phone">Contact phone *</label><input id="contact_phone" name="contact_phone" value="${esc(state.contact_phone)}"></div>
            <div class="field"><label for="contact_mobile">Mobile / WhatsApp</label><input id="contact_mobile" name="contact_mobile" value="${esc(state.contact_mobile)}"></div>
          </div>
          ${pageActions(state, page, {})}
        </form>
      </section>`);
  }

  if (page === 5) {
    return wrapper(`${hero}
        <form method="post" action="/dummy/vendor-registration/${esc(state.id)}/page/5">
          <div class="grid two">
            <div class="field"><label for="employee_count">Employee count</label><input id="employee_count" name="employee_count" value="${esc(state.employee_count)}"></div>
            <div class="field"><label for="annual_revenue_band">Annual revenue band</label><select id="annual_revenue_band" name="annual_revenue_band"><option value="">Select band</option>${REVENUE_BANDS.map((band) => `<option value="${band}"${state.annual_revenue_band === band ? ' selected' : ''}>${esc(band.replace(/_/g, ' '))}</option>`).join('')}</select></div>
          </div>
          <div class="field" style="margin-top:.8rem"><label>Service categories</label>
            <div class="checkbox-grid">${SERVICE_CATEGORIES.map((service) => `<label class="choice"><input type="checkbox" name="services" value="${service}"${state.services.includes(service) ? ' checked' : ''}><strong>${esc(service.replace(/_/g, ' '))}</strong><small>Select every service your company will provide.</small></label>`).join('')}</div>
          </div>
          <div class="field" style="margin-top:.8rem"><label for="notes">Profile notes</label><textarea id="notes" name="notes">${esc(state.notes)}</textarea></div>
          ${pageActions(state, page, {})}
        </form>
      </section>`);
  }

  if (page === 6) {
    return wrapper(`${hero}
        <form method="post" action="/dummy/vendor-registration/${esc(state.id)}/page/6">
          <p class="muted">Select every document the external agent should complete. You can submit all 16 or any subset such as 3, 4 or 5.</p>
          <table class="doc-table" id="document-catalog">
            <thead><tr><th>Select</th><th>Name</th><th>Country</th><th>Lead days</th><th>Grace days</th></tr></thead>
            <tbody>${DOC_TYPES.map((doc) => `<tr>
              <td><input type="checkbox" id="select_${doc.key}" name="selected_documents" value="${doc.key}"${state.selected_documents.includes(doc.key) ? ' checked' : ''}></td>
              <td><label for="select_${doc.key}"><strong>${esc(doc.name)}</strong></label></td>
              <td>${esc(doc.country)}</td>
              <td>${doc.lead_days}</td>
              <td>${doc.grace_days}</td>
            </tr>`).join('')}</tbody>
          </table>
          ${pageActions(state, page, {
            extraLeft: `<div class="actions"><div class="left"><button class="secondary" type="submit" name="bulk" value="all" id="select-all-documents">Select all documents</button><button class="secondary" type="submit" name="bulk" value="clear" id="clear-all-documents">Clear selection</button></div></div>`,
          })}
        </form>
      </section>`);
  }

  if (page === 7 || page === 8) {
    const [batch1, batch2] = splitDocs(state.selected_documents);
    const batch = page === 7 ? batch1 : batch2;
    return wrapper(`${hero}
        <form method="post" action="/dummy/vendor-registration/${esc(state.id)}/page/${page}" enctype="multipart/form-data">
          ${docFields(state, batch, page)}
          ${pageActions(state, page, { multipart: true })}
        </form>
        ${perFileUploadScript(state.id, page)}
      </section>`);
  }

  if (page === 9) {
    return wrapper(`${hero}
        ${reviewBlock(state)}
        <form method="post" action="/dummy/vendor-registration/${esc(state.id)}/page/9" style="margin-top:1rem">
          <div class="grid two">
            <div class="field"><label for="declaration_name">Authorised signatory name *</label><input id="declaration_name" name="declaration_name" value="${esc(state.declaration_name)}"></div>
            <div class="field"><label for="declaration_role">Authorised signatory role *</label><input id="declaration_role" name="declaration_role" value="${esc(state.declaration_role)}"></div>
          </div>
          <label class="choice" style="margin-top:1rem"><input type="checkbox" id="declaration_confirmed" name="declaration_confirmed" value="yes"${state.declaration_confirmed ? ' checked' : ''}><strong>I confirm the information and uploaded legal company documents are correct and ready for submission.</strong><small>This keeps the final state explicit for automation and human review.</small></label>
          ${pageActions(state, page, { submitLabel: 'Submit and generate acknowledgement' })}
        </form>
      </section>`);
  }

  const files = Object.entries(state.documents)
    .filter(([, doc]) => doc.file)
    .map(([key, doc]) => ({ key, doc }));
  const ackNo = acknowledgementNo(state.id, state.submitted_at ?? new Date().toISOString());
  return wrapper(`${hero}
      <section class="card ack" id="acknowledgement">
        <div class="eyebrow">Submission complete</div>
        <strong id="acknowledgement-number">${esc(ackNo)}</strong>
        <p>Your registration has been filled and submitted. Keep this acknowledgement number for follow-up.</p>
        <p class="muted">Submitted at ${esc(state.submitted_at ?? '')}</p>
      </section>
      <section class="card" style="margin-top:1rem">
        ${reviewBlock(state)}
        <div class="file-box" style="margin-top:1rem">
          <h3>Submitted documents</h3>
          ${files.map(({ key, doc }) => `<p class="mono">${esc(DOCS_BY_KEY.get(key)?.name ?? key)} · ${esc(doc.file?.original_name ?? '')}</p>`).join('')}
        </div>
        <div class="actions"><div class="left"><a href="/dummy/receipt/${esc(state.id)}?format=json"><button type="button" class="secondary">View JSON receipt</button></a></div><div class="right"><a href="/dummy/vendor-registration"><button type="button">Start another application</button></a></div></div>
      </section>`,
  );
}

/**
 * The partial upload on disk. `.part` lives beside the finished files and is
 * removed the moment the document is stored or refused, so a interrupted
 * upload leaves no half-file anyone could mistake for a document.
 */
async function partSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function appendChunk(path: string, bytes: Buffer, first: boolean): Promise<void> {
  if (first) await writeFile(path, bytes);
  else await appendFile(path, bytes);
}

async function readPart(path: string): Promise<Buffer> {
  return await readFile(path);
}

async function discardPart(path: string): Promise<void> {
  await rm(path, { force: true });
  await rm(`${path}.json`, { force: true });
}

/**
 * THE FIRST CHUNK DECIDES WHAT THIS DOCUMENT IS.
 *
 * Without this the name, media type and declared total came from whichever
 * chunk happened to be in hand, so a later request could rename the file or
 * restate its length — weaker than the one-request contract it replaced. The
 * first chunk's values are written beside the part and every later chunk is
 * compared to them.
 */
type PartMeta = { name: string; type: string; total: number };

async function writePartMeta(path: string, meta: PartMeta): Promise<void> {
  await writeFile(`${path}.json`, JSON.stringify(meta));
}

async function readPartMeta(path: string): Promise<PartMeta | null> {
  try {
    return JSON.parse(await readFile(`${path}.json`, 'utf8')) as PartMeta;
  } catch {
    return null;
  }
}

/**
 * The reassembled document as the rest of this file expects a `File`: same
 * duck test `isUpload` uses, so no global `File` is touched on Node 18. The
 * bytes are the concatenated chunks, unaltered.
 */
function fileLike(name: string, type: string, bytes: Buffer): File {
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
}

async function storeFiles(dir: string, field: string, files: File[], startIndex: number): Promise<StoredFile[]> {
  const stored: StoredFile[] = [];
  for (const [index, file] of files.entries()) {
    const storedAs = `${field}-${startIndex + index}-${safeFilename(file.name)}`;
    await writeFile(join(dir, storedAs), Buffer.from(await file.arrayBuffer()));
    stored.push({
      field,
      original_name: file.name,
      stored_as: storedAs,
      size: file.size,
      content_type: file.type || 'application/octet-stream',
    });
  }
  return stored;
}

export function dummyUploadRouter(env: NodeJS.ProcessEnv = process.env): Router {
  const uploadRoot = env.DUMMY_UPLOAD_DIR ?? join(tmpdir(), 'sbi-noor-dummy-uploads');
  const draftsRoot = join(uploadRoot, 'drafts');
  const submissionsRoot = join(uploadRoot, 'submissions');
  const draftDir = (id: string): string => join(draftsRoot, id);
  const draftPath = (id: string): string => join(draftDir(id), 'draft.json');
  const receiptDir = (id: string): string => join(submissionsRoot, id);
  const receiptPath = (id: string): string => join(receiptDir(id), 'receipt.json');
  const sessions = new Set<string>();
  const isLoggedIn = (req: Request): boolean => {
    const cookie = req.header('cookie') ?? '';
    const session = cookie.match(/(?:^|;\s*)dummy_session=([^;]+)/)?.[1];
    return Boolean(session && sessions.has(session));
  };

  const router = Router();
  router.use(urlencoded({ extended: true }));

  const saveDraft = async (state: WizardState): Promise<void> => {
    state.updated_at = new Date().toISOString();
    await mkdir(draftDir(state.id), { recursive: true });
    await writeFile(draftPath(state.id), JSON.stringify(state, null, 2));
  };

  const readDraft = async (id: string): Promise<WizardState | undefined> => {
    if (!UUID.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(draftPath(id), 'utf8')) as WizardState;
    } catch {
      if (id === SEDAR_DRAFT_ID) {
        const state = sedarDraft();
        await saveDraft(state);
        return state;
      }
      return undefined;
    }
  };

  const readReceipt = async (id: string): Promise<Receipt | undefined> => {
    if (!UUID.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(receiptPath(id), 'utf8')) as Receipt;
    } catch {
      return undefined;
    }
  };

  const fail = (req: Request, res: Response, status: number, errors: string[], state: WizardState, page: number): void => {
    if (wantsJson(req)) {
      res.status(status).json({ ok: false, errors, page });
      return;
    }
    res.status(status).type('html').send(renderPage(state, page, errors));
  };

  const ensureDraft = async (req: Request, res: Response): Promise<WizardState | undefined> => {
    const id = req.params.id as string;
    const state = await readDraft(id);
    if (state) return state;
    res.status(404).type('html').send(renderLayout('Draft not found', 'error', '<aside class="aside"></aside>', '<section class="card"><p>No such draft.</p></section>'));
    return undefined;
  };

  router.get('/vendor-registration', (req, res) => {
    res.type('html').send(isLoggedIn(req) ? renderTemplatePicker() : renderLogin());
  });

  router.post('/vendor-registration/login', (req, res) => {
    if (req.body?.username !== 'admin' || req.body?.password !== 'admin') {
      res.status(401).type('html').send(renderLogin('Invalid username or password', inputValue(req.body as Record<string, unknown>, 'return_to')));
      return;
    }
    const session = randomUUID();
    sessions.add(session);
    res.setHeader('Set-Cookie', `dummy_session=${session}; HttpOnly; SameSite=Lax; Path=/dummy`);
    const requested = inputValue(req.body as Record<string, unknown>, 'return_to');
    const returnTo = /^\/dummy\/vendor-registration\/[0-9a-f-]+\/page\/(?:1|3)$/.test(requested)
      ? requested
      : '/dummy/vendor-registration';
    res.redirect(303, returnTo);
  });

  router.post('/vendor-registration/logout', (req, res) => {
    const cookie = req.header('cookie') ?? '';
    const session = cookie.match(/(?:^|;\s*)dummy_session=([^;]+)/)?.[1];
    if (session) sessions.delete(session);
    res.setHeader('Set-Cookie', 'dummy_session=; HttpOnly; SameSite=Lax; Path=/dummy; Max-Age=0');
    res.redirect(303, '/dummy/vendor-registration');
  });

  router.get('/vendor-registration/uae-abu-dhabi', (req, res, next) => {
    if (!isLoggedIn(req)) {
      res.type('html').send(renderLogin());
      return;
    }
    readFile(uaeFormPath, 'utf8').then((html) => res.type('html').send(html), next);
  });

  router.get('/vendor-registration/quick', (req, res) => {
    if (!isLoggedIn(req)) { res.redirect(303, '/dummy/vendor-registration'); return; }
    res.type('html').send(renderQuickVendor());
  });

  router.post('/vendor-registration/quick', (req, res, next) => {
    if (!isLoggedIn(req)) { res.redirect(303, '/dummy/vendor-registration'); return; }
    void (async () => {
      const form = await readMultipart(req);
      const text = (key: string): string => String(form.get(key) ?? '').trim();
      const values = Object.fromEntries(['contact_email', 'entity_type', 'company_name', 'country'].map((key) => [key, text(key)]));
      const fileKeys = ['cr_copy', 'vat_certificate', 'bank_iban', 'national_address'];
      const files = fileKeys.map((key) => ({ key, file: form.get(key) })).filter(({ file }) => isUpload(file) && file.name);
      const errors = Object.entries(values).filter(([, value]) => !value).map(([key]) => `${key.replace(/_/g, ' ')} is required`);
      if (values.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contact_email)) errors.push('contact email is not valid');
      if (values.country && !COUNTRIES.includes(values.country)) errors.push('country is invalid');
      if (values.entity_type && !ENTITY_TYPES.includes(values.entity_type)) errors.push('entity type is invalid');
      for (const key of fileKeys) {
        const upload = form.get(key);
        if (!(isUpload(upload)) || !upload.name) errors.push(`${key.replace(/_/g, ' ')} PDF is required`);
        else if (extensionOf(upload.name) !== 'pdf') errors.push(`${key.replace(/_/g, ' ')} must be a PDF`);
      }
      if (errors.length) { res.status(400).type('html').send(renderQuickVendor(errors, values)); return; }
      const id = randomUUID();
      const dir = join(submissionsRoot, 'quick', id);
      await mkdir(dir, { recursive: true });
      const stored = [];
      for (const [index, key] of fileKeys.entries()) {
        const upload = form.get(key) as File;
        const [saved] = await storeFiles(dir, key, [upload], index);
        stored.push({ key, file: saved });
      }
      const acknowledgement = `QUICK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${id.slice(0, 8).toUpperCase()}`;
      res.type('html').send(renderLayout('Registration submitted', 'success', '<aside class="aside"><div class="eyebrow">Complete</div><h2>Vendor intake received</h2><p class="muted">One-page registration submitted successfully.</p></aside>', `<section class="card ack"><div class="eyebrow">Acknowledgement</div><strong>${acknowledgement}</strong><p><b>${esc(values.company_name)}</b> has been registered.</p><p>${esc(values.country)} · ${esc(((values.entity_type ?? '') as string).replace(/_/g, ' '))} · ${esc(values.contact_email)}</p><h3>Uploaded documents</h3><ul>${stored.map(({ key, file }) => `<li>${esc(key.replace(/_/g, ' '))}: ${esc(file?.original_name ?? '')}</li>`).join('')}</ul><a href="/dummy/vendor-registration"><button type="button">Back to registration list</button></a></section>`));
    })().catch(next);
  });

  router.post('/vendor-registration/start', (req, res, next) => {
    if (!isLoggedIn(req)) { res.redirect(303, '/dummy/vendor-registration'); return; }
    void (async () => {
      const templateKey = inputValue(req.body as Record<string, unknown>, 'template');
      const state = applyTemplate(randomUUID(), templateKey);
      await saveDraft(state);
      res.redirect(303, `/dummy/vendor-registration/${state.id}/page/1`);
    })().catch(next);
  });

  router.post('/vendor-registration/:id/clear', (req, res, next) => {
    if (!isLoggedIn(req)) { res.redirect(303, '/dummy/vendor-registration'); return; }
    void (async () => {
      const state = await ensureDraft(req, res);
      if (!state) return;
      const cleared = initialState(state.id);
      cleared.portal_style = state.portal_style;
      await saveDraft(cleared);
      res.redirect(303, `/dummy/vendor-registration/${state.id}/page/1`);
    })().catch(next);
  });

  router.get('/vendor-registration/:id/page/:page', (req, res, next) => {
    void (async () => {
      const page = Number(req.params.page);
      if (!Number.isInteger(page) || page < 1 || page > 10) {
        res.status(404).send('Not found');
        return;
      }
      const state = await ensureDraft(req, res);
      if (!state) return;
      if (!isLoggedIn(req) && (page === 1 || page === 3)) {
        res.type('html').send(renderLogin('', `/dummy/vendor-registration/${state.id}/page/${page}`));
        return;
      }
      if (!isLoggedIn(req)) { res.redirect(303, '/dummy/vendor-registration'); return; }
      if (page === 10 && !state.submitted_at) {
        res.redirect(303, `/dummy/vendor-registration/${state.id}/page/9`);
        return;
      }
      res.type('html').send(renderPage(state, page, []));
    })().catch(next);
  });

  /**
   * ONE FILE, ONE BOUNDED REQUEST. The whole point of this route: a body the
   * platform will actually deliver. Returns a small JSON ref; the bytes and
   * their name are stored exactly as the batch path stores them, so the hash
   * of what lands on disk is the hash of what was sent.
   */
  router.post('/vendor-registration/:id/page/:page/upload/:key', (req, res, next) => {
    void (async () => {
      const page = Number(req.params.page);
      const key = String(req.params.key ?? '');
      if (!Number.isInteger(page) || (page !== 7 && page !== 8)) {
        res.status(404).json({ ok: false, errors: ['no such upload page'] });
        return;
      }
      if (!isLoggedIn(req)) {
        res.status(401).json({ ok: false, errors: ['not signed in'] });
        return;
      }
      const state = await readDraft(String(req.params.id ?? ''));
      if (!state) {
        res.status(404).json({ ok: false, errors: ['no such registration'] });
        return;
      }
      const [batch1, batch2] = splitDocs(state.selected_documents);
      const batch = page === 7 ? batch1 : batch2;
      // Only a document THIS page is responsible for, and only one it selected.
      if (!batch.includes(key)) {
        res.status(400).json({ ok: false, errors: ['that document is not on this page'] });
        return;
      }
      const def = DOCS_BY_KEY.get(key);
      if (!def) {
        res.status(400).json({ ok: false, errors: ['unknown document'] });
        return;
      }
      // REFUSED BEFORE IT IS READ, and only ever about ONE CHUNK. The declared
      // length is enough to answer, and answering is the difference between a
      // 413 with a reason and a dead page.
      const declared = Number(req.header('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
        res.status(413).json({
          ok: false,
          errors: [`a chunk may not exceed ${MAX_REQUEST_BYTES} bytes`],
          limit: MAX_REQUEST_BYTES,
        });
        return;
      }
      let form: FormData;
      try {
        form = await readMultipart(req);
      } catch (err) {
        res.status(400).json({ ok: false, errors: [`could not parse the upload: ${(err as Error).message}`] });
        return;
      }
      // EXACTLY ONE FILE PART. A batch smuggled into this route is the thing
      // this route exists to prevent.
      const uploads = [...form.values()].filter((value) => isUpload(value));
      if (uploads.length !== 1) {
        res.status(400).json({ ok: false, errors: ['send exactly one file per request'] });
        return;
      }
      const upload = form.get(`doc_file_${key}`);
      if (!isUpload(upload) || !upload.name) {
        res.status(400).json({ ok: false, errors: [`expected a file named doc_file_${key}`] });
        return;
      }
      if (upload.size > MAX_REQUEST_BYTES) {
        res.status(413).json({
          ok: false,
          errors: [`a chunk may not exceed ${MAX_REQUEST_BYTES} bytes`],
          limit: MAX_REQUEST_BYTES,
        });
        return;
      }
      /**
       * ONE BOUNDED CHUNK PER REQUEST, APPENDED IN ORDER.
       *
       * This is what removes every DOCUMENT and PACKAGE size ceiling: a file of
       * any size arrives as a sequence of requests, none of which exceeds the
       * platform's own immutable per-request body limit. `offset` says where
       * this chunk belongs and `total` the document's whole length. Anything
       * that does not continue exactly where the last chunk ended, or would
       * carry the file past its declared length, is refused BEFORE a byte is
       * written. Omitting both is the single-chunk case.
       */
      const part = (name: string) => String(form.get(name) ?? '').trim();
      const total = Number(part('total') || String(upload.size));
      const at = Number(part('offset') || '0');
      if (!Number.isInteger(total) || total < 0 || !Number.isInteger(at) || at < 0 || at > total) {
        res.status(400).json({ ok: false, errors: ['malformed chunk offset'] });
        return;
      }
      const dir = draftDir(state.id);
      await mkdir(dir, { recursive: true });
      const partPath = join(dir, `${key}.part`);
      const held = at === 0 ? 0 : await partSize(partPath);
      if (held !== at) {
        res.status(409).json({ ok: false, errors: ['chunk out of order'], expected_offset: held });
        return;
      }
      // The first chunk binds what this document IS; a later one may not
      // rename it, restate its type, or change how long it claims to be.
      const bound = at === 0 ? null : await readPartMeta(partPath);
      if (at > 0) {
        if (!bound || bound.total !== total || bound.name !== upload.name || bound.type !== upload.type) {
          res.status(409).json({ ok: false, errors: ['chunk does not match the document it continues'] });
          return;
        }
      }
      const bytes = Buffer.from(await upload.arrayBuffer());
      // REFUSED BEFORE THE APPEND, so an overflowing chunk leaves no partial
      // write behind and can never be mistaken for a complete document.
      if (at + bytes.byteLength > total) {
        res.status(400).json({ ok: false, errors: ['chunk runs past the declared total'] });
        return;
      }
      if (at === 0) await writePartMeta(partPath, { name: upload.name, type: upload.type, total });
      await appendChunk(partPath, bytes, at === 0);
      const written = at + bytes.byteLength;
      if (written < total) {
        // More to come: no document is recorded until the last byte lands.
        res.json({ ok: true, key, received: written, total });
        return;
      }

      // COMPLETE. Only now is the document validated and recorded, so a
      // half-arrived file is never mistaken for an uploaded one. The name and
      // type are the FIRST chunk's, never this request's.
      const assembled = await readPart(partPath);
      const identity = (await readPartMeta(partPath)) ?? { name: upload.name, type: upload.type, total };
      const whole = fileLike(identity.name, identity.type, assembled);
      const uploadErrors: string[] = [];
      const valid = validateFile(def.name, whole, uploadErrors);
      if (def.upload_only && extensionOf(identity.name) !== 'pdf') {
        uploadErrors.push(`${def.name}: upload-only documents must be PDF files`);
      }
      if (!valid || uploadErrors.length > 0) {
        await discardPart(partPath);
        res.status(400).json({ ok: false, errors: uploadErrors });
        return;
      }
      const offset = Object.values(state.documents).filter((doc) => doc.file).length;
      const [stored] = await storeFiles(dir, key, [whole], offset);
      await discardPart(partPath);
      const current = state.documents[key] ?? { number: '', issue_date: '', expiry_date: '', issuing_authority: '', notes: '' };
      current.file = stored;
      state.documents[key] = current;
      await saveDraft(state);
      // A SMALL REF, which is all the form then has to carry.
      res.json({ ok: true, key, stored_as: stored!.stored_as, size: stored!.size, original_name: stored!.original_name });
    })().catch(next);
  });

  router.post('/vendor-registration/:id/page/:page', (req, res, next) => {
    void (async () => {
      const page = Number(req.params.page);
      if (!Number.isInteger(page) || page < 1 || page > 9) {
        res.status(404).send('Not found');
        return;
      }
      const state = await ensureDraft(req, res);
      if (!state) return;
      if (!isLoggedIn(req) && (page === 1 || page === 3)) {
        res.type('html').send(renderLogin('', `/dummy/vendor-registration/${state.id}/page/${page}`));
        return;
      }
      if (!isLoggedIn(req)) { res.redirect(303, '/dummy/vendor-registration'); return; }
      if ((req.body as Record<string, unknown>).nav === 'back') {
        res.redirect(303, `/dummy/vendor-registration/${state.id}/page/${Math.max(1, page - 1)}`);
        return;
      }

      const errors: string[] = [];
      if (page <= 6 || page === 9) {
        const body = req.body as Record<string, unknown>;
        if (page === 1) {
          state.company_name = inputValue(body, 'company_name');
          state.trading_name = inputValue(body, 'trading_name');
          state.country = inputValue(body, 'country');
          state.entity_type = inputValue(body, 'entity_type');
          if (!state.company_name) errors.push('Registered company name is required');
          if (!COUNTRIES.includes(state.country)) errors.push('Country is required');
          if (!ENTITY_TYPES.includes(state.entity_type)) errors.push('Entity type is required');
          if (state.selected_documents.length) {
            const valid = new Set(filteredDocsForCountry(state.country).map((doc) => doc.key));
            state.selected_documents = state.selected_documents.filter((key) => valid.has(key));
          }
        } else if (page === 2) {
          state.registration_number = inputValue(body, 'registration_number');
          state.tax_number = inputValue(body, 'tax_number');
          state.incorporation_date = inputValue(body, 'incorporation_date');
          state.website = inputValue(body, 'website');
          if (!state.registration_number) errors.push('Commercial registration number is required');
          if (!state.incorporation_date) errors.push('Incorporation date is required');
          if (state.website && !/^https?:\/\/\S+$/i.test(state.website)) errors.push('Website must start with http:// or https://');
        } else if (page === 3) {
          state.address_line = inputValue(body, 'address_line');
          state.city = inputValue(body, 'city');
          state.region = inputValue(body, 'region');
          state.postal_code = inputValue(body, 'postal_code');
          if (!state.address_line) errors.push('Registered address is required');
          if (!state.city) errors.push('City is required');
        } else if (page === 4) {
          state.contact_name = inputValue(body, 'contact_name');
          state.contact_title = inputValue(body, 'contact_title');
          state.contact_email = inputValue(body, 'contact_email');
          state.contact_phone = inputValue(body, 'contact_phone');
          state.contact_mobile = inputValue(body, 'contact_mobile');
          if (!state.contact_name) errors.push('Primary contact name is required');
          if (!state.contact_email) errors.push('Contact email is required');
          if (!state.contact_phone) errors.push('Contact phone is required');
          if (state.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.contact_email)) errors.push('Contact email is not a valid address');
        } else if (page === 5) {
          state.employee_count = inputValue(body, 'employee_count');
          state.annual_revenue_band = inputValue(body, 'annual_revenue_band');
          state.notes = inputValue(body, 'notes');
          state.services = inputValues(body, 'services').filter((service) => SERVICE_CATEGORIES.includes(service));
          if (state.annual_revenue_band && !REVENUE_BANDS.includes(state.annual_revenue_band)) errors.push('Annual revenue band is invalid');
        } else if (page === 6) {
          const bulk = inputValue(body, 'bulk');
          if (bulk === 'all') {
            state.selected_documents = filteredDocsForCountry(state.country).map((doc) => doc.key);
            await saveDraft(state);
            res.type('html').send(renderPage(state, page, []));
            return;
          }
          if (bulk === 'clear') {
            state.selected_documents = [];
            await saveDraft(state);
            res.type('html').send(renderPage(state, page, []));
            return;
          }
          const allowed = new Set(filteredDocsForCountry(state.country).map((doc) => doc.key));
          state.selected_documents = inputValues(body, 'selected_documents').filter((key) => allowed.has(key));
          if (state.selected_documents.length === 0) errors.push('Select at least one document');
          if (state.selected_documents.length > MAX_SELECTED_DOCUMENTS) errors.push(`No more than ${MAX_SELECTED_DOCUMENTS} documents can be selected`);
        } else if (page === 9) {
          state.declaration_name = inputValue(body, 'declaration_name');
          state.declaration_role = inputValue(body, 'declaration_role');
          state.declaration_confirmed = inputValue(body, 'declaration_confirmed') === 'yes';
          if (!state.declaration_name) errors.push('Authorised signatory name is required');
          if (!state.declaration_role) errors.push('Authorised signatory role is required');
          if (!state.declaration_confirmed) errors.push('The final declaration must be confirmed');
          for (const key of state.selected_documents) {
            if (!state.documents[key]?.file) errors.push(`${DOCS_BY_KEY.get(key)?.name ?? key} must be uploaded before submission`);
          }
          if (!errors.length) {
            state.submitted_at = new Date().toISOString();
            await saveDraft(state);
            const files = state.selected_documents
              .map((key) => state.documents[key]?.file)
              .filter((file): file is StoredFile => Boolean(file));
            const receipt: Receipt = {
              ok: true,
              id: state.id,
              acknowledgement_no: acknowledgementNo(state.id, state.submitted_at),
              received_at: state.submitted_at,
              fields: fieldsForReceipt(state),
              selected_documents: state.selected_documents,
              document_details: state.documents,
              files,
              file_count: files.length,
              stored_in: receiptDir(state.id),
            };
            await mkdir(receiptDir(state.id), { recursive: true });
            await writeFile(receiptPath(state.id), JSON.stringify(receipt, null, 2));
            res.redirect(303, `/dummy/vendor-registration/${state.id}/page/10`);
            return;
          }
        }
      } else {
        let form: FormData;
        try {
          form = await readMultipart(req);
        } catch (err) {
          const message = `could not parse the upload: ${(err as Error).message}`;
          fail(req, res, 400, [message], state, page);
          return;
        }
        const [batch1, batch2] = splitDocs(state.selected_documents);
        const batch = page === 7 ? batch1 : batch2;
        const dir = draftDir(state.id);
        await mkdir(dir, { recursive: true });
        const existingCount = Object.values(state.documents).filter((doc) => doc.file).length;
        let offset = existingCount;
        for (const key of batch) {
          const def = DOCS_BY_KEY.get(key)!;
          const current = state.documents[key] ?? { number: '', issue_date: '', expiry_date: '', issuing_authority: '', notes: '' };
          if (!def.upload_only) {
            current.number = String(form.get(`doc_number_${key}`) ?? '').trim();
            current.issue_date = String(form.get(`issue_date_${key}`) ?? '').trim();
            current.expiry_date = String(form.get(`expiry_date_${key}`) ?? '').trim();
            current.issuing_authority = String(form.get(`issuing_authority_${key}`) ?? '').trim();
            current.notes = String(form.get(`doc_notes_${key}`) ?? '').trim();
          }
          const upload = form.get(`doc_file_${key}`);
          if (isUpload(upload) && upload.name) {
            const uploadErrors: string[] = [];
            const valid = validateFile(def.name, upload, uploadErrors);
            if (def.upload_only && extensionOf(upload.name) !== 'pdf') {
              uploadErrors.push(`${def.name}: upload-only documents must be PDF files`);
            }
            if (valid && uploadErrors.length === 0) {
              const [stored] = await storeFiles(dir, key, [upload], offset);
              offset += 1;
              current.file = stored;
            } else {
              errors.push(...uploadErrors);
            }
          }
          if (!current.file) errors.push(`${def.name} file is required`);
          state.documents[key] = current;
        }
      }

      if (errors.length) {
        fail(req, res, 400, errors, state, page);
        return;
      }

      await saveDraft(state);
      res.redirect(303, `/dummy/vendor-registration/${state.id}/page/${page + 1}`);
    })().catch(next);
  });

  router.get('/receipt/:id', (req, res, next) => {
    if (!isLoggedIn(req)) { res.redirect(303, '/dummy/vendor-registration'); return; }
    void (async () => {
      const receipt = await readReceipt(req.params.id as string);
      if (!receipt) {
        if (wantsJson(req)) {
          res.status(404).json({ ok: false, errors: ['no such registration'] });
          return;
        }
        res.status(404).type('html').send(renderLayout('Not found', 'error', '<aside class="aside"></aside>', '<section class="card"><p>No such registration.</p></section>'));
        return;
      }
      if (wantsJson(req)) {
        res.json(receipt);
        return;
      }
      const state = await readDraft(receipt.id);
      if (!state) {
        res.redirect(303, `/dummy/vendor-registration`);
        return;
      }
      res.type('html').send(renderPage(state, 10, []));
    })().catch(next);
  });

  return router;
}
