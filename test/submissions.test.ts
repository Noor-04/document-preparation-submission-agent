import assert from 'node:assert/strict';
import test from 'node:test';
import { AdapterRefused, mockAdapter, selectAdapter } from '../src/adapters.js';
import { AppError, addDocument, buildPackage, createApproval } from '../src/core.js';
import type { DB } from '../src/db.js';
import { processSubmission, queueSubmission, tick } from '../src/submissions.js';
import { ALLOWLIST, ENV, cleanRegistrationId, testDb, userByRole } from './support.js';

const ACTION = 'SUBMIT_NEW_REGISTRATION';

/** Build → approve → return everything needed to queue a submission at `path`. */
function ready(db: DB, path = '/submit') {
  const preparer = userByRole(db, 'preparer');
  const approver = userByRole(db, 'approver');
  const submitter = userByRole(db, 'submitter');
  const registration_id = cleanRegistrationId(db);
  const pkg = buildPackage(db, preparer, registration_id);
  const destination_url = `https://portal.registry.example${path}`;
  const approval = createApproval(db, approver, { package_id: pkg.id, destination_url, action: ACTION }, ALLOWLIST);
  return {
    submitter,
    intent: {
      registration_id,
      package_id: pkg.id,
      approval_id: approval.id,
      destination_url,
      action: ACTION,
      adapter: 'mock',
      idempotency_key: `key-${path}`,
    },
  };
}

test('a sandbox submission runs to SUCCEEDED and consumes its approval', async () => {
  const db = testDb();
  const { submitter, intent } = ready(db);
  const { submission } = queueSubmission(db, submitter, intent, { env: ENV });
  assert.equal(submission.state, 'QUEUED');

  const done = await tick(db, { env: ENV });
  assert.equal(done?.state, 'SUCCEEDED');
  assert.equal(done?.outcome_code, 'PORTAL_ACCEPTED');
  assert.match(done!.receipt!, /^SBX-[0-9A-F]{16}$/);
  assert.equal(
    (db.prepare('SELECT status AS s FROM approvals WHERE id = ?').get(intent.approval_id) as { s: string }).s,
    'CONSUMED',
  );
  assert.equal(
    (db.prepare('SELECT status AS s FROM registrations WHERE id = ?').get(intent.registration_id) as { s: string }).s,
    'SUBMITTED',
  );
  assert.equal(await tick(db, { env: ENV }), null, 'the queue is drained');
});

test('the live adapter fails closed with PORTAL_NO_ADAPTER', async () => {
  const db = testDb();
  const { submitter, intent } = ready(db);
  const { submission } = queueSubmission(db, submitter, { ...intent, adapter: 'live' }, { env: ENV });
  const done = await processSubmission(db, submission.id, { env: ENV });
  assert.equal(done.state, 'TERMINAL_FAILED');
  assert.equal(done.outcome_code, 'PORTAL_NO_ADAPTER');
  assert.equal(done.receipt, null);
});

test('the sandbox adapter is refused in production', async () => {
  const prodEnv = { ...ENV, NODE_ENV: 'production' };
  assert.throws(
    () => selectAdapter('mock', prodEnv),
    (e: AdapterRefused) => e.code === 'SIMULATION_FORBIDDEN_IN_PRODUCTION',
  );
  // even with the simulation flag explicitly set
  assert.throws(
    () => selectAdapter('mock', { ...prodEnv, ALLOW_SIMULATION: 'true' }),
    (e: AdapterRefused) => e.code === 'SIMULATION_FORBIDDEN_IN_PRODUCTION',
  );
  // and outside production it still needs an explicit opt-in
  assert.throws(
    () => selectAdapter('mock', { PORTAL_HOST_ALLOWLIST: ENV.PORTAL_HOST_ALLOWLIST }),
    (e: AdapterRefused) => e.code === 'SIMULATION_FORBIDDEN_IN_PRODUCTION',
  );
  assert.equal(selectAdapter('mock', ENV), mockAdapter);
  assert.throws(() => selectAdapter('pretend', ENV), (e: AdapterRefused) => e.code === 'UNKNOWN_ADAPTER');

  const db = testDb();
  const { submitter, intent } = ready(db);
  const { submission } = queueSubmission(db, submitter, intent, { env: prodEnv });
  const done = await processSubmission(db, submission.id, { env: prodEnv });
  assert.equal(done.state, 'TERMINAL_FAILED');
  assert.equal(done.outcome_code, 'SIMULATION_FORBIDDEN_IN_PRODUCTION');
});

test('replaying an idempotency key returns the original submission', async () => {
  const db = testDb();
  const { submitter, intent } = ready(db);
  const first = queueSubmission(db, submitter, intent, { env: ENV });
  const second = queueSubmission(db, submitter, intent, { env: ENV });
  assert.equal(second.replayed, true);
  assert.equal(second.submission.id, first.submission.id);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number }).n, 1);

  await tick(db, { env: ENV });
  const third = queueSubmission(db, submitter, intent, { env: ENV });
  assert.equal(third.submission.state, 'SUCCEEDED', 'a replay after completion does not resubmit');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number }).n, 1);
});

