-- Document Preparation and Submission Agent — initial schema.
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('preparer', 'approver', 'submitter', 'admin')),
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Requirements catalogue: resolved per (reg_type, jurisdiction) with '*' fallback.
CREATE TABLE requirements (
  reg_type     TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  doc_type     TEXT NOT NULL,
  mandatory    INTEGER NOT NULL DEFAULT 1,
  notes        TEXT,
  PRIMARY KEY (reg_type, jurisdiction, doc_type)
);

CREATE TABLE registrations (
  id           TEXT PRIMARY KEY,
  entity_name  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  reg_type     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('INTAKE', 'READY', 'SUBMITTED')),
  created_by   TEXT NOT NULL REFERENCES users (id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Controlled document register: one ACTIVE version per (registration, doc_type).
CREATE TABLE documents (
  id              TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations (id),
  doc_type        TEXT NOT NULL,
  filename        TEXT NOT NULL,
  content_sha256  TEXT NOT NULL,
  byte_size       INTEGER NOT NULL,
  entity_name     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  issued_at       TEXT,
  expires_at      TEXT,
  version         INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'WITHDRAWN')),
  uploaded_by     TEXT NOT NULL REFERENCES users (id),
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX documents_one_active
  ON documents (registration_id, doc_type) WHERE status = 'ACTIVE';

CREATE TABLE packages (
  id              TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations (id),
  version         INTEGER NOT NULL,
  fingerprint     TEXT NOT NULL,
  manifest_json   TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('READY', 'INVALIDATED')),
  created_by      TEXT NOT NULL REFERENCES users (id),
  created_at      TEXT NOT NULL,
  invalidated_reason TEXT,
  UNIQUE (registration_id, version)
);

CREATE TABLE package_documents (
  package_id  TEXT NOT NULL REFERENCES packages (id),
  document_id TEXT NOT NULL REFERENCES documents (id),
  PRIMARY KEY (package_id, document_id)
);

-- An approval is bound to the exact registration + package + fingerprint + destination + action.
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations (id),
  package_id      TEXT NOT NULL REFERENCES packages (id),
  fingerprint     TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  action          TEXT NOT NULL,
  approver_id     TEXT NOT NULL REFERENCES users (id),
  status          TEXT NOT NULL CHECK (status IN ('VALID', 'INVALIDATED', 'CONSUMED')),
  created_at      TEXT NOT NULL,
  invalidated_reason TEXT
);

CREATE TABLE submissions (
  id              TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations (id),
  package_id      TEXT NOT NULL REFERENCES packages (id),
  approval_id     TEXT NOT NULL REFERENCES approvals (id),
  destination_url TEXT NOT NULL,
  action          TEXT NOT NULL,
  adapter         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state           TEXT NOT NULL CHECK (state IN (
                    'QUEUED', 'RUNNING', 'SUCCEEDED', 'HALTED',
                    'RETRYABLE_FAILED', 'TERMINAL_FAILED')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  outcome_code    TEXT,
  outcome_detail  TEXT,
  receipt         TEXT,
  created_by      TEXT NOT NULL REFERENCES users (id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Append-only, hash-chained audit trail.
CREATE TABLE audit_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  data_json    TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
