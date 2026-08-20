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
