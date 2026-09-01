import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/api.js';
import { safeFilename } from '../src/dummy-upload.js';
import { ENV, testDb } from './support.js';

interface Ctx {
  base: string;
  uploadDir: string;
  get: (path: string) => Promise<Response>;
  postForm: (path: string, body: URLSearchParams, json?: boolean) => Promise<Response>;
  postMultipart: (path: string, form: FormData, json?: boolean) => Promise<Response>;
}

async function withPages(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const uploadDir = mkdtempSync(join(tmpdir(), 'dummy-upload-test-'));
  const db = testDb();
  const server = createApp(db, { env: { ...ENV, DUMMY_UPLOAD_DIR: uploadDir } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({
      base,
      uploadDir,
      get: (path) => fetch(base + path, { redirect: 'manual' }),
      postForm: (path, body, json = false) =>
        fetch(base + path, {
          method: 'POST',
          body,
          redirect: 'manual',
          headers: json ? { accept: 'application/json' } : undefined,
        }),
      postMultipart: (path, form, json = false) =>
        fetch(base + path, {
          method: 'POST',
          body: form,
          redirect: 'manual',
          headers: json ? { accept: 'application/json' } : undefined,
        }),
    });
  } finally {
    server.close();
    db.close();
    rmSync(uploadDir, { recursive: true, force: true });
  }
}

const file = (name: string, bytes = 64, type = 'application/pdf'): File =>
  new File([new Uint8Array(bytes).fill(65)], name, { type });

async function startWizard(base: string): Promise<string> {
  const picker = await fetch(`${base}/dummy/vendor-registration`, { redirect: 'manual' });
  assert.equal(picker.status, 200);
  const pickerHtml = await picker.text();
  assert.match(pickerHtml, /Choose registration flow/);
  assert.match(pickerHtml, /Saudi and UAE company scenarios/);
  const res = await fetch(`${base}/dummy/vendor-registration/start`, {
    method: 'POST',
    body: new URLSearchParams({ template: '' }),
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  const location = res.headers.get('location')!;
  assert.match(location, /^\/dummy\/vendor-registration\/[0-9a-f-]{36}\/page\/1$/);
  return location.match(/vendor-registration\/([0-9a-f-]{36})\/page\/1$/)![1]!;
}

function pagePath(id: string, page: number): string {
  return `/dummy/vendor-registration/${id}/page/${page}`;
}

test('wizard starts on page 1 and exposes ten-step progress plus document catalog', async () => {
  await withPages(async ({ base, get, postForm }) => {
    const id = await startWizard(base);
    const page1 = await get(pagePath(id, 1));
    assert.equal(page1.status, 200);
    const page1Html = await page1.text();
    assert.match(page1Html, /Page 1 of 10/);
    assert.match(page1Html, /Registered company name/);
    assert.match(page1Html, /data-result="form"/);

    await postForm(pagePath(id, 1), new URLSearchParams({
      company_name: 'Acme Trading LLC',
      trading_name: 'Acme',
      country: 'SA',
      entity_type: 'llc',
    }));
    await postForm(pagePath(id, 2), new URLSearchParams({
      registration_number: 'CR-1234567',
      tax_number: 'VAT-998877',
      incorporation_date: '2019-04-01',
      website: 'https://acme.example',
    }));
    await postForm(pagePath(id, 3), new URLSearchParams({
      address_line: '12 Harbour Road',
      city: 'Riyadh',
      region: 'Riyadh',
      postal_code: '11411',
    }));
    await postForm(pagePath(id, 4), new URLSearchParams({
      contact_name: 'Dana Fox',
      contact_title: 'Compliance Lead',
      contact_email: 'dana@acme.example',
      contact_phone: '+966500000000',
      contact_mobile: '+966511111111',
    }));
    await postForm(pagePath(id, 5), new URLSearchParams({
      employee_count: '240',
      annual_revenue_band: '5m_to_25m',
      services: 'logistics',
      notes: 'Supplier onboarding test',
    }));

    const page6 = await get(pagePath(id, 6));
    const page6Html = await page6.text();
    assert.match(page6Html, /Page 6 of 10/);
    assert.match(page6Html, /Select all documents/);
    assert.match(page6Html, /Commercial Registration/);
    assert.match(page6Html, /Saudization Certificate \(Qiwa \/ Nitaqat Certificate\)/);
    assert.match(page6Html, /name="selected_documents"/);
  });
});

test('template picker starts blank Saudi and UAE portal variants', async () => {
  await withPages(async ({ base, postForm, get }) => {
    const saStart = await postForm('/dummy/vendor-registration/start', new URLSearchParams({ template: 'sa_noor_logistics' }));
    assert.equal(saStart.status, 303);
    const saId = saStart.headers.get('location')!.match(/vendor-registration\/([0-9a-f-]{36})\/page\/1$/)![1]!;
    const saPage = await get(pagePath(saId, 1));
    const saHtml = await saPage.text();
    assert.match(saHtml, /Supplier Registration Portal/);
    assert.match(saHtml, /starts blank/);
    assert.match(saHtml, /name="company_name" value=""/);
    assert.doesNotMatch(saHtml, /Noor Logistics Saudi LLC/);

    const aeStart = await postForm('/dummy/vendor-registration/start', new URLSearchParams({ template: 'ae_desert_falcon' }));
    assert.equal(aeStart.status, 303);
    const aeId = aeStart.headers.get('location')!.match(/vendor-registration\/([0-9a-f-]{36})\/page\/1$/)![1]!;
    const aePage = await get(pagePath(aeId, 1));
    const aeHtml = await aePage.text();
    assert.match(aeHtml, /Procurement Registration Desk/);
    assert.match(aeHtml, /name="company_name" value=""/);
    assert.doesNotMatch(aeHtml, /Desert Falcon Trading LLC/);
    assert.match(aeHtml, /Procurement Registration Desk/);

    const complianceStart = await postForm('/dummy/vendor-registration/start', new URLSearchParams({ template: 'sa_riyadh_industrial' }));
    assert.equal(complianceStart.status, 303);
    const complianceId = complianceStart.headers.get('location')!.match(/vendor-registration\/([0-9a-f-]{36})\/page\/1$/)![1]!;
    const compliancePage = await get(pagePath(complianceId, 1));
    assert.match(await compliancePage.text(), /Vendor Compliance Gateway/);
  });
});

test('a complete ten-page submission stores selected files and exposes an acknowledgement number', async () => {
  await withPages(async ({ base, get, postForm, postMultipart, uploadDir }) => {
    const id = await startWizard(base);

    const formPage1 = await postForm(pagePath(id, 1), new URLSearchParams({
      company_name: 'Acme Trading LLC',
      trading_name: 'Acme',
      country: 'SA',
      entity_type: 'llc',
    }));
    assert.equal(formPage1.status, 303);
    assert.equal(formPage1.headers.get('location'), pagePath(id, 2));

    await postForm(pagePath(id, 2), new URLSearchParams({
      registration_number: 'CR-1234567',
      tax_number: 'VAT-998877',
      incorporation_date: '2019-04-01',
      website: 'https://acme.example',
    }));
    await postForm(pagePath(id, 3), new URLSearchParams({
      address_line: '12 Harbour Road',
      city: 'Riyadh',
      region: 'Riyadh',
      postal_code: '11411',
    }));
    await postForm(pagePath(id, 4), new URLSearchParams({
      contact_name: 'Dana Fox',
      contact_title: 'Compliance Lead',
      contact_email: 'dana@acme.example',
      contact_phone: '+966500000000',
      contact_mobile: '+966511111111',
    }));

    const page5 = new URLSearchParams();
    page5.set('employee_count', '240');
    page5.set('annual_revenue_band', '5m_to_25m');
    page5.append('services', 'it_services');
    page5.append('services', 'logistics');
    page5.set('notes', 'Supplier onboarding test');
    await postForm(pagePath(id, 5), page5);

    const page6 = new URLSearchParams();
    page6.append('selected_documents', 'commercial_registration');
    page6.append('selected_documents', 'company_profile');
    page6.append('selected_documents', 'gosi');
    page6.append('selected_documents', 'iban');
    page6.append('selected_documents', 'vat');
    await postForm(pagePath(id, 6), page6);

    const page7 = new FormData();
    for (const key of ['commercial_registration', 'company_profile', 'gosi']) {
      page7.set(`doc_number_${key}`, `${key.toUpperCase()}-001`);
      page7.set(`issue_date_${key}`, '2025-01-15');
      page7.set(`expiry_date_${key}`, '2027-01-15');
      page7.set(`issuing_authority_${key}`, 'Saudi Authority');
      page7.set(`doc_notes_${key}`, `${key} uploaded`);
      page7.set(`doc_file_${key}`, file(`${key}.pdf`));
    }
    const page7Res = await postMultipart(pagePath(id, 7), page7);
    assert.equal(page7Res.status, 303);
    assert.equal(page7Res.headers.get('location'), pagePath(id, 8));

    const page8 = new FormData();
    for (const key of ['iban', 'vat']) {
      page8.set(`doc_number_${key}`, `${key.toUpperCase()}-002`);
      page8.set(`issue_date_${key}`, '2025-02-01');
      page8.set(`expiry_date_${key}`, '2027-02-01');
      page8.set(`issuing_authority_${key}`, 'Global Authority');
      page8.set(`doc_notes_${key}`, `${key} uploaded`);
      page8.set(`doc_file_${key}`, file(`${key}.pdf`));
    }
    await postMultipart(pagePath(id, 8), page8);

    const page9 = await get(pagePath(id, 9));
    const page9Html = await page9.text();
    assert.match(page9Html, /Page 9 of 10/);
    assert.match(page9Html, /Uploaded files: 5\/5/);
    assert.match(page9Html, /Authorised signatory name/);

    const page9Submit = await postForm(pagePath(id, 9), new URLSearchParams({
      declaration_name: 'Fatima Noor',
      declaration_role: 'Authorised Signatory',
      declaration_confirmed: 'yes',
    }));
    assert.equal(page9Submit.status, 303);
    assert.equal(page9Submit.headers.get('location'), pagePath(id, 10));

    const page10 = await get(pagePath(id, 10));
    assert.equal(page10.status, 200);
    const page10Html = await page10.text();
    assert.match(page10Html, /data-result="success"/);
    assert.match(page10Html, /Submission complete/);
    assert.match(page10Html, /ACK-20260811-/);
    assert.match(page10Html, /Your registration has been filled and submitted/);

    const receipt = await (await get(`/dummy/receipt/${id}?format=json`)).json() as {
      ok: boolean;
      file_count: number;
      selected_documents: string[];
      acknowledgement_no: string;
    };
    assert.equal(receipt.ok, true);
    assert.equal(receipt.file_count, 5);
    assert.deepEqual(receipt.selected_documents, ['commercial_registration', 'company_profile', 'gosi', 'iban', 'vat']);
    assert.match(receipt.acknowledgement_no, /^ACK-20260811-/);

    const drafts = readdirSync(join(uploadDir, 'drafts', id));
    assert.ok(drafts.includes('draft.json'));
    const stored = readdirSync(join(uploadDir, 'drafts', id)).filter((name) => name.endsWith('.pdf'));
    assert.equal(stored.length, 5);
  });
});

test('validation errors are explicit and keep the user on the same page', async () => {
  await withPages(async ({ base, postForm, postMultipart }) => {
    const id = await startWizard(base);

    const page1 = await postForm(pagePath(id, 1), new URLSearchParams());
    assert.equal(page1.status, 400);
    const page1Html = await page1.text();
    assert.match(page1Html, /Registered company name is required/);
    assert.match(page1Html, /Country is required/);
    assert.match(page1Html, /Entity type is required/);

    await postForm(pagePath(id, 1), new URLSearchParams({
      company_name: 'Acme Trading LLC',
      country: 'AE',
      entity_type: 'llc',
    }));
    await postForm(pagePath(id, 2), new URLSearchParams({
      registration_number: 'AE-123',
      incorporation_date: '2024-04-01',
    }));
    await postForm(pagePath(id, 3), new URLSearchParams({
      address_line: '1 Marina Plaza',
      city: 'Dubai',
    }));
    await postForm(pagePath(id, 4), new URLSearchParams({
      contact_name: 'Mona',
      contact_email: 'mona@example.com',
      contact_phone: '+971500000000',
    }));
    await postForm(pagePath(id, 5), new URLSearchParams());
    await postForm(pagePath(id, 6), new URLSearchParams('selected_documents=trade_license'));

    const badUpload = new FormData();
    badUpload.set('doc_number_trade_license', 'TL-001');
    badUpload.set('doc_file_trade_license', file('trade-license.exe'));
    const page7 = await postMultipart(pagePath(id, 7), badUpload);
    assert.equal(page7.status, 400);
    const page7Html = await page7.text();
    assert.match(page7Html, /file type &#34;exe&#34; is not accepted/);
    assert.match(page7Html, /Trade License file is required/);
  });
});

test('upload-only documents show PDF-only upload fields without manual metadata inputs', async () => {
  await withPages(async ({ base, postForm, postMultipart, get }) => {
    const start = await postForm('/dummy/vendor-registration/start', new URLSearchParams({ template: 'ae_marina_blue' }));
    const id = start.headers.get('location')!.match(/vendor-registration\/([0-9a-f-]{36})\/page\/1$/)![1]!;

    await postForm(pagePath(id, 1), new URLSearchParams({
      company_name: 'Marina Blue Services LLC',
      trading_name: 'Marina Blue',
      country: 'AE',
      entity_type: 'sole_establishment',
    }));
    await postForm(pagePath(id, 2), new URLSearchParams({
      registration_number: 'AE-SRV-551902',
      tax_number: 'TRN100551902700003',
      incorporation_date: '2019-11-21',
      website: 'https://marina-blue.example.ae',
    }));
    await postForm(pagePath(id, 3), new URLSearchParams({
      address_line: 'Marina Plaza, Al Reem Island',
      city: 'Abu Dhabi',
      region: 'Abu Dhabi',
      postal_code: '00000',
    }));
    await postForm(pagePath(id, 4), new URLSearchParams({
      contact_name: 'Sara Nasser',
      contact_title: 'Account Manager',
      contact_email: 'sara@marina-blue.example.ae',
      contact_phone: '+97126770004',
      contact_mobile: '+971502020400',
    }));
    await postForm(pagePath(id, 5), new URLSearchParams());
    await postForm(pagePath(id, 6), new URLSearchParams('selected_documents=company_profile&selected_documents=vat_certificate'));

    const page7 = await get(pagePath(id, 7));
    const html = await page7.text();
    assert.match(html, /Upload-only document/);
    assert.doesNotMatch(html, /Document number \/ reference/);
    assert.match(html, /accept="\.pdf"/);

    const bad = new FormData();
    bad.set('doc_file_company_profile', file('company-profile.png', 64, 'image/png'));
    bad.set('doc_file_vat_certificate', file('vat-certificate.pdf'));
    const badRes = await postMultipart(pagePath(id, 7), bad);
    assert.equal(badRes.status, 400);
    assert.match(await badRes.text(), /upload-only documents must be PDF files/);

    const good = new FormData();
    good.set('doc_file_company_profile', file('company-profile.pdf'));
    good.set('doc_file_vat_certificate', file('vat-certificate.pdf'));
    const goodRes = await postMultipart(pagePath(id, 7), good);
    assert.equal(goodRes.status, 303);
    assert.equal(goodRes.headers.get('location'), pagePath(id, 8));
  });
});

test('page 6 bulk actions can select all and final submission refuses missing uploads', async () => {
  await withPages(async ({ base, get, postForm }) => {
    const id = await startWizard(base);

    await postForm(pagePath(id, 1), new URLSearchParams({
      company_name: 'Acme Trading LLC',
      country: 'SA',
      entity_type: 'llc',
    }));
    await postForm(pagePath(id, 2), new URLSearchParams({
      registration_number: 'CR-1234567',
      incorporation_date: '2019-04-01',
    }));
    await postForm(pagePath(id, 3), new URLSearchParams({
      address_line: '12 Harbour Road',
      city: 'Riyadh',
    }));
    await postForm(pagePath(id, 4), new URLSearchParams({
      contact_name: 'Dana Fox',
      contact_email: 'dana@acme.example',
      contact_phone: '+966500000000',
    }));
    await postForm(pagePath(id, 5), new URLSearchParams());

    const selectAll = await postForm(pagePath(id, 6), new URLSearchParams({ bulk: 'all' }));
    assert.equal(selectAll.status, 200);
    const page6Html = await selectAll.text();
    assert.match(page6Html, /checked/);
    assert.match(page6Html, /Commercial Registration/);

    const directToReview = await postForm(pagePath(id, 9), new URLSearchParams({
      declaration_name: 'Fatima Noor',
      declaration_role: 'Authorised Signatory',
      declaration_confirmed: 'yes',
    }));
    assert.equal(directToReview.status, 400);
    const reviewHtml = await directToReview.text();
    assert.match(reviewHtml, /must be uploaded before submission/);

    const redirect = await get(pagePath(id, 10));
    assert.equal(redirect.status, 303);
    assert.equal(redirect.headers.get('location'), pagePath(id, 9));
  });
});

test('multipart uploads accept files larger than the former per-file limit', async () => {
  await withPages(async ({ base, postForm, postMultipart }) => {
    const id = await startWizard(base);

    await postForm(pagePath(id, 1), new URLSearchParams({
      company_name: 'Acme Trading LLC',
      country: 'AE',
      entity_type: 'llc',
    }));
    await postForm(pagePath(id, 2), new URLSearchParams({
      registration_number: 'AE-123',
      incorporation_date: '2024-04-01',
    }));
    await postForm(pagePath(id, 3), new URLSearchParams({
      address_line: '1 Marina Plaza',
      city: 'Dubai',
    }));
    await postForm(pagePath(id, 4), new URLSearchParams({
      contact_name: 'Mona',
      contact_email: 'mona@example.com',
      contact_phone: '+971500000000',
    }));
    await postForm(pagePath(id, 5), new URLSearchParams());
    await postForm(pagePath(id, 6), new URLSearchParams('selected_documents=trade_license'));

    const large = new FormData();
    large.set('doc_file_trade_license', file('trade-license.pdf', (2 * 1024 * 1024) + 1));
    const bigRes = await postMultipart(pagePath(id, 7), large);
    assert.equal(bigRes.status, 303);
    assert.equal(bigRes.headers.get('location'), pagePath(id, 8));
  });
});

test('receipt lookups reject ids that are not UUIDs and filenames stay flattened', async () => {
  await withPages(async ({ get }) => {
    assert.equal(safeFilename('../../etc/passwd.pdf'), 'passwd.pdf');
    assert.equal(safeFilename('..\\..\\windows\\system32\\evil.pdf'), 'evil.pdf');
    assert.equal(safeFilename('...'), 'file');
    assert.equal(safeFilename('/absolute/path.pdf'), 'path.pdf');
    assert.equal(safeFilename('sp ace;rm -rf.pdf'), 'sp_ace_rm_-rf.pdf');

    for (const id of ['..%2f..%2fetc%2fpasswd', 'not-a-uuid', '%2e%2e']) {
      const res = await get(`/dummy/receipt/${id}?format=json`);
      assert.equal(res.status, 404, id);
    }
  });
});

test('the dummy pages stay off in production unless switched on', async () => {
  const db = testDb();
  const prod = createApp(db, { env: { ...ENV, NODE_ENV: 'production' } }).listen(0);
  await new Promise((r) => prod.once('listening', r));
  const base = `http://127.0.0.1:${(prod.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/dummy/vendor-registration`, { redirect: 'manual' })).status, 404);
  } finally {
    prod.close();
    db.close();
  }
});

