# Deploying Ghostpass

This runbook puts zwatch, both demo merchants and the dashboard on one Ubuntu
server behind Caddy, which provides HTTPS. Only the merchant's **viewing key**
goes to the server; the spending seed stays on dr-winner's machine. The commands
were run end to end in an Ubuntu 24.04 container with systemd and Caddy (see
[What was tested](#what-was-tested)).

```
Internet ──443──▶ Caddy (TLS, no access logs, strips X-Forwarded-For)
                   ├─ letter.example.com    ─▶ 127.0.0.1:3000  The Quiet Letter
                   ├─ api.example.com       ─▶ 127.0.0.1:3001  Private Price API
                   └─ dashboard.example.com ─▶ 127.0.0.1:3002  Dashboard
                  ghostpass-demo ──matcher──▶ 127.0.0.1:8787  zwatch ──▶ lightwalletd (zec.rocks)
```

## What you need

- An Ubuntu 24.04 LTS server (x86-64 or ARM64) with 2+ vCPUs, 4 GB RAM (for
  building zcash-devtool) and 20 GB of disk, and an account with sudo.
- Three DNS records pointing at the server, for example `letter.`, `api.` and
  `dashboard.` under your domain. Ports 80 and 443 must be reachable for certificates.
- From dr-winner's machine, where `pnpm setup:wallet` created the merchant wallet:
  the wallet itself (to export the viewing key) and `.local/merchant-account.json`
  (its `address` and `birthday`).

In the commands below, replace `example.com` with your domain.

## 1. Base packages and firewall

```sh
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev clang protobuf-compiler sqlite3 git curl xz-utils ufw
sudo ufw allow 22/tcp   # your SSH port, if different
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

## 2. Node 24.14.1

```sh
NODE_VERSION=24.14.1
case "$(dpkg --print-architecture)" in amd64) ARCH=x64 ;; arm64) ARCH=arm64 ;; esac
cd /tmp
curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.xz"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " node-v$NODE_VERSION-linux-$ARCH.tar.xz\$" | sha256sum -c -
sudo tar -xJf "node-v$NODE_VERSION-linux-$ARCH.tar.xz" -C /usr/local --strip-components=1 --no-same-owner --exclude='*.md' --exclude=LICENSE
sudo corepack enable
node --version
```

`sha256sum -c` must print `OK`. The systemd units expect Node at `/usr/local/bin/node`.

## 3. Caddy

The official Caddy apt repository ([caddyserver.com/docs/install](https://caddyserver.com/docs/install)):

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

## 4. Service user and code

```sh
sudo useradd --system --create-home --home-dir /var/lib/ghostpass --shell /usr/sbin/nologin ghostpass
sudo install -d -o ghostpass -g ghostpass -m 755 /opt/ghostpass
sudo -u ghostpass -H git clone https://github.com/big14way/Ghostpass.git /opt/ghostpass
cd /opt/ghostpass
sudo -u ghostpass -H install -d -m 700 .local .local/home .local/bin
sudo -u ghostpass -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile
```

Do not set `NODE_ENV=production` while installing: the services run TypeScript through
`tsx`, a development dependency.

## 5. zcash-devtool (pinned revision)

Rust is installed for the `ghostpass` user only. The build took about 4 minutes on 11 cores; allow 10–30 on a small server.

```sh
sudo -u ghostpass -H bash -c 'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'
REV=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/opt/ghostpass/versions.lock','utf8')).zcashDevtool.revision)")
sudo -u ghostpass -H git clone https://github.com/zcash/zcash-devtool.git /var/lib/ghostpass/zcash-devtool
sudo -u ghostpass -H git -C /var/lib/ghostpass/zcash-devtool checkout --quiet "$REV"
sudo -u ghostpass -H bash -c '. ~/.cargo/env && cargo install --locked --path ~/zcash-devtool --root /opt/ghostpass/.local'
sudo -u ghostpass -H /opt/ghostpass/.local/bin/zcash-devtool --help | head -3
```

## 6. Configuration

```sh
cd /opt/ghostpass
sudo -u ghostpass -H install -m 600 deploy/env.production.example .env
sudo -u ghostpass -H sed -i \
  -e "s/^ZWATCH_API_TOKEN=.*/ZWATCH_API_TOKEN=$(openssl rand -hex 32)/" \
  -e "s/^GP_KEK_HEX=.*/GP_KEK_HEX=$(openssl rand -hex 32)/" \
  -e "s|^GP_ADMIN_PASSWORD=.*|GP_ADMIN_PASSWORD=$(openssl rand -base64 18)|" .env
