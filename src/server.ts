import { createApp } from './api.js';
import { openDb } from './db.js';
import { tick } from './submissions.js';

const db = openDb();
const port = Number(process.env.PORT ?? 3000);
const app = createApp(db);

app.listen(port, () => {
  console.log(`doc-agent listening on http://localhost:${port}`);
  console.log(`  NODE_ENV=${process.env.NODE_ENV ?? 'development'} ALLOW_SIMULATION=${process.env.ALLOW_SIMULATION ?? 'false'}`);
  console.log(`  portal allowlist: ${process.env.PORTAL_HOST_ALLOWLIST ?? '(empty — every destination is refused)'}`);
});

// ponytail: in-process polling worker. Swap for a real queue if more than one
// process ever needs to drain submissions.
const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 1000);
setInterval(() => {
  tick(db).catch((err) => console.error('worker tick failed:', err));
}, intervalMs).unref();
