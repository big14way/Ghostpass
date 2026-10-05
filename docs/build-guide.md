# GHOSTPASS — Build Guide

**Unlinkable subscriptions paid in shielded ZEC**
ZECATHON · Track: **Shielded Payments** · Team: **[friend] (lead)** + **[you]**
Deadline: **28 Oct 2026** (aim to submit on the 27th) · Guide prepared 5 Oct 2026

> **How to read this.** Sections 1–5 are for both of you. Every task after that is tagged **[LEAD]** (your friend) or **[YOU]**.
> **⚠ VERIFY** marks a detail that tooling may have changed, or that the docs don't settle. Check it before you build on it. Zcash's developer CLIs say their interfaces can change without notice.

---

## Contents

1. What you're building and why it wins
2. Zcash ground truth (October 2026)
3. Network, money and safety rules
4. Setup (both)
5. Architecture and repo layout
6. The GP1 protocol
7. zwatch: the payment watcher [YOU]
8. Merchant wallet [YOU]
9. Core package [LEAD]
10. Server [LEAD; matcher is YOU]
11. Client [LEAD]
12. Demo merchants and dashboard [LEAD]
13. Database schema
14. Dev mode for judges
15. Privacy engineering, leak table, honest limits
16. Optional: pay with other assets via NEAR Intents [YOU, only if time]
17. Tests
18. Day-by-day plan
19. Definition of done
20. Three-minute video
21. Submission README template
22. Rules to confirm on thezecathon.com
23. Resources

---

## 1. What you're building and why it wins

A subscriber pays once per period in shielded ZEC and receives a batch of **blind-signed access tokens**. Each visit or API call spends one token. The merchant can check that a token is valid, paid for and unspent. Because the tokens were signed *blind*, the merchant **cannot link a token to the payment that bought it**, or tokens to each other. There's no account, email or password.

**Why it fits the hackathon**

- The track names four use cases: point of sale, payroll, remittance and subscriptions. The first three already have entries (SAVANNA for point of sale, ZPayroll, Zapp for remittance), and zkSEND covers payment links in this hackathon. No subscription project turned up.
- It builds on proven winners. ZcashMe's sign-in (2nd at ZecHub 3.0) turned a shielded payment into a login. Portal unlocked paid content with Zcash. Zink gave every invoice its own address. Your new piece is that access can't be linked back to the payment.
- There's real demand: NymVPN already sells subscriptions for shielded ZEC through BTCPay.
- It hits the hackathon's theme, "build something on Zcash that does not leak", at two layers: the payment is shielded, and usage is unlinkable.

---

## 2. Zcash ground truth (October 2026)

| Fact | What it means for you |
|---|---|
| **NU6.3 "Ironwood"** activated on Mainnet at block **3,428,143** on 28 Jul 2026 and added the **Ironwood** shielded pool. | New shielded payments land in Ironwood. Tutorials from before August 2026 may be wrong in the details. |
| After NU6.3, wallets **must not** send to external receivers in the old **Orchard pool**, which is now withdraw-only (ZIP 326, ZIP 318). | Use only NU6.3-aware software: current Zodl, `zcash-devtool` main, Zebra ≥ 6.0.0. |
| Receivers belong to the Orchard *protocol*, not a pool. A `u1…` address with an Orchard receiver receives Ironwood funds, and the same incoming viewing key decrypts both pools (ZIP 326). | Addresses and viewing keys look exactly as before. |
| Ironwood uses the **v6 transaction format** (ZIP 229). | Use tool versions built for v6. |
| **Fees (ZIP 317):** 5,000 zatoshis per logical action, minimum 2. Ironwood actions count like Orchard actions. | A simple shielded payment costs **10,000 zats (0.0001 ZEC)**. |
| **NU7:** Testnet activation 6 Oct; Mainnet decision 20 Oct; Mainnet target 5 Nov. 25-second blocks (ZIP 218), v4 transactions disallowed (ZIP 2003). No new transaction format. | Never hard-code block time; count confirmations. If judging runs past 5 Nov, update dependencies to NU7-aware releases. |
| **Memos:** 512 bytes, encrypted to the recipient, shielded outputs only. If the first byte is ≤ 0xF4 the memo is UTF-8 text, and trailing zero bytes are padding (ZIP 302). | Ghostpass matches payments by a code in the memo. |
| **ZIP 321 URI:** `zcash:<address>?amount=<ZEC, max 8 decimals>&memo=<base64url, no padding>&message=<percent-encoded>`. A memo on a transparent address makes the whole URI invalid. | This is your checkout QR code. |
| **NEAR Intents** supports ZEC on **transparent addresses only**. | The optional "pay with other assets" mode (§16) has a public transparent hop. Label it, and never make it the default. |
| **Zcash Shielded Assets** are not on Mainnet. | Ghostpass is priced in ZEC. |

---

## 3. Network, money and safety rules

- **Build on Mainnet with tiny amounts.** Judges want Mainnet transaction IDs. Testnet switches to NU7 rules on 6 Oct, and any tool that doesn't yet know Testnet's NU7 activation will build transactions the network rejects. **⚠ VERIFY** your tool versions before you touch Testnet.
- **Budget about 0.03 ZEC.** Test payments go to a merchant wallet you control, so the money recycles. Each payment costs 0.0001 ZEC in fees.
- **Never commit secrets.** Add to `.gitignore`: wallet directories, `*.age`, `.env`, `*.sqlite`, `keys/`.
- `zcash-devtool` is a prototyping tool, not production software. Keep only small amounts in it.

---

## 4. Setup (both)

```bash
# Ubuntu/Debian. On macOS install the Homebrew equivalents and the Xcode command-line tools.
sudo apt update && sudo apt install -y build-essential pkg-config libssl-dev clang \
  protobuf-compiler sqlite3 git curl
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # latest stable Rust
# Node.js 20 or newer (nvm or your package manager), then:
corepack enable                                                  # provides pnpm
```

Some of those packages may already be installed or unnecessary on your machine; installing them is harmless.

**[YOU] Zcash CLI (the friend only needs it to run zwatch locally):**

```bash
cargo install --git https://github.com/zcash/zcash-devtool.git --locked
zcash-devtool --help
zcash-devtool wallet --help     # the source of truth for every flag used below
```

