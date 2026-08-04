import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppError,
  addDocument,
  buildPackage,
  checkApprovalBinding,
  createApproval,
  createRegistration,
  revokeApproval,
  updateRegistration,
} from '../src/core.js';
import { ALLOWLIST, cleanRegistrationId, testDb, userByRole } from './support.js';

const DEST = 'https://portal.registry.example/submit';
const ACTION = 'SUBMIT_NEW_REGISTRATION';

function approved(db = testDb()) {
  const preparer = userByRole(db, 'preparer');
  const approver = userByRole(db, 'approver');
  const registrationId = cleanRegistrationId(db);
  const pkg = buildPackage(db, preparer, registrationId);
  const approval = createApproval(db, approver, { package_id: pkg.id, destination_url: DEST, action: ACTION }, ALLOWLIST);
  return { db, preparer, approver, registrationId, pkg, approval };
}

const intent = (o: { registrationId: string; pkgId: string; dest?: string; action?: string }) => ({
  registration_id: o.registrationId,
  package_id: o.pkgId,
  destination_url: o.dest ?? DEST,
  action: o.action ?? ACTION,
});

test('an approval authorises exactly the tuple it was granted for', () => {
  const { db, registrationId, pkg, approval } = approved();
  const ok = checkApprovalBinding(db, approval.id, intent({ registrationId, pkgId: pkg.id }), ALLOWLIST);
  assert.equal(ok.ok, true);
  assert.equal(approval.fingerprint, pkg.fingerprint);
});

test('the destination is compared after normalisation, not textually', () => {
  const { db, registrationId, pkg, approval } = approved();
  const ok = checkApprovalBinding(
    db,
    approval.id,
    intent({ registrationId, pkgId: pkg.id, dest: 'https://PORTAL.registry.example:443/submit' }),
    ALLOWLIST,
  );
  assert.equal(ok.ok, true);
});

test('a different destination is refused even if it is allowlisted', () => {
  const { db, registrationId, pkg, approval } = approved();
  const res = checkApprovalBinding(
    db,
    approval.id,
    intent({ registrationId, pkgId: pkg.id, dest: 'https://filing.gov.example/submit' }),
    ALLOWLIST,
  );
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.code, 'APPROVAL_DESTINATION_MISMATCH');
});

test('a different action is refused', () => {
  const { db, registrationId, pkg, approval } = approved();
  const res = checkApprovalBinding(db, approval.id, intent({ registrationId, pkgId: pkg.id, action: 'WITHDRAW' }), ALLOWLIST);
  assert.equal(res.ok === false && res.code, 'APPROVAL_ACTION_MISMATCH');
});

test('a different package or registration is refused', () => {
  const { db, preparer, registrationId, pkg, approval } = approved();
  const other = buildPackage(db, preparer, registrationId); // a second, unapproved package v2
  assert.notEqual(other.id, pkg.id);
  const res = checkApprovalBinding(db, approval.id, intent({ registrationId, pkgId: other.id }), ALLOWLIST);
  assert.equal(res.ok === false && res.code, 'APPROVAL_PACKAGE_MISMATCH');

  const elsewhere = createRegistration(db, preparer, {
    entity_name: 'Other Co', entity_id: 'O1', jurisdiction: 'NL', reg_type: 'BUSINESS_LICENSE',
  });
  const res2 = checkApprovalBinding(db, approval.id, intent({ registrationId: elsewhere.id, pkgId: pkg.id }), ALLOWLIST);
  assert.equal(res2.ok === false && res2.code, 'APPROVAL_REGISTRATION_MISMATCH');
});

test('registering a document after approval invalidates package and approval', () => {
  const { db, preparer, registrationId, pkg, approval } = approved();
  addDocument(db, preparer, registrationId, {
    doc_type: 'TAX_ID_CERTIFICATE',
    filename: 'vat-v2.txt',
    content: 'VAT REGISTRATION — reissued',
    entity_name: 'Noor Logistics B.V.',
    entity_id: 'NL857123456B01',
  });
  const res = checkApprovalBinding(db, approval.id, intent({ registrationId, pkgId: pkg.id }), ALLOWLIST);
  assert.equal(res.ok === false && res.code, 'APPROVAL_NOT_VALID');
  const row = db.prepare('SELECT status, invalidated_reason FROM packages WHERE id = ?').get(pkg.id) as {
    status: string; invalidated_reason: string;
  };
  assert.equal(row.status, 'INVALIDATED');
  assert.equal(row.invalidated_reason, 'DOCUMENT_REGISTER_CHANGED');
});