test('Abu Dhabi login returns to the exact reviewed form and nowhere else', async () => {
  await withPages(async ({ base, get, postForm }) => {
    const path = '/dummy/vendor-registration/uae-abu-dhabi';
    const legacy = await get('/vendor-registration-form.html');
    assert.equal(legacy.status, 303);
    assert.equal(legacy.headers.get('location'), path);
    const page = await get(path);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /name="return_to" value="\/dummy\/vendor-registration\/uae-abu-dhabi"/);

    const login = await postForm('/dummy/vendor-registration/login', new URLSearchParams({
      username: 'admin',
      password: 'admin',
      return_to: path,
    }));
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), path);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const returned = await fetch(base + path, { headers: { cookie } });
    assert.equal(returned.status, 200);
    assert.match(await returned.text(), /name="q6_organizationbusinessName"/);

    for (const unsafe of ['//evil.example', 'https://evil.example', `${path}/extra`]) {
      const refused = await postForm('/dummy/vendor-registration/login', new URLSearchParams({
        username: 'admin',
        password: 'admin',
        return_to: unsafe,
      }));
      assert.equal(refused.headers.get('location'), '/dummy/vendor-registration');
    }
  });
});

/**
 * Page 7 answered `File is not defined` on the runtime the rig actually runs
 * (Node 18 has no global `File`). Uploads are appended as Blobs on purpose:
 * `new File` would throw in the test itself there, and the helpers above do not
 * carry the portal's session cookie.
 */