Record the zcash-devtool git commit you built in `versions.lock`. If upstream changes mid-hackathon, you can rebuild exactly what worked.

**Test wallet (both):** install **Zodl** on your phone (iOS or Android) and fund it with about 0.02 ZEC. This is your "subscriber" wallet.

---

## 5. Architecture and repo layout

```
Subscriber browser                                     Merchant side
 ├─ checkout widget ── POST /v1/checkout ─────────▶ ghostpass server (Node/TS, Express)
 │     shows ZIP 321 QR (amount + memo)               ├─ checkouts (claim codes)
 ├─ pays from Zodl ── shielded tx ─▶ chain ─▶ zwatch (merchant viewing key) ─▶ matcher
 ├─ POST /v1/issue (blinded messages) ────────────▶ issuer (blind RSA, monthly keys)
 ├─ token wallet (IndexedDB)
 └─ request + "Authorization: Ghostpass …" ───────▶ redeemer middleware
                                                      (verify signature, spent-set)
```

**Stack:** Node 20+, TypeScript, Express, `better-sqlite3`, `cookie-parser`, Next.js for the demo apps, `@cloudflare/blindrsa-ts` (implements RFC 9474), `qrcode`, `idb-keyval`.

```
ghostpass/
  packages/core       # encoding, ZIP 321, plans, memo parsing      [LEAD]
  packages/client     # checkout widget, token wallet, ghostFetch   [LEAD]
  packages/server     # keys, issuer, redeemer, sessions            [LEAD]
  packages/matcher    # payment matching against zwatch             [YOU]
  zwatch/             # payment watcher service                     [YOU]
  apps/server         # the merchant's Ghostpass service
  apps/newsletter     # demo 1: session mode
  apps/api-demo       # demo 2: per-request mode
  apps/dashboard      # aggregate stats only
  KEYS.json           # public hashes of every period key (§15)
  versions.lock
```

**The contract between you:** the zwatch HTTP API in §7.1. Freeze it on day 2. Until zwatch is live, the friend develops against dev mode (§14).

---

## 6. The GP1 protocol

### 6.1 Keys

- One **RSA-2048** key pair per calendar month (UTC), named by period: `2026-10`.
- Suite: **RSABSSA-SHA384-PSS-Randomized** (RFC 9474).
- Tokens issued in a month stay redeemable until **00:00 UTC on the 15th of the next month**. That gives late-month payers a grace window.
- Keys are published, oldest first, at:

```json
GET /.well-known/ghostpass.json
{
  "v": 1,
  "merchant": "The Quiet Letter",
  "current": "2026-10",
  "keys": [
    { "period": "2026-10", "spki": "<base64url DER>", "redeemUntil": "2026-11-15T00:00:00.000Z" }
  ],
  "plans": [
    { "id": "monthly", "label": "30 days",       "amountZec": "0.005", "tokens": 30,  "mode": "session" },
    { "id": "api100",  "label": "100 API calls", "amountZec": "0.002", "tokens": 100, "mode": "per-request" }
  ]
}
```

### 6.2 Checkout

`POST /v1/checkout {plan}` returns `{claimCode, uri, address, amountZec, memo, expiresAt}`.

- `claimCode`: 16 random bytes in base32 (26 characters, `A–Z` and `2–7`).
- Memo text: `GP1 <claimCode> <planId>`. It's ASCII, so the first byte is far below 0xF4 and it counts as a text memo.
- `uri`: `buildZip321(MERCHANT_UA, priceZat, memo, "<merchant> - <plan label>")`.
- The browser saves the claim code immediately (§11.1). Until tokens are issued, the claim code is the subscriber's only receipt.

### 6.3 Status

`GET /v1/checkout/:claimCode` returns `{status, paidZec, confirmations}`.

| Status | Meaning |
|---|---|
| `AWAITING_PAYMENT` | Nothing received yet |
| `DETECTED` | Paid in full, but fewer than 2 confirmations |
| `CONFIRMED` | Paid in full with ≥ 2 confirmations; tokens can be issued |
| `UNDERPAID` | Something arrived, but less than the price |
| `EXPIRED` | Nothing arrived before `expiresAt` (a late payment still moves it forward) |
| `ISSUED` | Tokens have been issued; the claim code is spent |

### 6.4 Issue (exactly once per claim code)

`POST /v1/issue {claimCode, period, blinded: [base64url, …]}` returns `{period, blindSigs: [base64url, …]}`.

- `blinded.length` must equal the plan's token count.
- `period` must equal the server's current period. Otherwise the server returns `409 period_changed`, and the client refetches the key and retries.
- The server moves the checkout from `CONFIRMED` to `ISSUED` **atomically, before signing**. If signing fails, it moves the checkout back.

### 6.5 Redeem

```
Authorization: Ghostpass v=1, period=2026-10, msg=<base64url prepared message>, sig=<base64url signature>
```

- **Session mode** (newsletter): one token opens a 24-hour session cookie.
- **Per-request mode** (API): one token per call.
- On failure the server returns `401` with `WWW-Authenticate: Ghostpass realm="<merchant>", keys="/.well-known/ghostpass.json"`.

**Stretch options:** speak the IETF Privacy Pass HTTP authentication scheme (RFC 9577) for interoperability, or replace monthly keys with partially blind RSA that uses the period as public metadata (`RSAPBSSA` in the same library). Note that partially blind *verification* doesn't work in browsers, so do it server-side only.

---

## 7. zwatch: the payment watcher [YOU]

zwatch watches a viewing key and reports what has been received, including memos. It never holds spending keys and listens on `127.0.0.1` only. Your Shadow Desk project reuses it.

### 7.1 API (freeze on day 2)

| Method | Path | Returns |
|---|---|---|
| POST | `/accounts` `{name, ufvk, birthday}` | `{accountId}` |
| GET | `/accounts/:id/balance` | `{confirmedZat, pendingZat, tipHeight}` |
| GET | `/accounts/:id/received?sinceHeight=N` | `{tipHeight, outputs: [{txid, outIndex, pool, height, confirmations, valueZat, memoText}]}` |
| GET | `/health` | `{tipHeight, lastSyncAt}` |

`valueZat` is returned as a decimal **string**, because JSON has no 64-bit integers. `memoText` is `null` when the memo is empty or not text.

### 7.2 Path A: drive zcash-devtool (aim to finish in 2–3 days)

