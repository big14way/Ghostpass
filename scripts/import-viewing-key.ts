import { loadEnvFile } from 'node:process';
import { text } from 'node:stream/consumers';
import { integer } from '../packages/watcher-contract/src/index.ts';

// Imports the merchant's Unified Full Viewing Key into a running zwatch. The key is read from
// stdin (for example piped over SSH from `zcash-devtool wallet list-accounts`) and never printed,
// so it stays out of terminal output, shell history, and this script's arguments.
try { loadEnvFile('.env'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

const usage = 'usage: pnpm import:viewing-key --birthday <height> < text-containing-one-uview1-key';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--birthday') throw new Error(usage);
const birthday = integer(Number(args[1]), 'birthday');
if (process.stdin.isTTY) throw new Error(`Pipe the viewing key in; do not type it. ${usage}`);

const keys = [...new Set((await text(process.stdin)).match(/\buview1[0-9a-z]+\b/g) ?? [])];
if (keys.length !== 1) throw new Error(keys.length ? 'Input contains more than one viewing key' : 'No Mainnet Unified Full Viewing Key (uview1...) found on stdin');

const token = process.env.ZWATCH_API_TOKEN ?? '';
if (token.length < 32) throw new Error('Set ZWATCH_API_TOKEN (32+ characters) in .env');
const url = new URL('/accounts', process.env.ZWATCH_URL ?? 'http://127.0.0.1:8787');
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('ZWATCH_URL must be a loopback address');

const r = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'merchant', ufvk: keys[0], birthday }),
  signal: AbortSignal.timeout(300_000),
});
const body = await r.json().catch(() => ({})) as { accountId?: string; error?: string };
if (r.status !== 201 || !body.accountId) throw new Error(`zwatch refused the import: HTTP ${r.status} ${body.error ?? ''}`.trim());
console.log('Viewing key imported. Add this line to .env, then wait for zwatch to finish its first sync:');
console.log(`MERCHANT_ACCOUNT_ID=${body.accountId}`);