async function signedInWizard(base: string): Promise<{ id: string; cookie: string }> {
  const login = await fetch(`${base}/dummy/vendor-registration/login`, {
    method: 'POST',
    body: new URLSearchParams({ username: 'admin', password: 'admin' }),
    redirect: 'manual',
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const started = await fetch(`${base}/dummy/vendor-registration/start`, {
    method: 'POST',
    body: new URLSearchParams({ template: '' }),
    headers: { cookie },
    redirect: 'manual',
  });
  assert.equal(started.status, 303);
  return { id: started.headers.get('location')!.match(/vendor-registration\/([0-9a-f-]{36})\//)![1]!, cookie };
}

const pdfBlob = (type = 'application/pdf'): Blob =>
  new Blob([new Uint8Array(64).fill(65)], { type });

test('page 7 accepts an upload without depending on a global File', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    const page6 = new URLSearchParams();
    page6.append('selected_documents', 'commercial_registration');
    page6.append('selected_documents', 'company_profile');
    await fetch(base + pagePath(id, 6), { method: 'POST', body: page6, headers: { cookie }, redirect: 'manual' });

    const page7 = new FormData();
    for (const key of ['commercial_registration', 'company_profile']) {
      page7.set(`doc_number_${key}`, `${key.toUpperCase()}-001`);
      page7.set(`issue_date_${key}`, '2025-01-15');
      page7.set(`expiry_date_${key}`, '2027-01-15');
      page7.set(`issuing_authority_${key}`, 'Saudi Authority');
      page7.set(`doc_file_${key}`, pdfBlob(), `${key}.pdf`);
    }
    const res = await fetch(base + pagePath(id, 7), { method: 'POST', body: page7, headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), pagePath(id, 8));
  });
});

test('page 7 still refuses a non-PDF upload-only document', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    const page6 = new URLSearchParams();
    page6.append('selected_documents', 'company_profile');
    await fetch(base + pagePath(id, 6), { method: 'POST', body: page6, headers: { cookie }, redirect: 'manual' });

    const page7 = new FormData();
    page7.set('doc_file_company_profile', pdfBlob('image/png'), 'company-profile.png');
    const res = await fetch(base + pagePath(id, 7), { method: 'POST', body: page7, headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 400);
  });
});

