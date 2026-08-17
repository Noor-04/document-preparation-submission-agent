import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../src/api.js';
import { DEMO_TOKENS } from '../src/seed.js';
import { ENV, testDb } from './support.js';

async function withServer(fn: (call: Call, base: string) => Promise<void>): Promise<void> {
  const db = testDb();
  const server = createApp(db, { env: ENV }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: Call = async (path, token, method = 'GET', body?) => {
    const res = await fetch(base + path, {
      method,
      headers: token
        ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
        : { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  try {
    await fn(call, base);
  } finally {
    server.close();
    db.close();
  }
}

type Call = (
  path: string,
  token?: string,
  method?: string,
  body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

test('the API rejects unauthenticated and unknown-token callers', async () => {
  await withServer(async (call) => {
    assert.equal((await call('/api/registrations')).status, 401);
    assert.equal((await call('/api/registrations', 'not-a-real-token')).status, 401);
    assert.equal((await call('/api/registrations', DEMO_TOKENS.preparer)).status, 200);
  });
});

test('the API advertises its safety configuration', async () => {
  await withServer(async (call) => {
    const { body } = await call('/api/config');
    assert.deepEqual(body.adapters, ['live', 'mock']);
    assert.equal(body.production, false);
    assert.equal(body.simulation_allowed, true);
  });
});

test('roles are enforced over HTTP', async () => {
  await withServer(async (call) => {
    const list = (await call('/api/registrations', DEMO_TOKENS.preparer)).body as unknown as
      { id: string; jurisdiction: string }[];
    assert.ok(list.length >= 2);
    const nl = list.find((r) => r.jurisdiction === 'NL')!;
    const pkg = await call(`/api/registrations/${nl.id}/packages`, DEMO_TOKENS.preparer, 'POST');
    assert.equal(pkg.status, 201);

    const selfApprove = await call('/api/approvals', DEMO_TOKENS.preparer, 'POST', {
      package_id: pkg.body.id,
      destination_url: 'https://portal.registry.example/submit',
      action: 'SUBMIT_NEW_REGISTRATION',
    });
    assert.equal(selfApprove.status, 403);
    assert.equal(selfApprove.body.error, 'APPROVER_ROLE_REQUIRED');

    const amend = { entity_name: 'Noor Logistics Holding B.V.' };
    for (const token of [DEMO_TOKENS.approver, DEMO_TOKENS.submitter]) {
      const refused = await call(`/api/registrations/${nl.id}`, token, 'PATCH', amend);
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, 'PREPARER_ROLE_REQUIRED');
    }
    assert.equal((await call(`/api/registrations/${nl.id}`, DEMO_TOKENS.preparer, 'PATCH', amend)).status, 200);
  });
});

test('the happy path works end to end over HTTP', async () => {
  await withServer(async (call) => {
    const list = (await call('/api/registrations', DEMO_TOKENS.preparer)).body as unknown as
      { id: string; jurisdiction: string }[];
    const reg = list.find((r) => r.jurisdiction === 'NL')!;

    const checks = await call(`/api/registrations/${reg.id}/checks`, DEMO_TOKENS.preparer);
    assert.deepEqual(checks.body, [] as unknown as Record<string, unknown>);

    const pkg = await call(`/api/registrations/${reg.id}/packages`, DEMO_TOKENS.preparer, 'POST');
    const approval = await call('/api/approvals', DEMO_TOKENS.approver, 'POST', {
      package_id: pkg.body.id,
      destination_url: 'https://portal.registry.example/submit',
      action: 'SUBMIT_NEW_REGISTRATION',
    });
    assert.equal(approval.status, 201);

    const intent = {
      registration_id: reg.id,
      package_id: pkg.body.id,
      approval_id: approval.body.id,
      destination_url: 'https://portal.registry.example/submit',
      action: 'SUBMIT_NEW_REGISTRATION',
      adapter: 'mock',
      idempotency_key: 'http-demo-1',
    };
    const queued = await call('/api/submissions', DEMO_TOKENS.submitter, 'POST', intent);
    assert.equal(queued.status, 201);

    const replay = await call('/api/submissions', DEMO_TOKENS.submitter, 'POST', intent);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.id, queued.body.id);

    const ran = await call('/api/worker/tick', DEMO_TOKENS.submitter, 'POST');
    assert.equal(ran.body.state, 'SUCCEEDED');

    const verified = await call('/api/audit/verify', DEMO_TOKENS.submitter);
    assert.equal(verified.body.ok, true);
  });
});

test('a live submission over HTTP fails closed', async () => {
  await withServer(async (call) => {
    const list = (await call('/api/registrations', DEMO_TOKENS.preparer)).body as unknown as
      { id: string; jurisdiction: string }[];
    const reg = list.find((r) => r.jurisdiction === 'NL')!;
    const pkg = await call(`/api/registrations/${reg.id}/packages`, DEMO_TOKENS.preparer, 'POST');
    const approval = await call('/api/approvals', DEMO_TOKENS.approver, 'POST', {
      package_id: pkg.body.id,
      destination_url: 'https://portal.registry.example/submit',
      action: 'SUBMIT_NEW_REGISTRATION',
    });
    const queued = await call('/api/submissions', DEMO_TOKENS.submitter, 'POST', {
      registration_id: reg.id,
      package_id: pkg.body.id,
      approval_id: approval.body.id,
      destination_url: 'https://portal.registry.example/submit',
      action: 'SUBMIT_NEW_REGISTRATION',
      adapter: 'live',
      idempotency_key: 'http-live-1',
    });
    const ran = await call(`/api/submissions/${queued.body.id}/run`, DEMO_TOKENS.submitter, 'POST');
    assert.equal(ran.body.state, 'TERMINAL_FAILED');
    assert.equal(ran.body.outcome_code, 'PORTAL_NO_ADAPTER');
  });
});

test('the UI is served', async () => {
  await withServer(async (_call, base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Document Preparation/);
  });
});
