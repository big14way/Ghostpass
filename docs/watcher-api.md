# zwatch API and matcher integration

Status: version 1 is implemented and tested locally. Review this contract with
the lead before treating it as a jointly frozen API. It extends guide §7.1 with
authentication and explicit snapshot completeness for safe reconciliation.

## Run locally

Prerequisites: Node 24.14.1, pnpm 10.33.0. Install JS dependencies with `pnpm install`.

```sh
pnpm typecheck
pnpm test
pnpm check:tools

# Standalone simulated underpayment + top-up demonstration:
pnpm demo:payments

# HTTP service with simulated payments:
pnpm dev:watcher

# HTTP service using the real viewing-only wallet:
pnpm start:watcher
```

The fixture service advertises `mode: "fixture"`, prints a simulated-payment
message, and refuses `NODE_ENV=production`. By default its API token is
`ghostpass-local-demo`; when `.env` defines `ZWATCH_API_TOKEN`, that token is used
instead. The standalone demo needs no running server. Set `ZWATCH_URL` explicitly
to exercise its HTTP client against a running fixture service.

`start:watcher` loads `.env` and requires a random API token of at least 32
characters. The service binds only to `127.0.0.1`; it rejects browser origins and
non-loopback Host headers. It has no request or payment-content logging.

## Endpoints

All account endpoints require `Authorization: Bearer <ZWATCH_API_TOKEN>`.
`GET /health` is available without the token. Every response has `Cache-Control: no-store`.

| Method | Path | Request / response |
| --- | --- | --- |
| POST | `/accounts` | `{name, ufvk, birthday}` → `201 {accountId}` |
| GET | `/accounts/:id/balance` | `{confirmedZat, pendingZat, tipHeight}` |
| GET | `/accounts/:id/received?sinceHeight=N` | Complete received-output snapshot described below |
| GET | `/health` | `{v, mode, tipHeight, lastSyncAt, ready}`; `503` when unhealthy |

Account imports accept Unified Full Viewing Keys only, never spending keys or
mnemonics. The native tool validates the key encoding. Reimporting the same key
with the same birthday returns the same account ID; a conflicting birthday
returns `409`. Import success does not imply sync completion: reads return `503`
until the first complete sync. The fixture backend accepts only `ufvk: "fixture-only"`.

`sinceHeight` is an inclusive nonnegative integer; it defaults to zero. Output
records include mined payments, including spent receipts, but exclude change,
transparent outputs, sent-only outputs, and unmined transactions. An empty
snapshot is meaningful only when `complete` is true.

```json
{
  "v": 1,
  "accountId": "fixture-merchant",
  "mode": "fixture",
  "tipHeight": 3428200,
  "sinceHeight": 0,
  "complete": true,
  "lastSyncAt": "2026-10-05T18:00:00.000Z",
  "outputs": [
    {
      "txid": "1111111111111111111111111111111111111111111111111111111111111111",
      "pool": 4,
      "outIndex": 0,
      "height": 3428199,
      "confirmations": 2,
      "valueZat": "300000",
      "memoText": "GP1 AAAAAAAAAAAAAAAAAAAAAAAAAA monthly"
    }
  ]
}
```

The example is simulated. Pool codes from the pinned schema are `2` (Sapling),
`3` (Orchard), and `4` (Ironwood). Identity is **(txid, pool, outIndex)**. All
amounts are decimal strings; matcher arithmetic uses `bigint`. Memo decoding
rejects binary markers and malformed UTF-8 and removes trailing zero padding.

Live balance uses `wallet balance --json --min-confirmations 2`: `confirmedZat`
is the sum of spendable balances across all pools; `pendingZat` is total minus
spendable. Witness availability and the native wallet's spendability policy can
keep funds pending. This is wallet balance, not lifetime receipts. Fixture balance
is only the sum of fixture receipts, because its scenario has no spending history.

Errors are JSON `{error: "code"}`. Invalid JSON, keys, or query arguments return
`400`; bad authentication `401`; browser/Host rejection `403`; unknown accounts
`404`; conflicting imports `409`; oversized JSON bodies `413`; unavailable,
incomplete, failed, or stale wallet syncs `503`. Error responses never echo keys,
command arguments, wallet paths, or memos. Account request bodies are limited to 16 KiB.

## Lead's server integration

