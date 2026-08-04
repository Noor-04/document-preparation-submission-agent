/**
 * Demo seed data. The tokens below are obvious non-secrets for local use only —
 * never put a real credential in this file or in the database.
 */
import { addDocument, createRegistration, type User } from './core.js';
import { openDb, type DB } from './db.js';

export const DEMO_TOKENS = {
  preparer: 'demo-preparer-token',
  approver: 'demo-approver-token',
  submitter: 'demo-submitter-token',
} as const;

const USERS: User[] = [
  { id: 'u-priya', name: 'Priya (preparer)', role: 'preparer', token: DEMO_TOKENS.preparer },
  { id: 'u-omar', name: 'Omar (approver)', role: 'approver', token: DEMO_TOKENS.approver },
  { id: 'u-lena', name: 'Lena (submitter)', role: 'submitter', token: DEMO_TOKENS.submitter },
];

const REQUIREMENTS: [string, string, string, number, string][] = [
  ['BUSINESS_LICENSE', '*', 'CERTIFICATE_OF_INCORPORATION', 1, 'Certified copy, any age'],
  ['BUSINESS_LICENSE', '*', 'TAX_ID_CERTIFICATE', 1, 'Must be current'],
  ['BUSINESS_LICENSE', '*', 'PROOF_OF_ADDRESS', 1, 'Not older than 12 months'],
  ['BUSINESS_LICENSE', 'NL', 'UBO_DECLARATION', 1, 'NL only: ultimate beneficial owner register extract'],
  ['EXPORT_PERMIT', '*', 'CERTIFICATE_OF_INCORPORATION', 1, null as unknown as string],
  ['EXPORT_PERMIT', '*', 'GOODS_SCHEDULE', 1, 'HS-coded schedule of goods'],
  ['EXPORT_PERMIT', '*', 'INSURANCE_CERTIFICATE', 0, 'Optional but recommended'],
];

const days = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString();

export function seed(db: DB): void {
  if ((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n > 0) return;

  const insertUser = db.prepare('INSERT INTO users (id, name, role, token, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const u of USERS) insertUser.run(u.id, u.name, u.role, u.token, new Date().toISOString());

  const insertReq = db.prepare(
    'INSERT INTO requirements (reg_type, jurisdiction, doc_type, mandatory, notes) VALUES (?, ?, ?, ?, ?)',
  );
  for (const r of REQUIREMENTS) insertReq.run(...r);

  const preparer = USERS[0]!;

  // 1. A clean registration: every requirement met, nothing expired.
  const clean = createRegistration(db, preparer, {
    entity_name: 'Noor Logistics B.V.',
    entity_id: 'NL857123456B01',
    jurisdiction: 'NL',
    reg_type: 'BUSINESS_LICENSE',
  });
  const cleanEntity = { entity_name: clean.entity_name, entity_id: clean.entity_id };
  addDocument(db, preparer, clean.id, {
    doc_type: 'CERTIFICATE_OF_INCORPORATION',
    filename: 'incorporation.txt',
    content: 'CERTIFICATE OF INCORPORATION — Noor Logistics B.V. — KVK 87654321',
    ...cleanEntity,
    issued_at: days(-900),
    expires_at: null,
  });
  addDocument(db, preparer, clean.id, {
    doc_type: 'TAX_ID_CERTIFICATE',
    filename: 'vat.txt',
    content: 'VAT REGISTRATION — NL857123456B01 — valid',
    ...cleanEntity,
    issued_at: days(-200),
    expires_at: days(400),
  });
  addDocument(db, preparer, clean.id, {
    doc_type: 'PROOF_OF_ADDRESS',
    filename: 'address.txt',
    content: 'UTILITY STATEMENT — Havenweg 12, Rotterdam',
    ...cleanEntity,
    issued_at: days(-60),
    expires_at: days(300),
  });
  addDocument(db, preparer, clean.id, {
    doc_type: 'UBO_DECLARATION',
    filename: 'ubo.txt',
    content: 'UBO REGISTER EXTRACT — 2 beneficial owners recorded',
    ...cleanEntity,
    issued_at: days(-30),
    expires_at: days(150),
  });

  // 2. A registration that deliberately fails the checks (expired + wrong entity + missing doc).
  const messy = createRegistration(db, preparer, {
    entity_name: 'Sedar Trading Ltd',
    entity_id: 'GB123456789',
    jurisdiction: 'GB',
    reg_type: 'BUSINESS_LICENSE',
  });
  addDocument(db, preparer, messy.id, {
    doc_type: 'CERTIFICATE_OF_INCORPORATION',
    filename: 'incorporation-gb.txt',
    content: 'CERTIFICATE OF INCORPORATION — Sedar Trading Ltd — CRN 09876543',
    entity_name: 'Sedar Trading Ltd',
    entity_id: 'GB123456789',
    issued_at: days(-1200),
    expires_at: null,
  });
  addDocument(db, preparer, messy.id, {
    doc_type: 'TAX_ID_CERTIFICATE',
    filename: 'vat-wrong-entity.txt',
    content: 'VAT REGISTRATION — GB999999999 — Sedar Trading Holdings Ltd',
    entity_name: 'Sedar Trading Holdings Ltd', // entity mismatch on purpose
    entity_id: 'GB999999999',
    issued_at: days(-100),
    expires_at: days(200),
  });
  addDocument(db, preparer, messy.id, {
    doc_type: 'PROOF_OF_ADDRESS',
    filename: 'address-old.txt',
    content: 'UTILITY STATEMENT — 14 Dock Road, Hull',
    entity_name: 'Sedar Trading Ltd',
    entity_id: 'GB123456789',
    issued_at: days(-800),
    expires_at: days(-30), // expired on purpose
  });
}

if (process.argv[1]?.endsWith('seed.js')) {
  const db = openDb();
  seed(db);
  const n = (db.prepare('SELECT COUNT(*) AS n FROM registrations').get() as { n: number }).n;
  console.log(`seeded: ${n} registrations, demo tokens: ${Object.values(DEMO_TOKENS).join(', ')}`);
}
