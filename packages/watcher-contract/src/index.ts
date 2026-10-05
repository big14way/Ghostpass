export type ShieldedPool = 2 | 3 | 4;
export type BackendMode = 'devtool' | 'fixture';
export type CheckoutStatus = 'AWAITING_PAYMENT' | 'DETECTED' | 'CONFIRMED' | 'UNDERPAID' | 'EXPIRED' | 'ISSUED';

export interface ReceivedOutput {
  txid: string;
  pool: ShieldedPool;
  outIndex: number;
  height: number;
  confirmations: number;
  valueZat: string;
  memoText: string | null;
}

export interface ReceivedSnapshot {
  v: 1;
  accountId: string;
  mode: BackendMode;
  tipHeight: number;
  sinceHeight: number;
  complete: true;
  lastSyncAt: string;
  outputs: ReceivedOutput[];
}

export interface Balance {
  confirmedZat: string;
  pendingZat: string;
  tipHeight: number;
}

export interface AccountInput { name: string; ufvk: string; birthday: number }

export class WatcherError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
    this.name = 'WatcherError';
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WatcherError('invalid_object');
  return value as Record<string, unknown>;
}

export function integer(value: unknown, name: string, max = 0xffff_ffff): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new WatcherError(`invalid_${name}`);
  }
  return value;
}

export function decimalZat(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value) || BigInt(value) > 2_100_000_000_000_000n) {
    throw new WatcherError('invalid_value_zat');
  }
  return value;
}

export function accountInput(value: unknown): AccountInput {
  const o = object(value);
  if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 80 || /[\x00-\x1f]/.test(o.name)) {
    throw new WatcherError('invalid_name');
  }
  if (typeof o.ufvk !== 'string' || o.ufvk.length > 8192 || /\s/.test(o.ufvk) || !o.ufvk) {
    throw new WatcherError('invalid_viewing_key');
  }
  return { name: o.name, ufvk: o.ufvk, birthday: integer(o.birthday, 'birthday') };
}

export function receivedSnapshot(value: unknown): ReceivedSnapshot {
  const o = object(value);
  if (o.v !== 1 || o.complete !== true || (o.mode !== 'fixture' && o.mode !== 'devtool')) {
    throw new WatcherError('incomplete_or_unsupported_snapshot');
  }
  if (typeof o.accountId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(o.accountId)) {
    throw new WatcherError('invalid_account_id');
  }
  const tipHeight = integer(o.tipHeight, 'tip_height');
  const sinceHeight = integer(o.sinceHeight, 'since_height');
  if (typeof o.lastSyncAt !== 'string' || !Number.isFinite(Date.parse(o.lastSyncAt))) throw new WatcherError('invalid_sync_time');
  if (!Array.isArray(o.outputs) || o.outputs.length > 100_000) throw new WatcherError('invalid_outputs');
  const seen = new Set<string>();
  const outputs = o.outputs.map((raw): ReceivedOutput => {
    const r = object(raw);
    if (typeof r.txid !== 'string' || !/^[a-f0-9]{64}$/.test(r.txid)) throw new WatcherError('invalid_txid');
    if (r.pool !== 2 && r.pool !== 3 && r.pool !== 4) throw new WatcherError('invalid_pool');
    const height = integer(r.height, 'height');
    const outIndex = integer(r.outIndex, 'output_index');
    const confirmations = integer(r.confirmations, 'confirmations');
    if (height < sinceHeight || height > tipHeight || confirmations !== tipHeight - height + 1) {
      throw new WatcherError('inconsistent_confirmations');
    }
    if (r.memoText !== null && (typeof r.memoText !== 'string' || Buffer.byteLength(r.memoText) > 512)) {
      throw new WatcherError('invalid_memo');
    }
    const key = `${r.txid}:${r.pool}:${outIndex}`;
    if (seen.has(key)) throw new WatcherError('duplicate_output');
    seen.add(key);
    return { txid: r.txid, pool: r.pool, outIndex, height, confirmations, valueZat: decimalZat(r.valueZat), memoText: r.memoText };
  });
  return { v: 1, accountId: o.accountId, mode: o.mode, tipHeight, sinceHeight, complete: true, lastSyncAt: o.lastSyncAt, outputs };
}

export function parsePaymentMemo(text: string | null): { claimCode: string; planId: string } | null {
  const m = /^GP1 ([A-Z2-7]{26}) ([a-z0-9]{1,64})$/.exec(text ?? '');
  // Sixteen bytes produce 26 base32 characters; the final character has three data bits and two zero padding bits.
  if (!m || !m[1] || !m[2] || !/[AEIMQUY4]$/.test(m[1])) return null;
  return { claimCode: m[1], planId: m[2] };
}

export function decodeMemo(memo: Uint8Array | null): string | null {
  if (!memo || memo.length === 0 || memo.length > 512 || memo[0]! > 0xf4) return null;
  let end = memo.length;
  while (end > 0 && memo[end - 1] === 0) end--;
  if (end === 0) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(memo.subarray(0, end)); }
  catch { return null; }
}