The approach:

- One wallet directory per watched account, created with `init-fvk`.
- A loop runs `wallet sync` every 20 seconds.
- Received outputs and memos are read from the wallet's SQLite database, opened **read-only**. `zcash_client_sqlite` exposes the `v_transactions` and `v_tx_outputs` views as part of its public API. `v_tx_outputs` has one row per output, keyed by transaction, pool and output index, with a `memo` column.

```ts
// zwatch/src/devtool.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const run = promisify(execFile);
const DEVTOOL = process.env.ZCASH_DEVTOOL ?? 'zcash-devtool';

export async function importAccount(dir: string, name: string, ufvk: string, birthday: number) {
  await run(DEVTOOL, ['wallet', '-w', dir, 'init-fvk', '--name', name, '--fvk', ufvk,
    '--birthday', String(birthday), '-s', 'zecrocks'], { timeout: 300_000 });
}

export async function sync(dir: string) {
  await run(DEVTOOL, ['wallet', '-w', dir, 'sync', '-s', 'zecrocks'],
    { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
}

// ⚠ VERIFY column names first:  sqlite3 <dir>/data.sqlite ".schema v_tx_outputs"
// Recent zcash_client_sqlite versions include txid, output_pool, output_index, value,
// is_change, memo, to_account_uuid and tx_mined_height. Adjust the query to what you see.
export function receivedSince(dir: string, sinceHeight: number) {
  const db = new Database(`${dir}/data.sqlite`, { readonly: true, fileMustExist: true });
  try {
    const tip = (db.prepare('SELECT MAX(height) AS h FROM blocks').get() as { h: number | null }).h ?? 0; // ⚠ VERIFY
    const rows = db.prepare(`
      SELECT txid, output_pool, output_index, value, memo, tx_mined_height
      FROM v_tx_outputs
      WHERE to_account_uuid IS NOT NULL AND is_change = 0
        AND tx_mined_height IS NOT NULL AND tx_mined_height >= ?`).all(sinceHeight) as any[];
    return {
      tipHeight: tip,
      outputs: rows.map((r) => ({
        // txids are stored as raw bytes; block explorers show them byte-reversed. ⚠ VERIFY against Zodl.
        txid: Buffer.from(r.txid).reverse().toString('hex'),
        outIndex: r.output_index,
        pool: r.output_pool,                      // numeric pool code; ⚠ VERIFY which code is Ironwood
        height: r.tx_mined_height,
        confirmations: tip - r.tx_mined_height + 1,
        valueZat: String(r.value),
        memoText: decodeMemo(r.memo ? new Uint8Array(r.memo) : null),
      })),
    };
  } finally {
    db.close();
  }
}

// ZIP 302: 0xF6 = "no memo"; first byte > 0xF4 = not text; otherwise UTF-8 with zero padding.
export function decodeMemo(memo: Uint8Array | null): string | null {
  if (!memo || memo.length === 0) return null;
  if (memo[0] === 0xf6 || memo[0] > 0xf4) return null;
  let end = memo.length;
  while (end > 0 && memo[end - 1] === 0) end--;
  return new TextDecoder('utf-8').decode(memo.subarray(0, end));
}
```

**Rules for Path A**

- Run `sync` and the reads one after another in a single loop, so the database isn't being written while you read it. If you hit "database is locked", retry after a second.
- **⚠ VERIFY memos are populated.** Compact blocks don't carry memos, so the wallet must download each full transaction to read one. If `memo` is NULL for a payment you know had one, the sync isn't fetching full transactions; look for the step that does in `zcash-devtool wallet --help`.
- Wrap all this in a small Express server implementing §7.1, bound to `127.0.0.1`.

### 7.3 Path B: native Rust (Week 2, only if Path A is shaky)