# Start the key log from the public one, so publishing it later only ever adds entries.
sudo -u ghostpass -H install -m 600 KEYS.json .local/KEYS.json
```

Then `sudoedit /opt/ghostpass/.env` and set `MERCHANT_UA` to the `address` from
dr-winner's `.local/merchant-account.json`. `GP_KEYS_URL` already points at
`KEYS.json` on `main` in this repository.

Back up `GP_KEK_HEX` and the dashboard password somewhere safe:
`sudo grep -E '^(GP_KEK_HEX|GP_ADMIN_PASSWORD)=' /opt/ghostpass/.env`.

## 7. Start zwatch and import the viewing key

```sh
sudo cp /opt/ghostpass/deploy/systemd/ghostpass-zwatch.service /opt/ghostpass/deploy/systemd/ghostpass-demo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ghostpass-zwatch
curl -s http://127.0.0.1:8787/health; echo
```

With no account imported yet, health reports `"ready":true` and `"tipHeight":0`.

On **dr-winner's machine**, in the Ghostpass checkout that holds the wallet, pipe the
viewing key straight to the server. It is never shown on screen, stored in a file,
or put in shell history. Replace `you@server`:

```sh
BIRTHDAY=$(node -p "require('./.local/merchant-account.json').birthday")
.local/bin/zcash-devtool wallet -w .local/merchant list-accounts \
  | ssh you@server "cd /opt/ghostpass && sudo -u ghostpass -H node --import tsx scripts/import-viewing-key.ts --birthday $BIRTHDAY"
```

This needs passwordless sudo for `you` on the server (the default for the `ubuntu`
user on most cloud images). The script prints `MERCHANT_ACCOUNT_ID=...`: add that line
with `sudoedit /opt/ghostpass/.env`. Wait until zwatch has synced, which can take
several minutes:

```sh
until curl -sf http://127.0.0.1:8787/health; do sleep 10; done; echo
```

## 8. Start the merchants and publish their keys

```sh
sudo systemctl enable --now ghostpass-demo
sudo journalctl -u ghostpass-demo -n 20 --no-pager
```

On first start each merchant creates its issuer keys for this month and next. The log
warns that the public `KEYS.json` lacks them, and browsers will refuse the keys until
they are published. On your machine, in an up-to-date checkout of `main`:

```sh
ssh you@server 'sudo cat /opt/ghostpass/.local/KEYS.json' > KEYS.json
git diff KEYS.json   # must only add new entries; no existing spkiSha256 may change
git commit -m "Publish issuer keys" KEYS.json
git push origin main
```

GitHub's raw file can take a few minutes to update. Only one deployment may publish
keys for these merchant names. Never commit a key log from a local or test run.

## 9. Caddy

```sh
sudo cp /opt/ghostpass/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/\.example\.com/.YOUR-DOMAIN/' /etc/caddy/Caddyfile   # for example .ghostpass.dev
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 10. Check everything

```sh
cd /opt/ghostpass && sudo -u ghostpass -H node --import tsx scripts/check-deploy.ts
curl -sI https://letter.example.com/subscribe
```

Every line of `check-deploy` must start with `ok`. The `curl` response must include
`strict-transport-security`, `content-security-policy` and `referrer-policy: no-referrer`,
and no `server` or `x-powered-by` header. Then subscribe from Zodl: open
`https://letter.example.com/subscribe`, scan the QR code, and pay. After two
confirmations the page stores 30 tokens. Record the transaction ID for the README.

The dashboard is at `https://dashboard.example.com` (any user name, `GP_ADMIN_PASSWORD`).

## Running it

