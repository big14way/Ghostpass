# Ghostpass

Unlinkable subscriptions paid in shielded ZEC, built for ZECATHON.

A subscriber pays in shielded ZEC and receives a batch of blind-signed access
tokens. Merchants verify and redeem tokens without an account, email, or password.
The design aims to prevent linking redeemed tokens to their purchase; network
metadata, timing, and small anonymity sets remain privacy limits.

## Project documents

- [Original build guide](docs/build-guide.md): your friend's proposal, preserved unchanged.
- [Working plan](docs/project-plan.md): responsibilities, milestones, and verification gates.

The guide specifies the Shielded Payments track, a 28 October 2026 deadline, and
a target submission date of 27 October. Event rules and dates still need confirmation.

## Responsibilities

| Owner | Scope from the guide |
| --- | --- |
| dr-winner | `zwatch`, merchant wallet setup, payment matcher, confirmations and payment edge cases, privacy review, deployment support |
| Friend / lead | Core package, blind-token issuer and redeemer, browser token wallet, demo merchants, dashboard, submission materials |

The proposed stack is a pnpm monorepo with TypeScript, Express, SQLite, Next.js,
and `@cloudflare/blindrsa-ts`. The initial watcher proposal wraps `zcash-devtool`;
a Rust watcher is a fallback. No application code or dependencies are installed yet.

## Orca workspace

Use the **Zecaton — Ghostpass** workspace as the project hub. The primary checkout
is `/Users/procoder/Projects/Ghostpass`, and `main` is the base branch for new task
workspaces.

Setup and archive scripts are empty, and setup is skipped by default. After the
pnpm workspace is created, configure verified install and run commands in Orca's
project settings.

New task workspaces use Orca's standard workspace directory. The existing Codex
session can help with planning, implementation, testing, and submission materials.

Commits use the maintainer's GitHub identity, `dr-winner`; agent attribution rules
are recorded in [AGENTS.md](AGENTS.md).