/**
 * ONE FILE PER REQUEST, SO A SERVERLESS BODY LIMIT IS NEVER THE THING THAT
 * DECIDES WHETHER A REGISTRATION IS FILED.
 *
 * Pages 7 and 8 posted a whole BATCH of documents in one multipart body. On the
 * deployed rig that body exceeds the platform's request limit and is rejected
 * before any handler runs: no 400, no error list, just an error page under the
 * wizard's own URL. The per-file route below is bounded, answers with a small
 * ref, and leaves the batch POST carrying metadata only.
 */
const uploadPath = (id: string, page: number, key: string): string =>
  `${pagePath(id, page)}/upload/${key}`;

const sizedPdf = (bytes: number): Blob =>
  new Blob([new Uint8Array(bytes).fill(65)], { type: 'application/pdf' });

async function selectDocuments(base: string, id: string, cookie: string, keys: string[]): Promise<void> {
  const page6 = new URLSearchParams();
  for (const key of keys) page6.append('selected_documents', key);
  await fetch(base + pagePath(id, 6), { method: 'POST', body: page6, headers: { cookie }, redirect: 'manual' });
}

test('the per-file upload route accepts a document under the request ceiling', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    await selectDocuments(base, id, cookie, ['company_profile']);

    const body = new FormData();
    body.set('doc_file_company_profile', sizedPdf(1024), 'company-profile.pdf');
    const res = await fetch(base + uploadPath(id, 7, 'company_profile'), {
      method: 'POST', body, headers: { cookie }, redirect: 'manual',
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.key, 'company_profile');
    // A SMALL REF: the bytes stay on the portal, the answer does not carry them.
    assert.equal(json.size, 1024);
    assert.equal(json.original_name, 'company-profile.pdf');
  });
});

