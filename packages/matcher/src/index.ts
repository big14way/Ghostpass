import type Database from 'better-sqlite3';
import { receivedSnapshot, parsePaymentMemo, decimalZat, integer, WatcherError } from '@ghostpass/watcher-contract';
import type { CheckoutStatus, ReceivedOutput } from '@ghostpass/watcher-contract';

interface Checkout { claim_code: string; plan: string; price_zat: bigint; expires_at: number; status: CheckoutStatus }
export interface MatchResult { claimCode: string; status: CheckoutStatus; paidZat: string; confirmations: number }
export interface MatchOptions {
  accountId: string;
  allowFixture?: boolean;
  now?: number;
  maxSnapshotAgeMs?: number;
  requiredConfirmations?: number;
}

/** Call after the lead's checkouts table exists. Never silently upgrade an incompatible ledger. */
export function installPaymentTables(db: Database.Database): void {
  const checkoutColumns = db.prepare('PRAGMA table_info(checkouts)').all() as { name: string }[];
  for (const name of ['claim_code', 'plan', 'price_zat', 'paid_zat', 'min_conf', 'status', 'expires_at']) {
    if (!checkoutColumns.some(c => c.name === name)) throw new Error(`checkouts_missing_${name}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      txid TEXT NOT NULL, pool INTEGER NOT NULL, out_index INTEGER NOT NULL,
      claim_code TEXT NOT NULL REFERENCES checkouts(claim_code),
      value_zat INTEGER NOT NULL, confirmations INTEGER NOT NULL,
      height INTEGER NOT NULL, PRIMARY KEY (txid, pool, out_index)
    );
    CREATE INDEX IF NOT EXISTS payments_claim ON payments(claim_code);
    CREATE TABLE IF NOT EXISTS matcher_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  const columns = db.prepare('PRAGMA table_info(payments)').all() as { name: string; pk: number }[];
  if (['txid', 'pool', 'out_index'].some((name, i) => !columns.some(c => c.name === name && c.pk === i + 1)) ||
      !columns.some(c => c.name === 'height')) throw new Error('incompatible_payments_schema');
}

/** Full wallet snapshots reconcile orphaned outputs even outside a fixed reorg lookback window. */
export function reconcilePayments(db: Database.Database, raw: unknown, options: MatchOptions): MatchResult[] {
  const snapshot = receivedSnapshot(raw);
  if (snapshot.accountId !== options.accountId) throw new WatcherError('account_mismatch');
  if (snapshot.sinceHeight !== 0) throw new WatcherError('full_snapshot_required');
  if (snapshot.mode === 'fixture' && options.allowFixture !== true) throw new WatcherError('simulated_payments_disabled');
  if (snapshot.mode === 'fixture' && process.env.NODE_ENV === 'production') throw new WatcherError('simulated_payments_in_production');
  const now = options.now ?? Date.now();
  const age = now - Date.parse(snapshot.lastSyncAt);
  if (age < -30_000 || age > (options.maxSnapshotAgeMs ?? 120_000)) throw new WatcherError('stale_snapshot');
  const required = integer(options.requiredConfirmations ?? 2, 'required_confirmations');
  if (!required) throw new WatcherError('invalid_required_confirmations');

  const transaction = db.transaction((): MatchResult[] => {
    const binding = db.prepare("SELECT v FROM matcher_meta WHERE k = 'account_id'").get() as { v: string } | undefined;
    if (binding && binding.v !== snapshot.accountId) throw new WatcherError('database_account_mismatch');
    db.prepare("INSERT OR IGNORE INTO matcher_meta(k, v) VALUES ('account_id', ?)").run(snapshot.accountId);
    const select = db.prepare('SELECT claim_code, plan, price_zat, expires_at, status FROM checkouts');
    select.safeIntegers(true);
    const checkouts = select.all() as (Omit<Checkout, 'expires_at'> & { expires_at: bigint })[];
    const byCode = new Map(checkouts.map(c => [c.claim_code, c]));
    const grouped = new Map<string, ReceivedOutput[]>();

    // Rebuild the ledger inside the same transaction as status updates. Failures leave the previous state intact.
    db.prepare('DELETE FROM payments').run();
    const insert = db.prepare('INSERT INTO payments(txid, pool, out_index, claim_code, value_zat, confirmations, height) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const o of snapshot.outputs) {
      const memo = parsePaymentMemo(o.memoText);
      if (!memo) continue;
      const checkout = byCode.get(memo.claimCode);
      if (!checkout || checkout.plan !== memo.planId || checkout.status === 'ISSUED' || BigInt(o.valueZat) === 0n) continue;
      insert.run(o.txid, o.pool, o.outIndex, checkout.claim_code, BigInt(o.valueZat), o.confirmations, o.height);
      const payments = grouped.get(checkout.claim_code) ?? [];
      payments.push(o);
      grouped.set(checkout.claim_code, payments);
    }

    const update = db.prepare('UPDATE checkouts SET paid_zat = ?, min_conf = ?, status = ? WHERE claim_code = ? AND status <> ?');
    const results: MatchResult[] = [];
    for (const co of checkouts) {
      if (co.status === 'ISSUED') continue;
      const price = BigInt(decimalZat(co.price_zat.toString()));
      if (!price) throw new Error('invalid_checkout_price');
      const payments = (grouped.get(co.claim_code) ?? []).sort((a, b) => b.confirmations - a.confirmations);
      const paid = payments.reduce((sum, p) => sum + BigInt(p.valueZat), 0n);
      // A later unconfirmed overpayment must not reduce the confirmations of funds that already cover the price.
      let covered = 0n;
      let confirmations = 0;
      for (const payment of payments) {
        covered += BigInt(payment.valueZat);
        confirmations = payment.confirmations;
        if (covered >= price) break;
      }
      const status: CheckoutStatus = paid === 0n ? (co.expires_at < BigInt(now) ? 'EXPIRED' : 'AWAITING_PAYMENT') :
        paid < price ? 'UNDERPAID' : confirmations >= required ? 'CONFIRMED' : 'DETECTED';
      update.run(paid, confirmations, status, co.claim_code, 'ISSUED');
      results.push({ claimCode: co.claim_code, status, paidZat: paid.toString(), confirmations });
    }
    db.prepare("INSERT INTO matcher_meta(k, v) VALUES ('tip_height', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(snapshot.tipHeight));
    return results;
  });
  return transaction.immediate();
}

/** The issuer should call this inside its own successful issuance transaction. */
export function forgetIssuedPayments(db: Database.Database, claimCode: string): void {
  db.prepare("DELETE FROM payments WHERE claim_code = ? AND EXISTS(SELECT 1 FROM checkouts WHERE claim_code = ? AND status = 'ISSUED')").run(claimCode, claimCode);
}

export async function fetchReceivedSnapshot(base: string, accountId: string, token: string): Promise<unknown> {
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new WatcherError('watcher_must_be_loopback');
  }
  url.pathname = `/accounts/${encodeURIComponent(accountId)}/received`;
  url.search = 'sinceHeight=0';
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new WatcherError('watcher_unavailable', 503);
  // Bound reads even when the upstream response has no Content-Length.
  const reader = response.body?.getReader();
  if (!reader) throw new WatcherError('empty_watcher_response', 503);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16 * 1024 * 1024) throw new WatcherError('watcher_response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel(); }
}
