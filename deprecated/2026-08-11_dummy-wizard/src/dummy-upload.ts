/**
 * Isolated dummy vendor-registration pages for browser-agent upload testing.
 *
 * Nothing here touches registrations, packages, approvals or submissions: it is a
 * self-contained multipart target that stores files in a temporary directory
 * outside source control and reports an explicit success/error result an
 * automation agent can assert on (HTML with `data-result`, or JSON).
 */
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_SUPPORTING_FILES = 5;
export const ALLOWED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'docx'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface TextField {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
}

const TEXT_FIELDS: TextField[] = [
  { name: 'company_name', label: 'Registered company name', required: true, placeholder: 'Acme Trading LLC' },
  { name: 'trading_name', label: 'Trading name (if different)' },
  { name: 'registration_number', label: 'Commercial registration number', required: true, placeholder: 'CR-1234567' },
  { name: 'tax_number', label: 'Tax / VAT number', placeholder: 'VAT-998877' },
  { name: 'incorporation_date', label: 'Date of incorporation', type: 'date', required: true },
  { name: 'website', label: 'Website', type: 'url', placeholder: 'https://example.com' },
  { name: 'address_line', label: 'Registered address', required: true },
  { name: 'city', label: 'City', required: true },
  { name: 'contact_name', label: 'Primary contact name', required: true },
  { name: 'contact_email', label: 'Contact email', type: 'email', required: true },
  { name: 'contact_phone', label: 'Contact phone', type: 'tel', required: true },
];

const COUNTRIES = ['AE', 'SA', 'GB', 'NL', 'DE', 'US'];
const ENTITY_TYPES = ['llc', 'sole_establishment', 'branch', 'partnership'];
const SERVICE_CATEGORIES = ['it_services', 'logistics', 'consulting', 'facilities'];
const DOCUMENT_CATEGORIES = ['supporting', 'clarification', 'renewal'];

interface FileField {
  name: string;
  label: string;
  required?: boolean;
}

const FILE_FIELDS: FileField[] = [
  { name: 'trade_licence', label: 'Trade licence', required: true },
  { name: 'tax_certificate', label: 'Tax / VAT certificate', required: true },
  { name: 'bank_letter', label: 'Bank letter', required: true },
  { name: 'company_profile', label: 'Company profile' },
  { name: 'certifications', label: 'Certifications (ISO, quality)' },
];

export interface StoredFile {
  field: string;
  original_name: string;
  stored_as: string;
  size: number;
  content_type: string;
}

