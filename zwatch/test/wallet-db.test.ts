import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWalletSnapshot } from '../src/wallet-db.ts';
import { createWalletFixture } from './helpers.ts';

test('wallet adapter joins mined height, reverses txid bytes, reads exact integers, and excludes change/transparent/sent outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghostpass-wallet-test-'));
  const path = join(dir, 'data.sqlite');
  const db = createWalletFixture(path);
  try {
    const txid = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    db.prepare('INSERT INTO transactions VALUES (1, ?, 99)').run(txid);
    const insert = db.prepare('INSERT INTO fixture_outputs VALUES (?, ?, ?, ?, ?, ?, ?)');
    const memo = Buffer.alloc(512);
    memo.write('zwatch test 1');
    insert.run(txid, 4, 0, 100000n, memo, Buffer.alloc(16), 0);
    insert.run(txid, 3, 0, 2100000000000000n, null, Buffer.alloc(16), 0);
    insert.run(txid, 4, 1, 99, memo, Buffer.alloc(16), 1);
    insert.run(txid, 0, 0, 99, null, Buffer.alloc(16), 0);
    insert.run(txid, 4, 2, 99, memo, null, 0);
    const result = readWalletSnapshot(path, 'merchant', 90);
    assert.equal(result.tipHeight, 100);
    assert.equal(result.outputs.length, 2);
    assert.equal(result.outputs.find(o => o.pool === 4)?.memoText, 'zwatch test 1');
    assert.equal(result.outputs[0]?.txid, Buffer.from(txid).reverse().toString('hex'));
    assert.equal(result.outputs[0]?.confirmations, 2);
    assert.equal(result.outputs.find(o => o.pool === 3)?.valueZat, '2100000000000000');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('partial scans and unsupported database schemas fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghostpass-wallet-test-'));
  const path = join(dir, 'data.sqlite');
  const db = createWalletFixture(path);
  try {
    db.prepare('UPDATE scan_queue SET block_range_start = 95').run();
    assert.throws(() => readWalletSnapshot(path, 'merchant', 90), /wallet_scan_incomplete/);
    db.prepare('UPDATE scan_queue SET block_range_start = 90, block_range_end = 99').run();
    db.prepare('INSERT INTO scan_queue VALUES(99, 101, 20)').run();
    assert.throws(() => readWalletSnapshot(path, 'merchant', 90), /wallet_scan_incomplete/);
    db.exec('DROP VIEW v_tx_outputs');
    db.prepare('DELETE FROM scan_queue WHERE priority = 20').run();
    assert.throws(() => readWalletSnapshot(path, 'merchant', 90), /wallet_schema_or_read_failed/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
