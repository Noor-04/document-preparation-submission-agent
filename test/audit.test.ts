import assert from 'node:assert/strict';
import test from 'node:test';
import { auditTrail, canonical, verifyAudit } from '../src/audit.js';
import { buildPackage, createApproval } from '../src/core.js';
import { processSubmission, queueSubmission } from '../src/submissions.js';
import { ALLOWLIST, ENV, cleanRegistrationId, testDb, userByRole } from './support.js';

const DEST = 'https://portal.registry.example/submit';
const ACTION = 'SUBMIT_NEW_REGISTRATION';

async function fullRun() {
  const db = testDb();
  const preparer = userByRole(db, 'preparer');
  const approver = userByRole(db, 'approver');
  const submitter = userByRole(db, 'submitter');
  const registration_id = cleanRegistrationId(db);
  const pkg = buildPackage(db, preparer, registration_id);
  const approval = createApproval(db, approver, { package_id: pkg.id, destination_url: DEST, action: ACTION }, ALLOWLIST);
  const { submission } = queueSubmission(
    db,
    submitter,
    {
      registration_id,
      package_id: pkg.id,
      approval_id: approval.id,
      destination_url: DEST,
      action: ACTION,
      adapter: 'mock',
      idempotency_key: 'audit-run',
    },
    { env: ENV },
  );
  await processSubmission(db, submission.id, { env: ENV });
  return { db, registration_id, pkg, approval, submission };
}

test('canonical JSON is stable regardless of key order', () => {
  assert.equal(canonical({ b: 1, a: [3, { z: 1, y: 2 }] }), canonical({ a: [3, { y: 2, z: 1 }], b: 1 }));
  assert.equal(canonical({ a: 1, b: undefined }), '{"a":1}');
});

test('every step of a run leaves audit evidence', async () => {
  const { db, pkg, approval, submission } = await fullRun();
  const actions = auditTrail(db).map((e) => e.action);
  for (const expected of [
    'REGISTRATION_CREATED',
    'DOCUMENT_REGISTERED',
    'PACKAGE_BUILT',
    'APPROVAL_GRANTED',
    'SUBMISSION_QUEUED',
    'SUBMISSION_RUNNING',
    'SUBMISSION_SUCCEEDED',
  ]) {
    assert.ok(actions.includes(expected), `missing audit action ${expected}`);
  }

  const queued = auditTrail(db, submission.id).find((e) => e.action === 'SUBMISSION_QUEUED');
  const data = JSON.parse(queued!.data_json) as Record<string, string>;
  assert.equal(data.fingerprint, pkg.fingerprint, 'the queued event pins the approved fingerprint');
  assert.equal(data.destination_url, DEST);
  assert.equal(data.approval_id, approval.id);

  assert.deepEqual(verifyAudit(db), { ok: true, count: auditTrail(db).length });
});

test('a refused submission is recorded, not silently dropped', () => {
  const db = testDb();
  const preparer = userByRole(db, 'preparer');
  const approver = userByRole(db, 'approver');
  const submitter = userByRole(db, 'submitter');
  const registration_id = cleanRegistrationId(db);
  const pkg = buildPackage(db, preparer, registration_id);
  const approval = createApproval(db, approver, { package_id: pkg.id, destination_url: DEST, action: ACTION }, ALLOWLIST);
  assert.throws(() =>
    queueSubmission(
      db,
      submitter,
      {
        registration_id,
        package_id: pkg.id,
        approval_id: approval.id,
        destination_url: 'https://filing.gov.example/submit', // not what was approved
        action: ACTION,
        adapter: 'mock',
        idempotency_key: 'refused-run',
      },
      { env: ENV },
    ),
  );
  const refusal = auditTrail(db).find((e) => e.action === 'SUBMISSION_REFUSED');
  assert.ok(refusal, 'refusal must be audited');
  assert.equal((JSON.parse(refusal!.data_json) as { code: string }).code, 'APPROVAL_DESTINATION_MISMATCH');
});

test('editing the audit trail breaks the hash chain', async () => {
  const { db } = await fullRun();
  const before = verifyAudit(db);
  assert.equal(before.ok, true);

  const victim = auditTrail(db).find((e) => e.action === 'APPROVAL_GRANTED')!;
  db.prepare('UPDATE audit_events SET data_json = ? WHERE seq = ?').run(
    canonical({ tampered: true }),
    victim.seq,
  );
  const after = verifyAudit(db);
  assert.equal(after.ok, false);
  assert.equal(after.brokenAtSeq, victim.seq);
});

test('deleting an audit row breaks the hash chain', async () => {
  const { db } = await fullRun();
  const victim = auditTrail(db).find((e) => e.action === 'PACKAGE_BUILT')!;
  db.prepare('DELETE FROM audit_events WHERE seq = ?').run(victim.seq);
  const after = verifyAudit(db);
  assert.equal(after.ok, false);
  assert.equal(after.brokenAtSeq, victim.seq + 1);
});
