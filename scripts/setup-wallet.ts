import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, chmod, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { DevtoolBackend } from '../zwatch/src/devtool.ts';
import { object, integer } from '../packages/watcher-contract/src/index.ts';

// Creates a fresh encrypted merchant wallet. It never sends funds or prints keys.
process.umask(0o077);
try { loadEnvFile('.env'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const binary = resolve(process.env.ZCASH_DEVTOOL ?? '.local/bin/zcash-devtool');
const merchantDir = resolve('.local/merchant');
const keyDir = resolve('.local/keys');
const identity = join(keyDir, 'merchant.age');
const server = process.env.ZWATCH_SERVER ?? 'zecrocks';
await mkdir(merchantDir, { recursive: true, mode: 0o700 });
await mkdir(keyDir, { recursive: true, mode: 0o700 });
await chmod(merchantDir, 0o700);
await chmod(keyDir, 0o700);

function merchantCommand(command: string, args: string[] = [], input?: string): Promise<string> {
  return new Promise((done, reject) => {
    const child = execFile(binary, ['wallet', '-w', merchantDir, command, ...args], {
      timeout: 300_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, RUST_LOG: 'error' },
    }, (error, stdout) => error ? reject(new Error('merchant_wallet_command_failed')) : done(stdout));
    child.stdin?.end(input ?? '');
  });
}
let initialized = true;
try { await access(join(merchantDir, 'keys.toml')); } catch { initialized = false; }
if (!initialized) {
  console.log('Creating an encrypted Mainnet merchant wallet; no funds will be sent.');
  await merchantCommand('init', ['--name', 'merchant', '-i', identity, '-n', 'main', '-s', server], '\n');
  await chmod(identity, 0o600);
}
const accounts = await merchantCommand('list-accounts');
const ufvk = /UFVK: (uview1[0-9a-z]+)/.exec(accounts)?.[1];
const birthdayRaw = /birthday height ([0-9]+)/.exec(accounts)?.[1];
if (!ufvk || !birthdayRaw) throw new Error('merchant_account_output_unsupported');
const birthday = integer(Number(birthdayRaw), 'birthday');
const addressOutput = await merchantCommand('list-addresses', ['--receiver', 'orchard']);
const address = /Receiver\(orchard\): (u1[0-9a-z]+)/.exec(addressOutput)?.[1];
if (!address) throw new Error('merchant_shielded_address_unavailable');
const info = object(JSON.parse(await merchantCommand('get-info', ['-s', server])));
if (info.chain_name !== 'main') throw new Error('merchant_network_mismatch');

const backend = new DevtoolBackend({
  root: process.env.ZWATCH_DATA_DIR ?? '.local/zwatch', binary, server,
  intervalMs: 20_000, maxAgeMs: 120_000,
});
await backend.start();
try {
  const accountId = await backend.importAccount({ name: 'merchant', ufvk, birthday });
  await backend.refresh();
  // importAccount may have scheduled its first sync before the explicit refresh call.
  const deadline = Date.now() + 300_000;
  while (!(await backend.health()).ready && Date.now() < deadline) await new Promise(r => setTimeout(r, 1000));
  const snapshot = await backend.received(accountId, 0);
  const balance = await backend.balance(accountId);
  await writeFile('.local/merchant-account.json', JSON.stringify({ accountId, address, birthday, network: 'main' }, null, 2) + '\n', { mode: 0o600 });
  try {
    await writeFile('.env', [
      'ZWATCH_PORT=8787', 'ZWATCH_DATA_DIR=.local/zwatch', 'ZCASH_DEVTOOL=.local/bin/zcash-devtool',
      `ZWATCH_SERVER=${server}`, `ZWATCH_API_TOKEN=${randomBytes(32).toString('hex')}`,
      'ZWATCH_SYNC_INTERVAL_MS=20000', 'ZWATCH_MAX_SNAPSHOT_AGE_MS=120000',
      'ZWATCH_URL=http://127.0.0.1:8787', `MERCHANT_ACCOUNT_ID=${accountId}`, `MERCHANT_UA=${address}`, '',
    ].join('\n'), { flag: 'wx', mode: 0o600 });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  console.log(`Merchant wallet and viewing-only watcher initialized. Synced height: ${snapshot.tipHeight}.`);
  console.log(`Balance: ${balance.confirmedZat} confirmed zatoshis; ${balance.pendingZat} pending.`);
  console.log('Local account details: .local/merchant-account.json. No wallet keys were printed.');
  console.log('Back up .local/keys/merchant.age and the encrypted .local/merchant/keys.toml offline before funding.');
} finally { await backend.close(); }
