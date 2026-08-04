import { openDb, type DB } from '../src/db.js';
import { seed } from '../src/seed.js';
import type { AppError, User } from '../src/core.js';

/** Run `fn`, require it to throw, and return the AppError it threw. */
export function thrown(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected the call to throw');
}

export const ALLOWLIST = ['portal.registry.example', '.gov.example'];

export const ENV: NodeJS.ProcessEnv = {
  PORTAL_HOST_ALLOWLIST: ALLOWLIST.join(','),
  ALLOW_SIMULATION: 'true',
};

export function testDb(): DB {
  const db = openDb(':memory:');
  seed(db);
  return db;
}

export function userByRole(db: DB, role: User['role']): User {
  return db.prepare('SELECT * FROM users WHERE role = ?').get(role) as User;
}

/** The seeded registration whose documents pass every check. */
export function cleanRegistrationId(db: DB): string {
  return (db.prepare("SELECT id FROM registrations WHERE jurisdiction = 'NL'").get() as { id: string }).id;
}

/** The seeded registration with an expired document and an entity mismatch. */
export function messyRegistrationId(db: DB): string {
  return (db.prepare("SELECT id FROM registrations WHERE jurisdiction = 'GB'").get() as { id: string }).id;
}
