import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/api.js';
import { MAX_FILE_BYTES, MAX_SUPPORTING_FILES, safeFilename } from '../src/dummy-upload.js';
import { ENV, testDb } from './support.js';

interface Ctx {
  base: string;
  uploadDir: string;
  post: (path: string, form: FormData, json?: boolean) => Promise<Response>;
  get: (path: string) => Promise<Response>;
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
      get: (path) => fetch(base + path),
      post: (path, form, json = true) =>
        fetch(base + path, {
          method: 'POST',
          body: form,
          headers: json ? { accept: 'application/json' } : {},
          redirect: 'manual',
        }),
    });
  } finally {
    server.close();
    db.close();
    rmSync(uploadDir, { recursive: true, force: true });
  }
}

const file = (name: string, bytes = 32, type = 'application/pdf'): File =>
  new File([new Uint8Array(bytes).fill(65)], name, { type });

/** A registration form that passes every validation rule. */
function validForm(): FormData {
  const f = new FormData();
  const fields: Record<string, string> = {
    company_name: 'Acme Trading LLC',
    trading_name: 'Acme',
    registration_number: 'CR-1234567',
    tax_number: 'VAT-998877',
    incorporation_date: '2019-04-01',
    website: 'https://acme.example',
    address_line: '12 Harbour Road',
    city: 'Rotterdam',
    contact_name: 'Dana Fox',
    contact_email: 'dana@acme.example',
    contact_phone: '+31 10 000 0000',
    notes: 'test upload',
    country: 'NL',
    entity_type: 'llc',
    terms: 'yes',
  };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  f.append('services', 'it_services');
  f.append('services', 'logistics');
  f.set('trade_licence', file('trade-licence.pdf'));
  f.set('tax_certificate', file('vat.pdf'));
  f.set('bank_letter', file('bank.pdf'));
  return f;
}

test('the registration page exposes every labelled field and control', async () => {
  await withPages(async ({ get }) => {
    const res = await get('/dummy/vendor-registration');
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /enctype="multipart\/form-data"/);
    for (const name of [
      'company_name',
      'registration_number',
      'incorporation_date',
      'address_line',
      'contact_name',
      'contact_email',
      'contact_phone',
    ]) {
      assert.match(html, new RegExp(`name="${name}"`), `missing text field ${name}`);
    }
    assert.match(html, /<select id="country" name="country">/);
    assert.match(html, /type="radio" id="entity_type_llc"/);
    assert.match(html, /type="checkbox" id="services_logistics"/);
    assert.match(html, /type="checkbox" id="terms"/);
    assert.match(html, /<textarea id="notes"/);

    for (const name of ['trade_licence', 'tax_certificate', 'bank_letter', 'company_profile', 'certifications']) {
      assert.match(html, new RegExp(`id="${name}" name="${name}" type="file"`), `missing file input ${name}`);
    }
    assert.match(html, /name="supporting_documents" type="file" multiple/);
  });
});

