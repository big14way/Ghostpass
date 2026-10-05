import Database from 'better-sqlite3';
import { decodeMemo, integer, receivedSnapshot, WatcherError } from '@ghostpass/watcher-contract';
import type { ReceivedSnapshot } from '@ghostpass/watcher-contract';

interface WalletRow {
  txid: Buffer; output_pool: bigint; output_index: bigint; value: bigint;
  memo: Buffer | null; mined_height: bigint;
}

/** SQL adapter for the schema in zcash_client_sqlite 0.22.0. It never writes to the wallet. */
export function readWalletSnapshot(path: string, accountId: string, birthday: number): ReceivedSnapshot {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    db.exec('BEGIN');
    // v_tx_outputs does NOT contain mined_height: join the transaction table.
    const tip = db.prepare('SELECT MAX(block_range_end) - 1 AS height FROM scan_queue').get() as { height: number | null };
    if (tip.height === null) throw new WatcherError('wallet_not_synced', 503);
    const tipHeight = integer(tip.height, 'tip_height');
    const scanned = db.prepare('SELECT block_range_start AS start, block_range_end AS end FROM scan_queue WHERE priority = 10 ORDER BY block_range_start LIMIT 1').get() as { start: number; end: number } | undefined;
    if (!scanned || scanned.start > birthday || scanned.end <= tipHeight) throw new WatcherError('wallet_scan_incomplete', 503);
    const rows = db.prepare(`
      SELECT o.txid, o.output_pool, o.output_index, o.value, o.memo, t.mined_height
      FROM v_tx_outputs o JOIN transactions t ON t.txid = o.txid
      WHERE o.to_account_uuid IS NOT NULL AND o.is_change = 0 AND o.output_pool <> 0
        AND t.mined_height IS NOT NULL AND t.mined_height <= ?
      ORDER BY t.mined_height, o.txid, o.output_pool, o.output_index
    `).safeIntegers(true).all(tipHeight) as WalletRow[];
    const snapshot = receivedSnapshot({
      v: 1, accountId, mode: 'devtool', tipHeight, sinceHeight: 0, complete: true,
      lastSyncAt: new Date().toISOString(),
      outputs: rows.map(r => {
        if (!Buffer.isBuffer(r.txid) || r.txid.length !== 32) throw new WatcherError('invalid_wallet_txid', 503);
        return {
          txid: Buffer.from(r.txid).reverse().toString('hex'), pool: Number(r.output_pool),
          outIndex: Number(r.output_index), height: Number(r.mined_height),
          confirmations: tipHeight - Number(r.mined_height) + 1,
          valueZat: r.value.toString(), memoText: decodeMemo(r.memo),
        };
      }),
    });
    db.exec('COMMIT');
    return snapshot;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    if (error instanceof WatcherError) throw error;
    throw new WatcherError('wallet_schema_or_read_failed', 503);
  } finally { db.close(); }
}