/** Posts one bounded chunk, exactly as the page script does. */
async function sendChunk(
  base: string,
  id: string,
  cookie: string,
  key: string,
  bytes: Uint8Array,
  offset: number,
  total: number,
  page = 7,
): Promise<Response> {
  const body = new FormData();
  body.set('offset', String(offset));
  body.set('total', String(total));
  body.set(
    `doc_file_${key}`,
    new Blob([Buffer.from(bytes)], { type: 'application/pdf' }),
    `${key}.pdf`,
  );
  return await fetch(base + uploadPath(id, page, key), {
    method: 'POST', body, headers: { cookie }, redirect: 'manual',
  });
}

/** A document far bigger than any single request may carry. */
const BIG = 3_500_000 * 2 + 11;
const CHUNK = 1_750_000;

async function sendWholeFile(
  base: string,
  id: string,
  cookie: string,
  key: string,
  bytes: Uint8Array,
  page = 7,
): Promise<Record<string, unknown>> {
  let at = 0;
  let last: Record<string, unknown> = {};
  while (at < bytes.byteLength) {
    const end = Math.min(at + CHUNK, bytes.byteLength);
    const res = await sendChunk(base, id, cookie, key, bytes.subarray(at, end), at, bytes.byteLength, page);
    assert.equal(res.status, 200, `chunk at ${at} should be accepted`);
    last = await res.json();
    at = end;
  }
  return last;
}

/**
 * NO DOCUMENT OR PACKAGE SIZE CEILING. The platform's per-request limit is a
 * transport fact and is handled as one: the document crosses it in bounded
 * chunks, and what lands is byte-for-byte what was sent.
 */
test('a single document far larger than one request uploads in chunks, unaltered', async () => {
  await withPages(async ({ base, uploadDir }) => {
    const { id, cookie } = await signedInWizard(base);
    await selectDocuments(base, id, cookie, ['company_profile']);

    const bytes = new Uint8Array(BIG);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const done = await sendWholeFile(base, id, cookie, 'company_profile', bytes);

    assert.equal(done.ok, true);
    assert.equal(done.size, BIG, 'the whole document is stored, not one chunk');
    // THE BYTES ARE THE FILE'S OWN: read back off disk and compared.
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const stored = await readFile(join(uploadDir, 'drafts', id, String(done.stored_as)));
    assert.equal(stored.byteLength, BIG);
    assert.ok(Buffer.from(bytes).equals(stored), 'stored bytes must equal sent bytes');
  });
});

test('no document is recorded until the last chunk lands', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    await selectDocuments(base, id, cookie, ['company_profile']);

    const bytes = new Uint8Array(BIG).fill(65);
    const first = await sendChunk(base, id, cookie, 'company_profile', bytes.subarray(0, CHUNK), 0, BIG);
    assert.equal(first.status, 200);
    const json = await first.json();
    // Progress, not a document: nothing to mistake for an uploaded file.
    assert.equal(json.received, CHUNK);
    assert.equal(json.total, BIG);
    assert.equal(json.stored_as, undefined);

    // And page 7 still says the document is missing.
    const page7 = new FormData();
    const res = await fetch(base + pagePath(id, 7), {
      method: 'POST', body: page7, headers: { cookie }, redirect: 'manual',
    });
    assert.equal(res.status, 400, 'a half-arrived document is not an uploaded one');
  });
});