Write a small Rust service on `zcash_client_backend` and `zcash_client_sqlite`, at **exactly** the versions in zcash-devtool's `Cargo.lock` (the Ironwood-capable line). Borrow zcash-devtool's sync code (it's MIT/Apache licensed). For memos, process the wallet's transaction data requests and store the decrypted full transactions; check docs.rs for the current function names.

### 7.4 Acceptance test

1. Import the merchant UFVK (§8).
2. From Zodl, send 0.001 ZEC to `MERCHANT_UA` with memo `zwatch test 1`.
3. After one confirmation, `/received` must show `valueZat: "100000"`, `memoText: "zwatch test 1"`, and a txid that matches Zodl's.

---

## 8. Merchant wallet [YOU]

```bash
mkdir -p ~/gp
zcash-devtool wallet -w ~/gp/merchant init --name merchant -i ~/gp/merchant.age -n main -s zecrocks
zcash-devtool wallet -w ~/gp/merchant list-accounts      # copy the UFVK (it also shows the UIVK)
zcash-devtool wallet -w ~/gp/merchant list-addresses     # choose MERCHANT_UA
```

- `-i` is an `age` identity that encrypts the 24-word seed. Back up `merchant.age` offline and never commit it.
- **Birthday:** `init` sets it near the chain tip. When you import the UFVK into zwatch, use the current tip height from a block explorer. It's always ≥ 3,428,143, so zwatch never scans the old Orchard pool.
- **Least privilege:** zwatch gets only the **UFVK**. If your zwatch path supports importing an incoming-only key (UIVK), use that instead.
- **MERCHANT_UA:** prefer an address with no transparent receiver; check it with `zcash-devtool inspect <address>` (**⚠ VERIFY** the output format). If it does include one, Zodl will still pay the shielded receiver. Transparent-only senders can't attach a memo, so their payments won't match anyway.
- **Withdrawing revenue:** use zcash-devtool's send commands (see `wallet --help`), or restore the seed into Zodl. The seed is stored age-encrypted in `keys.toml`; decrypt it with `age -d -i ~/gp/merchant.age` (**⚠ VERIFY**).

---

## 9. Core package [LEAD]

**`packages/core/src/encoding.ts`**

```ts
export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;                                   // 16 bytes → 26 characters
}

export async function sha256hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}
```

**`packages/core/src/zip321.ts`** (spec: zips.z.cash/zip-0321)

```ts
import { b64url } from './encoding';

export function zatToZec(zat: bigint): string {
  if (zat < 0n) throw new Error('negative amount');
  const whole = zat / 100_000_000n;
  const frac = (zat % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function buildZip321(address: string, zat: bigint, memoText?: string, message?: string): string {
  const params: string[] = [`amount=${zatToZec(zat)}`];
  if (memoText !== undefined) {
    if (address.startsWith('t')) throw new Error('ZIP 321: memo not allowed for a transparent address');
    const memo = new TextEncoder().encode(memoText);
    if (memo.length > 512) throw new Error('ZIP 321: memo exceeds 512 bytes');
    params.push(`memo=${b64url(memo)}`);
  }
  if (message) params.push(`message=${encodeURIComponent(message)}`);
  return `zcash:${address}?${params.join('&')}`;
}
```

**`packages/core/src/plans.ts`**

```ts
export type Plan = {
  id: string; label: string; priceZat: bigint; tokens: number; mode: 'session' | 'per-request';
};

export const PLANS: Record<string, Plan> = {
  monthly: { id: 'monthly', label: '30 days',       priceZat: 500_000n, tokens: 30,  mode: 'session' },
  api100:  { id: 'api100',  label: '100 API calls', priceZat: 200_000n, tokens: 100, mode: 'per-request' },
};
// Plan ids must match /^[a-z0-9]+$/ (they appear in the memo).
// JSON cannot serialize bigint: always convert with zatToZec() before sending.
```

**`packages/core/src/memo.ts`**

```ts
export const MEMO_RE = /^GP1 ([A-Z2-7]{26}) ([a-z0-9]+)$/;
export const buildMemo = (claimCode: string, planId: string) => `GP1 ${claimCode} ${planId}`;
export function parseMemo(text: string | null) {
  const m = MEMO_RE.exec(text ?? '');
  return m ? { claimCode: m[1], planId: m[2] } : null;
}
```

---

## 10. Server [LEAD; §10.5 is YOU]

### 10.1 Keys (`packages/server/src/keys.ts`)

```ts
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const suite = RSABSSA.SHA384.PSS.Randomized();

export const currentPeriod = (d = new Date()) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

// 00:00 UTC on the 15th of the following month (Date.UTC rolls December over to January).
export function redeemUntil(period: string): number {
  const [y, m] = period.split('-').map(Number);
  return Date.UTC(y, m, 15);
}

export async function newKeyPair() {
  const { privateKey, publicKey } = await suite.generateKey({
    publicExponent: Uint8Array.from([1, 0, 1]),
    modulusLength: 2048,
  });
  // ⚠ VERIFY the generated keys are extractable. If not, generate them with
  // crypto.subtle.generateKey({ name: 'RSA-PSS', modulusLength: 2048,
  //   publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-384' }, true, ['sign', 'verify'])
  // and confirm the suite accepts them by running the full blind/sign/finalize/verify round trip.
  const spki  = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
  return { spki, pkcs8 };
}

export const importPub = (spki: Uint8Array) =>
  crypto.subtle.importKey('spki', spki, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
export const importPriv = (pkcs8: Uint8Array) =>
  crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
// ⚠ VERIFY these import parameters against the library's examples.

// Private keys are encrypted at rest with a key-encryption key: GP_KEK_HEX=$(openssl rand -hex 32)
const KEK = Buffer.from(process.env.GP_KEK_HEX ?? '', 'hex');
if (KEK.length !== 32) throw new Error('GP_KEK_HEX must be 32 bytes of hex');

export function seal(data: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEK, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function unseal(blob: Buffer): Uint8Array {
  const d = createDecipheriv('aes-256-gcm', KEK, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return new Uint8Array(Buffer.concat([d.update(blob.subarray(28)), d.final()]));
}
```

On startup and once an hour, make sure the current period has a key. Insert it into `issuer_keys` with `redeem_until = redeemUntil(period)`. Then append the SHA-256 of its SPKI to `KEYS.json` in the public repo (§15.1).

### 10.2 `/.well-known/ghostpass.json`

Return every key whose `redeem_until` is still in the future, oldest first, plus `current: currentPeriod()` and the plans (amounts via `zatToZec`). The shape is in §6.1.

### 10.3 Checkout and status

```ts
app.post('/v1/checkout', express.json(), (req, res) => {
  const plan = PLANS[String(req.body?.plan)];
  if (!plan) return res.status(400).json({ error: 'unknown_plan' });
  const claimCode = base32(crypto.getRandomValues(new Uint8Array(16)));
  const memo = buildMemo(claimCode, plan.id);
  const uri = buildZip321(MERCHANT_UA, plan.priceZat, memo, `${MERCHANT_NAME} - ${plan.label}`);
  const now = Date.now(), expiresAt = now + 2 * 60 * 60 * 1000;
  db.prepare(`INSERT INTO checkouts (claim_code, plan, price_zat, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?)`).run(claimCode, plan.id, Number(plan.priceZat), now, expiresAt);
  res.json({ claimCode, uri, address: MERCHANT_UA, amountZec: zatToZec(plan.priceZat), memo, expiresAt });
});

app.get('/v1/checkout/:claimCode', (req, res) => {
  const co = db.prepare('SELECT * FROM checkouts WHERE claim_code = ?').get(req.params.claimCode) as any;
  if (!co) return res.status(404).json({ error: 'unknown_claim' });
  res.json({ status: co.status, paidZec: zatToZec(BigInt(co.paid_zat)), confirmations: co.min_conf });
});
```

### 10.4 Issuer

```ts
app.post('/v1/issue', express.json({ limit: '2mb' }), async (req, res) => {
  const { claimCode, period, blinded } = req.body ?? {};
  const co = db.prepare('SELECT * FROM checkouts WHERE claim_code = ?').get(String(claimCode)) as any;
  if (!co) return res.status(404).json({ error: 'unknown_claim' });
  const plan = PLANS[co.plan];
  if (period !== currentPeriod()) return res.status(409).json({ error: 'period_changed', current: currentPeriod() });
  if (!Array.isArray(blinded) || blinded.length !== plan.tokens)
    return res.status(400).json({ error: 'bad_count', expected: plan.tokens });

  // Atomic claim BEFORE signing: only one request can move CONFIRMED -> ISSUED.
  const claimed = db.prepare(`UPDATE checkouts SET status = 'ISSUED', issued_at = ?
                              WHERE claim_code = ? AND status = 'CONFIRMED'`).run(Date.now(), co.claim_code);
  if (claimed.changes !== 1) return res.status(409).json({ error: 'not_confirmed_or_already_issued' });

  try {
    const sk = await keys.privateFor(period);            // unseal + importPriv
    const blindSigs: string[] = [];
    for (const b of blinded) blindSigs.push(b64url(await suite.blindSign(sk, fromB64url(String(b)))));
    db.prepare('DELETE FROM payments WHERE claim_code = ?').run(co.claim_code);   // forget txids
    db.prepare(`INSERT INTO stats (period, issued) VALUES (?, ?)
                ON CONFLICT(period) DO UPDATE SET issued = issued + excluded.issued`).run(period, plan.tokens);
    res.json({ period, blindSigs });
  } catch {
    db.prepare(`UPDATE checkouts SET status = 'CONFIRMED', issued_at = NULL
                WHERE claim_code = ? AND status = 'ISSUED'`).run(co.claim_code);  // let the subscriber retry
    res.status(500).json({ error: 'issue_failed' });
  }
});
```

### 10.5 Matcher [YOU]

```ts
import { parseMemo } from '@ghostpass/core';
const REQUIRED_CONF = 2;

export async function matchPayments() {
  const since = Math.max(0, getCursor() - 20);          // re-check recent blocks in case of a reorg
  const r = await fetch(`http://127.0.0.1:8787/accounts/${MERCHANT_ACCOUNT_ID}/received?sinceHeight=${since}`);
  const { tipHeight, outputs } = await r.json();

  const upsert = db.prepare(`
    INSERT INTO payments (txid, out_index, claim_code, value_zat, confirmations)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(txid, out_index) DO UPDATE SET confirmations = excluded.confirmations`);
  for (const o of outputs) {
    const parsed = parseMemo(o.memoText);
    if (!parsed) continue;
    const co = db.prepare('SELECT status FROM checkouts WHERE claim_code = ?').get(parsed.claimCode) as any;
    if (!co || co.status === 'ISSUED') continue;        // unknown code, or a duplicate payment after issuance
    upsert.run(o.txid, o.outIndex, parsed.claimCode, Number(o.valueZat), o.confirmations);
  }

  const now = Date.now();
  db.exec(`
    UPDATE checkouts SET
      paid_zat = (SELECT COALESCE(SUM(value_zat), 0)     FROM payments p WHERE p.claim_code = checkouts.claim_code),
      min_conf = (SELECT COALESCE(MIN(confirmations), 0) FROM payments p WHERE p.claim_code = checkouts.claim_code)
    WHERE status IN ('AWAITING_PAYMENT','DETECTED','UNDERPAID','EXPIRED');`);
  db.prepare(`
    UPDATE checkouts SET status = CASE
      WHEN paid_zat = 0         THEN CASE WHEN expires_at < ? THEN 'EXPIRED' ELSE 'AWAITING_PAYMENT' END
      WHEN paid_zat < price_zat THEN 'UNDERPAID'
      WHEN min_conf >= ?        THEN 'CONFIRMED'
      ELSE 'DETECTED' END
    WHERE status IN ('AWAITING_PAYMENT','DETECTED','UNDERPAID','EXPIRED')`).run(now, REQUIRED_CONF);
  setCursor(tipHeight);
}

