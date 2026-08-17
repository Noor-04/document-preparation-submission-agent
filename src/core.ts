import { randomUUID } from 'node:crypto';
import { audit, canonical, sha256 } from './audit.js';
import type { DB } from './db.js';
import { validateDestination } from './policy.js';

export const ACTIONS = ['SUBMIT_NEW_REGISTRATION', 'SUBMIT_AMENDMENT', 'WITHDRAW'] as const;
export type Action = (typeof ACTIONS)[number];

export interface User {
  id: string;
  name: string;
  role: 'preparer' | 'approver' | 'submitter' | 'admin';
  token: string;
}

export interface Registration {
  id: string;
  entity_name: string;
  entity_id: string;
  jurisdiction: string;
  reg_type: string;
  status: 'INTAKE' | 'READY' | 'SUBMITTED';
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  registration_id: string;
  doc_type: string;
  filename: string;
  content_sha256: string;
  byte_size: number;
  entity_name: string;
  entity_id: string;
  issued_at: string | null;
  expires_at: string | null;
  version: number;
  status: 'ACTIVE' | 'SUPERSEDED' | 'WITHDRAWN';
  uploaded_by: string;
  created_at: string;
}

export interface PackageRow {
  id: string;
  registration_id: string;
  version: number;
  fingerprint: string;
  manifest_json: string;
  status: 'READY' | 'INVALIDATED';
  created_by: string;
  created_at: string;
  invalidated_reason: string | null;
}

export interface ApprovalRow {
  id: string;
  registration_id: string;
  package_id: string;
  fingerprint: string;
  destination_url: string;
  action: string;
  approver_id: string;
  status: 'VALID' | 'INVALIDATED' | 'CONSUMED';
  created_at: string;
  invalidated_reason: string | null;
}

