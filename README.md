# Document Preparation & Submission Agent (MVP)

Prepares a controlled document package for a registration, binds a human approval to
that exact package and destination, and drives a queued submission through an explicit
state machine — with a tamper-evident audit trail behind every step.

**This is an MVP for local evaluation. It is not production ready.** See
[Operational gaps](#operational-gaps).

There is **no real portal adapter**. A `live` submission always fails closed with
`PORTAL_NO_ADAPTER`. A local `mock` sandbox adapter exists solely for tests and the
demo; it performs no network I/O and is refused outright when `NODE_ENV=production`.

---

## Setup

Requires Node.js ≥ 20.6 (tested on v20.20.2). No other services.

```bash
npm install
cp .env.example .env      # demo values only — never put a real credential here
npm run build
npm run seed              # demo users, requirements catalogue, two registrations
npm start                 # http://localhost:3000
```

If port 3000 is taken: `PORT=4317 node --env-file=.env dist/src/server.js`.

Open the UI and pick a persona from the **Acting as** dropdown (Priya = preparer,
Omar = approver, Lena = submitter). The demo bearer tokens live in `src/seed.ts` and
are deliberately fake.

Reset at any time with `rm -rf data && npm run seed`.

## Verify

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # builds, then node --test over dist/test
npm run build       # tsc
```

## Demo script (5 minutes)

1. **Checks fail loudly.** Select *Sedar Trading Ltd*. The Checks panel shows
   `EXPIRED_DOCUMENT` (proof of address expired) and `ENTITY_MISMATCH` (the tax
   certificate is issued to a different legal entity). *Assemble package* is disabled.
2. **A clean registration packages.** Select *Noor Logistics B.V.* — all four NL
   requirements are met. Click **Assemble package**: you get package v1 with a SHA-256
   fingerprint over its canonical manifest.
3. **Approval is bound, not general.** Switch to **Omar (approver)** and approve
   package v1 for `https://portal.registry.example/submit` and action
   `SUBMIT_NEW_REGISTRATION`. Try `http://169.254.169.254/latest/meta-data` first — it
   is refused by the URL policy. Priya cannot approve her own package.
4. **Live submission fails closed.** Switch to **Lena (submitter)**, queue with adapter
   `live`, click **Run worker tick** → `TERMINAL_FAILED / PORTAL_NO_ADAPTER`.
5. **Sandbox run.** Approve a second destination and submit with adapter `mock`:
   - `/submit` → `SUCCEEDED` with a sandbox receipt
   - `/captcha`, `/mfa`, `/declaration` → `HALTED`, never auto-resumed
   - `/flaky` → `RETRYABLE_FAILED`, then succeeds on the next tick
   - `/reject` → `TERMINAL_FAILED`
6. **Invalidation.** Register a replacement document (or amend the entity name). The
   package flips to `INVALIDATED` and its approval with it; submitting the old approval
   is refused.
7. **Audit.** *Load* then *Verify chain* — every step is recorded and the hash chain is
   intact. Edit any row in SQLite and verification reports the exact broken sequence.

## Architecture

```
public/index.html      one-file UI (vanilla JS, no build step)
src/db.ts              SQLite open + forward-only migration runner
src/audit.ts           sha256, canonical JSON, hash-chained audit append/verify
src/policy.ts          destination URL policy (static checks + DNS/SSRF check)
src/core.ts            intake, requirements, register, checks, packages, approvals
src/adapters.ts        portal adapters — live (fail-closed) and mock (sandbox only)
src/submissions.ts     queue, idempotency, submission state machine, worker tick
src/api.ts             Express routes + bearer auth
src/server.ts          entry point + polling worker
migrations/001_init.sql
```

Persistence is SQLite (`better-sqlite3`). Runtime dependencies: `express`,
`better-sqlite3`. Everything else is Node's standard library — crypto, DNS, and the
built-in test runner.

### The pipeline

**Intake** → every request carries a bearer token mapped to a user and role
(`preparer` / `approver` / `submitter` / `admin`).

**Requirements resolution** → `requirements` is a data table keyed by
`(reg_type, jurisdiction, doc_type)`; a jurisdiction-specific row overrides the `*`
fallback. NL business licences need a UBO declaration, GB ones do not.

**Controlled register** → one `ACTIVE` version per `(registration, doc_type)`, enforced
by a partial unique index. Registering a replacement supersedes the previous version and
bumps its version number. Nothing is deleted.

**Checks** → `MISSING_DOCUMENT`, `EXPIRED_DOCUMENT`, `ENTITY_MISMATCH`,
`DUPLICATE_CONTENT` (identical bytes registered twice) are blocking;
`UNEXPECTED_DOCUMENT` and missing optional documents are warnings. A package cannot be
assembled while a blocking finding exists.

**Package** → an immutable, versioned manifest (registration identity + each document's
type, version, filename and content hash) serialised as canonical JSON. The fingerprint
is `sha256(canonical(manifest))`, so it is reproducible and order-independent.

**Approval** → binds one tuple: `(registration, package, fingerprint, destination, action)`.
The destination is stored normalised (lower-cased host, default port dropped, fragment
dropped) so binding survives cosmetic rewrites but not real ones. The preparer of a
package may not approve it.

**Invalidation** → any change to the registration or its register moves every `READY`
package to `INVALIDATED` and cascades to its `VALID` approvals. On top of that, the
gate recomputes the fingerprint from the stored manifest, so editing the database
directly is caught as `MANIFEST_TAMPERED`.

**Submission** → queued with a required idempotency key. Replaying a key returns the
original submission; reusing it for a *different* intent is a `409` conflict. The
approval binding is checked at queue time **and again at execution time**, because the
register can change while a submission is queued.

```
QUEUED ──► RUNNING ──┬─► SUCCEEDED          (approval CONSUMED, registration SUBMITTED)
   ▲                 ├─► HALTED             (human gate — never auto-resumed)
   │                 ├─► RETRYABLE_FAILED ──┴─► TERMINAL_FAILED (budget exhausted)
   └─────────────────┘                      └─► TERMINAL_FAILED
```

Only these transitions are performed; anything else raises `ILLEGAL_TRANSITION`.

**Audit** → every state change appends a row whose hash covers the previous row's hash.
`GET /api/audit/verify` recomputes the chain and reports the first broken sequence
number. Refusals are audited too — a rejected submission leaves `SUBMISSION_REFUSED`
evidence rather than vanishing.

### Safety model

| Control | Where | Behaviour |
|---|---|---|
| No live submissions | `src/adapters.ts` | `live` always returns `TERMINAL_FAILED / PORTAL_NO_ADAPTER` |
| Simulation banned in production | `selectAdapter` | `NODE_ENV=production` + `mock` → `SIMULATION_FORBIDDEN_IN_PRODUCTION`, regardless of `ALLOW_SIMULATION` |
| Simulation off by default | `selectAdapter` | outside production the sandbox still needs `ALLOW_SIMULATION=true` |
| Destination allowlist | `src/policy.ts` | deny-by-default; https only, no userinfo, no IP literals, port 443 only, host allowlist (exact or `.suffix`) |
| SSRF / DNS rebinding | `checkHostAddresses` | every resolved address must be public; loopback, RFC1918, link-local, CGNAT, multicast and IPv6 ULA are refused |
| Human gates | adapters + state machine | CAPTCHA / MFA / legal declaration → `HALTED`; no adapter may answer them, and `HALTED` has no outgoing transition |
| Separation of duties | `createApproval` | approver role required, and never the package's preparer |
| Secrets | everywhere | none stored; the demo tokens are obvious fakes |

`PORTAL_DNS_CHECK` is `false` in `.env.example` because the demo hosts intentionally do
not resolve. Turn it on for any configuration pointing at a real host.

## API

All routes need `Authorization: Bearer <token>` except `GET /api/config`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/config` | actions, adapters, allowlist, whether simulation is allowed |
| GET/POST | `/api/registrations` | list / create |
| GET/PATCH | `/api/registrations/:id` | full detail bundle / amend — preparer only (invalidates packages) |
| POST | `/api/registrations/:id/documents` | register or replace a document |
| GET | `/api/registrations/:id/checks` | current findings |
| POST | `/api/registrations/:id/packages` | assemble a versioned package |
| POST | `/api/approvals` | approver only, bound to package + destination + action |
| POST | `/api/approvals/:id/revoke` | |
| POST | `/api/submissions` | submitter only; requires `idempotency_key` |
| POST | `/api/submissions/:id/run`, `/api/worker/tick` | drive the queue manually |
| GET | `/api/audit`, `/api/audit/verify` | trail and chain verification |

## Tests

`npm test` — 56 tests, `node --test` over the compiled output.

| File | Covers |
|---|---|
| `test/policy.test.ts` | scheme, credentials, IP literals, ports, allowlist deny-by-default, suffix rules, normalisation, private-range detection, DNS rebinding |
| `test/approval.test.ts` | approval binding to registration / package / fingerprint / destination / action, normalisation-tolerant matching, invalidation after document and entity changes, revocation, manifest tampering, separation of duties |
| `test/checks.test.ts` | requirement resolution, missing / expired / entity-mismatch / duplicate findings, optional-vs-mandatory, one active version per type, fingerprint changes with content |
| `test/submissions.test.ts` | happy path, `PORTAL_NO_ADAPTER`, production refusal of simulation, idempotent replay and key conflict, CAPTCHA/MFA/declaration halts that never auto-resume, retry then success, retry-budget exhaustion, terminal states, role enforcement, re-check at execution time, SSRF refusal at execution time |
| `test/audit.test.ts` | canonical JSON stability, evidence for every step, audited refusals, chain breakage on edit and on deletion |
| `test/api.test.ts` | authentication, config exposure, role enforcement over HTTP, end-to-end happy path, live fail-closed, UI served |

## Operational gaps

Known and deliberate; this is an MVP.

- **No portal adapter.** Real submission, portal session handling, receipts and
  polling for portal-side status do not exist.
- **Document contents are plain text stored inline.** No file upload, no virus
  scanning, no object storage, no encryption at rest, no content parsing — the register
  trusts the metadata the caller supplies (`expires_at`, `entity_name`) rather than
  extracting it from the document.
- **Auth is a static bearer token per seeded user.** No password login, no session
  expiry, no rotation, no rate limiting, no CSRF defence, no TLS termination.
- **The audit chain is tamper-*evident*, not tamper-*proof*.** It lives in the same
  database it protects; an attacker with write access could rebuild the whole chain.
  Anchoring (external notarisation, append-only storage) is not implemented.
- **Single-process worker.** An in-process `setInterval` polls the queue; there is no
  distributed lock, so two processes against one database would double-execute.
  `RUNNING` submissions are not recovered after a crash.
- **DNS check is not TOCTOU-safe.** Resolution happens before the request would be
  made; a real adapter needs to pin the resolved address for the connection itself and
  refuse redirects.
- **No retention, no PII handling, no multi-tenancy, no backups.**