test('amending the registration invalidates package and approval', () => {
  const { db, preparer, registrationId, pkg, approval } = approved();
  updateRegistration(db, preparer, registrationId, { entity_name: 'Noor Logistics Holding B.V.' });
  const res = checkApprovalBinding(db, approval.id, intent({ registrationId, pkgId: pkg.id }), ALLOWLIST);
  assert.equal(res.ok === false && res.code, 'APPROVAL_NOT_VALID');
  assert.equal(
    (db.prepare('SELECT invalidated_reason AS r FROM approvals WHERE id = ?').get(approval.id) as { r: string }).r,
    'REGISTRATION_CHANGED',
  );
});

test('a revoked approval no longer authorises anything', () => {
  const { db, approver, registrationId, pkg, approval } = approved();
  revokeApproval(db, approver, approval.id, 'changed my mind');
  const res = checkApprovalBinding(db, approval.id, intent({ registrationId, pkgId: pkg.id }), ALLOWLIST);
  assert.equal(res.ok === false && res.code, 'APPROVAL_NOT_VALID');
});

test('tampering with a stored manifest is detected at the gate', () => {
  const { db, registrationId, pkg, approval } = approved();
  const manifest = JSON.parse(pkg.manifest_json) as { documents: { content_sha256: string }[] };
  manifest.documents[0]!.content_sha256 = 'f'.repeat(64);
  db.prepare('UPDATE packages SET manifest_json = ? WHERE id = ?').run(JSON.stringify(manifest), pkg.id);
  const res = checkApprovalBinding(db, approval.id, intent({ registrationId, pkgId: pkg.id }), ALLOWLIST);
  assert.equal(res.ok === false && res.code, 'MANIFEST_TAMPERED');
});

test('approval requires the approver role, a distinct person and a valid destination', () => {
  const db = testDb();
  const preparer = userByRole(db, 'preparer');
  const approver = userByRole(db, 'approver');
  const submitter = userByRole(db, 'submitter');
  const pkg = buildPackage(db, preparer, cleanRegistrationId(db));

  assert.throws(
    () => createApproval(db, preparer, { package_id: pkg.id, destination_url: DEST, action: ACTION }, ALLOWLIST),
    (e: AppError) => e.code === 'APPROVER_ROLE_REQUIRED',
  );
  assert.throws(
    () => createApproval(db, submitter, { package_id: pkg.id, destination_url: DEST, action: ACTION }, ALLOWLIST),
    (e: AppError) => e.code === 'APPROVER_ROLE_REQUIRED',
  );
  assert.throws(
    () => createApproval(db, approver, { package_id: pkg.id, destination_url: 'http://portal.registry.example/submit', action: ACTION }, ALLOWLIST),
    (e: AppError) => e.code === 'URL_SCHEME_FORBIDDEN',
  );
  assert.throws(
    () => createApproval(db, approver, { package_id: pkg.id, destination_url: DEST, action: 'DELETE_EVERYTHING' }, ALLOWLIST),
    (e: AppError) => e.code === 'UNKNOWN_ACTION',
  );
});

test('the preparer of a package may not approve it', () => {
  const db = testDb();
  const admin = { id: 'u-admin', name: 'admin', role: 'admin' as const, token: 'x' };
  db.prepare('INSERT INTO users (id, name, role, token, created_at) VALUES (?, ?, ?, ?, ?)').run(
    admin.id, admin.name, admin.role, admin.token, new Date().toISOString(),
  );
  const pkg = buildPackage(db, admin, cleanRegistrationId(db));
  assert.throws(
    () => createApproval(db, admin, { package_id: pkg.id, destination_url: DEST, action: ACTION }, ALLOWLIST),
    (e: AppError) => e.code === 'SEPARATION_OF_DUTIES',
  );
});
