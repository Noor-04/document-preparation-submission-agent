import express, { type NextFunction, type Request, type Response } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_NAMES } from './adapters.js';
import { auditTrail, verifyAudit } from './audit.js';
import {
  ACTIONS,
  AppError,
  activeDocuments,
  addDocument,
  allDocuments,
  buildPackage,
  createApproval,
  createRegistration,
  getRegistration,
  listPackages,
  resolveRequirements,
  revokeApproval,
  runChecks,
  updateRegistration,
  type ApprovalRow,
  type User,
} from './core.js';
import type { DB } from './db.js';
import { allowlistFromEnv } from './policy.js';
import { getSubmission, listSubmissions, processSubmission, queueSubmission, tick, type Env } from './submissions.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

const h =
  (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };

const actor = (req: Request): User => {
  if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'missing or unknown bearer token');
  return req.user;
};

export function createApp(db: DB, opts: Env = {}): express.Express {
  const env = opts.env ?? process.env;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use((req, _res, next) => {
    const token = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (token) {
      req.user = db.prepare('SELECT * FROM users WHERE token = ?').get(token) as User | undefined;
    }
    next();
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      actions: ACTIONS,
      adapters: ADAPTER_NAMES,
      allowlist: allowlistFromEnv(env),
      simulation_allowed: env.NODE_ENV !== 'production' && env.ALLOW_SIMULATION === 'true',
      production: env.NODE_ENV === 'production',
    });
  });

  app.get('/api/me', h((req, res) => {
    const u = actor(req);
    res.json({ id: u.id, name: u.name, role: u.role });
  }));

  app.get('/api/registrations', h((req, res) => {
    actor(req);
    res.json(db.prepare('SELECT * FROM registrations ORDER BY created_at DESC').all());
  }));

  app.post('/api/registrations', h((req, res) => {
    res.status(201).json(createRegistration(db, actor(req), req.body));
  }));

  app.get('/api/registrations/:id', h((req, res) => {
    actor(req);
    const id = req.params.id as string;
    const registration = getRegistration(db, id);
    res.json({
      registration,
      requirements: resolveRequirements(db, registration.reg_type, registration.jurisdiction),
      documents: allDocuments(db, id),
      active_documents: activeDocuments(db, id),
      findings: runChecks(db, id),
      packages: listPackages(db, id),
      approvals: db
        .prepare('SELECT * FROM approvals WHERE registration_id = ? ORDER BY created_at DESC')
        .all(id) as ApprovalRow[],
      submissions: listSubmissions(db, id),
    });
  }));

  app.patch('/api/registrations/:id', h((req, res) => {
    res.json(updateRegistration(db, actor(req), req.params.id as string, req.body));
  }));

  app.post('/api/registrations/:id/documents', h((req, res) => {
    res.status(201).json(addDocument(db, actor(req), req.params.id as string, req.body));
  }));

  app.get('/api/registrations/:id/checks', h((req, res) => {
    actor(req);
    res.json(runChecks(db, req.params.id as string));
  }));

  app.post('/api/registrations/:id/packages', h((req, res) => {
    res.status(201).json(buildPackage(db, actor(req), req.params.id as string));
  }));

  app.post('/api/approvals', h((req, res) => {
    res.status(201).json(createApproval(db, actor(req), req.body, allowlistFromEnv(env)));
  }));

  app.post('/api/approvals/:id/revoke', h((req, res) => {
    res.json(revokeApproval(db, actor(req), req.params.id as string, req.body?.reason ?? 'revoked by approver'));
  }));

  app.get('/api/submissions', h((req, res) => {
    actor(req);
    res.json(listSubmissions(db, req.query.registration_id as string | undefined));
  }));

  app.post('/api/submissions', h((req, res) => {
    const { submission, replayed } = queueSubmission(db, actor(req), req.body, opts);
    res.status(replayed ? 200 : 201).json({ ...submission, replayed });
  }));

  app.post('/api/submissions/:id/run', h(async (req, res) => {
    actor(req);
    res.json(await processSubmission(db, req.params.id as string, opts));
  }));

  app.get('/api/submissions/:id', h((req, res) => {
    actor(req);
    res.json(getSubmission(db, req.params.id as string));
  }));

  app.post('/api/worker/tick', h(async (req, res) => {
    actor(req);
    res.json((await tick(db, opts)) ?? { message: 'nothing queued' });
  }));

  app.get('/api/audit', h((req, res) => {
    actor(req);
    res.json(auditTrail(db, req.query.subject_id as string | undefined));
  }));

  app.get('/api/audit/verify', h((req, res) => {
    actor(req);
    res.json(verifyAudit(db));
  }));

  app.use(express.static(publicDir));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message });
  });

  return app;
}
