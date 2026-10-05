# Ghostpass

Unlinkable subscriptions paid in shielded ZEC, built for ZECATHON.

A subscriber pays in shielded ZEC and receives a batch of blind-signed access
tokens. Merchants verify and redeem tokens without an account, email, or password.
The design aims to prevent linking redeemed tokens to their purchase; network
metadata, timing, and small anonymity sets remain privacy limits.

## Project documents

- [Original build guide](docs/build-guide.md): Gwill's proposal, preserved unchanged.
- [Working plan](docs/project-plan.md): responsibilities, milestones, and verification gates.
- [Watcher API and integration guide](docs/watcher-api.md): running your components and connecting the lead's server.

The guide specifies the Shielded Payments track, a 28 October 2026 deadline, and
a target submission date of 27 October. Event rules and dates still need confirmation.

## Responsibilities

| Owner | Scope from the guide |
| --- | --- |
| dr-winner | `zwatch`, merchant wallet setup, payment matcher, confirmations and payment edge cases, privacy review, deployment support |
| Gwill ([big14way](https://github.com/big14way)), lead | Core package, blind-token issuer and redeemer, browser token wallet, demo merchants, dashboard, submission materials |

The proposed stack is a pnpm monorepo with TypeScript, Express, SQLite, Next.js,
and `@cloudflare/blindrsa-ts`. Your payment watcher and matcher are implemented
with TypeScript, Express, and SQLite, wrapping a pinned `zcash-devtool`. The lead's
core, issuer, client, and demo apps are still to be built.

## Run your components

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm demo:payments   # simulated underpayment and top-up, no funds needed
pnpm dev:watcher     # HTTP API with fixture payments
pnpm start:watcher   # real viewing-only wallet, using local .env
```

Your local toolchain and empty encrypted merchant wallet have been prepared.
Before funding, back up the two wallet files listed in the [integration guide](docs/watcher-api.md#merchant-wallet-and-native-tool).
Real memo-bearing payments and the lead's token flow remain to be tested.

## Orca workspace

Use the **Zecaton — Ghostpass** workspace as the project hub. The primary checkout
is `/Users/procoder/Projects/Ghostpass`, and `main` is the base branch for new task
workspaces.

Setup and archive scripts are empty, and setup is skipped by default. Run
`pnpm install --frozen-lockfile` in a fresh task workspace. The merchant wallet
and `.env` remain local to the primary checkout.

New task workspaces use Orca's standard workspace directory. The existing Codex
session can help with planning, implementation, testing, and submission materials.

Commits use the maintainer's GitHub identity, `dr-winner`; agent attribution rules
are recorded in [AGENTS.md](AGENTS.md).
