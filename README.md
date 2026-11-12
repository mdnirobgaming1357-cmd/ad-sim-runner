# ad-sim-runner

A 24/7 background runner that generates **clearly labelled, TEST_ONLY simulated ad events** so you can exercise your own monetization pipeline and fake-ad / bot detection.

## Isolation from real advertising (important)

- This project **never loads, calls or triggers** the real SDK (`//libtl.com/sdk.js`, zone `10199516`). Keep that `<script>` tag only on your real website.
- The worker (`worker.js`) has no network code. Events go only to a local `data/events.jsonl` file and to the dashboard over IPC/WebSocket.
- The dashboard's Content-Security-Policy allows only same-origin scripts, so an ad SDK could not run here even if pasted in.
- Every event carries `testOnly: true`, `label: "TEST_ONLY"` and a `SIMULATED_*` status.
- Do not point your production ad zone, revenue reporting or analytics at this service. If you feed these events into your own detection system, filter on `testOnly`.

## Architecture

- `server.js`: Express API, session auth, WebSocket live logs, worker supervisor (auto-recovery with backoff, lock file against duplicate workers, graceful shutdown).
- `worker.js`: separate child process that generates events at random intervals and appends them to JSONL storage.
- `public/`: dark terminal dashboard (HTML/CSS/JS).

Event types: `SIMULATED_IMPRESSION`, `SIMULATED_CLICK`, `SIMULATED_BOT_TRAFFIC`, `SIMULATED_REPEATED_VISIT`, `SIMULATED_INVALID_EVENT`. Example record:

```json
{"eventId":"…uuid…","timestamp":"2026-11-12T10:00:00.000Z","sessionId":"sess_ab12cd34ef56","eventType":"SIMULATED_IMPRESSION","simulationStatus":"SIMULATED_VALID","testOnly":true,"label":"TEST_ONLY","placement":"banner"}
```

## Local setup

```bash
npm install
cp .env.example .env     # then edit ADMIN_PASSWORD and SESSION_SECRET
npm start
```

Open http://localhost:3000, sign in, press START. Generate a secret with:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## API (all `/api/runner/*` require a logged-in session; POSTs also need header `X-Requested-With: sim-dashboard`)

| Method | Path | Purpose |
|---|---|---|
| POST | /api/login, /api/logout | Session auth |
| POST | /api/runner/start | Start worker |
| POST | /api/runner/stop | Stop worker |
| POST | /api/runner/restart | Restart worker |
| GET | /api/runner/status | State, uptime, PID, restarts, config |
| GET | /api/runner/logs?limit=100 | Recent log lines |
| GET | /api/runner/statistics | Counters and file size |

## Configuration

See `.env.example`. Intervals (`SIM_INTERVAL_MIN_MS`/`MAX_MS`), batch size, click rate and scenario weights are all configurable. `AUTO_RESUME=true` resumes the runner after a server restart only if it was running when the server went down; otherwise it stays idle until you press START.

## Deploy to GitHub + Railway

1. `git init && git add . && git commit -m "Initial commit"`, create a GitHub repo and push. (`.env` and `data/` are git-ignored.)
2. In Railway: **New Project → Deploy from GitHub repo** and pick the repo. Railway detects Node and runs `npm start`.
3. **Variables**: set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `NODE_ENV=production`, `DATA_DIR=/data`, and optionally `AUTO_RESUME=true` plus the `SIM_*` values.
4. **Volume**: add a Volume mounted at `/data` so counters and event records survive redeploys.
5. **Settings → Networking → Generate Domain**, then open the URL and sign in.
6. Keep **one replica** only: sessions and the worker supervisor are in-process.

Notes: sessions use an in-memory store, so you will be signed out after a restart or redeploy (the runner itself is unaffected if `AUTO_RESUME=true`). `events.jsonl` rotates to `events.jsonl.1` at 50 MB.
