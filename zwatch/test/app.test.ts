import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { createWatcherApp } from '../src/app.ts';
import { FixtureBackend } from '../src/fixture.ts';
import { fetchReceivedSnapshot } from '../../packages/matcher/src/index.ts';
import { installPaymentTables } from '../../packages/matcher/src/index.ts';
import { PaymentMatcher } from '../../packages/matcher/src/poller.ts';
import Database from 'better-sqlite3';

const token = 'ghostpass-local-demo';
const auth = { Authorization: `Bearer ${token}` };

test('watcher HTTP contract, authentication, loopback policy, and strict query validation', async () => {
  const backend = new FixtureBackend(resolve('fixtures/watcher.json'));
  const server = createWatcherApp(backend, token).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { mode: string }).mode, 'fixture');
    assert.equal((await fetch(`${base}/accounts/fixture-merchant/balance`)).status, 401);
    assert.equal((await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const foreignHost = await new Promise<number>((done, reject) => {
      const req = request(`${base}/health`, { headers: { Host: 'evil.example' } }, res => { res.resume(); done(res.statusCode!); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(foreignHost, 403);
    const imported = await fetch(`${base}/accounts`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'merchant', ufvk: 'fixture-only', birthday: 3428100 }),
    });
    assert.equal(imported.status, 201);
    assert.deepEqual(await imported.json(), { accountId: 'fixture-merchant' });
    const balance = await fetch(`${base}/accounts/fixture-merchant/balance`, { headers: auth });
    assert.deepEqual(await balance.json(), { confirmedZat: '500000', pendingZat: '0', tipHeight: 3428200 });
    const snapshot = await fetchReceivedSnapshot(base, 'fixture-merchant', token) as { outputs: unknown[]; sinceHeight: number };
    assert.equal(snapshot.outputs.length, 2);
    assert.equal(snapshot.sinceHeight, 0);
    for (const query of ['-1', '1.5', '01', '4294967296', '1&sinceHeight=2']) {
      assert.equal((await fetch(`${base}/accounts/fixture-merchant/received?sinceHeight=${query}`, { headers: auth })).status, 400);
    }
    assert.equal((await fetch(`${base}/accounts/missing/received`, { headers: auth })).status, 404);
    const filtered = await fetch(`${base}/accounts/fixture-merchant/received?sinceHeight=3428200`, { headers: auth });
    assert.deepEqual((await filtered.json() as { outputs: unknown[] }).outputs, []);
    const malformed = await fetch(`${base}/accounts`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{invalid' });
    assert.equal(malformed.status, 400);
    const realKey = await fetch(`${base}/accounts`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'merchant', ufvk: 'uview1secret', birthday: 100 }),
    });
    assert.equal(realKey.status, 400);
    assert.ok(!(await realKey.text()).includes('secret'));
  } finally { await new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done())); }
});

test('simulated watcher refuses production and client refuses non-loopback URLs', async () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { assert.throws(() => new FixtureBackend('fixtures/watcher.json'), /simulated_payments_in_production/); }
  finally { if (prior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prior; }
  await assert.rejects(fetchReceivedSnapshot('https://public.example', 'merchant', token), /watcher_must_be_loopback/);
});

test('poller coalesces simultaneous calls and settles pending work before shutdown', async () => {
  const backend = new FixtureBackend(resolve('fixtures/watcher.json'));
  const read = backend.received.bind(backend);
  let calls = 0;
  backend.received = async (...args) => { calls++; await new Promise(r => setTimeout(r, 10)); return read(...args); };
  const server = createWatcherApp(backend, token).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE checkouts (
    claim_code TEXT PRIMARY KEY, plan TEXT NOT NULL, price_zat INTEGER NOT NULL,
    paid_zat INTEGER NOT NULL DEFAULT 0, min_conf INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT', expires_at INTEGER NOT NULL
  )`);
  db.prepare('INSERT INTO checkouts(claim_code, plan, price_zat, expires_at) VALUES (?, ?, ?, ?)').run('A'.repeat(26), 'monthly', 500000, Date.now() + 60000);
  installPaymentTables(db);
  const matcher = new PaymentMatcher({ db, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, accountId: 'fixture-merchant', token, allowFixture: true });
  try {
    const first = matcher.runOnce();
    assert.equal(matcher.runOnce(), first);
    assert.equal((await first)[0]?.status, 'CONFIRMED');
    assert.equal(calls, 1);
    matcher.start();
    matcher.start();
    await matcher.stop();
    assert.equal(calls, 2);
  } finally {
    await matcher.stop();
    db.close();
    await new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done()));
  }
});
