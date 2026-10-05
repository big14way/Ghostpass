import type { AccountInput, Balance, BackendMode, ReceivedSnapshot } from '@ghostpass/watcher-contract';

export interface WatcherBackend {
  readonly mode: BackendMode;
  importAccount(input: AccountInput): Promise<string>;
  received(accountId: string, sinceHeight: number): Promise<ReceivedSnapshot>;
  balance(accountId: string): Promise<Balance>;
  health(): Promise<{ tipHeight: number; lastSyncAt: string | null; ready: boolean }>;
  close(): Promise<void>;
}