setInterval(() => matchPayments().catch((e) => console.error('matcher', e.message)), 20_000);
```

**Rules**

- **Honour late payments.** An `EXPIRED` checkout moves forward if money arrives later; never lose a payer's money.
- **Underpayments** stay `UNDERPAID`. A second payment carrying the same memo tops them up.
- **Duplicate payments** after issuance stay with the merchant. State that in your docs.

### 10.6 Redeemer middleware and sessions

```ts
import type { RequestHandler, Response } from 'express';
const AUTH_RE = /^Ghostpass v=1, period=(\d{4}-\d{2}), msg=([A-Za-z0-9_-]+), sig=([A-Za-z0-9_-]+)$/;

function challenge(res: Response) {
  res.setHeader('WWW-Authenticate', `Ghostpass realm="${MERCHANT_NAME}", keys="/.well-known/ghostpass.json"`);
  return res.status(401).json({ error: 'payment_required' });
}

export function requireGhostpass(): RequestHandler {
  return async (req, res, next) => {
    try {
      const m = AUTH_RE.exec(req.get('authorization') ?? '');
      if (!m) return challenge(res);
      const [, period, msgB64, sigB64] = m;
      const pk = await keys.publicIfRedeemable(period, Date.now());   // null if unknown or past redeem_until
      if (!pk) return challenge(res);
      const msg = fromB64url(msgB64);
      if (!(await suite.verify(pk, fromB64url(sigB64), msg))) return challenge(res);
      const spent = db.prepare('INSERT OR IGNORE INTO spent_tokens (period, token_hash) VALUES (?, ?)')
                      .run(period, await sha256hex(msg));
      if (spent.changes !== 1) return res.status(401).json({ error: 'token_already_spent' });
      db.prepare(`INSERT INTO stats (period, redeemed) VALUES (?, 1)
                  ON CONFLICT(period) DO UPDATE SET redeemed = redeemed + 1`).run(period);
      next();
    } catch {
      return challenge(res);
    }
  };
}
```

**Session mode** (requires `cookie-parser` and HTTPS):

```ts
import { createHash, randomBytes } from 'node:crypto';
const h = (s: string) => createHash('sha256').update(s).digest('hex');

app.post('/session/start', requireGhostpass(), (_req, res) => {
  const id = randomBytes(32).toString('base64url');
  const ttl = 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions (id_hash, expires_at) VALUES (?, ?)').run(h(id), Date.now() + ttl);
  res.cookie('gp_s', id, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: ttl });
  res.json({ ok: true });
});

