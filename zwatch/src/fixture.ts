import { readFile } from 'node:fs/promises';
import { object, receivedSnapshot, WatcherError } from '@ghostpass/watcher-contract';
import type { AccountInput, Balance, ReceivedSnapshot } from '@ghostpass/watcher-contract';
import type { WatcherBackend } from './backend.ts';

export class FixtureBackend implements WatcherBackend {
  readonly mode = 'fixture' as const;
  constructor(private readonly path: string) {
    if (process.env.NODE_ENV === 'production') throw new WatcherError('simulated_payments_in_production');
  }
  private async snapshot(): Promise<ReceivedSnapshot> {
    const fixture = object(JSON.parse(await readFile(this.path, 'utf8')));
    return receivedSnapshot({ ...fixture, v: 1, mode: this.mode, complete: true, sinceHeight: 0, lastSyncAt: new Date().toISOString() });
  }
  async importAccount(input: AccountInput): Promise<string> {
    // Never accept a real viewing key in a simulated backend.
    if (input.ufvk !== 'fixture-only') throw new WatcherError('fixture_key_required');
    return (await this.snapshot()).accountId;
  }
  async received(accountId: string, sinceHeight: number): Promise<ReceivedSnapshot> {
    const s = await this.snapshot();
    if (s.accountId !== accountId) throw new WatcherError('unknown_account', 404);
    return { ...s, sinceHeight, outputs: s.outputs.filter(o => o.height >= sinceHeight) };
  }
  async balance(accountId: string): Promise<Balance> {
    const s = await this.received(accountId, 0);
    const sum = (confirmed: boolean) => s.outputs.filter(o => (o.confirmations >= 2) === confirmed).reduce((v, o) => v + BigInt(o.valueZat), 0n).toString();
    return { confirmedZat: sum(true), pendingZat: sum(false), tipHeight: s.tipHeight };
  }
  async health() {
    const s = await this.snapshot();
    return { tipHeight: s.tipHeight, lastSyncAt: s.lastSyncAt, ready: true };
  }
  async close() {}
}
