import { randomUUID } from 'node:crypto';
import { AdapterRefused, PORTAL_NO_ADAPTER, selectAdapter } from './adapters.js';
import type { AdapterResult, Outcome } from './adapters.js';
import { audit } from './audit.js';
import { AppError, checkApprovalBinding, getPackage, type Manifest, type User } from './core.js';
import type { DB } from './db.js';
import { allowlistFromEnv, checkHostAddresses, type Lookup } from './policy.js';

export type SubmissionState = 'QUEUED' | 'RUNNING' | Outcome;

export interface SubmissionRow {
  id: string;
  registration_id: string;
  package_id: string;
  approval_id: string;
  destination_url: string;
  action: string;
  adapter: string;
  idempotency_key: string;
  state: SubmissionState;
  attempts: number;
  max_attempts: number;
  outcome_code: string | null;
  outcome_detail: string | null;
  receipt: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** The only transitions the state machine will perform. */
const TRANSITIONS: Record<SubmissionState, SubmissionState[]> = {
  QUEUED: ['RUNNING'],
  RUNNING: ['SUCCEEDED', 'HALTED', 'RETRYABLE_FAILED', 'TERMINAL_FAILED'],
  RETRYABLE_FAILED: ['QUEUED', 'TERMINAL_FAILED'],
  SUCCEEDED: [],
  HALTED: [], // resuming a halted submission requires a human to start a new one
  TERMINAL_FAILED: [],
};

const nowIso = (): string => new Date().toISOString();

export interface Env {
  env?: NodeJS.ProcessEnv;
  resolver?: Lookup;
}

function transition(
  db: DB,
  actor: string,
  sub: SubmissionRow,
  to: SubmissionState,
  patch: Partial<SubmissionRow> = {},
): SubmissionRow {
  if (!TRANSITIONS[sub.state].includes(to)) {
    throw new AppError(409, 'ILLEGAL_TRANSITION', `cannot move submission from ${sub.state} to ${to}`);
  }
  const next: SubmissionRow = { ...sub, ...patch, state: to, updated_at: nowIso() };
  db.prepare(
    `UPDATE submissions SET state = @state, attempts = @attempts, outcome_code = @outcome_code,
       outcome_detail = @outcome_detail, receipt = @receipt, updated_at = @updated_at WHERE id = @id`,
  ).run(next);
  audit(db, actor, `SUBMISSION_${to}`, 'submission', sub.id, {
    from: sub.state,
    to,
    attempt: next.attempts,
    outcome_code: next.outcome_code,
    outcome_detail: next.outcome_detail,
  });
  return next;
}

export function getSubmission(db: DB, id: string): SubmissionRow {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as SubmissionRow | undefined;
  if (!row) throw new AppError(404, 'SUBMISSION_NOT_FOUND', `no submission ${id}`);
  return row;
}

export function listSubmissions(db: DB, registrationId?: string): SubmissionRow[] {
  return registrationId
    ? (db
        .prepare('SELECT * FROM submissions WHERE registration_id = ? ORDER BY created_at DESC')
        .all(registrationId) as SubmissionRow[])
    : (db.prepare('SELECT * FROM submissions ORDER BY created_at DESC LIMIT 100').all() as SubmissionRow[]);
}

/**
 * Queue a submission. Refuses unless the caller's exact intent
 * (registration, package, destination, action) is what the approval authorises.
 * Replaying an idempotency key returns the original submission instead of a new one.
 */
export function queueSubmission(
  db: DB,
  actor: User,
  input: {
    registration_id: string;
    package_id: string;
    approval_id: string;
    destination_url: string;
    action: string;
    adapter: string;
    idempotency_key: string;
  },
  opts: Env = {},
): { submission: SubmissionRow; replayed: boolean } {
  if (actor.role !== 'submitter' && actor.role !== 'admin') {
    throw new AppError(403, 'SUBMITTER_ROLE_REQUIRED', 'only a submitter may queue a submission');
  }
  if (!input.idempotency_key?.trim()) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'idempotency_key is required');
  }
  const existing = db
    .prepare('SELECT * FROM submissions WHERE idempotency_key = ?')
    .get(input.idempotency_key) as SubmissionRow | undefined;
  if (existing) {
    const sameIntent =
      existing.registration_id === input.registration_id &&
      existing.package_id === input.package_id &&
      existing.approval_id === input.approval_id &&
      existing.action === input.action &&
      existing.adapter === input.adapter;
    if (!sameIntent) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'this idempotency key was used for a different submission');
    }
    audit(db, actor.id, 'SUBMISSION_REPLAYED', 'submission', existing.id, {
      idempotency_key: input.idempotency_key,
    });
    return { submission: existing, replayed: true };
  }

  const allowlist = allowlistFromEnv(opts.env);
  const binding = checkApprovalBinding(db, input.approval_id, input, allowlist);
  if (!binding.ok) {
    audit(db, actor.id, 'SUBMISSION_REFUSED', 'approval', input.approval_id, {
      code: binding.code,
      reason: binding.reason,
      intent: input,
    });
    throw new AppError(403, binding.code, binding.reason);
  }

  const sub: SubmissionRow = {
    id: randomUUID(),
    registration_id: input.registration_id,
    package_id: input.package_id,
    approval_id: input.approval_id,
    destination_url: binding.destination,
    action: input.action,
    adapter: input.adapter,
    idempotency_key: input.idempotency_key,
    state: 'QUEUED',
    attempts: 0,
    max_attempts: 3,
    outcome_code: null,
    outcome_detail: null,
    receipt: null,
    created_by: actor.id,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO submissions (id, registration_id, package_id, approval_id, destination_url, action, adapter,
       idempotency_key, state, attempts, max_attempts, outcome_code, outcome_detail, receipt, created_by, created_at, updated_at)
     VALUES (@id, @registration_id, @package_id, @approval_id, @destination_url, @action, @adapter,
       @idempotency_key, @state, @attempts, @max_attempts, @outcome_code, @outcome_detail, @receipt, @created_by, @created_at, @updated_at)`,
  ).run(sub);
  audit(db, actor.id, 'SUBMISSION_QUEUED', 'submission', sub.id, {
    registration_id: sub.registration_id,
    package_id: sub.package_id,
    approval_id: sub.approval_id,
    destination_url: sub.destination_url,
    action: sub.action,
    adapter: sub.adapter,
    fingerprint: binding.approval.fingerprint,
  });
  return { submission: sub, replayed: false };
}

/** Execute one queued submission through the state machine. */
export async function processSubmission(db: DB, id: string, opts: Env = {}): Promise<SubmissionRow> {
  const env = opts.env ?? process.env;
  const queued = getSubmission(db, id);
  if (queued.state !== 'QUEUED') return queued;
  let sub = transition(db, 'system', queued, 'RUNNING', { attempts: queued.attempts + 1 });

  const fail = (outcome: Outcome, code: string, detail: string, receipt?: string): SubmissionRow =>
    transition(db, 'system', sub, outcome, { outcome_code: code, outcome_detail: detail, receipt: receipt ?? null });

  // Re-check the approval binding at execution time: the register may have changed while queued.
  const binding = checkApprovalBinding(db, sub.approval_id, sub, allowlistFromEnv(env));
  if (!binding.ok) return fail('TERMINAL_FAILED', binding.code, binding.reason);

  if (env.PORTAL_DNS_CHECK === 'true') {
    const host = new URL(sub.destination_url).hostname;
    const dns = await checkHostAddresses(host, opts.resolver);
    if (!dns.ok) return fail('TERMINAL_FAILED', dns.code ?? 'URL_REJECTED', dns.reason ?? 'destination rejected');
  }

  let result: AdapterResult;
  try {
    const adapter = selectAdapter(sub.adapter, env);
    result = await adapter({
      destination: sub.destination_url,
      action: sub.action,
      fingerprint: binding.approval.fingerprint,
      manifest: JSON.parse(getPackage(db, sub.package_id).manifest_json) as Manifest,
      attempt: sub.attempts,
    });
  } catch (err) {
    if (err instanceof AdapterRefused) return fail('TERMINAL_FAILED', err.code, err.message);
    return fail('RETRYABLE_FAILED', 'ADAPTER_ERROR', err instanceof Error ? err.message : String(err));
  }

  if (result.outcome === 'SUCCEEDED') {
    sub = fail('SUCCEEDED', result.code, result.detail, result.receipt);
    db.prepare("UPDATE approvals SET status = 'CONSUMED' WHERE id = ?").run(sub.approval_id);
    db.prepare("UPDATE registrations SET status = 'SUBMITTED', updated_at = ? WHERE id = ?").run(
      nowIso(),
      sub.registration_id,
    );
    return sub;
  }
  if (result.outcome === 'RETRYABLE_FAILED' && sub.attempts >= sub.max_attempts) {
    return fail('TERMINAL_FAILED', 'RETRY_BUDGET_EXHAUSTED', `${result.code}: ${result.detail}`);
  }
  return fail(result.outcome, result.code, result.detail);
}

/**
 * One worker tick: requeue retryable failures that still have budget, then run
 * the oldest queued submission. HALTED and TERMINAL_FAILED are never touched.
 */
export async function tick(db: DB, opts: Env = {}): Promise<SubmissionRow | null> {
  const retryable = db
    .prepare("SELECT * FROM submissions WHERE state = 'RETRYABLE_FAILED' AND attempts < max_attempts")
    .all() as SubmissionRow[];
  for (const r of retryable) transition(db, 'system', r, 'QUEUED');

  const next = db
    .prepare("SELECT * FROM submissions WHERE state = 'QUEUED' ORDER BY created_at ASC LIMIT 1")
    .get() as SubmissionRow | undefined;
  if (!next) return null;
  return processSubmission(db, next.id, opts);
}

export { PORTAL_NO_ADAPTER };
