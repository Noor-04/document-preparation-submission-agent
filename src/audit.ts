import { createHash } from 'node:crypto';
import type { DB } from './db.js';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Deterministic JSON: object keys sorted recursively. Used for fingerprints and audit hashes. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export interface AuditEvent {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  subject_type: string;
  subject_id: string;
  data_json: string;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

/**
 * Append a tamper-evident audit record. Each row's hash covers the previous
 * row's hash, so any edit or deletion breaks the chain at `verifyAudit`.
 */
export function audit(
  db: DB,
  actor: string,
  action: string,
  subjectType: string,
  subjectId: string,
  data: Record<string, unknown> = {},
): AuditEvent {
  const prev = db.prepare('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1').get() as
    | { hash: string }
    | undefined;
  const prevHash = prev?.hash ?? GENESIS;
  const ts = new Date().toISOString();
  const dataJson = canonical(data);
  const hash = sha256(canonical({ prevHash, ts, actor, action, subjectType, subjectId, dataJson }));
  const info = db
    .prepare(
      `INSERT INTO audit_events (ts, actor, action, subject_type, subject_id, data_json, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ts, actor, action, subjectType, subjectId, dataJson, prevHash, hash);
  return {
    seq: Number(info.lastInsertRowid),
    ts,
    actor,
    action,
    subject_type: subjectType,
    subject_id: subjectId,
    data_json: dataJson,
    prev_hash: prevHash,
    hash,
  };
}

export function verifyAudit(db: DB): { ok: boolean; count: number; brokenAtSeq?: number } {
  const rows = db.prepare('SELECT * FROM audit_events ORDER BY seq ASC').all() as AuditEvent[];
  let prevHash = GENESIS;
  for (const r of rows) {
    const expect = sha256(
      canonical({
        prevHash,
        ts: r.ts,
        actor: r.actor,
        action: r.action,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        dataJson: r.data_json,
      }),
    );
    if (r.prev_hash !== prevHash || r.hash !== expect) {
      return { ok: false, count: rows.length, brokenAtSeq: r.seq };
    }
    prevHash = r.hash;
  }
  return { ok: true, count: rows.length };
}

export function auditTrail(db: DB, subjectId?: string): AuditEvent[] {
  return subjectId
    ? (db
        .prepare('SELECT * FROM audit_events WHERE subject_id = ? ORDER BY seq ASC')
        .all(subjectId) as AuditEvent[])
    : (db.prepare('SELECT * FROM audit_events ORDER BY seq DESC LIMIT 200').all() as AuditEvent[]);
}