export const requireSession: RequestHandler = (req, res, next) => {
  const id = req.cookies?.gp_s;
  const row = id && (db.prepare('SELECT expires_at FROM sessions WHERE id_hash = ?').get(h(id)) as any);
  if (!row || row.expires_at < Date.now()) return res.redirect('/subscribe');
  next();
};
```

Run a cleanup job every hour to delete expired sessions, and `spent_tokens` rows whose period is past its redeem window.

---

## 11. Client [LEAD]

### 11.1 Persist pending checkouts

As soon as `/v1/checkout` returns, save `{claimCode, plan, createdAt}` in IndexedDB under `gp.pending`. On every page load, resume polling any pending claim. Show the claim code with a "Save this code" note: until tokens are issued, it is the subscriber's only receipt.

### 11.2 Checkout component (outline)

1. `POST /v1/checkout {plan}`.
2. Render the QR code from `uri` (`qrcode` package). Show the amount, plus the memo text with a **Copy** button in case a wallet ignores the memo parameter. **⚠ VERIFY** that Zodl carries the `memo` from a scanned ZIP 321 URI.
3. Poll `GET /v1/checkout/:claimCode` every 10 seconds and show the status in plain words.
4. On `CONFIRMED`, call `obtainTokens()`, remove the entry from `gp.pending`, and show "Ready".

### 11.3 Obtaining tokens

```ts
import { get, set } from 'idb-keyval';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { b64url, fromB64url } from '@ghostpass/core';

const suite = RSABSSA.SHA384.PSS.Randomized();
export type Token = { period: string; msg: string; sig: string };

export async function obtainTokens(base: string, claimCode: string, count: number): Promise<number> {
  const meta = await (await fetch(`${base}/.well-known/ghostpass.json`)).json();
  const key = meta.keys.find((k: any) => k.period === meta.current);
  await checkKeyConsistency(key.period, key.spki);        // §15.1; throws on mismatch
  const pk = await crypto.subtle.importKey('spki', fromB64url(key.spki),
    { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);

  const pending = [];
  for (let i = 0; i < count; i++) {
    const prepared = suite.prepare(crypto.getRandomValues(new Uint8Array(32)));
    const { blindedMsg, inv } = await suite.blind(pk, prepared);
    pending.push({ prepared, blindedMsg, inv });
  }

  const r = await fetch(`${base}/v1/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claimCode, period: key.period, blinded: pending.map((p) => b64url(p.blindedMsg)) }),
  });
  if (r.status === 409) throw new Error('retry: period changed or claim already used');
  if (!r.ok) throw new Error(`issue failed: ${r.status}`);
  const { blindSigs } = await r.json();

  const tokens: Token[] = [];
  for (let i = 0; i < count; i++) {
    const sig = await suite.finalize(pk, pending[i].prepared, fromB64url(blindSigs[i]), pending[i].inv);
    tokens.push({ period: key.period, msg: b64url(pending[i].prepared), sig: b64url(sig) });
  }
  await set('gp.tokens', [...(((await get('gp.tokens')) as Token[]) ?? []), ...tokens]);
  await set('gp.notBefore', Date.now() + (60 + Math.floor(Math.random() * 540)) * 1000); // 1–10 min first-use delay (§15)
  return tokens.length;
}
```

### 11.4 Spending tokens

```ts
export async function ghostFetch(url: string, init: RequestInit = {}) {
  const notBefore = ((await get('gp.notBefore')) as number) ?? 0;
  if (Date.now() < notBefore) throw new Error('Your pass activates in a few minutes (privacy delay)');
  const all = ((await get('gp.tokens')) as Token[]) ?? [];
  const t = all.shift();
  if (!t) throw new Error('No tokens left: renew your plan');
  await set('gp.tokens', all);                 // remove BEFORE use, so a token is never sent twice
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Ghostpass v=1, period=${t.period}, msg=${t.msg}, sig=${t.sig}`);
  return fetch(url, { ...init, headers });
}
```

Known edge: two tabs can race for the same token. That's acceptable for the demo; the server rejects the second use.

### 11.5 Renewal

Show "N tokens left · redeemable until <date>", plus a **Renew** button that starts a new checkout. Zcash can't pull money from a wallet, so renewal is always a fresh payment. Say this plainly in the UI.

---

## 12. Demo merchants and dashboard [LEAD]

**1. "The Quiet Letter"** (Next.js newsletter, session mode)
- `/subscribe` hosts the checkout widget.
- After tokens arrive, the page calls `ghostFetch('/session/start', { method: 'POST' })`, which sets the 24-hour cookie.
- Post pages are protected by `requireSession`.

**2. "Private Price API"** (per-request mode)
- `GET /api/v1/price` (or any small service), protected by `requireGhostpass()`.
- For the README and video:

```bash
curl -H "Authorization: Ghostpass v=1, period=2026-10, msg=<…>, sig=<…>" https://<your-host>/api/v1/price
```

**3. Dashboard** (admin password, HTTPS)
- Per period: checkouts paid, tokens issued, tokens redeemed, ZEC received, and zwatch balance.
- There are no per-subscriber rows, because none exist. Point that out in the video.

**Hosting:** one small VPS running the server, zwatch and zcash-devtool behind a reverse proxy with TLS. Secure cookies require HTTPS. Turn off IP addresses in the access logs (§15.3).

---

## 13. Database schema

```sql
CREATE TABLE checkouts (
  claim_code  TEXT PRIMARY KEY,
  plan        TEXT    NOT NULL,
  price_zat   INTEGER NOT NULL,
  paid_zat    INTEGER NOT NULL DEFAULT 0,
  min_conf    INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'AWAITING_PAYMENT',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  issued_at   INTEGER
);

-- Deleted once the checkout reaches ISSUED, so txids are not kept.
CREATE TABLE payments (
  txid          TEXT    NOT NULL,
  out_index     INTEGER NOT NULL,
  claim_code    TEXT    NOT NULL REFERENCES checkouts(claim_code),
  value_zat     INTEGER NOT NULL,
  confirmations INTEGER NOT NULL,
  PRIMARY KEY (txid, out_index)
);

CREATE TABLE issuer_keys (
  period       TEXT PRIMARY KEY,
  spki         BLOB    NOT NULL,
  pkcs8_sealed BLOB    NOT NULL,
  redeem_until INTEGER NOT NULL
);

-- No timestamps or request data: only "this token was used".
CREATE TABLE spent_tokens (
  period     TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  PRIMARY KEY (period, token_hash)
);

CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);

CREATE TABLE stats (
  period   TEXT PRIMARY KEY,
  issued   INTEGER NOT NULL DEFAULT 0,
  redeemed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);   -- matcher cursor, etc.
