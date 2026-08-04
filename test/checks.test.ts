import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDocument,
  buildPackage,
  createRegistration,
  fingerprintOf,
  resolveRequirements,
  runChecks,
  type Finding,
  type Manifest,
} from '../src/core.js';
import { cleanRegistrationId, messyRegistrationId, testDb, thrown, userByRole } from './support.js';

const codes = (f: Finding[]): string[] => f.map((x) => x.code).sort();

test('requirements resolve per jurisdiction with a * fallback', () => {
  const db = testDb();
  const nl = resolveRequirements(db, 'BUSINESS_LICENSE', 'NL').map((r) => r.doc_type);
  const gb = resolveRequirements(db, 'BUSINESS_LICENSE', 'GB').map((r) => r.doc_type);
  assert.ok(nl.includes('UBO_DECLARATION'), 'NL adds the UBO declaration');
  assert.ok(!gb.includes('UBO_DECLARATION'), 'GB does not');
  assert.deepEqual(gb, ['CERTIFICATE_OF_INCORPORATION', 'PROOF_OF_ADDRESS', 'TAX_ID_CERTIFICATE']);
});

test('a complete register produces no findings and packages cleanly', () => {
  const db = testDb();
  const preparer = userByRole(db, 'preparer');
  const id = cleanRegistrationId(db);
  assert.deepEqual(runChecks(db, id), []);
  const pkg = buildPackage(db, preparer, id);
  assert.equal(pkg.status, 'READY');
  assert.equal(pkg.version, 1);
  assert.match(pkg.fingerprint, /^[0-9a-f]{64}$/);
  const manifest = JSON.parse(pkg.manifest_json) as Manifest;
  assert.equal(manifest.documents.length, 4);
  assert.equal(fingerprintOf(manifest), pkg.fingerprint, 'fingerprint reproduces from the manifest');
});

test('expiry and entity mismatch block packaging', () => {
  const db = testDb();
  const id = messyRegistrationId(db);
  const found = codes(runChecks(db, id));
  assert.ok(found.includes('EXPIRED_DOCUMENT'), found.join());
  assert.ok(found.includes('ENTITY_MISMATCH'), found.join());

  const err = thrown(() => buildPackage(db, userByRole(db, 'preparer'), id));
  assert.equal(err.code, 'PACKAGE_CHECKS_FAILED');
  assert.ok((err.details as Finding[]).every((f) => f.severity === 'BLOCKING'));
});

test('missing mandatory documents are reported and block packaging', () => {
  const db = testDb();
  const preparer = userByRole(db, 'preparer');
  const reg = createRegistration(db, preparer, {
    entity_name: 'Fresh Co',
    entity_id: 'X1',
    jurisdiction: 'NL',
    reg_type: 'BUSINESS_LICENSE',
  });
  const findings = runChecks(db, reg.id);
  assert.equal(findings.length, 4);
  assert.ok(findings.every((f) => f.code === 'MISSING_DOCUMENT' && f.severity === 'BLOCKING'));

  addDocument(db, preparer, reg.id, {
    doc_type: 'CERTIFICATE_OF_INCORPORATION',
    filename: 'coi.txt',
    content: 'COI',
    entity_name: 'Fresh Co',
    entity_id: 'X1',
  });
  assert.equal(runChecks(db, reg.id).length, 3);
  assert.equal(thrown(() => buildPackage(db, preparer, reg.id)).code, 'PACKAGE_CHECKS_FAILED');
});

test('optional requirements are warnings, not blockers', () => {
  const db = testDb();
  const preparer = userByRole(db, 'preparer');
  const reg = createRegistration(db, preparer, {
    entity_name: 'Export Co',
    entity_id: 'E9',
    jurisdiction: 'NL',
    reg_type: 'EXPORT_PERMIT',
  });
  for (const [doc_type, content] of [['CERTIFICATE_OF_INCORPORATION', 'coi'], ['GOODS_SCHEDULE', 'hs codes']] as const) {
    addDocument(db, preparer, reg.id, {
      doc_type,
      filename: `${doc_type}.txt`,
      content,
      entity_name: 'Export Co',
      entity_id: 'E9',
    });
  }
  const findings = runChecks(db, reg.id);
  assert.deepEqual(findings.map((f) => [f.code, f.severity]), [['MISSING_DOCUMENT', 'WARNING']]);
  assert.equal(buildPackage(db, preparer, reg.id).status, 'READY', 'warnings do not block');
});

test('two documents with identical content are a duplicate', () => {
  const db = testDb();
  const preparer = userByRole(db, 'preparer');
  const id = cleanRegistrationId(db);
  addDocument(db, preparer, id, {
    doc_type: 'PROOF_OF_ADDRESS',
    filename: 'copy-of-ubo.txt',
    content: 'UBO REGISTER EXTRACT — 2 beneficial owners recorded', // same bytes as the UBO document
    entity_name: 'Noor Logistics B.V.',
    entity_id: 'NL857123456B01',
  });
  assert.ok(codes(runChecks(db, id)).includes('DUPLICATE_CONTENT'));
  assert.equal(thrown(() => buildPackage(db, preparer, id)).code, 'PACKAGE_CHECKS_FAILED');
});

test('the register keeps exactly one active version per document type', () => {
  const db = testDb();
  const preparer = userByRole(db, 'preparer');
  const id = cleanRegistrationId(db);
  const v2 = addDocument(db, preparer, id, {
    doc_type: 'PROOF_OF_ADDRESS',
    filename: 'address-new.txt',
    content: 'UTILITY STATEMENT — new address',
    entity_name: 'Noor Logistics B.V.',
    entity_id: 'NL857123456B01',
  });
  assert.equal(v2.version, 2);
  const active = db
    .prepare("SELECT * FROM documents WHERE registration_id = ? AND doc_type = 'PROOF_OF_ADDRESS' AND status = 'ACTIVE'")
    .all(id);
  assert.equal(active.length, 1);
});

test('a package fingerprint changes when any document changes', () => {
  const db = testDb();
  const preparer = userByRole(db, 'preparer');
  const id = cleanRegistrationId(db);
  const first = buildPackage(db, preparer, id);
  addDocument(db, preparer, id, {
    doc_type: 'PROOF_OF_ADDRESS',
    filename: 'address.txt',
    content: 'UTILITY STATEMENT — Havenweg 12, Rotterdam (reissued)',
    entity_name: 'Noor Logistics B.V.',
    entity_id: 'NL857123456B01',
  });
  const second = buildPackage(db, preparer, id);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(second.version, 2);
});
