'use strict';
const $ = (id) => document.getElementById(id);
const api = (path, method = 'GET', body) =>
  fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sim-dashboard' },
    body: body ? JSON.stringify(body) : undefined,
  });
const MAX_LINES = 600;
let ws = null, retry = 1000, status = null;

const fmtUp = (s) => {
  s = Math.max(0, s | 0);
  const d = (s / 86400) | 0, h = ((s % 86400) / 3600) | 0, m = ((s % 3600) / 60) | 0;
  return (d ? d + 'd ' : '') + (h || d ? h + 'h ' : '') + m + 'm ' + (s % 60) + 's';
};
const num = (n) => Number(n || 0).toLocaleString();

function show(authed) {
  $('login').hidden = authed;
  $('dash').hidden = !authed;
  if (authed) connect(); else if (ws) { ws.close(); ws = null; }
}

function render(st, stats) {
  if (st) {
    status = st;
    const b = $('badge');
    b.textContent = st.state;
    b.className = 'badge ' + st.state.toLowerCase();
    $('upSrv').textContent = fmtUp(st.serverUptimeSec);
    $('upRun').textContent = st.state === 'RUNNING' ? fmtUp(st.runnerUptimeSec) : '-';
    $('sRst').textContent = st.restarts;
    $('sPid').textContent = st.workerPid || '-';
  }
  if (stats) {
    $('sImp').textContent = num(stats.impressions);
    $('sClk').textContent = num(stats.clicks);
    $('sTot').textContent = num(stats.total);
    $('sOth').textContent = `${num(stats.bot)} / ${num(stats.repeated)} / ${num(stats.invalid)}`;
  }
}

function addLog(e) {
  const term = $('term');
  const row = document.createElement('div');
  row.className = 'l-' + (e.level || 'info');
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = '[' + new Date(e.ts).toLocaleTimeString() + '] ';
  row.append(ts, document.createTextNode(e.level.toUpperCase().padEnd(5) + ' ' + e.msg));
  term.appendChild(row);
  while (term.childElementCount > MAX_LINES) term.firstChild.remove();
  if ($('scroll').checked) term.scrollTop = term.scrollHeight;
}

function connect() {
  if (ws) return;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { retry = 1000; };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'hello') { $('term').textContent = ''; m.logs.forEach(addLog); render(m.status, m.stats); }
    else if (m.type === 'log') addLog(m.data);
    else if (m.type === 'tick') render(m.status, m.stats);
  };
  ws.onclose = async () => {
    ws = null;
    const r = await api('/api/me').then((x) => x.json()).catch(() => ({ authenticated: true }));
    if (!r.authenticated) return show(false);
    setTimeout(connect, retry); retry = Math.min(retry * 2, 15000);
  };
}

async function action(name) {
  const btns = ['start', 'stop', 'restart'].map($);
  btns.forEach((b) => (b.disabled = true));
  try {
    const res = await api('/api/runner/' + name, 'POST');
    if (res.status === 401) return show(false);
    const j = await res.json();
    if (!res.ok) addLog({ ts: new Date().toISOString(), level: 'error', msg: j.error || 'Request failed' });
    else render(j.status);
  } catch (e) {
    addLog({ ts: new Date().toISOString(), level: 'error', msg: 'Network error: ' + e.message });
  } finally { btns.forEach((b) => (b.disabled = false)); }
}

['start', 'stop', 'restart'].forEach((n) => $(n).addEventListener('click', () => action(n)));
$('clear').addEventListener('click', () => { $('term').textContent = ''; });
$('logout').addEventListener('click', async () => { await api('/api/logout', 'POST'); show(false); });
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  const res = await api('/api/login', 'POST', { username: $('user').value, password: $('pass').value });
  const j = await res.json().catch(() => ({}));
  if (res.ok) { $('pass').value = ''; show(true); } else $('loginErr').textContent = j.error || 'Login failed';
});
setInterval(() => { if (status && status.state === 'RUNNING') { status.serverUptimeSec++; status.runnerUptimeSec++; render(status); } }, 1000);

api('/api/me').then((r) => r.json()).then((j) => show(j.authenticated)).catch(() => show(false));
