import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** Open a database and apply any migrations it has not seen yet. */
export function openDb(file = process.env.DB_FILE ?? 'data/app.db'): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => (r as { name: string }).name),
  );
  for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    db.exec(readFileSync(join(migrationsDir, name), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
  }
}
