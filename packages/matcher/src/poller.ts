import type Database from 'better-sqlite3';
import { fetchReceivedSnapshot, reconcilePayments } from './index.ts';
import type { MatchOptions, MatchResult } from './index.ts';

interface PollerOptions extends Omit<MatchOptions, 'now'> {
  db: Database.Database;
  url: string;
  token: string;
  intervalMs?: number;
  onResult?: (result: MatchResult[]) => void;
  onError?: (code: 'matcher_poll_failed') => void;
}

/** Runs only one fetch/reconciliation at a time; stop before closing the merchant database. */
export class PaymentMatcher {
  private inFlight: Promise<MatchResult[]> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly interval: number;
  constructor(private readonly options: PollerOptions) {
    this.interval = options.intervalMs ?? 20_000;
    if (!Number.isSafeInteger(this.interval) || this.interval < 1000) throw new Error('invalid_matcher_interval');
  }
  runOnce(): Promise<MatchResult[]> {
    if (this.inFlight) return this.inFlight;
    const task = fetchReceivedSnapshot(this.options.url, this.options.accountId, this.options.token)
      .then(snapshot => reconcilePayments(this.options.db, snapshot, this.options));
    this.inFlight = task;
    void task.then(() => { if (this.inFlight === task) this.inFlight = undefined; }, () => { if (this.inFlight === task) this.inFlight = undefined; });
    return task;
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }
  private async tick(): Promise<void> {
    try {
      const result = await this.runOnce();
      this.options.onResult?.(result);
    }
    catch { this.options.onError?.('matcher_poll_failed'); }
    finally {
      if (this.running) {
        this.timer = setTimeout(() => { void this.tick(); }, this.interval);
        this.timer.unref();
      }
    }
  }
  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.inFlight?.catch(() => {});
  }
}