test('a chunk that does not continue where the last one ended is refused', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    await selectDocuments(base, id, cookie, ['company_profile']);

    const bytes = new Uint8Array(BIG).fill(65);
    await sendChunk(base, id, cookie, 'company_profile', bytes.subarray(0, CHUNK), 0, BIG);
    // Skipping ahead would silently corrupt the file; it is refused instead.
    const gap = await sendChunk(base, id, cookie, 'company_profile', bytes.subarray(0, 10), CHUNK * 2, BIG);
    assert.equal(gap.status, 409);
    const json = await gap.json();
    assert.equal(json.expected_offset, CHUNK, 'and it says where to resume');

    // Resuming from the offset it named completes the document.
    const done = await sendWholeFile(base, id, cookie, 'company_profile', bytes);
    assert.equal(done.ok, true);
    assert.equal(done.size, BIG);
  });
});

/**
 * An overflowing chunk used to be APPENDED and then read as complete, because
 * the length was only compared after the write and `written < total` is false
 * when it overshoots. It is refused before a byte lands now.
 */
test('a chunk that runs past the declared total is refused, and writes nothing', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    await selectDocuments(base, id, cookie, ['company_profile']);

    // A total only slightly past the first chunk, so the overflowing second
    // chunk is still WELL WITHIN the request bound — this is about the
    // declared length, not about transport.
    const total = CHUNK + 10;
    const bytes = new Uint8Array(total).fill(65);
    await sendChunk(base, id, cookie, 'company_profile', bytes.subarray(0, CHUNK), 0, total);

    const over = await sendChunk(
      base, id, cookie, 'company_profile', new Uint8Array(CHUNK).fill(66), CHUNK, total,
    );
    assert.equal(over.status, 400);
    assert.match((await over.json()).errors.join(' '), /past the declared total/);

    // NOTHING WAS WRITTEN: the honest last chunk is still accepted at CHUNK.
    const resumed = await sendChunk(
      base, id, cookie, 'company_profile', bytes.subarray(CHUNK), CHUNK, total,
    );
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).size, total);
  });
});

test('the exact boundary chunk completes the document', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    await selectDocuments(base, id, cookie, ['company_profile']);

    const bytes = new Uint8Array(BIG).fill(65);
    let at = 0;
    while (at + CHUNK < BIG) {
      await sendChunk(base, id, cookie, 'company_profile', bytes.subarray(at, at + CHUNK), at, BIG);
      at += CHUNK;
    }
    // The last chunk lands exactly ON the total — one byte more would refuse.
    const last = await sendChunk(base, id, cookie, 'company_profile', bytes.subarray(at), at, BIG);
    assert.equal(last.status, 200);
    const json = await last.json();
    assert.equal(json.ok, true);
    assert.equal(json.size, BIG, 'exactly the declared length, no more');
  });
});

/** The first chunk decides what the document is; a later one may not restate it. */
test('a later chunk cannot rename, retype or re-length the document', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    await selectDocuments(base, id, cookie, ['company_profile']);
    const bytes = new Uint8Array(BIG).fill(65);

    const send = async (over: { name?: string; type?: string; total?: number }) => {
      const body = new FormData();
      body.set('offset', String(CHUNK));
      body.set('total', String(over.total ?? BIG));
      body.set(
        'doc_file_company_profile',
        new Blob([Buffer.from(bytes.subarray(CHUNK, CHUNK * 2))], { type: over.type ?? 'application/pdf' }),
        over.name ?? 'company_profile.pdf',
      );
      return await fetch(base + uploadPath(id, 7, 'company_profile'), {
        method: 'POST', body, headers: { cookie }, redirect: 'manual',
      });
    };

    await sendChunk(base, id, cookie, 'company_profile', bytes.subarray(0, CHUNK), 0, BIG);
    for (const [what, over] of [
      ['a different name', { name: 'something-else.pdf' }],
      ['a different media type', { type: 'application/octet-stream' }],
      ['a different declared total', { total: BIG + 1 }],
    ] as const) {
      const res = await send(over);
      assert.equal(res.status, 409, `${what} must be refused`);
      assert.match((await res.json()).errors.join(' '), /does not match the document it continues/);
    }

    // The honest continuation still works afterwards.
    const ok = await send({});
    assert.equal(ok.status, 200);
  });
});

test('a package far larger than one request reaches page 9', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    const keys = ['commercial_registration', 'company_profile'];
    await selectDocuments(base, id, cookie, keys);

    // Two documents, each already over the old per-request ceiling.
    for (const [index, key] of keys.entries()) {
      const page = index === 0 ? 7 : 8;
      const done = await sendWholeFile(base, id, cookie, key, new Uint8Array(BIG).fill(66), page);
      assert.equal(done.ok, true, `${key} should upload whole`);
      assert.equal(done.size, BIG);
    }

    // The page POSTs carry metadata only, and the wizard walks on.
    for (const [index, key] of keys.entries()) {
      const page = index === 0 ? 7 : 8;
      const form = new FormData();
      form.set(`doc_number_${key}`, `${key.toUpperCase()}-001`);
      form.set(`issue_date_${key}`, '2025-01-15');
      form.set(`expiry_date_${key}`, '2027-01-15');
      form.set(`issuing_authority_${key}`, 'Authority');
      const res = await fetch(base + pagePath(id, page), {
        method: 'POST', body: form, headers: { cookie }, redirect: 'manual',
      });
      assert.equal(res.status, 303, `page ${page} should accept metadata alone`);
      assert.equal(res.headers.get('location'), pagePath(id, page + 1));
    }
  });
});

test('the per-file upload route refuses a batch smuggled into one request', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    await selectDocuments(base, id, cookie, ['commercial_registration', 'company_profile']);

    const body = new FormData();
    body.set('doc_file_commercial_registration', sizedPdf(64), 'cr.pdf');
    body.set('doc_file_company_profile', sizedPdf(64), 'profile.pdf');
    const res = await fetch(base + uploadPath(id, 7, 'commercial_registration'), {
      method: 'POST', body, headers: { cookie }, redirect: 'manual',
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).errors.join(' '), /exactly one file per request/);
  });
});

