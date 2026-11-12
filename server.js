'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
const SECRET = process.env.SESSION_SECRET;
const AUTO_RESUME = process.env.AUTO_RESUME === 'true';

if (!ADMIN_PASS || !SECRET || SECRET.length < 32) {
  console.error('FATAL: set ADMIN_PASSWORD and SESSION_SECRET (32+ chars). See .env.example');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOCK_FILE = path.join(DATA_DIR, 'worker.lock');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');

/* ---------- persistent state ---------- */
const blank = () => ({ impressions: 0, clicks: 0, bot: 0, repeated: 0, invalid: 0, total: 0 });
let saved = {};
try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
let stats = { ...blank(), ...(saved.stats || {}) };
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ desiredRunning: desired, stats }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { pushLog('error', 'State save failed: ' + e.message); }
}
const scheduleSave = () => { if (!saveTimer) saveTimer = setTimeout(saveState, 2000); };

/* ---------- logs + websocket ---------- */
const logs = [];
const MAX_LOGS = 500;
let wss;
function broadcast(obj) {
  if (!wss) return;
  const s = JSON.stringify(obj);
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(s); });
}
function pushLog(level, msg) {
  const e = { ts: new Date().toISOString(), level, msg };
  logs.push(e); if (logs.length > MAX_LOGS) logs.shift();
  broadcast({ type: 'log', data: e });
  if (level === 'error' || level === 'warn') console.error(`[${level}] ${msg}`);
}

/* ---------- runner supervisor ---------- */
let worker = null, ready = false, desired = false, restarts = 0, crashes = 0;
let respawnTimer = null, readyAt = null, workerConfig = null;

function lockHolder() {
  try {
    const pid = +fs.readFileSync(LOCK_FILE, 'utf8');
    if (pid && (!worker || pid !== worker.pid)) { process.kill(pid, 0); return pid; }
  } catch (_) {}
  return 0;
}
const rmLock = () => { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} };

function spawnWorker() {
  if (worker) return 'already_running';
  if (lockHolder()) return 'lock_held';
  clearTimeout(respawnTimer); respawnTimer = null;
  const w = fork(path.join(__dirname, 'worker.js'), [], { env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  worker = w; ready = false; w.t0 = Date.now();
  try { fs.writeFileSync(LOCK_FILE, String(w.pid)); } catch (_) {}
  pushLog('info', `Worker process spawned (pid ${w.pid})`);

  w.on('message', (m) => {
    if (!m) return;
    if (m.type === 'ready') { ready = true; readyAt = Date.now(); workerConfig = m.config; }
    else if (m.type === 'log') pushLog(m.level || 'info', m.msg);
    else if (m.type === 'event') onEvent(m.event);
  });
  w.on('error', (e) => pushLog('error', 'Worker error: ' + e.message));
  w.on('exit', (code, sig) => {
    if (worker === w) { worker = null; ready = false; readyAt = null; rmLock(); }
    pushLog(code === 0 ? 'info' : 'warn', `Worker exited (code=${code} signal=${sig})`);
    if (desired) {
      crashes = Date.now() - w.t0 > 30000 ? 1 : crashes + 1;
      restarts++;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(crashes, 5));
      pushLog('warn', `Auto-recovery: restarting worker in ${delay / 1000}s`);
      respawnTimer = setTimeout(() => { respawnTimer = null; if (desired && !worker) spawnWorker(); }, delay);
    }
  });
  return 'started';
}

function onEvent(ev) {
  const t = ev.eventType;
  stats.total++;
  if (t === 'SIMULATED_IMPRESSION') stats.impressions++;
  else if (t === 'SIMULATED_CLICK') stats.clicks++;
  else if (t === 'SIMULATED_BOT_TRAFFIC') stats.bot++;
  else if (t === 'SIMULATED_REPEATED_VISIT') stats.repeated++;
  else if (t === 'SIMULATED_INVALID_EVENT') stats.invalid++;
  scheduleSave();
  pushLog('event', `${t} id=${ev.eventId.slice(0, 8)} session=${ev.sessionId} status=${ev.simulationStatus} TEST_ONLY`);
}

function stopWorker() {
  clearTimeout(respawnTimer); respawnTimer = null;
  const w = worker;
  if (!w) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => { try { w.kill('SIGKILL'); } catch (_) {} }, 5000);
    w.once('exit', () => { clearTimeout(kill); resolve(); });
    try { w.send({ type: 'stop' }); } catch (_) { try { w.kill('SIGTERM'); } catch (__) {} }
  });
}

