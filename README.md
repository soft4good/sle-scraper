# SLE Auction Watcher

Watches the Receita Federal SLE auction portal
(<https://www25.receita.fazenda.gov.br/sle-sociedade/portal/editais-disponiveis>)
and notifies you on Windows (toast) and on your phone (ntfy) when lots matching
your configured triggers appear. Built to run inside WSL2.

## How it works

- **Scraper** (`npm run scrape`, hourly via cron): pulls the public JSON API —
  notices list → lots per active notice → item descriptions per lot — into
  `data/sle.db` (SQLite). Incremental: item details are fetched once per lot,
  requests are spaced 500 ms apart.
- **Triggers**: saved filter sets (keywords over item descriptions, category,
  state/city, price bounds, % of appraisal, individuals-can-bid, photos,
  featured). Events per trigger: `new_lot`, `proposals_open`, `deadline_soon`
  (24h before the proposal window closes). Every (trigger, notice, lot, event)
  notifies at most once; matches are batched into one message per trigger per run.
- **Web UI** (`npm run serve`): <http://localhost:8377>, loopback-only —
  trigger CRUD with live match preview, lot browser with photos, notification
  history, settings (ntfy topic, test buttons, "Run scrape now").
- **Notifications**: Windows toast via `powershell.exe` interop (click opens
  the matches page); push via [ntfy.sh](https://ntfy.sh) (JSON publish).

## Setup

```bash
npm install
cp .env.sample .env        # set NTFY_TOPIC (treat it like a password)
npm run scrape             # first run backfills all lot details (~10 min)
npm run serve              # UI on http://localhost:8377
```

Subscribe to your `NTFY_TOPIC` in the ntfy mobile app to get pushes. The topic
can also be overridden at runtime in the UI's Settings page (stored in the DB).

### Hourly scrape (cron inside WSL)

```bash
NODE=$(command -v node) DIR=$(pwd) \
  sh -c '(crontab -l 2>/dev/null | grep -v run-scrape; sed "s|{{NODE}}|$NODE|g; s|{{PROJECT_DIR}}|$DIR|g" deploy/crontab.txt.sample) | crontab -'
```

### Web UI as a systemd user service

```bash
mkdir -p ~/.config/systemd/user
NODE=$(command -v node) DIR=$(pwd) \
  sh -c 'sed "s|{{NODE}}|$NODE|g; s|{{PROJECT_DIR}}|$DIR|g" deploy/sle-web.service.sample > ~/.config/systemd/user/sle-web.service'
systemctl --user daemon-reload
systemctl --user enable --now sle-web
loginctl enable-linger "$USER"   # start without an interactive login
```

### Surviving Windows restarts (optional)

Cron fires only while WSL is running, and Windows does not boot WSL by itself.
A Windows Task Scheduler job that wakes WSL hourly closes the gap (run from
WSL; adjust the distro name — `wsl.exe -l` lists yours):

```bash
NODE=$(command -v node) DIR=$(pwd) sh -c 'schtasks.exe /Create /F /TN "SLE Scrape" /SC HOURLY /ST 00:37 \
  /TR "wsl.exe -d '"$WSL_DISTRO_NAME"' -u '"$USER"' -- /bin/bash -lc \"$NODE --no-warnings $DIR/src/run-scrape.js >> $DIR/logs/scrape.log 2>&1\""'
```

It overlaps harmlessly with the WSL cron entry (lockfile + notification
dedup), runs only while you are logged into Windows, and — since booting the
distro also starts systemd — brings the web UI back up as a side effect.

## Layout

| Path | Purpose |
|---|---|
| `src/api-client.js` | SLE HTTP client; maps the Portuguese API to the English domain model |
| `src/scraper.js` | one scrape pass (notices → lots → item details) |
| `src/matcher.js` | trigger validation + lot matching (accent/case-insensitive) |
| `src/events.js` | notice-level event detection (proposals_open, deadline_soon) |
| `src/notify.js` | batching, dedup bookkeeping, toast/ntfy transports |
| `src/toast.ps1` | WinRT toast (protocol activation → opens URL on click) |
| `src/run.js` | full pipeline: scrape → events → match → notify (lockfile-guarded) |
| `src/server.js` | Express REST API + static frontend |
| `public/` | vanilla-JS SPA |
| `config.json` | port, rate limits, non-secret app config |
| `.env` | secrets (`NTFY_TOPIC`) — never committed |

## Tests

```bash
npm test          # unit/integration suites (fixtures captured from the live API)
npm run test:e2e  # Playwright browser suite (screenshots in test/e2e/screenshots/)
```

E2E needs Chromium once: `npx playwright install chromium` (plus
`sudo npx playwright install-deps chromium` if shared libraries are missing).

## Caveats

- The web UI has no authentication — it binds to `127.0.0.1` only. Don't
  expose it (reverse proxy, port forward) without adding auth.
- ntfy topics on the public ntfy.sh server are readable/writable by anyone who
  knows the name: pick an unguessable `NTFY_TOPIC`, or self-host ntfy and set
  `ntfyServer` in `config.json`.
- `node:sqlite` prints an ExperimentalWarning on Node 22; `--no-warnings`
  silences it. Node ≥ 22.13 is required (built-in `fetch`, `node:sqlite`,
  `process.loadEnvFile`).
- Notice status-code semantics (2 = published, 3 = receiving proposals,
  8 = bidding session) were inferred from live data; unknown codes are stored
  raw and simply not treated as active.
- Scrapes are polite by design (1 req/500 ms, details fetched once, capped per
  run) — keep them that way.