export interface Receipt {
  ok: true;
  id: string;
  received_at: string;
  fields: Record<string, string | string[]>;
  files: StoredFile[];
  file_count: number;
  stored_in: string;
}

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

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
  :root { --bg:#f6f7f9; --panel:#fff; --ink:#16191d; --muted:#6b7280; --line:#e3e6ea;
          --accent:#2b5cd9; --ok:#0f7b4f; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14171a; --panel:#1c2024; --ink:#e8eaed; --muted:#9aa3ad; --line:#2c3238;
            --accent:#6f9bff; --ok:#4ec38a; --bad:#ff8a80; }
  }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--ink); }
  header { padding:.8rem 1.2rem; background:var(--panel); border-bottom:1px solid var(--line); }
  header h1 { font-size:1rem; margin:0; }
  .banner { background:#fff4e5; color:#7a4a00; padding:.5rem 1.2rem; font-size:12.5px; }
  main { max-width:840px; margin:0 auto; padding:1rem 1.2rem; }
  fieldset { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:1rem; margin:0 0 1rem; }
  legend { font-size:.82rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  label { display:block; font-size:12px; color:var(--muted); margin:.6rem 0 .15rem; }
  input, select, textarea, button { font:inherit; padding:.4rem .55rem; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); width:100%; }
  input[type=radio], input[type=checkbox] { width:auto; }
  .inline { display:inline-block; margin-right:1rem; font-size:13px; color:var(--ink); }
  button { background:var(--accent); color:#fff; border:0; cursor:pointer; width:auto; padding:.5rem 1rem; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:.35rem .4rem; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-size:11.5px; text-transform:uppercase; }
  .errors { background:var(--panel); border:1px solid var(--bad); border-left-width:4px; border-radius:8px; padding:.7rem 1rem; margin-bottom:1rem; color:var(--bad); }
  .ok { color:var(--ok); } .muted { color:var(--muted); }
  .mono { font-family:ui-monospace,Menlo,monospace; font-size:12px; word-break:break-all; }
`;

function layout(title: string, result: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body data-result="${esc(result)}">
<header><h1>${esc(title)}</h1></header>
<div class="banner">Dummy test page. Not a real vendor portal — uploads are written to a temporary directory and discarded.</div>
<main>${body}</main>
</body></html>`;
}

function registrationForm(values: Record<string, string | string[]>, errors: string[]): string {
  const val = (n: string): string => esc(typeof values[n] === 'string' ? values[n] : '');
  const checked = (n: string, v: string): string => {
    const cur = values[n];
    return (Array.isArray(cur) ? cur.includes(v) : cur === v) ? ' checked' : '';
  };
  return layout(
    'Vendor Registration',
    errors.length ? 'error' : 'form',
    `${errors.length ? `<div class="errors" id="errors"><strong>${errors.length} problem(s) with this submission:</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/dummy/vendor-registration" enctype="multipart/form-data" id="vendor-registration-form" novalidate>
  <fieldset><legend>Company details</legend>
    ${TEXT_FIELDS.slice(0, 8)
      .map(
        (f) => `<label for="${f.name}">${esc(f.label)}${f.required ? ' *' : ''}</label>
    <input id="${f.name}" name="${f.name}" type="${f.type ?? 'text'}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''} value="${val(f.name)}">`,
      )
      .join('\n    ')}
    <label for="country">Country of registration *</label>
    <select id="country" name="country">
      <option value="">— select a country —</option>
      ${COUNTRIES.map((c) => `<option value="${c}"${values.country === c ? ' selected' : ''}>${c}</option>`).join('')}
    </select>
    <label>Entity type *</label>
    ${ENTITY_TYPES.map(
      (t) =>
        `<span class="inline"><input type="radio" id="entity_type_${t}" name="entity_type" value="${t}"${checked('entity_type', t)}> <label for="entity_type_${t}" style="display:inline">${t.replace(/_/g, ' ')}</label></span>`,
    ).join('\n    ')}
  </fieldset>

  <fieldset><legend>Contact</legend>
    ${TEXT_FIELDS.slice(8)
      .map(
        (f) => `<label for="${f.name}">${esc(f.label)}${f.required ? ' *' : ''}</label>
    <input id="${f.name}" name="${f.name}" type="${f.type ?? 'text'}" value="${val(f.name)}">`,
      )
      .join('\n    ')}
    <label for="notes">Notes</label>
    <textarea id="notes" name="notes" rows="3">${val('notes')}</textarea>
    <label>Service categories</label>
    ${SERVICE_CATEGORIES.map(
      (s) =>
        `<span class="inline"><input type="checkbox" id="services_${s}" name="services" value="${s}"${checked('services', s)}> <label for="services_${s}" style="display:inline">${s.replace(/_/g, ' ')}</label></span>`,
    ).join('\n    ')}
  </fieldset>

  <fieldset><legend>Required documents</legend>
    ${FILE_FIELDS.map(
      (f) => `<label for="${f.name}">${esc(f.label)}${f.required ? ' *' : ''}</label>
    <input id="${f.name}" name="${f.name}" type="file" accept="${ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',')}">`,
    ).join('\n    ')}
    <label for="supporting_documents">Supporting documents (up to ${MAX_SUPPORTING_FILES} files)</label>
    <input id="supporting_documents" name="supporting_documents" type="file" multiple accept="${ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',')}">
    <p class="muted">Accepted: ${ALLOWED_EXTENSIONS.join(', ')} — max ${MAX_FILE_BYTES / 1024 / 1024} MB per file, ${MAX_TOTAL_BYTES / 1024 / 1024} MB per submission.</p>
  </fieldset>

  <fieldset><legend>Declaration</legend>
    <span class="inline"><input type="checkbox" id="terms" name="terms" value="yes"${checked('terms', 'yes')}> <label for="terms" style="display:inline">I confirm the information above is accurate *</label></span>
  </fieldset>

  <button type="submit" id="submit">Submit registration</button>
</form>`,
  );
}

function receiptPage(r: Receipt): string {
  return layout(
    'Registration received',
    'success',
    `<fieldset><legend>Result</legend>
  <p class="ok" id="status"><strong>SUCCESS</strong> — registration <span class="mono" id="receipt-id">${esc(r.id)}</span> received with ${r.file_count} file(s).</p>
  <p class="muted">Received at ${esc(r.received_at)} · <a href="/dummy/receipt/${esc(r.id)}?format=json">JSON</a></p>
</fieldset>
<fieldset><legend>Files stored</legend>
  <table id="files"><thead><tr><th>Field</th><th>Original name</th><th>Stored as</th><th>Bytes</th></tr></thead>
  <tbody>${r.files
    .map(
      (f) =>
        `<tr><td>${esc(f.field)}</td><td class="mono">${esc(f.original_name)}</td><td class="mono">${esc(f.stored_as)}</td><td>${f.size}</td></tr>`,
    )
    .join('')}</tbody></table>
</fieldset>
<fieldset><legend>Submitted values</legend>
  <table><tbody>${Object.entries(r.fields)
    .map(
      ([k, v]) =>
        `<tr><th>${esc(k)}</th><td class="mono" data-field="${esc(k)}">${esc(Array.isArray(v) ? v.join(', ') : v)}</td></tr>`,
    )
    .join('')}</tbody></table>
</fieldset>
<p><a href="/dummy/receipt/${esc(r.id)}/documents">Step 2 — add more documents</a> · <a href="/dummy/vendor-registration">New registration</a></p>`,
  );
}

function documentsForm(id: string, errors: string[]): string {
  return layout(
    'Step 2 — additional documents',
    errors.length ? 'error' : 'form',
    `${errors.length ? `<div class="errors" id="errors"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/dummy/receipt/${esc(id)}/documents" enctype="multipart/form-data" id="additional-documents-form">
  <fieldset><legend>Registration <span class="mono">${esc(id)}</span></legend>
    <label for="category">Document category *</label>
    <select id="category" name="category">
      ${DOCUMENT_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
    </select>
    <label for="additional_documents">Additional documents (up to ${MAX_SUPPORTING_FILES} files) *</label>
    <input id="additional_documents" name="additional_documents" type="file" multiple accept="${ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',')}">
  </fieldset>
  <button type="submit" id="submit">Upload documents</button>
</form>
<p><a href="/dummy/receipt/${esc(id)}">Back to receipt</a></p>`,
  );
}

const wantsJson = (req: Request): boolean =>
  req.query.format === 'json' || (req.header('accept') ?? '').includes('application/json');

class TooLarge extends Error {}

/**
 * Parse the request body as multipart. The stream is capped before it is buffered,
 * so an oversized (or chunked, length-less) upload cannot exhaust memory.
 */
async function readMultipart(req: Request): Promise<FormData> {
  const contentType = req.header('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new Error('expected a multipart/form-data body');
  }
  if (Number(req.header('content-length') ?? 0) > MAX_TOTAL_BYTES) throw new TooLarge();

  let over = false;
  const capped = Readable.from(
    (async function* () {
      let seen = 0;
      for await (const chunk of req) {
        seen += (chunk as Buffer).length;
        if (seen > MAX_TOTAL_BYTES) {
          over = true;
          return; // truncating makes formData() reject; `over` tells us why
        }
        yield chunk;
      }
    })(),
  );

  try {
    return await new Response(Readable.toWeb(capped) as ReadableStream, {
      headers: { 'content-type': contentType },
    }).formData();
  } catch (err) {
    if (over) throw new TooLarge();
    throw err;
  }
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
  if (file.size > MAX_FILE_BYTES) {
    errors.push(`${field}: file is ${file.size} bytes, over the ${MAX_FILE_BYTES} byte limit`);
    return false;
  }
  return true;
}

const filesOf = (form: FormData, field: string): File[] =>
  form.getAll(field).filter((v): v is File => v instanceof File && v.name !== '');

async function storeFiles(dir: string, field: string, files: File[], startIndex: number): Promise<StoredFile[]> {
  const stored: StoredFile[] = [];
  for (const [i, file] of files.entries()) {
    const storedAs = `${field}-${startIndex + i}-${safeFilename(file.name)}`;
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
  const receiptPath = (id: string): string => join(uploadRoot, id, 'receipt.json');

  const router = Router();

  const readReceipt = async (id: string): Promise<Receipt | undefined> => {
    if (!UUID.test(id)) return undefined; // rejects traversal ids before any path is joined
    try {
      return JSON.parse(await readFile(receiptPath(id), 'utf8')) as Receipt;
    } catch {
      return undefined;
    }
  };

  const fail = (req: Request, res: Response, status: number, errors: string[], html: string): void => {
    if (wantsJson(req)) {
      res.status(status).json({ ok: false, errors });
      return;
    }
    res.status(status).type('html').send(html);
  };

  router.get('/vendor-registration', (_req, res) => {
    res.type('html').send(registrationForm({}, []));
  });

  router.post('/vendor-registration', (req, res, next) => {
    void (async () => {
      let form: FormData;
      try {
        form = await readMultipart(req);
      } catch (err) {
        const tooLarge = err instanceof TooLarge;
        const message = tooLarge
          ? `submission exceeds the ${MAX_TOTAL_BYTES} byte limit`
          : `could not parse the upload: ${(err as Error).message}`;
        fail(req, res, tooLarge ? 413 : 400, [message], registrationForm({}, [message]));
        return;
      }

      const errors: string[] = [];
      const values: Record<string, string | string[]> = {};
      for (const f of TEXT_FIELDS) {
        const v = (form.get(f.name) ?? '').toString().trim();
        values[f.name] = v;
        if (f.required && !v) errors.push(`${f.label} is required`);
      }
      values.notes = (form.get('notes') ?? '').toString().trim();

      const country = (form.get('country') ?? '').toString();
      values.country = country;
      if (!COUNTRIES.includes(country)) errors.push('Country of registration is required');

      const entityType = (form.get('entity_type') ?? '').toString();
      values.entity_type = entityType;
      if (!ENTITY_TYPES.includes(entityType)) errors.push('Entity type is required');

      const services = form.getAll('services').map(String);
      values.services = services;
      if (services.some((s) => !SERVICE_CATEGORIES.includes(s))) errors.push('Unknown service category selected');

      const terms = (form.get('terms') ?? '').toString();
      values.terms = terms;
      if (terms !== 'yes') errors.push('The declaration must be confirmed');

      const email = String(values.contact_email ?? '');
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Contact email is not a valid address');

      const accepted: { field: string; files: File[] }[] = [];
      for (const f of FILE_FIELDS) {
        const files = filesOf(form, f.name);
        if (files.length === 0) {
          if (f.required) errors.push(`${f.label} is required`);
          continue;
        }
        if (files.length > 1) errors.push(`${f.label} accepts a single file`);
        const ok = files.filter((file) => validateFile(f.label, file, errors));
        if (ok.length) accepted.push({ field: f.name, files: ok.slice(0, 1) });
      }

      const supporting = filesOf(form, 'supporting_documents');
      if (supporting.length > MAX_SUPPORTING_FILES) {
        errors.push(`Supporting documents: ${supporting.length} files, maximum is ${MAX_SUPPORTING_FILES}`);
      } else {
        const ok = supporting.filter((file) => validateFile('Supporting documents', file, errors));
        if (ok.length) accepted.push({ field: 'supporting_documents', files: ok });
      }

      if (errors.length) {
        fail(req, res, 400, errors, registrationForm(values, errors));
        return;
      }

      const id = randomUUID();
      const dir = join(uploadRoot, id);
      await mkdir(dir, { recursive: true });
      const files: StoredFile[] = [];
      for (const group of accepted) files.push(...(await storeFiles(dir, group.field, group.files, files.length)));

      const receipt: Receipt = {
        ok: true,
        id,
        received_at: new Date().toISOString(),
        fields: values,
        files,
        file_count: files.length,
        stored_in: dir,
      };
      await writeFile(receiptPath(id), JSON.stringify(receipt, null, 2));

      if (wantsJson(req)) {
        res.status(201).json(receipt);
        return;
      }
      res.redirect(303, `/dummy/receipt/${id}`);
    })().catch(next);
  });

  router.get('/receipt/:id', (req, res, next) => {
    void (async () => {
      const receipt = await readReceipt(req.params.id as string);
      if (!receipt) {
        fail(req, res, 404, ['no such registration'], layout('Not found', 'error', '<p>No such registration.</p>'));
        return;
      }
      if (wantsJson(req)) {
        res.json(receipt);
        return;
      }
      res.type('html').send(receiptPage(receipt));
    })().catch(next);
  });

  router.get('/receipt/:id/documents', (req, res, next) => {
    void (async () => {
      const id = req.params.id as string;
      if (!(await readReceipt(id))) {
        fail(req, res, 404, ['no such registration'], layout('Not found', 'error', '<p>No such registration.</p>'));
        return;
      }
      res.type('html').send(documentsForm(id, []));
    })().catch(next);
  });

  router.post('/receipt/:id/documents', (req, res, next) => {
    void (async () => {
      const id = req.params.id as string;
      const receipt = await readReceipt(id);
      if (!receipt) {
        fail(req, res, 404, ['no such registration'], layout('Not found', 'error', '<p>No such registration.</p>'));
        return;
      }

      let form: FormData;
      try {
        form = await readMultipart(req);
      } catch (err) {
        const tooLarge = err instanceof TooLarge;
        const message = tooLarge
          ? `submission exceeds the ${MAX_TOTAL_BYTES} byte limit`
          : `could not parse the upload: ${(err as Error).message}`;
        fail(req, res, tooLarge ? 413 : 400, [message], documentsForm(id, [message]));
        return;
      }

      const errors: string[] = [];
      const category = (form.get('category') ?? '').toString();
      if (!DOCUMENT_CATEGORIES.includes(category)) errors.push('Document category is required');

      const uploads = filesOf(form, 'additional_documents');
      if (uploads.length === 0) errors.push('At least one document is required');
      if (uploads.length > MAX_SUPPORTING_FILES) {
        errors.push(`${uploads.length} files, maximum is ${MAX_SUPPORTING_FILES}`);
      }
      const ok = uploads.filter((file) => validateFile('Additional documents', file, errors));
      if (errors.length) {
        fail(req, res, 400, errors, documentsForm(id, errors));
        return;
      }

      const dir = join(uploadRoot, id);
      const added = await storeFiles(dir, `additional_${category}`, ok, receipt.files.length);
      receipt.files.push(...added);
      receipt.file_count = receipt.files.length;
      await writeFile(receiptPath(id), JSON.stringify(receipt, null, 2));

      if (wantsJson(req)) {
        res.status(201).json(receipt);
        return;
      }
      res.redirect(303, `/dummy/receipt/${id}`);
    })().catch(next);
  });

  return router;
}