const getStatus = () => ({
  state: worker ? (ready ? 'RUNNING' : 'STARTING') : desired ? 'RECOVERING' : 'STOPPED',
  desired, workerPid: worker ? worker.pid : null, restarts,
  serverUptimeSec: Math.floor(process.uptime()),
  runnerUptimeSec: readyAt ? Math.floor((Date.now() - readyAt) / 1000) : 0,
  autoResume: AUTO_RESUME, config: workerConfig, testOnly: true,
});

/* ---------- http app ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
      connectSrc: ["'self'"], imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"],
      frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
      ...(PROD ? { upgradeInsecureRequests: [] } : {}),
    },
  },
}));
app.use(express.json({ limit: '10kb' }));
const sessionMw = session({
  name: 'sim.sid', secret: SECRET, resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 8 * 3600 * 1000 },
});
app.use(sessionMw);

const auth = (req, res, next) => (req.session && req.session.admin ? next() : res.status(401).json({ error: 'Authentication required' }));
const csrf = (req, res, next) => (req.get('X-Requested-With') === 'sim-dashboard' ? next() : res.status(403).json({ error: 'Missing CSRF header' }));
const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(h(a), h(b));

const attempts = new Map();
app.post('/api/login', csrf, (req, res) => {
  const a = attempts.get(req.ip) || { n: 0, until: 0 };
  if (Date.now() < a.until) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const { username = '', password = '' } = req.body || {};
  const u = safeEq(username, ADMIN_USER), p = safeEq(password, ADMIN_PASS);
  if (!(u && p)) {
    if (++a.n >= 5) { a.until = Date.now() + 15 * 60 * 1000; a.n = 0; }
    attempts.set(req.ip, a);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  attempts.delete(req.ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.admin = true;
    res.json({ ok: true });
  });
});
app.post('/api/logout', csrf, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ authenticated: !!(req.session && req.session.admin) }));

const r = express.Router();
r.use(auth);
r.post('/start', csrf, (req, res) => {
  desired = true; saveState();
  const result = spawnWorker();
  if (result === 'lock_held') return res.status(409).json({ error: 'Another worker holds the lock', status: getStatus() });
  res.json({ ok: true, result, status: getStatus() });
});
r.post('/stop', csrf, async (req, res) => {
  desired = false; saveState();
  await stopWorker();
  pushLog('info', 'Runner stopped by admin');
  res.json({ ok: true, status: getStatus() });
});
r.post('/restart', csrf, async (req, res) => {
  desired = false; await stopWorker();
  desired = true; crashes = 0; saveState();
  const result = spawnWorker();
  pushLog('info', 'Runner restarted by admin');
  res.json({ ok: true, result, status: getStatus() });
});
r.get('/status', (req, res) => res.json(getStatus()));
r.get('/logs', (req, res) => {
  const limit = Math.min(MAX_LOGS, Math.max(1, +req.query.limit || 100));
  res.json({ logs: logs.slice(-limit) });
});
r.get('/statistics', (req, res) => {
  let fileBytes = 0;
  try { fileBytes = fs.statSync(EVENTS_FILE).size; } catch (_) {}
  res.json({ ...stats, eventsFileBytes: fileBytes, testOnly: true });
});
app.use('/api/runner', r);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  pushLog('error', 'HTTP error: ' + err.message);
  res.status(err.status || 500).json({ error: 'Server error' });
});

/* ---------- websocket (session-authenticated) ---------- */
const server = http.createServer(app);
wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const deny = () => { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); };
  if (req.url !== '/ws') return socket.destroy();
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return deny();
  sessionMw(req, new http.ServerResponse(req), () => {
    if (!req.session || !req.session.admin) return deny();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
});
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  ws.send(JSON.stringify({ type: 'hello', logs: logs.slice(-100), status: getStatus(), stats }));
});
setInterval(() => broadcast({ type: 'tick', status: getStatus(), stats }), 1000);
setInterval(() => wss.clients.forEach((c) => { if (!c.isAlive) return c.terminate(); c.isAlive = false; c.ping(); }), 30000);

/* ---------- lifecycle ---------- */
let closing = false;
async function shutdown(sig) {
  if (closing) return; closing = true;
  console.log(`${sig} received: shutting down gracefully`);
  saveState();            // keeps `desired` as-is for AUTO_RESUME
  desired = false;        // prevent auto-respawn during shutdown
  await stopWorker();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => shutdown(s)));
process.on('uncaughtException', (e) => { console.error('uncaughtException', e); shutdown('uncaughtException'); });
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

server.listen(PORT, () => {
  pushLog('info', `Dashboard listening on :${PORT} (TEST_ONLY, isolated from any ad network)`);
  if (AUTO_RESUME && saved.desiredRunning) {
    pushLog('info', 'AUTO_RESUME=true: resuming runner');
    desired = true; spawnWorker();
  } else {
    pushLog('info', 'Runner idle. Press START to begin (AUTO_RESUME is off or runner was stopped).');
  }
});
