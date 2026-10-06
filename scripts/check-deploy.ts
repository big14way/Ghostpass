import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { merchantEnv, unpublishedKeys } from '../packages/demo-web/src/index.ts';
import type { MerchantEnv } from '../packages/demo-web/src/index.ts';
import { NEWSLETTER } from '../apps/newsletter/src/app.ts';
import { API_DEMO } from '../apps/api-demo/src/app.ts';
import { DASHBOARD } from '../apps/dashboard/src/app.ts';

// Checks a production .env before (re)starting the services. Run it on the server as the
// ghostpass user, from /opt/ghostpass. It prints no secrets.
try { loadEnvFile('.env'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

let failed = false;
function report(ok: boolean, name: string, detail = '') {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

// The services run with NODE_ENV=production, so validate exactly that configuration.
const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'production' };
const merchants: MerchantEnv[] = [];
for (const app of [NEWSLETTER, API_DEMO]) {
  try {
    merchants.push(merchantEnv(app, env));
    report(true, `${app.name} settings`);
  } catch (error) { report(false, `${app.name} settings`, (error as Error).message); }
}
const passwordOk = (env.GP_ADMIN_PASSWORD ?? '').length >= 16;
report(passwordOk, 'GP_ADMIN_PASSWORD', passwordOk ? '' : 'must be at least 16 characters');
const dashboardPort = Number(env[DASHBOARD.portVar] ?? DASHBOARD.defaultPort);
report(Number.isSafeInteger(dashboardPort) && dashboardPort > 0 && dashboardPort < 65536, DASHBOARD.portVar, String(env[DASHBOARD.portVar] ?? DASHBOARD.defaultPort));

const [first] = merchants;
if (first && first.payments.kind === 'watcher') {
  const { url, accountId, token } = first.payments;
  try {
    const health = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(5000) });
    const h = await health.json().catch(() => ({})) as { ready?: boolean; mode?: string; tipHeight?: number };
    report(health.ok && h.ready === true && h.mode === 'devtool', 'zwatch is running, synced, and using the real wallet backend',
      `HTTP ${health.status}, mode ${h.mode ?? '?'}, tip height ${h.tipHeight ?? '?'}`);
    const balance = await fetch(new URL(`/accounts/${encodeURIComponent(accountId)}/balance`, url), {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    report(balance.ok, 'zwatch accepts the API token and knows MERCHANT_ACCOUNT_ID', `HTTP ${balance.status}`);
  } catch (error) { report(false, 'zwatch reachable', (error as Error).message); }

  if (!existsSync(first.keyLogPath)) {
    report(false, 'key log', `${first.keyLogPath} does not exist yet; start ghostpass-demo once to create the keys, then run this again`);
  } else {
    try {
      const missing = await unpublishedKeys(first.keyLogPath, first.keysUrl, merchants.map(m => m.merchantName));
      report(!missing.length, 'every issuer key is in the public KEYS.json',
        missing.length ? `missing ${missing.map(k => `${k.merchant} ${k.period}`).join(', ')}; commit ${first.keyLogPath} as KEYS.json and push` : first.keysUrl);
    } catch (error) { report(false, 'public key log', (error as Error).message); }
  }
}

if (failed) process.exitCode = 1;
