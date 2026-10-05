import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { decimalZat, integer, object, WatcherError } from '@ghostpass/watcher-contract';
import type { AccountInput, Balance, ReceivedSnapshot } from '@ghostpass/watcher-contract';
import type { WatcherBackend } from './backend.ts';
import { readWalletSnapshot } from './wallet-db.ts';

const exec = promisify(execFile);
export type RunCommand = (binary: string, args: string[], timeout: number) => Promise<string>;
export const runCommand: RunCommand = async (binary, args, timeout) => {
  try {
    const result = await exec(binary, args, {
      timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, RUST_LOG: 'error' },
    });
    return result.stdout;
  } catch { throw new WatcherError('devtool_command_failed', 503); }
};

interface AccountMetadata { accountId: string; name: string; birthday: number; fingerprint: string }
interface AccountState { metadata: AccountMetadata; snapshot?: ReceivedSnapshot; balance?: Balance; failed: boolean }
interface DevtoolOptions { root: string; binary: string; server: string; intervalMs: number; maxAgeMs: number; run?: RunCommand }

export class DevtoolBackend implements WatcherBackend {
  readonly mode = 'devtool' as const;
  private accounts = new Map<string, AccountState>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private refreshTask: Promise<void> | undefined;
  private closed = false;
  private lockPath: string | undefined;
  private readonly root: string;
  private readonly run: RunCommand;
  constructor(private readonly options: DevtoolOptions) {
    if (options.intervalMs < 1000 || options.maxAgeMs < options.intervalMs) throw new Error('invalid_watcher_timing');
    this.root = resolve(options.root);
    this.run = options.run ?? runCommand;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new WatcherError('watcher_closed', 503));
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }
  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = join(this.root, '.zwatch.lock');
    try { await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); }
    catch { throw new WatcherError('watcher_directory_locked', 503); }
    this.lockPath = lockPath;
    try {
      for (const dir of await readdir(this.root, { withFileTypes: true })) {
        if (!dir.isDirectory() || !/^[a-f0-9-]{36}$/.test(dir.name)) continue;
        let content: string;
        try { content = await readFile(join(this.root, dir.name, 'account.json'), 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const raw = object(JSON.parse(content));
        if (raw.accountId !== dir.name || typeof raw.name !== 'string' || typeof raw.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.fingerprint)) {
          throw new WatcherError('invalid_account_metadata', 503);
        }
        const metadata: AccountMetadata = { accountId: dir.name, name: raw.name, birthday: integer(raw.birthday, 'birthday'), fingerprint: raw.fingerprint };
        this.accounts.set(dir.name, { metadata, failed: false });
      }
      this.timer = setInterval(() => { void this.refresh(); }, this.options.intervalMs);
      this.timer.unref();
      void this.refresh();
    } catch (error) { await this.close(); throw error; }
  }
  private async command(dir: string, command: string, args: string[] = [], timeout = 600_000): Promise<string> {
    return this.run(this.options.binary, ['wallet', '-w', dir, command, ...args], timeout);
  }
  async importAccount(input: AccountInput): Promise<string> {
    if (!/^uview(?:test)?1[0-9a-z]+$/.test(input.ufvk)) throw new WatcherError('unified_full_viewing_key_required');
    const fingerprint = createHash('sha256').update(input.ufvk).digest('hex');
    return this.serial(async () => {
      const prior = [...this.accounts.values()].find(a => a.metadata.fingerprint === fingerprint);
      if (prior) {
        if (prior.metadata.birthday !== input.birthday) throw new WatcherError('account_birthday_conflict', 409);
        return prior.metadata.accountId;
      }
      const accountId = randomUUID();
      const dir = join(this.root, accountId);
      await mkdir(dir, { mode: 0o700 });
      await this.command(dir, 'init-fvk', ['--name', input.name, '--fvk', input.ufvk, '--birthday', String(input.birthday), '-s', this.options.server], 300_000);
      const metadata: AccountMetadata = { accountId, name: input.name, birthday: input.birthday, fingerprint };
      await writeFile(join(dir, 'account.json'), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
      this.accounts.set(accountId, { metadata, failed: false });
      // Account import responds promptly; received/balance remain 503 until its first complete sync.
      setImmediate(() => { void this.refresh(); });
      return accountId;
    });
  }
  private async syncAccount(state: AccountState): Promise<void> {
    const dir = join(this.root, state.metadata.accountId);
    await this.command(dir, 'sync', ['-s', this.options.server]);
    await this.command(dir, 'enhance', ['-s', this.options.server]);
    const snapshot = readWalletSnapshot(join(dir, 'data.sqlite'), state.metadata.accountId, state.metadata.birthday);
    const raw = object(JSON.parse(await this.command(dir, 'balance', ['--json', '--min-confirmations', '2'])));
    if (integer(raw.chain_tip_height, 'tip_height') !== snapshot.tipHeight) throw new WatcherError('wallet_tip_mismatch', 503);
    const value = (name: string) => BigInt(decimalZat(String(integer(raw[name], name, 2_100_000_000_000_000))));
    const confirmed = value('sapling_spendable') + value('orchard_spendable') + value('ironwood_spendable') + value('transparent_spendable');
    const total = value('total');
    if (confirmed > total) throw new WatcherError('invalid_wallet_balance', 503);
    state.snapshot = { ...snapshot, lastSyncAt: new Date().toISOString() };
    state.balance = { tipHeight: snapshot.tipHeight, confirmedZat: confirmed.toString(), pendingZat: (total - confirmed).toString() };
    state.failed = false;
  }
  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.refreshTask) return this.refreshTask;
    const task = this.serial(async () => {
        for (const state of this.accounts.values()) {
          try { await this.syncAccount(state); }
          catch { state.failed = true; }
        }
      }).catch(() => {});
    this.refreshTask = task;
    try { await task; }
    finally { if (this.refreshTask === task) this.refreshTask = undefined; }
  }
  private state(accountId: string): AccountState {
    const state = this.accounts.get(accountId);
    if (!state) throw new WatcherError('unknown_account', 404);
    if (state.failed || !state.snapshot || Date.now() - Date.parse(state.snapshot.lastSyncAt) > this.options.maxAgeMs) {
      throw new WatcherError('account_not_synced', 503);
    }
    return state;
  }
  async received(accountId: string, sinceHeight: number): Promise<ReceivedSnapshot> {
    const s = this.state(accountId).snapshot!;
    return { ...s, sinceHeight, outputs: s.outputs.filter(o => o.height >= sinceHeight) };
  }
  async balance(accountId: string): Promise<Balance> { return this.state(accountId).balance!; }
  async health() {
    const states = [...this.accounts.values()];
    const snapshots = states.flatMap(s => s.snapshot ? [s.snapshot] : []);
    const ready = states.every(s => !s.failed && s.snapshot && Date.now() - Date.parse(s.snapshot.lastSyncAt) <= this.options.maxAgeMs);
    return {
      tipHeight: snapshots.length ? Math.min(...snapshots.map(s => s.tipHeight)) : 0,
      lastSyncAt: snapshots.length ? snapshots.map(s => s.lastSyncAt).sort()[0]! : null,
      ready,
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.queue;
    if (this.lockPath) { await unlink(this.lockPath); this.lockPath = undefined; }
  }
}