| Task | Command |
| --- | --- |
| Logs | `sudo journalctl -u ghostpass-demo -u ghostpass-zwatch -f` (codes only; no IPs, memos or keys) |
| Restart | `sudo systemctl restart ghostpass-demo` |
| Update | `cd /opt/ghostpass && sudo -u ghostpass -H git pull --ff-only && sudo -u ghostpass -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile && sudo systemctl restart ghostpass-demo ghostpass-zwatch` |
| Monthly | On the 1st, each merchant creates the key for the month after. The log warns until it is published; repeat the publishing step in section 8 during the month |
| Back up | See below |

### Backups

The merchant databases hold the issuer keys (sealed with `GP_KEK_HEX`), the spent
tokens and the checkouts. Take consistent copies while the service runs, then copy
them off the server together with the key log:

```sh
cd /opt/ghostpass
sudo -u ghostpass -H install -d -m 700 .local/backups
for db in newsletter api-demo; do sudo -u ghostpass sqlite3 .local/$db.sqlite ".backup '.local/backups/$db.sqlite'"; done
# On your machine:
ssh you@server 'sudo tar -C /opt/ghostpass/.local -cz backups KEYS.json' > ghostpass-backup-$(date +%F).tgz
```

Keep `GP_KEK_HEX` separately from these files: the backups are useless without it,
and anyone holding both could sign tokens. Never run `sqlite3` on these databases as
root; root-owned journal files would stop the service from opening them.

Losing a merchant database or `GP_KEK_HEX` means new keys for months already
published; the service then refuses to start rather than serve keys browsers
would reject. The zwatch wallet directory can be rebuilt from the viewing key.

Never set `GP_DEV_FAKE_PAYMENTS=1` on the server; the services refuse to start with it.

## Troubleshooting

| Log shows | Meaning and fix |
| --- | --- |
| `watcher_directory_locked` (zwatch) | A crash left `.local/zwatch/.zwatch.lock`. Read the PID in it with `sudo cat`; if `ps -p <pid>` shows no zwatch, delete the file and `sudo systemctl restart ghostpass-zwatch` |
| `matcher_poll_failed` every 20 seconds | zwatch is down or still syncing, or `MERCHANT_ACCOUNT_ID` / `ZWATCH_API_TOKEN` do not match it. Run `check-deploy` |
| `key_log_conflict` at startup | The key log already holds a different key for this merchant and month: a lost database, a changed `GP_KEK_HEX`, or a second deployment. Restore the database and key from backup |
| `WARNING: ... lacks the ... key` | Keys not yet in the public `KEYS.json`; publish them as in section 8 |

## What was tested

On 6 October 2026 every section was run as written in an Ubuntu 24.04 (ARM64) container
with systemd, as a passwordless-sudo admin user, against the `godswill/deployment` branch:

- The pinned zcash-devtool built in about 4 minutes on 11 cores with Rust 1.99.0.
- The hardened units ran Node and zcash-devtool without problems; `systemd-analyze security`
  rates both 1.4 ("OK").
- A throwaway, unfunded Mainnet wallet's viewing key was piped into `import-viewing-key`;
  zwatch imported it and synced from Mainnet, and both matchers reconciled its snapshots.
- Through Caddy over HTTPS, in production mode: the security headers were present, there was
  no `Server` header, and HTTP redirected to HTTPS. A browser client checked the issuer key
  against the published key log and received 30 tokens. It then got a `Secure; HttpOnly;
  SameSite=Strict` session cookie, opened a protected post, and had a replayed token
  rejected. The dashboard worked behind its password.
- Caddy forwarded no `X-Forwarded-For`, even when the client sent one. No visitor IP address
  appeared in any log, including for failed TLS handshakes. Caddy's only logged address is
  its local admin endpoint during `systemctl reload caddy`.
- `check-deploy` passed every check once the keys were published, and the service warned
  until then. The backup commands produced databases that passed `PRAGMA integrity_check`.
  After a restart, all services came back and zwatch resumed without a stale lock.

Test-only substitutions: Caddy used `tls internal` and `.test` hostnames instead of public
certificates, and a local HTTPS file stood in for GitHub's raw `KEYS.json`. The key was
piped locally instead of over SSH. One checkout was marked paid directly in the database,
because no ZEC was sent. Not yet tested: a funded payment from Zodl, public certificates,
and an x86-64 server.