export interface Finding {
  code: string;
  severity: 'BLOCKING' | 'WARNING';
  doc_type?: string;
  document_id?: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const nowIso = (): string => new Date().toISOString();

// ---------------------------------------------------------------- intake ----

export function createRegistration(
  db: DB,
  actor: User,
  input: { entity_name: string; entity_id: string; jurisdiction: string; reg_type: string },
): Registration {
  for (const field of ['entity_name', 'entity_id', 'jurisdiction', 'reg_type'] as const) {
    if (!input[field]?.trim()) throw new AppError(400, 'INVALID_INPUT', `${field} is required`);
  }
  const ts = nowIso();
  const reg: Registration = {
    id: randomUUID(),
    entity_name: input.entity_name.trim(),
    entity_id: input.entity_id.trim(),
    jurisdiction: input.jurisdiction.trim(),
    reg_type: input.reg_type.trim(),
    status: 'INTAKE',
    created_by: actor.id,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(
    `INSERT INTO registrations (id, entity_name, entity_id, jurisdiction, reg_type, status, created_by, created_at, updated_at)
     VALUES (@id, @entity_name, @entity_id, @jurisdiction, @reg_type, @status, @created_by, @created_at, @updated_at)`,
  ).run(reg);
  audit(db, actor.id, 'REGISTRATION_CREATED', 'registration', reg.id, { ...reg });
  return reg;
}

export function getRegistration(db: DB, id: string): Registration {
  const row = db.prepare('SELECT * FROM registrations WHERE id = ?').get(id) as Registration | undefined;
  if (!row) throw new AppError(404, 'REGISTRATION_NOT_FOUND', `no registration ${id}`);
  return row;
}

export function updateRegistration(
  db: DB,
  actor: User,
  id: string,
  patch: Partial<Pick<Registration, 'entity_name' | 'entity_id' | 'jurisdiction' | 'reg_type'>>,
): Registration {
  if (actor.role !== 'preparer' && actor.role !== 'admin') {
    throw new AppError(403, 'PREPARER_ROLE_REQUIRED', 'only a preparer may amend a registration');
  }
  const before = getRegistration(db, id);
  const next = { ...before, ...patch, updated_at: nowIso() };
  db.prepare(
    `UPDATE registrations SET entity_name = @entity_name, entity_id = @entity_id,
       jurisdiction = @jurisdiction, reg_type = @reg_type, updated_at = @updated_at WHERE id = @id`,
  ).run(next);
  audit(db, actor.id, 'REGISTRATION_UPDATED', 'registration', id, { before, after: next });
  invalidatePackages(db, actor, id, 'REGISTRATION_CHANGED');
  return next;
}

// ---------------------------------------------------------- requirements ----

export interface Requirement {
  doc_type: string;
  mandatory: number;
  notes: string | null;
}

/** Jurisdiction-specific rows win over the '*' fallback for the same doc_type. */
export function resolveRequirements(db: DB, regType: string, jurisdiction: string): Requirement[] {
  const rows = db
    .prepare(
      `SELECT doc_type, mandatory, notes, jurisdiction FROM requirements
       WHERE reg_type = ? AND jurisdiction IN (?, '*')`,
    )
    .all(regType, jurisdiction) as (Requirement & { jurisdiction: string })[];
  const byType = new Map<string, Requirement & { jurisdiction: string }>();
  for (const r of rows) {
    const existing = byType.get(r.doc_type);
    if (!existing || existing.jurisdiction === '*') byType.set(r.doc_type, r);
  }
  return [...byType.values()]
    .map(({ doc_type, mandatory, notes }) => ({ doc_type, mandatory, notes }))
    .sort((a, b) => (a.doc_type < b.doc_type ? -1 : 1));
}

// ------------------------------------------------------- document register ----

export function activeDocuments(db: DB, registrationId: string): DocumentRow[] {
  return db
    .prepare("SELECT * FROM documents WHERE registration_id = ? AND status = 'ACTIVE' ORDER BY doc_type")
    .all(registrationId) as DocumentRow[];
}

export function allDocuments(db: DB, registrationId: string): DocumentRow[] {
  return db
    .prepare('SELECT * FROM documents WHERE registration_id = ? ORDER BY doc_type, version DESC')
    .all(registrationId) as DocumentRow[];
}

/**
 * Register a document. Any previous ACTIVE document of the same type is superseded
 * (controlled register: exactly one active version per type) and every package for
 * the registration is invalidated, which cascades to its approvals.
 */
export function addDocument(
  db: DB,
  actor: User,
  registrationId: string,
  input: {
    doc_type: string;
    filename: string;
    content: string;
    entity_name: string;
    entity_id: string;
    issued_at?: string | null;
    expires_at?: string | null;
  },
): DocumentRow {
  getRegistration(db, registrationId);
  if (!input.doc_type?.trim() || !input.filename?.trim()) {
    throw new AppError(400, 'INVALID_INPUT', 'doc_type and filename are required');
  }
  if (typeof input.content !== 'string' || input.content.length === 0) {
    throw new AppError(400, 'INVALID_INPUT', 'content is required (demo documents are plain text)');
  }
  const prev = db
    .prepare(
      "SELECT * FROM documents WHERE registration_id = ? AND doc_type = ? AND status = 'ACTIVE'",
    )
    .get(registrationId, input.doc_type) as DocumentRow | undefined;

  const doc: DocumentRow = {
    id: randomUUID(),
    registration_id: registrationId,
    doc_type: input.doc_type.trim(),
    filename: input.filename.trim(),
    content_sha256: sha256(input.content),
    byte_size: Buffer.byteLength(input.content),
    entity_name: input.entity_name.trim(),
    entity_id: input.entity_id.trim(),
    issued_at: input.issued_at ?? null,
    expires_at: input.expires_at ?? null,
    version: (prev?.version ?? 0) + 1,
    status: 'ACTIVE',
    uploaded_by: actor.id,
    created_at: nowIso(),
  };
  db.transaction(() => {
    if (prev) db.prepare("UPDATE documents SET status = 'SUPERSEDED' WHERE id = ?").run(prev.id);
    db.prepare(
      `INSERT INTO documents (id, registration_id, doc_type, filename, content_sha256, byte_size,
         entity_name, entity_id, issued_at, expires_at, version, status, uploaded_by, created_at)
       VALUES (@id, @registration_id, @doc_type, @filename, @content_sha256, @byte_size,
         @entity_name, @entity_id, @issued_at, @expires_at, @version, @status, @uploaded_by, @created_at)`,
    ).run(doc);
  })();
  audit(db, actor.id, 'DOCUMENT_REGISTERED', 'document', doc.id, {
    registration_id: registrationId,
    doc_type: doc.doc_type,
    version: doc.version,
    content_sha256: doc.content_sha256,
    supersedes: prev?.id ?? null,
  });
  invalidatePackages(db, actor, registrationId, 'DOCUMENT_REGISTER_CHANGED');
  return doc;
}

// -------------------------------------------------------------- checks ------

/** Validity, entity-consistency and duplicate checks over the active register. */
export function runChecks(db: DB, registrationId: string, now = nowIso()): Finding[] {
  const reg = getRegistration(db, registrationId);
  const required = resolveRequirements(db, reg.reg_type, reg.jurisdiction);
  const docs = activeDocuments(db, registrationId);
  const byType = new Map(docs.map((d) => [d.doc_type, d]));
  const findings: Finding[] = [];

  for (const req of required) {
    if (!byType.has(req.doc_type)) {
      findings.push({
        code: 'MISSING_DOCUMENT',
        severity: req.mandatory ? 'BLOCKING' : 'WARNING',
        doc_type: req.doc_type,
        message: `required document ${req.doc_type} is not in the register`,
      });
    }
  }

  const requiredTypes = new Set(required.map((r) => r.doc_type));
  const seenContent = new Map<string, DocumentRow>();
  for (const d of docs) {
    if (!requiredTypes.has(d.doc_type)) {
      findings.push({
        code: 'UNEXPECTED_DOCUMENT',
        severity: 'WARNING',
        doc_type: d.doc_type,
        document_id: d.id,
        message: `${d.doc_type} is not part of the resolved requirements`,
      });
    }
    if (d.expires_at && d.expires_at <= now) {
      findings.push({
        code: 'EXPIRED_DOCUMENT',
        severity: 'BLOCKING',
        doc_type: d.doc_type,
        document_id: d.id,
        message: `${d.doc_type} expired at ${d.expires_at}`,
      });
    }
    if (d.entity_name !== reg.entity_name || d.entity_id !== reg.entity_id) {
      findings.push({
        code: 'ENTITY_MISMATCH',
        severity: 'BLOCKING',
        doc_type: d.doc_type,
        document_id: d.id,
        message: `${d.doc_type} is issued to ${d.entity_name} (${d.entity_id}) but the registration is for ${reg.entity_name} (${reg.entity_id})`,
      });
    }
    const twin = seenContent.get(d.content_sha256);
    if (twin) {
      findings.push({
        code: 'DUPLICATE_CONTENT',
        severity: 'BLOCKING',
        doc_type: d.doc_type,
        document_id: d.id,
        message: `${d.doc_type} has the same content as ${twin.doc_type} (sha256 ${d.content_sha256.slice(0, 12)}…)`,
      });
    } else {
      seenContent.set(d.content_sha256, d);
    }
  }
  return findings;
}

// -------------------------------------------------------------- packages ----

export interface Manifest {
  registration: { id: string; entity_name: string; entity_id: string; jurisdiction: string; reg_type: string };
  package_version: number;
  documents: {
    doc_type: string;
    document_id: string;
    version: number;
    filename: string;
    content_sha256: string;
    expires_at: string | null;
  }[];
}

export const fingerprintOf = (manifest: Manifest): string => sha256(canonical(manifest));

export function buildPackage(db: DB, actor: User, registrationId: string): PackageRow {
  const reg = getRegistration(db, registrationId);
  const findings = runChecks(db, registrationId);
  const blocking = findings.filter((f) => f.severity === 'BLOCKING');
  if (blocking.length > 0) {
    throw new AppError(422, 'PACKAGE_CHECKS_FAILED', 'document checks blocked package assembly', blocking);
  }
  const docs = activeDocuments(db, registrationId);
  if (docs.length === 0) throw new AppError(422, 'PACKAGE_EMPTY', 'no active documents to package');

  const version =
    ((db
      .prepare('SELECT MAX(version) AS v FROM packages WHERE registration_id = ?')
      .get(registrationId) as { v: number | null }).v ?? 0) + 1;

  const manifest: Manifest = {
    registration: {
      id: reg.id,
      entity_name: reg.entity_name,
      entity_id: reg.entity_id,
      jurisdiction: reg.jurisdiction,
      reg_type: reg.reg_type,
    },
    package_version: version,
    documents: docs
      .map((d) => ({
        doc_type: d.doc_type,
        document_id: d.id,
        version: d.version,
        filename: d.filename,
        content_sha256: d.content_sha256,
        expires_at: d.expires_at,
      }))
      .sort((a, b) => (a.doc_type < b.doc_type ? -1 : 1)),
  };
  const pkg: PackageRow = {
    id: randomUUID(),
    registration_id: registrationId,
    version,
    fingerprint: fingerprintOf(manifest),
    manifest_json: canonical(manifest),
    status: 'READY',
    created_by: actor.id,
    created_at: nowIso(),
    invalidated_reason: null,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO packages (id, registration_id, version, fingerprint, manifest_json, status, created_by, created_at, invalidated_reason)
       VALUES (@id, @registration_id, @version, @fingerprint, @manifest_json, @status, @created_by, @created_at, @invalidated_reason)`,
    ).run(pkg);
    const link = db.prepare('INSERT INTO package_documents (package_id, document_id) VALUES (?, ?)');
    for (const d of docs) link.run(pkg.id, d.id);
    db.prepare("UPDATE registrations SET status = 'READY', updated_at = ? WHERE id = ?").run(nowIso(), registrationId);
  })();
  audit(db, actor.id, 'PACKAGE_BUILT', 'package', pkg.id, {
    registration_id: registrationId,
    version,
    fingerprint: pkg.fingerprint,
    warnings: findings.filter((f) => f.severity === 'WARNING'),
  });
  return pkg;
}

export function getPackage(db: DB, id: string): PackageRow {
  const row = db.prepare('SELECT * FROM packages WHERE id = ?').get(id) as PackageRow | undefined;
  if (!row) throw new AppError(404, 'PACKAGE_NOT_FOUND', `no package ${id}`);
  return row;
}

export function listPackages(db: DB, registrationId: string): PackageRow[] {
  return db
    .prepare('SELECT * FROM packages WHERE registration_id = ? ORDER BY version DESC')
    .all(registrationId) as PackageRow[];
}

/** Any change to the registration or its register invalidates packages and their approvals. */
export function invalidatePackages(db: DB, actor: User, registrationId: string, reason: string): void {
  const live = db
    .prepare("SELECT id FROM packages WHERE registration_id = ? AND status = 'READY'")
    .all(registrationId) as { id: string }[];
  if (live.length === 0) return;
  db.transaction(() => {
    for (const { id } of live) {
      db.prepare("UPDATE packages SET status = 'INVALIDATED', invalidated_reason = ? WHERE id = ?").run(reason, id);
      db.prepare(
        "UPDATE approvals SET status = 'INVALIDATED', invalidated_reason = ? WHERE package_id = ? AND status = 'VALID'",
      ).run(reason, id);
    }
  })();
  for (const { id } of live) {
    audit(db, actor.id, 'PACKAGE_INVALIDATED', 'package', id, { registration_id: registrationId, reason });
  }
}

// ------------------------------------------------------------- approvals ----

export function createApproval(
  db: DB,
  approver: User,
  input: { package_id: string; destination_url: string; action: string },
  allowlist: string[],
): ApprovalRow {
  if (approver.role !== 'approver' && approver.role !== 'admin') {
    throw new AppError(403, 'APPROVER_ROLE_REQUIRED', 'only an approver may approve a package');
  }
  if (!ACTIONS.includes(input.action as Action)) {
    throw new AppError(400, 'UNKNOWN_ACTION', `action must be one of ${ACTIONS.join(', ')}`);
  }
  const pkg = getPackage(db, input.package_id);
  if (pkg.status !== 'READY') {
    throw new AppError(409, 'PACKAGE_NOT_READY', `package is ${pkg.status} and cannot be approved`);
  }
  if (pkg.created_by === approver.id) {
    throw new AppError(403, 'SEPARATION_OF_DUTIES', 'the package preparer may not approve their own package');
  }
  const decision = validateDestination(input.destination_url, allowlist);
  if (!decision.ok) {
    throw new AppError(400, decision.code ?? 'URL_REJECTED', decision.reason ?? 'destination rejected');
  }
  const approval: ApprovalRow = {
    id: randomUUID(),
    registration_id: pkg.registration_id,
    package_id: pkg.id,
    fingerprint: pkg.fingerprint,
    destination_url: decision.normalized!,
    action: input.action,
    approver_id: approver.id,
    status: 'VALID',
    created_at: nowIso(),
    invalidated_reason: null,
  };
  db.prepare(
    `INSERT INTO approvals (id, registration_id, package_id, fingerprint, destination_url, action, approver_id, status, created_at, invalidated_reason)
     VALUES (@id, @registration_id, @package_id, @fingerprint, @destination_url, @action, @approver_id, @status, @created_at, @invalidated_reason)`,
  ).run(approval);
  audit(db, approver.id, 'APPROVAL_GRANTED', 'approval', approval.id, { ...approval });
  return approval;
}

export function getApproval(db: DB, id: string): ApprovalRow {
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  if (!row) throw new AppError(404, 'APPROVAL_NOT_FOUND', `no approval ${id}`);
  return row;
}

export function revokeApproval(db: DB, actor: User, id: string, reason: string): ApprovalRow {
  const approval = getApproval(db, id);
  db.prepare("UPDATE approvals SET status = 'INVALIDATED', invalidated_reason = ? WHERE id = ?").run(reason, id);
  audit(db, actor.id, 'APPROVAL_REVOKED', 'approval', id, { reason });
  return { ...approval, status: 'INVALIDATED', invalidated_reason: reason };
}

/**
 * The approval gate. An approval authorises exactly one
 * (registration, package, fingerprint, destination, action) tuple — nothing else.
 */
export function checkApprovalBinding(
  db: DB,
  approvalId: string,
  intent: { registration_id: string; package_id: string; destination_url: string; action: string },
  allowlist: string[],
): { ok: true; approval: ApprovalRow; destination: string } | { ok: false; code: string; reason: string } {
  const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as ApprovalRow | undefined;
  if (!approval) return { ok: false, code: 'APPROVAL_NOT_FOUND', reason: `no approval ${approvalId}` };
  if (approval.status !== 'VALID') {
    return { ok: false, code: 'APPROVAL_NOT_VALID', reason: `approval is ${approval.status}` };
  }
  if (approval.registration_id !== intent.registration_id) {
    return { ok: false, code: 'APPROVAL_REGISTRATION_MISMATCH', reason: 'approval is bound to another registration' };
  }
  if (approval.package_id !== intent.package_id) {
    return { ok: false, code: 'APPROVAL_PACKAGE_MISMATCH', reason: 'approval is bound to another package' };
  }
  if (approval.action !== intent.action) {
    return { ok: false, code: 'APPROVAL_ACTION_MISMATCH', reason: `approval authorises ${approval.action}` };
  }
  const decision = validateDestination(intent.destination_url, allowlist);
  if (!decision.ok) {
    return { ok: false, code: decision.code ?? 'URL_REJECTED', reason: decision.reason ?? 'destination rejected' };
  }
  if (approval.destination_url !== decision.normalized) {
    return { ok: false, code: 'APPROVAL_DESTINATION_MISMATCH', reason: `approval authorises ${approval.destination_url}` };
  }
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(approval.package_id) as PackageRow | undefined;
  if (!pkg) return { ok: false, code: 'PACKAGE_NOT_FOUND', reason: 'package vanished' };
  if (pkg.status !== 'READY') return { ok: false, code: 'PACKAGE_NOT_READY', reason: `package is ${pkg.status}` };
  if (approval.fingerprint !== pkg.fingerprint) {
    return { ok: false, code: 'FINGERPRINT_MISMATCH', reason: 'the package changed after approval' };
  }
  // Recompute from the stored manifest: catches direct tampering with the package row.
  if (fingerprintOf(JSON.parse(pkg.manifest_json) as Manifest) !== pkg.fingerprint) {
    return { ok: false, code: 'MANIFEST_TAMPERED', reason: 'stored manifest does not match its fingerprint' };
  }
  return { ok: true, approval, destination: decision.normalized! };
}