test('a multi-document registration reaches page 9 with no bytes in any page POST', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    const keys = ['commercial_registration', 'company_profile'];
    await selectDocuments(base, id, cookie, keys);

    // Each file on its own, exactly as the page's script does it.
    for (const [index, key] of keys.entries()) {
      const page = index === 0 ? 7 : 8;
      const body = new FormData();
      body.set(`doc_file_${key}`, sizedPdf(2_000_000), `${key}.pdf`);
      const uploaded = await fetch(base + uploadPath(id, page, key), {
        method: 'POST', body, headers: { cookie }, redirect: 'manual',
      });
      assert.equal(uploaded.status, 200, `${key} should upload on its own`);
    }

    // The page POSTs now carry METADATA ONLY — no `doc_file_*` part at all,
    // which is the whole point: 4 MB of documents, and no request near the
    // platform's body limit.
    for (const [index, key] of keys.entries()) {
      const page = index === 0 ? 7 : 8;
      const form = new FormData();
      form.set(`doc_number_${key}`, `${key.toUpperCase()}-001`);
      form.set(`issue_date_${key}`, '2025-01-15');
      form.set(`expiry_date_${key}`, '2027-01-15');
      form.set(`issuing_authority_${key}`, 'Authority');
      const res = await fetch(base + pagePath(id, page), {
        method: 'POST', body: form, headers: { cookie }, redirect: 'manual',
      });
      assert.equal(res.status, 303, `page ${page} should accept metadata alone`);
      assert.equal(res.headers.get('location'), pagePath(id, page + 1));
    }
  });
});

/**
 * The submit must WAIT for the uploads it started.
 *
 * The extension dispatches `change` and can click Save in the same tick. Until
 * an upload resolves the input still has its name, so that Save posts the old
 * oversized batch — or navigates while the draft is still being written. This
 * runs the script the page actually ships, in a stub DOM, and drives exactly
 * that race.
 */
function runUploadScript(html: string, options: { settle: (ok: boolean) => void }[]) {
  const script = html.match(/<script>([\s\S]*?d14-upload-status[\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'page 7 should ship the per-file upload script');

  type El = {
    tagName: string;
    name?: string;
    id?: string;
    className?: string;
    textContent?: string;
    files?: unknown[];
    attributes: Record<string, string>;
    listeners: Record<string, ((event: unknown) => void)[]>;
    addEventListener(type: string, fn: (event: unknown) => void): void;
    setAttribute(key: string, value: string): void;
    removeAttribute(key: string): void;
    getAttribute(key: string): string | null;
    appendChild(child: El): El;
    parentNode?: El;
    submit?: () => void;
  };
  /** Every node the script appended, so its status element can be read back. */
  const appended: El[] = [];
  const element = (tagName: string, extra: Partial<El> = {}): El => {
    const el: El = {
      tagName,
      attributes: {},
      listeners: {},
      addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
      setAttribute(key, value) { el.attributes[key] = value; },
      removeAttribute(key) { delete el.attributes[key]; if (key === 'name') delete el.name; },
      getAttribute(key) { return el.attributes[key] ?? null; },
      appendChild(child) { child.parentNode = el; appended.push(child); return child; },
      ...extra,
    };
    return el;
  };

  let submitted = 0;
  const form = element('FORM', { submit: () => { submitted += 1; } });
  const inputs = ['commercial_registration', 'company_profile'].map((key) =>
    element('INPUT', {
      name: `doc_file_${key}`,
      // A file small enough to be ONE chunk, so these tests stay about the
      // queue and the retry rather than about chunking.
      files: [{ name: `${key}.pdf`, size: 4, slice: () => ({}) }],
      parentNode: form,
    }),
  );

  /** Each fetch hands back a promise the test resolves when it chooses. */
  const started: { settle: (ok: boolean) => void }[] = [];
  const fetchStub = () =>
    new Promise((resolve) => {
      started.push({
        // `stored_as` is what tells the script the LAST chunk landed; without
        // it the answer means "more to come".
        settle: (ok: boolean) =>
          resolve({
            json: async () =>
              ok
                ? { ok: true, stored_as: 'x-0-x.pdf', original_name: 'x.pdf', size: 4 }
                : { ok: false, errors: ['refused'] },
          }),
      });
    });

  const document_ = {
    querySelector: (selector: string) => (selector.startsWith('form') ? form : null),
    querySelectorAll: () => inputs,
    createElement: (tag: string) => element(tag.toUpperCase()),
  };

  new Function('document', 'fetch', 'FormData', 'Promise', 'encodeURIComponent', script!)(
    document_, fetchStub, class { append() {} }, Promise, encodeURIComponent,
  );

  options.push(...started);
  return {
    change: (index: number) => inputs[index]!.listeners.change!.forEach((fn) => fn({})),
    submit: () => {
      let prevented = 0;
      form.listeners.submit!.forEach((fn) => fn({ preventDefault: () => { prevented += 1; } }));
      return prevented;
    },
    started,
    submitted: () => submitted,
    /** The status node the script appends, by its own state attribute. */
    uploadState: () => {
      const node = (form as unknown as { children?: El[] });
      void node;
      return statusNode()?.getAttribute('data-d14-upload-state') ?? null;
    },
    statusNode,
    inputs,
  };

  function statusNode(): El | undefined {
    return appended.find((child) => child.id === 'd14-upload-status');
  }
}

/** Lets the queued promises run; a few turns is enough for one hop. */
const settleQueue = () => new Promise((resolve) => setTimeout(resolve, 10));

test('an immediate submit waits for the upload it started, then posts', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    await selectDocuments(base, id, cookie, ['commercial_registration', 'company_profile']);
    const html = await (await fetch(base + pagePath(id, 7), { headers: { cookie } })).text();

    const started: { settle: (ok: boolean) => void }[] = [];
    const page = runUploadScript(html, started);

    // The race: change and submit in the same tick, exactly as the extension does.
    page.change(0);
    const prevented = page.submit();
    assert.equal(prevented, 1, 'the submit must be held');
    assert.equal(page.submitted(), 0, 'nothing may post while an upload is in flight');
    // The input still has its name at this moment — which is why posting now
    // would carry the bytes.
    assert.equal(page.inputs[0]!.name, 'doc_file_commercial_registration');

    // The request is queued, so it leaves on a later turn.
    await settleQueue();
    page.started[0]!.settle(true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(page.submitted(), 1, 'the held submit runs once the upload lands');
    assert.equal(page.inputs[0]!.getAttribute('data-d14-uploaded'), 'true');
    assert.equal(page.inputs[0]!.name, undefined, 'the name is dropped so no bytes are posted');
  });
});