test('reusing an idempotency key for a different intent is a conflict', () => {
  const db = testDb();
  const { submitter, intent } = ready(db);
  queueSubmission(db, submitter, intent, { env: ENV });
  assert.throws(
    () => queueSubmission(db, submitter, { ...intent, adapter: 'live' }, { env: ENV }),
    (e: AppError) => e.code === 'IDEMPOTENCY_KEY_CONFLICT',
  );
});

test('CAPTCHA, MFA and legal declarations HALT and are never auto-resumed', async () => {
  for (const [path, code] of [
    ['/captcha', 'CAPTCHA_REQUIRED'],
    ['/mfa', 'MFA_REQUIRED'],
    ['/declaration', 'LEGAL_DECLARATION_REQUIRED'],
  ] as const) {
    const db = testDb();
    const { submitter, intent } = ready(db, path);
    const { submission } = queueSubmission(db, submitter, intent, { env: ENV });
    const done = await processSubmission(db, submission.id, { env: ENV });
    assert.equal(done.state, 'HALTED', path);
    assert.equal(done.outcome_code, code);

    assert.equal(await tick(db, { env: ENV }), null, 'a halted submission is not picked up again');
    const after = await processSubmission(db, submission.id, { env: ENV });
    assert.equal(after.state, 'HALTED');
    assert.equal(after.attempts, 1, 'no further attempts are made');
  }
});

test('a retryable failure is retried, then succeeds', async () => {
  const db = testDb();
  const { submitter, intent } = ready(db, '/flaky');
  queueSubmission(db, submitter, intent, { env: ENV });
  const first = await tick(db, { env: ENV });
  assert.equal(first?.state, 'RETRYABLE_FAILED');
  assert.equal(first?.outcome_code, 'PORTAL_TIMEOUT');
  assert.equal(first?.attempts, 1);

  const second = await tick(db, { env: ENV }); // requeues, then runs
  assert.equal(second?.state, 'SUCCEEDED');
  assert.equal(second?.attempts, 2);
});

test('an exhausted retry budget ends in TERMINAL_FAILED', async () => {
  const db = testDb();
  const { submitter, intent } = ready(db, '/flaky');
  const { submission } = queueSubmission(db, submitter, intent, { env: ENV });
  db.prepare('UPDATE submissions SET max_attempts = 1 WHERE id = ?').run(submission.id);
  const done = await processSubmission(db, submission.id, { env: ENV });
  assert.equal(done.state, 'TERMINAL_FAILED');
  assert.equal(done.outcome_code, 'RETRY_BUDGET_EXHAUSTED');
  assert.equal(await tick(db, { env: ENV }), null, 'it is not requeued');
});

test('a terminal state is never left again', async () => {
  const db = testDb();
  const { submitter, intent } = ready(db, '/reject');
  const { submission } = queueSubmission(db, submitter, intent, { env: ENV });
  const done = await processSubmission(db, submission.id, { env: ENV });
  assert.equal(done.state, 'TERMINAL_FAILED');
  assert.equal((await processSubmission(db, submission.id, { env: ENV })).state, 'TERMINAL_FAILED');
  assert.equal(await tick(db, { env: ENV }), null);
});

test('only a submitter may queue a submission', () => {
  const db = testDb();
  const { intent } = ready(db);
  for (const role of ['preparer', 'approver'] as const) {
    assert.throws(
      () => queueSubmission(db, userByRole(db, role), intent, { env: ENV }),
      (e: AppError) => e.code === 'SUBMITTER_ROLE_REQUIRED',
    );
  }
});

test('queueing is refused when the package changed after approval', () => {
  const db = testDb();
  const { submitter, intent } = ready(db);
  addDocument(db, userByRole(db, 'preparer'), intent.registration_id, {
    doc_type: 'PROOF_OF_ADDRESS',
    filename: 'address-v2.txt',
    content: 'UTILITY STATEMENT — reissued after approval',
    entity_name: 'Noor Logistics B.V.',
    entity_id: 'NL857123456B01',
  });
  assert.throws(
    () => queueSubmission(db, submitter, intent, { env: ENV }),
    (e: AppError) => e.code === 'APPROVAL_NOT_VALID',
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number }).n, 0);
});

test('an already-queued submission is re-checked at execution time', async () => {
  const db = testDb();
  const { submitter, intent } = ready(db);
  const { submission } = queueSubmission(db, submitter, intent, { env: ENV });
  addDocument(db, userByRole(db, 'preparer'), intent.registration_id, {
    doc_type: 'PROOF_OF_ADDRESS',
    filename: 'address-v2.txt',
    content: 'UTILITY STATEMENT — reissued while queued',
    entity_name: 'Noor Logistics B.V.',
    entity_id: 'NL857123456B01',
  });
  const done = await processSubmission(db, submission.id, { env: ENV });
  assert.equal(done.state, 'TERMINAL_FAILED');
  assert.equal(done.outcome_code, 'APPROVAL_NOT_VALID');
});

test('a destination that resolves to a private address is refused at execution time', async () => {
  const db = testDb();
  const { submitter, intent } = ready(db);
  const { submission } = queueSubmission(db, submitter, intent, { env: ENV });
  const done = await processSubmission(db, submission.id, {
    env: { ...ENV, PORTAL_DNS_CHECK: 'true' },
    resolver: async () => [{ address: '169.254.169.254', family: 4 }],
  });
  assert.equal(done.state, 'TERMINAL_FAILED');
  assert.equal(done.outcome_code, 'URL_PRIVATE_ADDRESS');
});