test('a complete submission stores every file and reports success', async () => {
  await withPages(async ({ post, get, uploadDir }) => {
    const form = validForm();
    form.set('company_profile', file('profile.docx'));
    form.set('certifications', file('iso-9001.png', 64, 'image/png'));
    form.append('supporting_documents', file('extra-1.pdf'));
    form.append('supporting_documents', file('extra-2.txt', 12, 'text/plain'));

    const res = await post('/dummy/vendor-registration', form);
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      ok: boolean;
      id: string;
      file_count: number;
      files: { field: string; original_name: string; stored_as: string; size: number }[];
      fields: Record<string, string | string[]>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.file_count, 7);
    assert.deepEqual(body.fields.services, ['it_services', 'logistics']);
    assert.equal(body.fields.company_name, 'Acme Trading LLC');
    assert.equal(body.files.filter((f) => f.field === 'supporting_documents').length, 2);

    // files really landed on disk, in the temporary upload dir
    const onDisk = readdirSync(join(uploadDir, body.id));
    assert.equal(onDisk.length, 8); // 7 uploads + receipt.json
    for (const f of body.files) assert.ok(onDisk.includes(f.stored_as), `${f.stored_as} not written`);

    const page = await get(`/dummy/receipt/${body.id}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /data-result="success"/);
    assert.match(html, /extra-2\.txt/);

    const json = (await (await get(`/dummy/receipt/${body.id}?format=json`)).json()) as { file_count: number };
    assert.equal(json.file_count, 7);
  });
});

test('a browser submission redirects to a result page instead of JSON', async () => {
  await withPages(async ({ post, base }) => {
    const res = await post('/dummy/vendor-registration', validForm(), false);
    assert.equal(res.status, 303);
    const location = res.headers.get('location')!;
    assert.match(location, /^\/dummy\/receipt\/[0-9a-f-]{36}$/);
    const html = await (await fetch(base + location)).text();
    assert.match(html, /data-result="success"/);
    assert.match(html, /SUCCESS/);
  });
});

test('missing required fields and files are reported, and nothing is stored', async () => {
  await withPages(async ({ post, uploadDir }) => {
    const form = new FormData();
    form.set('company_name', 'Acme Trading LLC');
    form.set('contact_email', 'not-an-email');

    const res = await post('/dummy/vendor-registration', form);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; errors: string[] };
    assert.equal(body.ok, false);
    const joined = body.errors.join('\n');
    for (const expected of [
      'Commercial registration number is required',
      'Primary contact name is required',
      'Trade licence is required',
      'Tax / VAT certificate is required',
      'Bank letter is required',
      'Country of registration is required',
      'Entity type is required',
      'declaration must be confirmed',
      'Contact email is not a valid address',
    ]) {
      assert.ok(joined.includes(expected), `missing error: ${expected}\ngot:\n${joined}`);
    }
    assert.ok(!joined.includes('Registered company name is required')); // that one was supplied
    assert.deepEqual(readdirSync(uploadDir), []);
  });
});

test('an invalid submission re-renders the form as an error page for browsers', async () => {
  await withPages(async ({ post }) => {
    const res = await post('/dummy/vendor-registration', new FormData(), false);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /data-result="error"/);
    assert.match(html, /id="errors"/);
  });
});

test('file type, empty files, size and count limits are enforced', async () => {
  await withPages(async ({ post }) => {
    const bad = validForm();
    bad.set('trade_licence', file('licence.exe'));
    const typeErr = (await (await post('/dummy/vendor-registration', bad)).json()) as { errors: string[] };
    assert.match(typeErr.errors.join('\n'), /file type "exe" is not accepted/);

    const empty = validForm();
    empty.set('bank_letter', file('bank.pdf', 0));
    const emptyErr = (await (await post('/dummy/vendor-registration', empty)).json()) as { errors: string[] };
    assert.match(emptyErr.errors.join('\n'), /file is empty/);

    const big = validForm();
    big.set('tax_certificate', file('huge.pdf', MAX_FILE_BYTES + 1));
    const bigRes = await post('/dummy/vendor-registration', big);
    assert.equal(bigRes.status, 400);
    assert.match(((await bigRes.json()) as { errors: string[] }).errors.join('\n'), /over the \d+ byte limit/);

    const many = validForm();
    for (let i = 0; i <= MAX_SUPPORTING_FILES; i++) many.append('supporting_documents', file(`s-${i}.pdf`));
    const manyErr = (await (await post('/dummy/vendor-registration', many)).json()) as { errors: string[] };
    assert.match(manyErr.errors.join('\n'), /maximum is 5/);
  });
});

test('a body over the total limit is refused with 413', async () => {
  await withPages(async ({ post }) => {
    const form = validForm();
    for (let i = 0; i < 5; i++) form.append('supporting_documents', file(`s-${i}.pdf`, 2 * 1024 * 1024));
    const res = await post('/dummy/vendor-registration', form);
    assert.equal(res.status, 413);
  });
});

test('a non-multipart POST is refused instead of crashing', async () => {
  await withPages(async ({ base }) => {
    const res = await fetch(`${base}/dummy/vendor-registration`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ company_name: 'Acme' }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { errors: string[] }).errors.join(), /multipart/);
  });
});

test('traversal and odd filenames are flattened before they touch the filesystem', async () => {
  assert.equal(safeFilename('../../etc/passwd.pdf'), 'passwd.pdf');
  assert.equal(safeFilename('..\\..\\windows\\system32\\evil.pdf'), 'evil.pdf');
  assert.equal(safeFilename('...'), 'file');
  assert.equal(safeFilename('/absolute/path.pdf'), 'path.pdf');
  assert.equal(safeFilename('sp ace;rm -rf.pdf'), 'sp_ace_rm_-rf.pdf');

  await withPages(async ({ post, uploadDir }) => {
    const form = validForm();
    form.set('trade_licence', file('../../../escape.pdf'));
    form.append('supporting_documents', file('a/b/../c.txt', 12, 'text/plain'));

    const body = (await (await post('/dummy/vendor-registration', form)).json()) as {
      id: string;
      files: { stored_as: string }[];
    };
    for (const f of body.files) {
      assert.ok(!f.stored_as.includes('..'), f.stored_as);
      assert.ok(!f.stored_as.includes('/'), f.stored_as);
    }
    // every written file is inside the submission directory, and nothing escaped upward
    assert.deepEqual(readdirSync(uploadDir), [body.id]);
    assert.ok(readdirSync(join(uploadDir, body.id)).some((n) => n.endsWith('escape.pdf')));
  });
});

test('receipt lookups reject ids that are not UUIDs', async () => {
  await withPages(async ({ get }) => {
    for (const id of ['..%2f..%2fetc%2fpasswd', 'not-a-uuid', '%2e%2e']) {
      const res = await get(`/dummy/receipt/${id}?format=json`);
      assert.equal(res.status, 404, id);
    }
  });
});

test('step 2 appends more documents to an existing registration', async () => {
  await withPages(async ({ post, get }) => {
    const created = (await (await post('/dummy/vendor-registration', validForm())).json()) as { id: string };

    const page = await get(`/dummy/receipt/${created.id}/documents`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /name="additional_documents" type="file" multiple/);
    assert.match(html, /name="category"/);

    const step2 = new FormData();
    step2.set('category', 'clarification');
    step2.append('additional_documents', file('clarify-1.pdf'));
    step2.append('additional_documents', file('clarify-2.pdf'));
    const res = await post(`/dummy/receipt/${created.id}/documents`, step2);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { file_count: number; files: { field: string }[] };
    assert.equal(body.file_count, 5); // 3 required + 2 additional
    assert.equal(body.files.filter((f) => f.field === 'additional_clarification').length, 2);

    const missing = new FormData();
    missing.set('category', 'nope');
    const bad = await post(`/dummy/receipt/${created.id}/documents`, missing);
    assert.equal(bad.status, 400);
    const errors = ((await bad.json()) as { errors: string[] }).errors.join('\n');
    assert.match(errors, /Document category is required/);
    assert.match(errors, /At least one document is required/);

    const unknown = await post(`/dummy/receipt/${'0'.repeat(8)}-0000-0000-0000-000000000000/documents`, step2);
    assert.equal(unknown.status, 404);
  });
});

test('the dummy pages stay off in production unless switched on', async () => {
  const db = testDb();
  const prod = createApp(db, { env: { ...ENV, NODE_ENV: 'production' } }).listen(0);
  await new Promise((r) => prod.once('listening', r));
  const base = `http://127.0.0.1:${(prod.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/dummy/vendor-registration`)).status, 404);
  } finally {
    prod.close();
    db.close();
  }
});
