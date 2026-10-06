import { keyLog, redeemUntil } from '@ghostpass/core';
import type { KeyLogEntry } from '@ghostpass/core';
import { readKeyLog } from '@ghostpass/server';

/**
 * Local key-log entries for these merchants, still inside their redeem window, that the public
 * KEYS.json lacks or contradicts. Browsers refuse such keys, so each one must be committed and pushed.
 */
export async function unpublishedKeys(localPath: string, publicUrl: string, merchants: string[], now = Date.now()): Promise<KeyLogEntry[]> {
  const local = await readKeyLog(localPath);
  const r = await fetch(publicUrl, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`public key log returned HTTP ${r.status}`);
  const published = keyLog(await r.json());
  return local.keys.filter(k => {
    if (!merchants.includes(k.merchant) || redeemUntil(k.period) <= now) return false;
    const matches = published.keys.filter(p => p.merchant === k.merchant && p.period === k.period);
    return matches.length !== 1 || matches[0]?.spkiSha256 !== k.spkiSha256;
  });
}