Add `@ghostpass/matcher` as a workspace dependency of the merchant server.
The lead creates `checkouts` with the guide's columns, then installs payment tables:

```ts
import { installPaymentTables, forgetIssuedPayments } from '@ghostpass/matcher';
import { PaymentMatcher } from '@ghostpass/matcher/poller';

installPaymentTables(db);
const matcher = new PaymentMatcher({
  db,
  url: process.env.ZWATCH_URL!,
  accountId: process.env.MERCHANT_ACCOUNT_ID!,
  token: process.env.ZWATCH_API_TOKEN!,
  onError: code => console.error(code),
});
matcher.start();

// After successful issuance, inside the issuer's transaction:
forgetIssuedPayments(db, claimCode);

// On shutdown, before db.close():
await matcher.stop();
```

The ledger differs from guide §13: `payments` adds `pool` and `height`, and its
primary key is `(txid, pool, out_index)`. The installer refuses a conflicting
schema rather than silently altering it. An existing guide-style ledger needs an
explicit migration. Matcher metadata lives in a separate `matcher_meta` table.

The poller serializes requests. It always fetches the full history (`sinceHeight=0`)
and replaces the unissued-payment ledger and checkout states in one SQLite
transaction. This removes orphaned payments and revisits previously confirmed
claims; a fixed twenty-block lookback is unnecessary. Full snapshots are suitable
for this prototype's small history; pagination and incremental reorg metadata
are future scaling work. Validate limits before increasing the current cap of
100,000 outputs / 16 MiB per HTTP snapshot.

Only memos whose claim code and plan match an existing checkout count. Late
payments and top-ups are supported. Confirmation depth is computed from enough
of the most-confirmed funds to cover the price; pending excess does not downgrade
an already covered checkout. Snapshot account, completeness, age, amount format,
output identity, and confirmation arithmetic are checked before any writes.

Fixture snapshots require explicit `allowFixture: true` and are rejected in
production. Issued claims are never reopened or credited again. Their transaction
ledger is deleted, while checkout totals remain. Deep reorganizations after
issuance cannot revoke already distributed blind tokens; the confirmation policy
is a settlement assumption, not finality. The separate wallet database still
contains transaction history: deleting the merchant application's `payments`
does not delete wallet history or hide it from the viewing-key holder.

## Merchant wallet and native tool

The locally built binary is `.local/bin/zcash-devtool`. `versions.lock` pins its
source revision and dependencies; `pnpm-lock.yaml` pins JS dependencies. To
rebuild on another host, clone the source, check out the recorded revision, and run
`cargo install --path <checkout> --locked --root <project>/.local`. Rust >= 1.88,
protobuf, and native build tools are required by the pinned source.

`pnpm setup:wallet` creates an encrypted Mainnet merchant wallet if none exists,
selects an Orchard-only Unified Address, imports only the UFVK into zwatch, and
validates an initial sync. It never sends funds or prints keys. It writes local
account details to `.local/merchant-account.json` and creates `.env` only if absent.
If `.env` already exists, ensure its account ID and address agree with that file.

Back up both `.local/keys/merchant.age` and the encrypted
`.local/merchant/keys.toml` offline before funding. All wallet directories, local
configuration, keys, and databases are ignored by Git. The watcher imports a
viewing key through a native command argument because the pinned CLI provides
that interface; local process inspection can therefore reveal it during import.

Each successful watcher cycle runs **sync → enhance → read-only SQLite snapshot
→ JSON balance**. It publishes only fully scanned snapshots; failures make an
account unready. A directory lock prevents two zwatch instances from operating
the same root. After a crash, confirm the recorded PID in `.zwatch.lock` is no
longer running before manually removing the stale lock. Do not run external
wallet-writing commands against zwatch's managed wallet directories.

Verified sources:

- [Pinned devtool source](https://github.com/zcash/zcash-devtool/tree/5a26ee854e634a4e88d1d79dab13f8fbb1eac6b8): native command definitions and compiled help.
- [Wallet crate 0.22.0](https://docs.rs/crate/zcash_client_sqlite/0.22.0/source/src/wallet/): received-output views, transaction heights, scan ranges, and pool codes.
- [ZIP 302](https://zips.z.cash/zip-0302): memo representation.

An empty Mainnet wallet sync has been verified locally. Receiving and matching
a real memo-bearing payment remains the next acceptance check.
