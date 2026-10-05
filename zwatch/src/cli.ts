import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { integer } from '@ghostpass/watcher-contract';
import { createWatcherApp } from './app.ts';
import { FixtureBackend } from './fixture.ts';
import { DevtoolBackend } from './devtool.ts';
import type { WatcherBackend } from './backend.ts';

try { loadEnvFile('.env'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

const args = process.argv.slice(2);
if (args.length && (args[0] !== '--fixture' || args.length !== 2)) throw new Error('usage: zwatch [--fixture path]');
const fixture = args[1];
const token = process.env.ZWATCH_API_TOKEN || (fixture ? 'ghostpass-local-demo' : '');
if (!fixture && token.length < 32) throw new Error('Set ZWATCH_API_TOKEN to a random token of at least 32 characters in .env');
const port = integer(Number(process.env.ZWATCH_PORT ?? 8787), 'port', 65535);
if (!port) throw new Error('invalid_port');
let backend: WatcherBackend;
if (fixture) {
  backend = new FixtureBackend(resolve(fixture));
} else {
  const live = new DevtoolBackend({
    root: process.env.ZWATCH_DATA_DIR ?? '.local/zwatch',
    binary: resolve(process.env.ZCASH_DEVTOOL ?? '.local/bin/zcash-devtool'),
    server: process.env.ZWATCH_SERVER ?? 'zecrocks',
    intervalMs: integer(Number(process.env.ZWATCH_SYNC_INTERVAL_MS ?? 20000), 'sync_interval'),
    maxAgeMs: integer(Number(process.env.ZWATCH_MAX_SNAPSHOT_AGE_MS ?? 120000), 'max_snapshot_age'),
  });
  await live.start();
  backend = live;
}
const server = createWatcherApp(backend, token).listen(port, '127.0.0.1', () => {
  console.log(`zwatch listening on http://127.0.0.1:${port} (${backend.mode})`);
  if (fixture) console.log('DEV MODE: payments are simulated. No real Zcash wallet is connected.');
});
server.on('error', async () => { console.error('watcher_listen_failed'); await backend.close(); process.exitCode = 1; });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close(() => { void backend.close().then(() => { process.exitCode = 0; }); });
});
