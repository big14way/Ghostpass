import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unpublishedKeys } from '../packages/demo-web/src/index.ts';

async function stub(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => handler(req, body, res));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function run(script: string, args: string[], env: Record<string, string>, input: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(done => {
    const child = execFile(process.execPath, ['--import', 'tsx', script, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GP_DEV_FAKE_PAYMENTS: '0', ...env },
    }, (error, stdout, stderr) => done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
    child.stdin?.end(input);
  });
}

const entry = (merchant: string, period: string, c: string) => ({ merchant, period, spkiSha256: c.repeat(64) });

test('unpublishedKeys reports local keys the public log lacks or contradicts, ignoring expired periods and other merchants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghostpass-keylog-'));
  let published: unknown = { v: 1, keys: [entry('M', '2026-10', 'a'), entry('M', '2026-09', 'f')] };
  let status = 200;
  const { server, base } = await stub((_req, _body, res) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(published)); });
  try {
    const local = join(dir, 'KEYS.json');
    writeFileSync(local, JSON.stringify({ v: 1, keys: [entry('M', '2026-09', 'e'), entry('M', '2026-10', 'a'), entry('M', '2026-11', 'b'), entry('Other', '2026-10', 'c')] }));
    const now = Date.UTC(2026, 9, 20);
    assert.deepEqual(await unpublishedKeys(local, base, ['M'], now), [entry('M', '2026-11', 'b')]);
    published = { v: 1, keys: [entry('M', '2026-10', 'd'), entry('M', '2026-11', 'b')] };
    assert.deepEqual(await unpublishedKeys(local, base, ['M'], now), [entry('M', '2026-10', 'a')]);
    published = { v: 1, keys: [entry('M', '2026-10', 'a'), entry('M', '2026-10', 'a'), entry('M', '2026-11', 'b')] };
    assert.deepEqual(await unpublishedKeys(local, base, ['M'], now), [entry('M', '2026-10', 'a')]);
    status = 404;
    await assert.rejects(unpublishedKeys(local, base, ['M'], now), /HTTP 404/);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('import:viewing-key sends the piped key to zwatch and never prints it', async () => {
  const ufvk = `uview1${'q'.repeat(200)}`;
  const requests: { auth: string | undefined; body: string }[] = [];
  const { server, base } = await stub((req, body, res) => {
    requests.push({ auth: req.headers.authorization, body });
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ accountId: 'acct-123' }));
  });
  const token = 't'.repeat(32);
  try {
    const ok = await run('scripts/import-viewing-key.ts', ['--birthday', '3500000'], { ZWATCH_URL: base, ZWATCH_API_TOKEN: token },
      `Account 0\n  UFVK: ${ufvk}\n  UIVK: uivk1zzzz\n`);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /^MERCHANT_ACCOUNT_ID=acct-123$/m);
    assert.doesNotMatch(ok.stdout + ok.stderr, /q{20}/);
    assert.deepEqual(requests, [{ auth: `Bearer ${token}`, body: JSON.stringify({ name: 'merchant', ufvk, birthday: 3_500_000 }) }]);

    for (const input of ['no key here', `${ufvk}\nuview1${'z'.repeat(200)}`, `uviewtest1${'q'.repeat(200)}`]) {
      const bad = await run('scripts/import-viewing-key.ts', ['--birthday', '3500000'], { ZWATCH_URL: base, ZWATCH_API_TOKEN: token }, input);
      assert.notEqual(bad.code, 0);
      assert.doesNotMatch(bad.stdout + bad.stderr, /q{20}|z{20}/);
    }
    const remote = await run('scripts/import-viewing-key.ts', ['--birthday', '3500000'], { ZWATCH_URL: 'http://example.com:8787', ZWATCH_API_TOKEN: token }, ufvk);
    assert.match(remote.stderr, /loopback/);
    assert.equal(requests.length, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('check:deploy validates production settings and zwatch, and fails until the key log exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghostpass-check-'));
  const token = 't'.repeat(32);
  const { server, base } = await stub((req, _body, res) => {
    if (req.url === '/health') return void res.writeHead(200).end(JSON.stringify({ v: 1, mode: 'devtool', tipHeight: 3500000, ready: true }));
    const authorized = req.headers.authorization === `Bearer ${token}`;
    res.writeHead(authorized && req.url === '/accounts/acct-1/balance' ? 200 : 401).end(JSON.stringify({ confirmedZat: '0', pendingZat: '0', tipHeight: 3500000 }));
  });
  const env = {
    MERCHANT_UA: 'u1merchant', GP_KEK_HEX: 'ab'.repeat(32), ZWATCH_URL: base, MERCHANT_ACCOUNT_ID: 'acct-1', ZWATCH_API_TOKEN: token,
    GP_KEYS_URL: 'https://example.invalid/KEYS.json', GP_KEYS_LOG: join(dir, 'KEYS.json'), GP_ADMIN_PASSWORD: 'p'.repeat(16),
    GP_NEWSLETTER_DB: join(dir, 'newsletter.sqlite'), GP_API_DEMO_DB: join(dir, 'api-demo.sqlite'),
  };
  try {
    const result = await run('scripts/check-deploy.ts', [], env, '');
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^ok {3}The Quiet Letter settings$/m);
    assert.match(result.stdout, /^ok {3}Private Price API settings$/m);
    assert.match(result.stdout, /^ok {3}GP_ADMIN_PASSWORD$/m);
    assert.match(result.stdout, /^ok {3}zwatch is running, synced, and using the real wallet backend/m);
    assert.match(result.stdout, /^ok {3}zwatch accepts the API token and knows MERCHANT_ACCOUNT_ID/m);
    assert.match(result.stdout, /^FAIL key log: .* does not exist yet/m);
    assert.doesNotMatch(result.stdout, /(ab){32}|t{32}|p{16}/);

    const broken = await run('scripts/check-deploy.ts', [], { ...env, GP_KEK_HEX: 'short', GP_ADMIN_PASSWORD: 'short', MERCHANT_ACCOUNT_ID: 'other' }, '');
    assert.equal(broken.code, 1);
    assert.match(broken.stdout, /^FAIL The Quiet Letter settings: GP_KEK_HEX must be 32 bytes of hex/m);
    assert.match(broken.stdout, /^FAIL GP_ADMIN_PASSWORD: must be at least 16 characters$/m);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
