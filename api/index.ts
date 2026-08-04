import { createApp } from '../src/api.js';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';

// Vercel Functions have an ephemeral writable /tmp directory. This deployment
// is an evaluation sandbox: data may reset on a cold start and is never a
// substitute for the production database described in the README.
const db = openDb(process.env.DB_FILE ?? '/tmp/document-agent-demo.db');
seed(db);

export default createApp(db, {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    ALLOW_SIMULATION: 'false',
  },
});