```

Show this schema in the README: it proves there is **no column** that links a claim code to a spent token.

---

## 14. Dev mode for judges

Judges may not hold ZEC, so give them a way to test.

- With `GP_DEV_FAKE_PAYMENTS=1`, the server exposes `POST /dev/pay/:claimCode`. It inserts a fake payment for the full price with `confirmations = 2`, so the normal matcher logic promotes the checkout.
- The server **refuses to start** if `NODE_ENV=production` and this flag is set.
- The UI shows a red "DEV MODE: payments are simulated" banner whenever it's on.
- The README gives two paths: "Try it in 2 minutes" (dev mode, local) and "Real payment" (Mainnet, Zodl).

---

## 15. Privacy engineering, leak table, honest limits

### 15.1 Key consistency

A dishonest merchant could give each subscriber a *different* key, and so recognise them when they redeem. The defence is to make everyone see the same key:

- Append `{period, sha256(spki)}` to `KEYS.json` in the public repo whenever a key is created. Git history makes it append-only and auditable.
- Before blinding, the client fetches the raw `KEYS.json` from the public repo and compares hashes (`checkKeyConsistency`). On a mismatch, it refuses to continue.
- The Privacy Pass architecture (RFC 9576) discusses this "key consistency" problem; cite it in the README.

### 15.2 Timing

If a subscriber is issued tokens and spends one immediately, the merchant can link the two by time. The client therefore waits a random 1–10 minutes before first use (`gp.notBefore`). Optional strict mode: issue only at :00, :15, :30 and :45.

### 15.3 Network and data

- Don't log IP addresses at the reverse proxy or in the app.
- No third-party scripts, fonts or analytics.
- Recommend Tor Browser or a VPN in the UI, because the same IP address at issuance and at use links the two.
- Delete txids after issuance, and spent-token hashes after the period's redeem window.
- Use fixed price tiers only, so every payment for a plan has the same amount.

### 15.4 Leak table (put this in the README)

| Who | What they learn |
|---|---|
| Blockchain observer | That a shielded transaction happened, plus its fee and size. Not the sender, recipient, amount or memo. |
| Merchant at payment time | Claim code X paid amount A at time T. |
| Merchant when a token is used | A valid token for period P was used at time T2. It can't be linked to X or to other tokens. |
| Merchant overall | How many subscribers there are per period. |
| Network observer | IP addresses, unless the subscriber uses Tor or a VPN. |

### 15.5 Honest limits

- **Small anonymity set at launch.** With few subscribers, timing can link payment and use. Privacy improves as the subscriber count grows.
- **Key consistency** depends on subscribers' clients checking the published hashes.
- **Tokens are bearer tokens.** They can be shared or stolen from the browser.
- **No automatic renewal.** Zcash has no pull payments.
- **zcash-devtool** is prototyping software.

---

## 16. Optional: pay with other assets via NEAR Intents [YOU, only if everything else is green]

NEAR Intents supports ZEC **only on transparent addresses**, so this mode has a public transparent hop. Label it "Convenience mode: weaker privacy" in the UI, and never make it the default.

**Flow**

1. `GET https://1click.chaindefuser.com/v0/tokens`. Look up the ZEC asset id (blockchain `zec`) and the payer's origin asset. Never hard-code asset ids.
2. `POST https://1click.chaindefuser.com/v0/quote`. Send a JWT (`Authorization: Bearer …`); without one there's an extra 0.25% fee.

```json
{
  "dry": false,
  "swapType": "EXACT_OUTPUT",
  "slippageTolerance": 100,
  "originAsset": "<payer's asset id from /v0/tokens>",
  "depositType": "ORIGIN_CHAIN",
  "destinationAsset": "<ZEC asset id from /v0/tokens>",
  "amount": "500000",
  "recipient": "<fresh merchant transparent address used for this checkout only>",
  "recipientType": "DESTINATION_CHAIN",
  "refundTo": "<payer's address on the origin chain>",
  "refundType": "ORIGIN_CHAIN",
  "deadline": "<ISO 8601 time, now + 30 minutes>"
}
```

**⚠ VERIFY** on the Swap Types page that with `EXACT_OUTPUT`, `amount` is the destination amount in zatoshis.

3. The payer sends funds to the returned `depositAddress`. Optionally notify the service with `POST /v0/deposit/submit {depositAddress, txHash}`.
4. Poll `GET /v0/status?depositAddress=…`. On `SUCCESS`, mark the checkout `CONFIRMED`; there's no memo in this mode, so match by `depositAddress`. Handle `INCOMPLETE_DEPOSIT`, `REFUNDED` and `FAILED`.
5. The merchant shields the transparent receipts afterwards.

**Disclose:** the source chain is public, solvers see the intent, and the intents system holds funds during the swap.

---

## 17. Tests

**Unit**
- `zatToZec`: `500000n → "0.005"`, `100000000n → "1"`, `1n → "0.00000001"`.
- `buildZip321`: base64url without padding; rejects a memo over 512 bytes; rejects a memo on a `t…` address.
- `base32`: 16 bytes produce 26 characters, all in `A–Z2–7`.
- `parseMemo` and `decodeMemo` (0xF6, binary, zero padding).

**Server**
- `claimForIssue` is atomic: two concurrent `/v1/issue` calls produce exactly one success.
- Full token round trip; double spend rejected; expired period rejected; token signed by a different key rejected.

**Integration**
- Checkout → `/dev/pay` → matcher → issue → session start → protected page → spend the same token again → `401`.

**Mainnet end-to-end** (before 24 Oct)
- At least 5 real subscriptions from Zodl across both plans, including one underpayment that's topped up and one late payment after `expiresAt`.

---

## 18. Day-by-day plan

Your Shadow Desk FROST spike runs 8–9 Oct, so your Ghostpass tasks on those days are blank on purpose. The friend works in dev mode until zwatch is live.