test('a failed upload blocks the submit entirely — no POST, no navigation', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    await selectDocuments(base, id, cookie, ['commercial_registration', 'company_profile']);
    const html = await (await fetch(base + pagePath(id, 7), { headers: { cookie } })).text();

    const page = runUploadScript(html, []);
    page.change(0);
    page.submit();
    await settleQueue();
    page.started[0]!.settle(false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(page.submitted(), 0, 'a failed upload must not submit or navigate');
    // A second attempt is refused too: the failure is sticky until retried.
    page.submit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(page.submitted(), 0);
  });
});

/**
 * Every request reads and rewrites the same draft JSON, so two in flight can
 * each save one document and the later write silently drops the earlier one.
 * The extension fires the changes fast enough to make that the normal case.
 */
test('two file changes in one tick upload one at a time, and the submit waits for both', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    await selectDocuments(base, id, cookie, ['commercial_registration', 'company_profile']);
    const html = await (await fetch(base + pagePath(id, 7), { headers: { cookie } })).text();

    const page = runUploadScript(html, []);
    page.change(0);
    page.change(1);
    const prevented = page.submit();
    await settleQueue();

    assert.equal(prevented, 1, 'the submit is held for the whole queue');
    // THE SERIALISATION: the second request has not been made at all yet.
    assert.equal(page.started.length, 1, 'only the first upload may be in flight');
    assert.equal(page.submitted(), 0);

    page.started[0]!.settle(true);
    await settleQueue();
    // Only now does the second one start.
    assert.equal(page.started.length, 2, 'the second upload starts after the first resolves');
    assert.equal(page.submitted(), 0, 'the submit still waits for the second');

    page.started[1]!.settle(true);
    await settleQueue();
    assert.equal(page.submitted(), 1, 'one submit, once the whole queue has landed');
    assert.equal(page.uploadState(), 'ready');
  });
});

test('a failed upload is retryable: retry succeeds, then exactly one submit', async () => {
  await withPages(async ({ base }) => {
    const { id, cookie } = await signedInWizard(base);
    await selectDocuments(base, id, cookie, ['commercial_registration', 'company_profile']);
    const html = await (await fetch(base + pagePath(id, 7), { headers: { cookie } })).text();

    const page = runUploadScript(html, []);
    page.change(0);
    page.submit();
    await settleQueue();
    page.started[0]!.settle(false);
    await settleQueue();

    assert.equal(page.submitted(), 0, 'a failure blocks the submit');
    assert.equal(page.uploadState(), 'failed');

    // The retry: the same key, chosen again. Its failure is replaced only by
    // this success — not cleared just because a new change arrived.
    page.change(0);
    const prevented = page.submit();
    assert.equal(prevented, 1, 'held again while the retry is in flight');
    await settleQueue();
    assert.equal(page.submitted(), 0, 'still nothing posted');

    page.started[1]!.settle(true);
    await settleQueue();
    assert.equal(page.submitted(), 1, 'exactly one submit once the retry lands');
    assert.equal(page.uploadState(), 'ready');
  });
});

test('the Sedar Global form takes extra documents and posts names only, at any size', async () => {
  await withPages(async ({ base, postForm }) => {
    const login = await postForm(
      '/dummy/vendor-registration/login',
      new URLSearchParams({ username: 'admin', password: 'admin', return_to: '/dummy/vendor-registration/abudhabi-sedar-global' }),
    );
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const html = await (await fetch(`${base}/dummy/vendor-registration/abudhabi-sedar-global`, { headers: { cookie } })).text();

    // The optional extra-documents input: any number, any format, any size.
    assert.match(html, /id="additionalDocuments"[^>]*\bmultiple\b/);
    assert.doesNotMatch(html, /id="additionalDocuments"[^>]*\brequired\b/);
    // Nothing on the page caps a file's size.
    assert.doesNotMatch(html, /maxsize|max-size|data-maxfilesize/i);

    // The submit hook strips every file input's name and reports one hidden
    // value per selected file, so a multi-file choice loses no document and
    // the request carries no bytes.
    const start = html.lastIndexOf('<script>') + '<script>'.length;
    const script = html.slice(start, html.indexOf('</script>', start));
    const form = { appended: [] as { name: string; value: string }[] };
    const input = {
      name: 'additionalDocuments',
      type: 'file',
      files: [{ name: 'a.pdf' }, { name: 'b.png' }],
      removeAttribute(): void { this.name = ''; },
    };
    const document = {
      createElement: () => ({ type: '', name: '', value: '' }),
      addEventListener: (_: string, fn: (e: unknown) => void) => {
        fn({
          defaultPrevented: false,
          target: {
            querySelectorAll: () => [input],
            appendChild: (el: { name: string; value: string }) => form.appended.push(el),
          },
        });
      },
    };
    new Function('document', script)(document);

    assert.deepEqual(form.appended.map((el) => [el.name, el.value]), [
      ['additionalDocuments_name', 'a.pdf'],
      ['additionalDocuments_name', 'b.png'],
    ]);
    assert.equal(input.name, '', 'the file input no longer posts its bytes');
  });
});
