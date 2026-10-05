import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { installPaymentTables, reconcilePayments, forgetIssuedPayments } from '../src/index.ts';
import type { ReceivedOutput } from '@ghostpass/watcher-contract';

const now = Date.now();
const code = 'A'.repeat(26);
function setup(expiresAt = now + 60_000) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE checkouts (
    claim_code TEXT PRIMARY KEY, plan TEXT NOT NULL, price_zat INTEGER NOT NULL,
    paid_zat INTEGER NOT NULL DEFAULT 0, min_conf INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT', expires_at INTEGER NOT NULL
  )`);
  db.prepare('INSERT INTO checkouts(claim_code, plan, price_zat, expires_at) VALUES (?, ?, ?, ?)').run(code, 'monthly', 500000, expiresAt);
  installPaymentTables(db);
  return db;
}
function output(overrides: Partial<ReceivedOutput> = {}): ReceivedOutput {
  return { txid: '1'.repeat(64), pool: 4, outIndex: 0, height: 99, confirmations: 2, valueZat: '500000', memoText: `GP1 ${code} monthly`, ...overrides };
}
function snapshot(outputs: ReceivedOutput[], extras: Record<string, unknown> = {}) {
  return { v: 1, accountId: 'merchant', mode: 'devtool', tipHeight: 100, sinceHeight: 0, complete: true, lastSyncAt: new Date(now).toISOString(), outputs, ...extras };
}
const options = { accountId: 'merchant', now };

test('checkout advances through detected to confirmed without counting repeat polls twice', () => {
  const db = setup();
  try {
    assert.equal(reconcilePayments(db, snapshot([output({ height: 100, confirmations: 1 })]), options)[0]?.status, 'DETECTED');
    assert.equal(reconcilePayments(db, snapshot([output()]), options)[0]?.status, 'CONFIRMED');
    assert.equal(reconcilePayments(db, snapshot([output()]), options)[0]?.paidZat, '500000');
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM payments').get(), { n: 1 });
  } finally { db.close(); }
});

test('underpayment plus top-up confirms; equal output indexes in distinct pools stay distinct', () => {
  const db = setup();
  try {
    const first = output({ valueZat: '300000' });
    assert.equal(reconcilePayments(db, snapshot([first]), options)[0]?.status, 'UNDERPAID');
    const result = reconcilePayments(db, snapshot([first, output({ pool: 3, valueZat: '200000' })]), options)[0];
    assert.equal(result?.status, 'CONFIRMED');
    assert.equal(result?.paidZat, '500000');
  } finally { db.close(); }
});

test('late payments advance an expired checkout', () => {
  const db = setup(now - 1000);
  try {
    assert.equal(reconcilePayments(db, snapshot([]), options)[0]?.status, 'EXPIRED');
    assert.equal(reconcilePayments(db, snapshot([output()]), options)[0]?.status, 'CONFIRMED');
  } finally { db.close(); }
});

test('orphaned payments roll confirmed checkouts back and can be re-mined later', () => {
  const db = setup();
  try {
    reconcilePayments(db, snapshot([output()]), options);
    const rolled = reconcilePayments(db, snapshot([], { tipHeight: 98 }), options)[0];
    assert.equal(rolled?.status, 'AWAITING_PAYMENT');
    assert.equal(rolled?.paidZat, '0');
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM payments').get(), { n: 0 });
    assert.equal(reconcilePayments(db, snapshot([output({ height: 100, confirmations: 1 })]), options)[0]?.status, 'DETECTED');
  } finally { db.close(); }
});

test('extra pending dust does not downgrade a fully covered confirmed payment', () => {
  const db = setup();
  try {
    const result = reconcilePayments(db, snapshot([output(), output({ txid: '2'.repeat(64), height: 100, confirmations: 1, valueZat: '1' })]), options)[0];
    assert.equal(result?.status, 'CONFIRMED');
    assert.equal(result?.confirmations, 2);
    assert.equal(result?.paidZat, '500001');
  } finally { db.close(); }
});

test('wrong-plan and unknown-code memos cannot credit a checkout', () => {
  const db = setup();
  try {
    assert.equal(reconcilePayments(db, snapshot([output({ memoText: `GP1 ${code} api100` })]), options)[0]?.paidZat, '0');
    assert.equal(reconcilePayments(db, snapshot([output({ memoText: `GP1 ${'B'.repeat(25)}A monthly` })]), options)[0]?.paidZat, '0');
  } finally { db.close(); }
});

test('issued checkouts retain their status and totals while their transaction ledger is removed', () => {
  const db = setup();
  try {
    reconcilePayments(db, snapshot([output()]), options);
    db.prepare("UPDATE checkouts SET status = 'ISSUED'").run();
    forgetIssuedPayments(db, code);
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM payments').get(), { n: 0 });
    reconcilePayments(db, snapshot([output(), output({ txid: '2'.repeat(64) })]), options);
    assert.deepEqual(db.prepare('SELECT status, paid_zat FROM checkouts').get(), { status: 'ISSUED', paid_zat: 500000 });
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM payments').get(), { n: 0 });
  } finally { db.close(); }
});

test('partial, stale, invalid, foreign-account, and unauthorized simulated snapshots leave the ledger unchanged', () => {
  const db = setup();
  try {
    reconcilePayments(db, snapshot([output()]), options);
    for (const bad of [
      snapshot([], { sinceHeight: 90 }), snapshot([], { complete: false }),
      snapshot([], { lastSyncAt: new Date(now - 300000).toISOString() }),
      snapshot([], { lastSyncAt: new Date(now + 300000).toISOString() }),
      snapshot([], { accountId: 'other' }), snapshot([], { mode: 'fixture' }),
      snapshot([output({ valueZat: '-1' })]), snapshot([output(), output()]),
    ]) assert.throws(() => reconcilePayments(db, bad, options));
    assert.deepEqual(db.prepare('SELECT status, paid_zat FROM checkouts').get(), { status: 'CONFIRMED', paid_zat: 500000 });
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM payments').get(), { n: 1 });
    assert.throws(() => reconcilePayments(db, snapshot([], { accountId: 'other' }), { ...options, accountId: 'other' }));
  } finally { db.close(); }
});

test('database failure rolls ledger replacement back atomically', () => {
  const db = setup();
  try {
    reconcilePayments(db, snapshot([output()]), options);
    db.exec("CREATE TRIGGER refuse_status BEFORE UPDATE ON checkouts BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => reconcilePayments(db, snapshot([]), options));
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM payments').get(), { n: 1 });
  } finally { db.close(); }
});

test('guide ledger without pool identity requires an explicit migration', () => {
  const db = setup();
  try {
    db.exec('DROP TABLE payments; CREATE TABLE payments(txid TEXT, out_index INTEGER, claim_code TEXT, PRIMARY KEY(txid, out_index))');
    assert.throws(() => installPaymentTables(db), /incompatible_payments_schema/);
  } finally { db.close(); }
});