| Dates | [LEAD] friend | [YOU] |
|---|---|---|
| 6 Oct | Repo, pnpm workspace, CI; `core` package with tests | Toolchain; merchant wallet (§8); fund Zodl |
| 7 Oct | Checkout endpoint and page with QR; dev mode | Freeze the zwatch API (§7.1); Path A import and sync |
| 8–9 Oct | Keys, `/.well-known`, issuer; token round trip in Node and the browser | (Shadow Desk spike) |
| 10–11 Oct | Token wallet, `ghostFetch`, pending-checkout persistence; redeemer and spent-set | zwatch `received` with memos; acceptance test (§7.4) |
| 12 Oct | End-to-end in dev mode | Matcher (§10.5) on Mainnet: first real subscription |
| 13–16 Oct | Newsletter demo (session mode); API demo (per-request) | Confirmations, late and under-payments, txid deletion |
| 17–20 Oct | Dashboard; renewal; error states; polish | Privacy review (§15); deploy on the VPS with TLS |
| 21–23 Oct | 5+ Mainnet subscriptions; bug fixes | NEAR Intents mode **only** if everything else is green |
| 24–26 Oct | README, leak table, video | Review the README; collect txids |
| 27 Oct | **Submit** | — |
| 28 Oct | Deadline (buffer) | — |

---

## 19. Definition of done

- [ ] At least 5 Mainnet subscriptions paid from Zodl, with txids and one line each in the README
- [ ] Both demo merchants work with real tokens
- [ ] A token replay is rejected live in the video
- [ ] The README shows the schema: no link between claim codes and spent tokens
- [ ] `KEYS.json` is published and checked by the client
- [ ] Leak table and honest limits are in the README
- [ ] A fresh clone runs in dev mode in under 10 minutes
- [ ] `versions.lock` is committed
- [ ] The video is 3 minutes or less

---

## 20. Three-minute video

| Time | Show |
|---|---|
| 0:00–0:20 | The problem: subscriptions need accounts, and crypto subscriptions are public |
| 0:20–0:50 | Subscribe to The Quiet Letter: QR code, pay from Zodl |
| 0:50–1:10 | Payment detected, tokens issued (show the blinded requests in browser devtools) |
| 1:10–1:40 | Read posts; call the API with curl; replay a token, which is rejected |
| 1:40–2:20 | The merchant database: claim codes and spent-token hashes, with no link between them |
| 2:20–2:45 | Leak table and the key-consistency check |
| 2:45–3:00 | The drop-in middleware: three lines to add Ghostpass to any API |

---

## 21. Submission README template

1. One-line pitch and video link
2. The problem, with one concrete example
3. How it works (the diagram from §5)
4. **What leaks to whom** (§15.4)
5. Mainnet evidence: txids and what each shows
6. Try it in 2 minutes (dev mode) / real payment (Mainnet)
7. Honest limits (§15.5)
8. Credits: blindrsa-ts (Apache-2.0), zcash-devtool (MIT/Apache-2.0), and any other reused code; license

---

## 22. Rules to confirm on thezecathon.com (behind the login)

- Can one person appear on two submissions? You're also on Shadow Desk.
- Are public repos allowed, given that "submissions are sealed until judging"?
- What's the policy on pre-existing code and dependencies?
- What are the judging criteria? Until you see them, self-score against ZecHub 3.0's: does it work, does it use Zcash meaningfully, completeness, originality, ecosystem impact, and documentation and ease of testing.
- Community Choice ($5,000): if the rules allow public posts, share a short demo clip.

---

## 23. Resources

**Hackathon:** https://thezecathon.com

**Specifications** (https://zips.z.cash/)
- ZIP 302 memo format: https://zips.z.cash/zip-0302
- ZIP 316 Unified Addresses and viewing keys: https://zips.z.cash/zip-0316
- ZIP 317 fees: https://zips.z.cash/zip-0317
- ZIP 321 payment request URIs: https://zips.z.cash/zip-0321
- ZIP 326 NU6.3 consequences for wallets: https://zips.z.cash/zip-0326
- ZIP 229 v6 transactions: https://zips.z.cash/zip-0229
- ZIP 258 NU6.3 deployment: https://zips.z.cash/zip-0258
- NU7: ZIP 259 (deployment), ZIP 218 (25-second blocks), ZIP 2003 (no v4 transactions)
- ZIP 315 wallet best practices: https://zips.z.cash/zip-0315
- ZIP 307 light client protocol: https://zips.z.cash/zip-0307
- Protocol specification: https://zips.z.cash/protocol/protocol.pdf
- The Ironwood Book: https://zcash.github.io/ironwood/

**Zcash software**
- librustzcash: https://github.com/zcash/librustzcash (`zcash_client_backend`, `zcash_client_sqlite`, `zcash_keys`, `zcash_address`, `zip321`)
- Wallet database views (`v_transactions`, `v_tx_outputs`): https://docs.rs/zcash_client_sqlite/latest/zcash_client_sqlite/wallet/index.html
- zcash-devtool: https://github.com/zcash/zcash-devtool
- zcash-devtool walkthrough: https://github.com/zcash/zcash-devtool/blob/main/doc/walkthrough.md
- Zebra (v6.0.0 or later for Ironwood): https://github.com/ZcashFoundation/zebra
- Zodl wallets and SDKs: https://github.com/zodl-inc
- ECC developer docs: https://zcash.readthedocs.io/en/latest/ (Basics, Development Best Practices, Light Client Development). Treat zcashd-specific pages as legacy; zcashd is being replaced by Zebra and Zallet.

**Blind tokens**
- RFC 9474, RSA Blind Signatures: https://www.rfc-editor.org/rfc/rfc9474
- Privacy Pass: RFC 9576 (architecture), RFC 9577 (HTTP authentication scheme), RFC 9578 (issuance protocols)
- `@cloudflare/blindrsa-ts`: https://github.com/cloudflare/blindrsa-ts
- Rust alternative: https://crates.io/crates/blind-rsa-signatures

**NEAR Intents** (optional mode only)
- Docs: https://docs.near-intents.org/
- Chain support (ZEC is transparent-only): https://docs.near-intents.org/resources/chain-support.md
- Making a request: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request.md
- OpenAPI specification: https://1click.chaindefuser.com/docs/v0/openapi.yaml

**Reference projects** (learn from them and credit them; don't copy)
- ZcashMe login: https://github.com/zcashme/zns-login
- Portal: https://github.com/IamHarrie-Labs/portal
- Zink: https://github.com/KaranSinghBisht/zink
- SAVANNA: https://github.com/LucasdoCondo/SAVANNA
- zkSEND: https://github.com/404snark/zkSEND
- ZecHub Hackathon 3.0 winners: https://zechub.substack.com/p/announcing-the-winners-of-zechub

**Community**
- Zcash Community Forum: https://forum.zcashcommunity.com
- ZecHub: https://zechub.wiki (links to the Zcash Global Discord)
