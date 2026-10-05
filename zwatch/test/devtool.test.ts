import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevtoolBackend } from '../src/devtool.ts';
import type { RunCommand } from '../src/devtool.ts';
import { createWalletFixture } from './helpers.ts';

test('driver sequences sync then enhance then read, deduplicates imports, persists metadata, and refuses failed sync snapshots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ghostpass-devtool-test-'));
  const commands: string[] = [];
  let fail = false;
  let active = 0;
  const run: RunCommand = async (_binary, args) => {
    assert.equal(active++, 0, 'devtool operations must never overlap');
    const command = args[3]!;
    try {
      commands.push(command);
      await new Promise(r => setTimeout(r, 5));
      if (command === 'init-fvk') { const db = createWalletFixture(join(args[2]!, 'data.sqlite')); db.close(); }
      if (command === 'sync' && fail) throw new Error('secret-key must not be echoed');
      if (command === 'balance') return JSON.stringify({ total: 0, sapling_spendable: 0, orchard_spendable: 0, ironwood_spendable: 0, transparent_spendable: 0, chain_tip_height: 100 });
      return '';
    } finally { active--; }
  };
  const config = { root, binary: 'fixture-devtool', server: 'zecrocks', intervalMs: 1_000_000, maxAgeMs: 1_000_000, run };
  const backend = new DevtoolBackend(config);
  await backend.start();
  try {
    const input = { name: 'merchant', ufvk: 'uview1testfixture', birthday: 90 };
    const ids = await Promise.all([backend.importAccount(input), backend.importAccount(input)]);
    assert.equal(ids[0], ids[1]);
    assert.equal(commands.filter(c => c === 'init-fvk').length, 1);
    await backend.refresh();
    // Wait for an already scheduled import refresh without introducing overlapping operations.
    for (let i = 0; i < 100 && !(await backend.health()).ready; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal((await backend.received(ids[0]!, 0)).complete, true);
    assert.ok(commands.indexOf('sync') < commands.indexOf('enhance'));
    assert.ok(commands.indexOf('enhance') < commands.indexOf('balance'));
    await assert.rejects(backend.importAccount({ ...input, birthday: 89 }), /account_birthday_conflict/);
    fail = true;
    await backend.refresh();
    await assert.rejects(backend.received(ids[0]!, 0), /account_not_synced/);
    assert.equal((await backend.health()).ready, false);
    await backend.close();
    const restarted = new DevtoolBackend({ ...config, run: async () => { throw new Error('offline'); } });
    await restarted.start();
    try { assert.equal(await restarted.importAccount(input), ids[0]); }
    finally { await restarted.close(); }
  } finally { await backend.close(); rmSync(root, { recursive: true, force: true }); }
});

test('two watcher processes cannot use the same wallet directory concurrently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ghostpass-devtool-test-'));
  const config = { root, binary: 'none', server: 'zecrocks', intervalMs: 1000000, maxAgeMs: 1000000 };
  const first = new DevtoolBackend(config);
  const second = new DevtoolBackend(config);
  await first.start();
  try { await assert.rejects(second.start(), /watcher_directory_locked/); }
  finally { await first.close(); rmSync(root, { recursive: true, force: true }); }
});
