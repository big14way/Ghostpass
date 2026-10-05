import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMemo, parsePaymentMemo, decimalZat, receivedSnapshot } from '../src/index.ts';

test('memo decoding respects binary markers, empty padding, and malformed UTF-8', () => {
  const memo = new Uint8Array(512);
  memo.set(new TextEncoder().encode('GP1 test'));
  assert.equal(decodeMemo(memo), 'GP1 test');
  for (const value of [null, new Uint8Array(512), Uint8Array.of(0xf6), Uint8Array.of(0xf5), Uint8Array.of(0xc3, 0x28), new Uint8Array(513)]) {
    assert.equal(decodeMemo(value), null);
  }
});

test('GP1 parser rejects injection, noncanonical claim codes, and malformed plan IDs', () => {
  const code = 'A'.repeat(26);
  assert.deepEqual(parsePaymentMemo(`GP1 ${code} monthly`), { claimCode: code, planId: 'monthly' });
  for (const text of [`GP1 ${code} monthly\n`, `GP1 ${'Z'.repeat(26)} monthly`, `GP1 ${code} api-100`, `GP1 ${code} monthly extra`, null]) {
    assert.equal(parsePaymentMemo(text), null);
  }
});

test('amounts stay decimal strings with a Zcash money bound', () => {
  assert.equal(decimalZat('2100000000000000'), '2100000000000000');
  for (const input of ['-1', '1.0', '01', 500000, '2100000000000001']) assert.throws(() => decimalZat(input));
});

test('snapshot validator catches wrong confirmations, incomplete data, and duplicate pool output IDs', () => {
  const output = { txid: '1'.repeat(64), pool: 4, outIndex: 0, height: 9, confirmations: 2, valueZat: '500000', memoText: null };
  const s = { v: 1, accountId: 'merchant', mode: 'devtool', tipHeight: 10, sinceHeight: 0, complete: true, lastSyncAt: new Date().toISOString(), outputs: [output] };
  assert.equal(receivedSnapshot(s).outputs.length, 1);
  assert.throws(() => receivedSnapshot({ ...s, complete: false }));
  assert.throws(() => receivedSnapshot({ ...s, outputs: [output, output] }));
  assert.throws(() => receivedSnapshot({ ...s, outputs: [{ ...output, confirmations: 3 }] }));
  assert.throws(() => receivedSnapshot({ ...s, outputs: [{ ...output, pool: 0 }] }));
  assert.equal(receivedSnapshot({ ...s, outputs: [output, { ...output, pool: 3 }] }).outputs.length, 2);
});
