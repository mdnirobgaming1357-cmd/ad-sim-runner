'use strict';
/**
 * Simulation worker (separate process). Pure local generator:
 * it requires NO network modules and never loads any ad SDK.
 * Events are written to a local JSONL file and sent to the parent over IPC only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const num = (k, d) => (Number.isFinite(+process.env[k]) && process.env[k] !== '' ? +process.env[k] : d);
const cfg = {
  min: Math.max(50, num('SIM_INTERVAL_MIN_MS', 500)),
  max: Math.max(100, num('SIM_INTERVAL_MAX_MS', 2500)),
  batchMax: Math.max(1, num('SIM_BATCH_MAX', 3)),
  clickRate: Math.min(1, Math.max(0, num('SIM_CLICK_RATE', 0.12))),
  weights: [
    ['normal', num('SIM_W_NORMAL', 60)],
    ['bot', num('SIM_W_BOT', 10)],
    ['repeat', num('SIM_W_REPEAT', 15)],
    ['invalid', num('SIM_W_INVALID', 15)],
  ],
};
if (cfg.max < cfg.min) cfg.max = cfg.min;

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'events.jsonl');
const MAX_BYTES = 50 * 1024 * 1024;
const rotate = () => {
  try { if (fs.statSync(FILE).size > MAX_BYTES) fs.renameSync(FILE, FILE + '.1'); } catch (_) {}
};
rotate();
const out = fs.createWriteStream(FILE, { flags: 'a' });
out.on('error', (e) => log('error', 'Write error: ' + e.message));

const send = (m) => { if (process.connected) process.send(m); };
const log = (level, msg) => send({ type: 'log', level, msg });
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sid = () => 'sess_' + crypto.randomBytes(6).toString('hex');

const pool = []; // known sessions for repeated-visit scenario
let written = 0;

function mk(type, sessionId, status, extra) {
  return {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId,
    eventType: type,
    simulationStatus: status,
    testOnly: true,
    label: 'TEST_ONLY',
    ...extra,
  };
}
function emit(ev) {
  out.write(JSON.stringify(ev) + '\n');
  send({ type: 'event', event: ev });
  if (++written % 1000 === 0) rotate();
}

const scenarios = {
  normal() {
    const s = sid();
    if (pool.length < 50) pool.push(s); else pool[Math.floor(Math.random() * 50)] = s;
    emit(mk('SIMULATED_IMPRESSION', s, 'SIMULATED_VALID', { placement: pick(['banner', 'interstitial', 'native']) }));
    if (Math.random() < cfg.clickRate) emit(mk('SIMULATED_CLICK', s, 'SIMULATED_VALID', { placement: 'banner' }));
  },
  bot() {
    const s = 'bot_' + crypto.randomBytes(4).toString('hex');
    const n = 5 + Math.floor(Math.random() * 11);
    for (let i = 0; i < n; i++) {
      emit(mk('SIMULATED_BOT_TRAFFIC', s, 'SIMULATED_FLAGGED', { burstIndex: i + 1, burstSize: n, intervalMs: Math.floor(rand(5, 60)) }));
    }
  },
  repeat() {
    const s = pool.length ? pick(pool) : sid();
    emit(mk('SIMULATED_REPEATED_VISIT', s, 'SIMULATED_FLAGGED', { visitCount: 2 + Math.floor(Math.random() * 20) }));
  },
  invalid() {
    emit(mk('SIMULATED_INVALID_EVENT', sid(), 'SIMULATED_REJECTED', {
      reason: pick(['missing_zone', 'bad_signature', 'negative_duration', 'unknown_placement', 'clock_skew']),
    }));
  },
};

function chooseScenario() {
  const total = cfg.weights.reduce((a, [, w]) => a + w, 0) || 1;
  let r = Math.random() * total;
  for (const [name, w] of cfg.weights) { if ((r -= w) <= 0) return name; }
  return 'normal';
}

let timer = null, stopping = false, consecutiveErrors = 0;
function tick() {
  if (stopping) return;
  try {
    const n = 1 + Math.floor(Math.random() * cfg.batchMax);
    for (let i = 0; i < n; i++) scenarios[chooseScenario()]();
    consecutiveErrors = 0;
  } catch (e) {
    consecutiveErrors++;
    log('error', `Tick failed (${consecutiveErrors}): ${e.message}`);
    if (consecutiveErrors >= 10) { log('error', 'Too many errors; exiting for supervisor restart'); return process.exit(1); }
  }
  timer = setTimeout(tick, rand(cfg.min, cfg.max));
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  log('info', 'Worker stopping gracefully');
  out.end(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
}

process.on('message', (m) => { if (m && m.type === 'stop') shutdown(0); });
process.on('disconnect', () => shutdown(0)); // parent died: never orphan
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (e) => { log('error', 'Uncaught: ' + e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { log('error', 'Unhandled rejection: ' + (e && e.message || e)); process.exit(1); });

send({ type: 'ready', config: { ...cfg } });
log('info', `Worker started pid=${process.pid} interval=${cfg.min}-${cfg.max}ms (TEST_ONLY, isolated)`);
tick();
