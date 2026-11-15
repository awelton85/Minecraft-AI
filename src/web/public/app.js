'use strict';
// Minecraft AI dashboard front-end. Vanilla JS; all untrusted text goes through textContent.

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  let c = o;
  for (const k of ks.slice(0, -1)) { if (!isObj(c[k])) c[k] = {}; c = c[k]; }
  c[ks.at(-1)] = v;
}
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
const fmtTime = (ts) => { const d = ts ? new Date(ts) : new Date(); return d.toTimeString().slice(0, 8); };

function toast(msg, kind = 'info', ms = 3500) {
  const t = h('div', { class: `toast ${kind}`, text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

class AuthError extends Error {}
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : undefined,
    body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new AuthError('Login required'); }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}
const guard = (fn) => async (...a) => {
  try { return await fn(...a); } catch (e) { if (!(e instanceof AuthError)) toast(e.message || String(e), 'error'); }
};

// ---------- state ----------
const S = {
  bots: new Map(),           // name -> {name, username, enabled, status}
  settings: null, characters: {}, secrets: {},
  voices: [],
};

function showLogin() { $('#loginOverlay').classList.remove('hidden'); $('#loginPw').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/login', { password: $('#loginPw').value });
    $('#loginOverlay').classList.add('hidden'); $('#loginPw').value = ''; $('#loginErr').textContent = '';
    await loadState(); connectWs();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { try { await api('POST', '/api/logout', {}); } catch { /* */ } location.reload(); });

async function loadState() {
  const st = await api('GET', '/api/state');
  S.bots = new Map(st.bots.map((b) => [b.name, b]));
  S.settings = st.settings; S.characters = st.characters; S.secrets = st.secrets;
  renderBots(); renderTargets(); renderChips();
  if (!settingsDirty) { renderSettingsForm(); }
  renderCharList();
  refreshMemBots();
  applyVoiceDefaults();
}

// ---------- tabs ----------
function selectTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  lsSet('tab', name);
  if (name === 'memory') loadMemory();
  if (name === 'logs') scrollLogs();
  if (name === 'chat') { const f = $('#feed'); f.scrollTop = f.scrollHeight; }
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) selectTab(b.dataset.tab); });
$$('.subtabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.subtabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.sub').forEach((s) => s.classList.toggle('active', s.id === `sub-${b.dataset.sub}`));
}));

// ---------- websocket ----------
let ws = null, wsDelay = 1000, wsTimer = null, wsEverOpen = false;
function setWsState(cls, text) { const el = $('#wsStatus'); el.className = `ws ${cls}`; $('span', el).textContent = text; }
function connectWs() {
  clearTimeout(wsTimer);
  if (ws && ws.readyState <= 1) return;
  setWsState('wait', 'connecting');
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    wsDelay = 1000; setWsState('on', 'live');
    if (wsEverOpen) loadState().catch(() => {});
    wsEverOpen = true;
  };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onWs(m); };
  ws.onclose = async () => {
    setWsState('off', `reconnecting in ${Math.round(wsDelay / 1000)}s`);
    try {
      const a = await (await fetch('/api/auth', { credentials: 'same-origin' })).json();
      if (a.required && !a.authed) { showLogin(); return; }
    } catch { /* server down */ }
    wsTimer = setTimeout(connectWs, wsDelay);
    wsDelay = Math.min(wsDelay * 1.7, 15000);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* */ } };
}
function wsSend(obj) {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(obj)); return true;
}
function onWs(m) {
  switch (m.type) {
    case 'hello':
      S.bots = new Map(m.data.bots.map((b) => [b.name, b])); renderBots(); renderTargets(); renderChips(); break;
    case 'backlog':
      logs.length = 0; for (const l of m.data.logs) logs.push(l); rebuildLogs();
      $('#feed').textContent = ''; recent.length = 0;
      for (const c of m.data.chats) addChat(c, true);
      break;
    case 'log': addLog(m.data); break;
    case 'chat': addChat(m.data); break;
    case 'speech': onSpeech(m.data); break;
    case 'thought': addThought(m.data); break;
    case 'status': {
      const b = S.bots.get(m.data.bot);
      if (b) { b.status = m.data.status; updateCard(b); renderChips(); }
      break;
    }
    case 'error': toast(m.error, 'error'); break;
  }
}

// ---------- bots tab ----------
const cards = new Map();
function stClass(s) { return `st-${(s && s.connection) || 'stopped'}`; }
function renderBots() {
  const ow = S.settings?.owners || [];
  $('#firstRun').classList.toggle('hidden', !(S.settings && (!ow.length || ow.includes('YourMinecraftName'))));
  const box = $('#botCards');
  const names = [...S.bots.keys()];
  for (const [n, c] of cards) if (!S.bots.has(n)) { c.root.remove(); cards.delete(n); }
  for (const n of names) {
    if (!cards.has(n)) cards.set(n, buildCard(S.bots.get(n)));
    box.append(cards.get(n).root);
    updateCard(S.bots.get(n));
  }
  if (!names.length) { box.textContent = ''; box.append(h('p', { class: 'muted', text: 'No characters configured. Add one under Settings > Characters.' })); }
}
function botAction(name, act, body) {
  return guard(() => api('POST', `/api/bots/${encodeURIComponent(name)}/${act}`, body ?? {}))();
}
function buildCard(b) {
  const r = {};
  r.badge = h('span', { class: 'badge' }); r.dis = h('span', { class: 'badge st-stopped', text: 'disabled', title: 'Not auto-started at launch; Start still works' });
  r.hp = h('div', { class: 'fill' }); r.hpT = h('span');
  r.fd = h('div', { class: 'fill' }); r.fdT = h('span');
  r.kv = h('dl', { class: 'kv' });
  r.auto = h('input', { type: 'checkbox', onchange: (e) => botAction(b.name, 'autonomous', { value: e.target.checked }) });
  r.goal = h('input', { type: 'text', placeholder: 'Set goal...', maxlength: 2000,
    onkeydown: (e) => { if (e.key === 'Enter') r.setGoal.click(); } });
  r.setGoal = h('button', { class: 'small', text: 'Set goal', onclick: async () => {
    if (!r.goal.value.trim()) return;
    await botAction(b.name, 'goal', { text: r.goal.value }); toast(`Goal set for ${b.name}`, 'ok'); r.goal.value = '';
  } });
  r.btnStart = h('button', { class: 'primary small', text: 'Start', onclick: () => botAction(b.name, 'start') });
  r.btnStop = h('button', { class: 'danger small', text: 'Stop', onclick: () => botAction(b.name, 'stop') });
  r.btnRestart = h('button', { class: 'small', text: 'Restart', onclick: () => botAction(b.name, 'restart') });
  r.btnReset = h('button', { class: 'small', text: 'Reset conversation', title: 'Forget this bot\'s current chat history (long-term memory is kept)', onclick: async () => { if (confirm(`Reset ${b.name}'s conversation history?`)) { await botAction(b.name, 'reset-conversation'); toast('Conversation reset', 'ok'); } } });
  r.btnAct = h('button', { class: 'small', text: 'Stop current action', onclick: () => botAction(b.name, 'stop-action') });
  r.root = h('div', { class: 'card' },
    h('header', null, h('h3', { text: b.name }), r.badge, r.dis, h('span', { class: 'muted', text: b.username !== b.name ? `(${b.username})` : '' })),
    h('div', { class: 'bar' }, h('b', { text: 'Health' }), h('div', { class: 'track' }, r.hp), r.hpT),
    h('div', { class: 'bar food' }, h('b', { text: 'Food' }), h('div', { class: 'track' }, r.fd), r.fdT),
    r.kv,
    h('div', { class: 'row' }, r.btnStart, r.btnStop, r.btnRestart, r.btnAct, r.btnReset,
      h('label', { class: 'chk' }, r.auto, 'Autonomous')),
    h('div', { class: 'goalrow' }, r.goal, r.setGoal));
  return r;
}
function updateCard(b) {
  const r = cards.get(b.name); if (!r) return;
  const s = b.status || {};
  r.dis.hidden = b.enabled !== false;
  r.badge.className = `badge ${stClass(s)}`; r.badge.textContent = s.connection || 'stopped';
  const hp = Number.isFinite(s.health) ? s.health : null, fd = Number.isFinite(s.food) ? s.food : null;
  r.hp.style.width = hp === null ? '0%' : `${Math.max(0, Math.min(100, hp * 5))}%`; r.hpT.textContent = hp === null ? '-' : `${Math.round(hp * 10) / 10}/20`;
  r.fd.style.width = fd === null ? '0%' : `${Math.max(0, Math.min(100, fd * 5))}%`; r.fdT.textContent = fd === null ? '-' : `${fd}/20`;
  const p = s.position;
  const pos = p ? `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}${s.dimension ? ` (${s.dimension})` : ''}` : '-';
  const rows = [['Position', pos], ['Action', s.currentAction || 'idle'], ['Goal', s.goal || '-'],
    ['LLM', [s.provider, s.model].filter(Boolean).join(' / ') || '-'],
    ['Reconnects', String(s.reconnectAttempts ?? 0)]];
  if (s.lastError) rows.push(['Last error', s.lastError]);
  r.kv.textContent = '';
  for (const [k, v] of rows) { const dd = h('dd', { text: v }); if (k === 'Last error') dd.className = 'err'; r.kv.append(h('dt', { text: k }), dd); }
  if (document.activeElement !== r.auto) r.auto.checked = !!s.autonomous;
  const running = ['connecting', 'connected', 'reconnecting'].includes(s.connection);
  r.btnStart.disabled = running; r.btnStop.disabled = !running; r.btnAct.disabled = s.connection !== 'connected';
  const all = [...S.bots.values()];
  $('#botsSummary').textContent = `${all.filter((x) => x.status?.connection === 'connected').length}/${all.length} connected`;
}
$('#startAll').onclick = guard(async () => { await api('POST', '/api/bots/start-all', {}); });
$('#stopAll').onclick = guard(async () => { await api('POST', '/api/bots/stop-all', {}); });

// ---------- chat feed ----------
const feed = $('#feed');
const recent = []; // dedupe speech vs chat
const MAX_FEED = 600;
function botColor(name) {
  let x = 0; for (const c of name) x = (x * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${x} 60% 60%)`;
}
function renderChips() {
  const box = $('#botChips'); box.textContent = '';
  for (const b of S.bots.values()) {
    const c = h('span', { class: `chip ${stClass(b.status)}`, text: `${b.name}: ${b.status?.connection || 'stopped'}` });
    box.append(c);
  }
}
function pushFeed(el, stick = true) {
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  feed.append(el);
  while (feed.children.length > MAX_FEED) feed.firstChild.remove();
  if (atBottom || stick === 'force') feed.scrollTop = feed.scrollHeight;
}
function isDup(bot, text) {
  const now = Date.now();
  while (recent.length && now - recent[0].t > 6000) recent.shift();
  const i = recent.findIndex((r) => r.bot === bot && r.text === text);
  if (i >= 0) { recent.splice(i, 1); return true; }
  recent.push({ t: now, bot, text }); return false;
}
const echoed = [];
function addChat(c, backlog) {
  if (!backlog && c.kind === 'player' && c.from !== 'You') {
    const now = Date.now(); const i = echoed.findIndex((e) => e.text === c.text && now - e.t < 8000);
    if (i >= 0) { echoed.splice(i, 1); return; }
  }
  if (!backlog && c.kind === 'bot' && isDup(c.bot, c.text)) return;
  if (backlog && c.kind === 'bot') recent.length = 0;
  const who = h('span', { class: 'who', text: c.from || c.bot || 'system' });
  if (c.kind === 'bot' && (c.from || c.bot)) who.style.color = botColor(c.from || c.bot);
  pushFeed(h('div', { class: `msg ${c.kind || 'system'}${c.from === 'You' ? ' me' : ''}` },
    h('span', { class: 'ts', text: fmtTime(c.ts) }), c.kind === 'system' ? null : who, h('span', { text: c.text })));
}
function addThought(t) {
  const el = h('div', { class: 'msg thought' }, h('span', { class: 'ts', text: fmtTime(t.ts) }), h('span', { class: 'who', text: `${t.bot} thinks:` }), h('span', { text: t.text }));
  el.hidden = !$('#showThoughts').checked; el.dataset.thought = '1';
  pushFeed(el);
}
function addSpeech(s) {
  if (isDup(s.bot, s.text)) return;
  const who = h('span', { class: 'who', text: s.bot }); who.style.color = botColor(s.bot);
  pushFeed(h('div', { class: 'msg speech bot' }, h('span', { class: 'ts', text: fmtTime(s.ts) }), h('span', { class: 'tag', text: 'speech' }), who, h('span', { text: s.text })));
}
$('#showThoughts').checked = lsGet('showThoughts', false);
$('#showThoughts').onchange = (e) => { lsSet('showThoughts', e.target.checked); $$('[data-thought]', feed).forEach((x) => { x.hidden = !e.target.checked; }); };
$('#chatClear').onclick = () => { feed.textContent = ''; };

function renderTargets() {
  const sel = $('#target'); const cur = sel.value || lsGet('target', 'all');
  sel.textContent = '';
  sel.append(h('option', { value: 'all', text: 'All bots' }));
  for (const n of S.bots.keys()) sel.append(h('option', { value: n, text: n }));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'all';
  const lb = $('#logBot'); const cl = lb.value || '';
  lb.textContent = ''; lb.append(h('option', { value: '', text: 'All' }));
  for (const n of S.bots.keys()) lb.append(h('option', { value: n, text: n }));
  lb.value = cl;
}
$('#target').onchange = (e) => lsSet('target', e.target.value);

async function sendChat(text, from) {
  text = text.trim(); if (!text) return;
  const target = $('#target').value;
  echoed.push({ t: Date.now(), text });
  addChat({ ts: Date.now(), kind: 'player', from: 'You', text: `[to ${target}] ${text}` });
  const id = Math.random().toString(36).slice(2);
  if (!wsSend({ type: 'message', id, target, text, from })) {
    try { await api('POST', '/api/message', { target, text, from }); } catch (e) { if (!(e instanceof AuthError)) toast(e.message, 'error'); }
  }
}
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault(); const i = $('#chatInput'); const t = i.value; i.value = ''; sendChat(t, 'dashboard');
});

// ---------- voice: TTS ----------
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
const ttsQueue = []; let speaking = false;
function loadVoices() { if (synth) S.voices = synth.getVoices(); }
if (synth) { loadVoices(); synth.addEventListener?.('voiceschanged', () => { loadVoices(); renderCharEditorVoices(); }); }
function applyVoiceDefaults() {
  const on = lsGet('ttsOn', null);
  $('#ttsOn').checked = on === null ? !!(S.settings?.voice?.ttsEnabled) : on;
}
$('#ttsOn').onchange = (e) => { lsSet('ttsOn', e.target.checked); if (!e.target.checked) stopSpeaking(); };
$('#ttsStop').onclick = stopSpeaking;
function splitText(t) {
  const parts = t.match(/[^.!?\n]+[.!?]*\s*/g) || [t]; const out = []; let cur = '';
  for (const p of parts) { if ((cur + p).length > 180 && cur) { out.push(cur); cur = p; } else cur += p; }
  if (cur.trim()) out.push(cur); return out;
}
function onSpeech(s) {
  addSpeech(s);
  if (!$('#ttsOn').checked || !synth) return;
  if (S.settings?.voice?.readAllBotChat === false) {
    const t = $('#target').value; if (t !== 'all' && t !== s.bot) return;
  }
  for (const part of splitText(String(s.text))) ttsQueue.push({ text: part, voice: s.voice || {} });
  pumpTts();
}
function findVoice(name) { return name ? S.voices.find((v) => v.name === name) || null : null; }
function utter(text, voice) {
  const u = new SpeechSynthesisUtterance(text);
  const v = findVoice(voice.name); if (v) u.voice = v;
  u.rate = Number.isFinite(voice.rate) ? voice.rate : 1; u.pitch = Number.isFinite(voice.pitch) ? voice.pitch : 1;
  return u;
}
let ttsId = 0, ttsWatchdog = null, curUtter = null;
function pumpTts() {
  if (speaking || !ttsQueue.length) return;
  const item = ttsQueue.shift(); speaking = true;
  voice.onTtsStart();
  const myId = ++ttsId;
  const u = utter(item.text, item.voice); curUtter = u;
  const done = () => {
    if (myId !== ttsId) return;
    clearTimeout(ttsWatchdog); curUtter = null; speaking = false;
    if (ttsQueue.length) pumpTts(); else voice.onTtsIdle();
  };
  u.onend = done; u.onerror = done;
  // watchdog: a dropped onend must not wedge TTS (or hands-free listening)
  ttsWatchdog = setTimeout(() => { try { synth.cancel(); } catch { /* */ } done(); }, item.text.length * 90 + 5000);
  try { synth.speak(u); } catch { done(); }
}
function stopSpeaking() {
  ttsQueue.length = 0; ttsId++; clearTimeout(ttsWatchdog); curUtter = null;
  if (synth) { try { synth.cancel(); } catch { /* */ } }
  const was = speaking; speaking = false; if (was) voice.onTtsIdle();
}
function previewVoice(name, rate, pitch, who) {
  if (!synth) { toast('Speech synthesis not supported in this browser', 'error'); return; }
  synth.cancel(); synth.speak(utter(`Hello, I am ${who || 'your bot'}. Let's go mining.`, { name, rate, pitch }));
}

// ---------- voice: STT ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const voice = (() => {
  let rec = null, mode = 'off'; // off | ptt | hands | test
  let pressAt = 0, toggled = false, wantRestart = false, ttsBusy = false;
  let releaseTimer = null, restartTimer = null, errDelay = 0;
  const msg = $('#voiceMsg'), interim = $('#interim'), mic = $('#pttBtn'), hf = $('#handsFree'), state = $('#voiceState');
  const supported = !!SR && window.isSecureContext;
  function notice(t) { msg.textContent = t; msg.classList.toggle('hidden', !t); }
  if (!SR) notice('Speech recognition is not available in this browser. Use Chrome or Edge.');
  else if (!window.isSecureContext) notice(`Microphone needs a secure context. Open this page over https (${location.protocol}//${location.host} is not secure), accept the certificate warning, or in Chrome add this origin to chrome://flags/#unsafely-treat-insecure-origin-as-secure.`);
  mic.disabled = hf.disabled = $('#testMic').disabled = !supported;

  const wakeExtra = $('#wakeExtra'); wakeExtra.value = lsGet('wakeExtra', '');
  wakeExtra.onchange = () => lsSet('wakeExtra', wakeExtra.value);

  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  function parseWake(raw) {
    const words = norm(raw).split(' ').filter(Boolean);
    while (words.length && ['hey', 'hi', 'hello', 'ok', 'okay', 'yo'].includes(words[0])) words.shift();
    const cands = [];
    for (const b of S.bots.values()) {
      const base = norm(b.name.replace(/_/g, ' ')); const user = norm(b.username.replace(/_/g, ' '));
      for (const c of new Set([base, user, base.split(' ')[0]])) if (c) cands.push({ phrase: c, target: b.name });
    }
    for (const c of ['everyone', 'all bots', 'everybody']) cands.push({ phrase: c, target: 'all' });
    for (const w of wakeExtra.value.split(',').map(norm).filter(Boolean)) cands.push({ phrase: w, target: null });
    let best = null;
    for (const c of cands) {
      const n = c.phrase.split(' ').length; if (words.length < n) continue;
      const head = words.slice(0, n).join(' ');
      const tol = c.phrase.length >= 7 ? 2 : c.phrase.length >= 4 ? 1 : 0;
      const dist = lev(head, c.phrase);
      if (dist <= tol && (!best || n > best.n || (n === best.n && dist < best.dist))) best = { n, dist, target: c.target };
    }
    if (!best) return null;
    return { target: best.target, text: words.slice(best.n).join(' ').trim() };
  }

  function ui() {
    mic.classList.toggle('live', mode === 'ptt'); mic.textContent = mode === 'ptt' ? 'Listening' : 'Mic';
    hf.classList.toggle('on', mode === 'hands'); hf.textContent = `Hands-free: ${mode === 'hands' ? 'on' : 'off'}`;
    let t = 'Mic: off', cls = 'off';
    if (mode !== 'off') { if (ttsBusy) { t = 'Mic: paused while speaking'; cls = 'wait'; } else { t = `Mic: listening (${mode === 'hands' ? 'hands-free' : mode === 'test' ? 'test' : 'push-to-talk'})`; cls = 'on'; } }
    state.textContent = t; state.className = `ws ${cls}`;
  }
  function showInterim(t) { interim.textContent = t; interim.classList.toggle('hidden', !t); }
  function startRec() {
    clearTimeout(restartTimer);
    if (mode === 'off' || ttsBusy) return;
    const r = new SR(); rec = r;
    r.lang = lsGet('sttLang', navigator.language || 'en-US'); r.interimResults = true; r.continuous = mode === 'hands';
    r.onresult = (e) => {
      if (r !== rec) return;
      errDelay = 0; let interimT = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]; const t = res[0].transcript;
        if (res.isFinal) finalText(t); else interimT += t;
      }
      showInterim(interimT ? `Hearing: ${interimT}` : '');
    };
    r.onerror = (e) => {
      if (r !== rec) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { notice('Microphone permission denied. Allow it in the browser address bar.'); stop(); }
      else if (e.error === 'network' || e.error === 'audio-capture') {
        errDelay = Math.min(errDelay ? errDelay * 2 : 1000, 30000);
        notice(e.error === 'network' ? `Speech recognition network error (Chrome needs internet for it). Retrying in ${errDelay / 1000}s.` : `Microphone problem (audio-capture). Retrying in ${errDelay / 1000}s.`);
      }
    };
    r.onend = () => {
      if (r !== rec) return;
      rec = null; showInterim('');
      if (mode === 'test' || (mode === 'ptt' && !wantRestart)) { if (mode === 'test') stop(); return; }
      if (wantRestart && mode !== 'off' && !ttsBusy) restartTimer = setTimeout(startRec, errDelay || 250);
    };
    try { r.start(); } catch { /* already started */ }
  }
  function finalText(t) {
    t = t.trim(); if (!t) return;
    if (mode === 'test') { toast(`Heard: "${t}"`, 'ok', 6000); return; }
    if (mode === 'hands') {
      const w = parseWake(t);
      if (!w) { showInterim(`Ignored (no wake word): ${t}`); setTimeout(() => showInterim(''), 2500); return; }
      if (!w.text) return;
      if (w.target) $('#target').value = w.target;
      sendChat(w.text, 'voice');
    } else sendChat(t, 'voice');
  }
  function stop() {
    wantRestart = false; mode = 'off'; toggled = false; errDelay = 0;
    clearTimeout(releaseTimer); clearTimeout(restartTimer);
    const r = rec; rec = null; try { r && r.abort(); } catch { /* */ }
    ui(); showInterim('');
  }
  function begin(m) { stop(); if (!supported) return; notice(''); mode = m; wantRestart = m !== 'test'; ui(); startRec(); }

  mic.addEventListener('pointerdown', (e) => {
    e.preventDefault(); if (!supported) return;
    clearTimeout(releaseTimer);
    if (mode === 'ptt' && toggled) { stop(); return; }
    stopSpeaking(); pressAt = Date.now(); begin('ptt'); toggled = false;
  });
  const release = () => {
    if (mode !== 'ptt' || toggled) return;
    if (Date.now() - pressAt > 450) {
      wantRestart = false; try { rec && rec.stop(); } catch { /* */ }
      clearTimeout(releaseTimer); releaseTimer = setTimeout(() => { if (mode === 'ptt') stop(); }, 1500);
    } else toggled = true;
  };
  mic.addEventListener('pointerup', release); mic.addEventListener('pointerleave', () => { if (Date.now() - pressAt > 450) release(); });
  hf.addEventListener('click', () => { if (mode === 'hands') stop(); else begin('hands'); });
  $('#testMic').addEventListener('click', () => { if (mode === 'test') stop(); else { begin('test'); toast('Say something...'); } });
  $('#testVoice').addEventListener('click', () => {
    if (!synth) { toast('Speech synthesis not supported in this browser', 'error'); return; }
    previewVoice('', 1, 1, 'the dashboard');
  });
  ui();

  return {
    onTtsStart() { ttsBusy = true; clearTimeout(restartTimer); const r = rec; rec = null; try { r && r.abort(); } catch { /* */ } ui(); },
    onTtsIdle() { ttsBusy = false; ui(); if (mode !== 'off' && wantRestart) restartTimer = setTimeout(startRec, 400); },
  };
})();

// ---------- settings ----------
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];
const FIELDS = [
  { title: 'Server connection', fields: [
    { p: 'server.host', l: 'Minecraft server host', t: 'text', restart: true },
    { p: 'server.port', l: 'Port', t: 'number', restart: true },
    { p: 'server.version', l: 'Game version', t: 'text', help: '"auto" detects it', restart: true },
    { p: 'server.auth', l: 'Auth', t: 'select', o: ['offline', 'microsoft'], restart: true },
  ] },
  { title: 'Owners', fields: [
    { p: 'owners', l: 'Owner Minecraft names (bots obey these players)', t: 'list', help: 'One per line' },
    { p: 'listenToEveryone', l: 'Listen to everyone (not just owners)', t: 'bool' },
  ] },
  { title: 'LLM provider', custom: 'llm' },
  { title: 'Agent behaviour', fields: [
    { p: 'agent.autonomous', l: 'Autonomous by default', t: 'bool' },
    { p: 'agent.idleThinkSeconds', l: 'Idle think interval (s)', t: 'number' },
    { p: 'agent.pauseWhenOwnerAway', l: 'Pause idle check-ins while no owner is online (saves API cost)', t: 'bool' },
    { p: 'agent.maxStepsPerTurn', l: 'Max steps per turn', t: 'number' },
    { p: 'agent.historyCompactAt', l: 'Compact history at (messages)', t: 'number' },
    { p: 'agent.actionTimeoutSeconds', l: 'Action timeout (s)', t: 'number' },
    { p: 'agent.stuckSeconds', l: 'Stuck watchdog (s)', t: 'number' },
    { p: 'agent.chatMaxLength', l: 'Max chat message length', t: 'number' },
    { p: 'agent.botsTalkToBots', l: 'Bots talk to bots', t: 'select', o: ['never', 'when-addressed', 'always'] },
  ] },
  { title: 'Reflexes', fields: [
    { p: 'reflexes.autoEat', l: 'Auto eat', t: 'bool' }, { p: 'reflexes.autoArmor', l: 'Auto armor', t: 'bool' },
    { p: 'reflexes.selfDefense', l: 'Self defense', t: 'bool' }, { p: 'reflexes.autoRespawn', l: 'Auto respawn', t: 'bool' },
  ] },
  { title: 'Reconnect', fields: [
    { p: 'reconnect.enabled', l: 'Auto reconnect', t: 'bool' },
    { p: 'reconnect.initialDelaySeconds', l: 'Initial delay (s)', t: 'number' },
    { p: 'reconnect.maxDelaySeconds', l: 'Max delay (s)', t: 'number' },
  ] },
  { title: 'Web dashboard', fields: [
    { p: 'web.host', l: 'Bind address', t: 'text', help: 'Needs app restart', appRestart: true },
    { p: 'web.port', l: 'Port', t: 'number', help: 'Needs app restart', appRestart: true },
    { p: 'web.https', l: 'HTTPS (required for microphone)', t: 'bool', help: 'Needs app restart', appRestart: true },
    { p: 'web.password', l: 'Dashboard password', t: 'password', help: 'Leave blank to keep the current one. Takes effect immediately.' },
    { p: 'web.clearPassword', l: 'Remove password', t: 'bool', virtual: true },
  ] },
  { title: 'Voice', fields: [
    { p: 'voice.ttsEnabled', l: 'Speak bot replies by default', t: 'bool' },
    { p: 'voice.readAllBotChat', l: 'Speak all bots (otherwise only the selected target)', t: 'bool' },
  ] },
];
let form = null, original = null, settingsDirty = false, lmModels = [];
const inputs = new Map();

function markDirty() { settingsDirty = true; $('#saveMsg').textContent = 'Unsaved changes'; }
const MINS = { 'agent.idleThinkSeconds': [5], 'agent.maxStepsPerTurn': [1, 50], 'agent.actionTimeoutSeconds': [10], 'agent.historyCompactAt': [10], 'agent.stuckSeconds': [3], 'reconnect.initialDelaySeconds': [1], 'reconnect.maxDelaySeconds': [1], 'server.port': [1, 65535], 'web.port': [1, 65535], 'llm.anthropic.maxTokens': [256], 'llm.lmstudio.maxTokens': [256], 'llm.lmstudio.contextTokens': [2048], 'llm.lmstudio.temperature': [0, 2], 'agent.chatMaxLength': [20, 256] };
function fieldEl(f) {
  const val = getPath(form, f.p);
  let input;
  const upd = (v) => { setPath(form, f.p, v); markDirty(); };
  if (f.t === 'bool') {
    input = h('input', { type: 'checkbox', checked: !!val, onchange: (e) => upd(e.target.checked) });
    return h('label', { class: 'field inline' }, input, h('span', { text: f.l }), f.help ? h('span', { class: 'help', text: f.help }) : null);
  }
  if (f.t === 'number') input = h('input', { type: 'number', step: 'any', min: MINS[f.p]?.[0], max: MINS[f.p]?.[1], value: val ?? '', oninput: (e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) upd(n); } });
  else if (f.t === 'select') input = h('select', { onchange: (e) => upd(e.target.value) }, f.o.map((o) => h('option', { value: o, text: o, selected: o === val })));
  else if (f.t === 'list') input = h('textarea', { rows: 3, oninput: (e) => upd(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)) }), input.value = (val || []).join('\n');
  else if (f.t === 'password') input = h('input', { type: 'password', autocomplete: 'new-password', placeholder: form.web.passwordSet ? 'set (unchanged)' : 'not set', oninput: (e) => upd(e.target.value) });
  else input = h('input', { type: 'text', value: val ?? '', oninput: (e) => upd(e.target.value) });
  inputs.set(f.p, input);
  return h('div', { class: 'field' }, h('span', { class: 'lbl', text: f.l }), input, f.help ? h('span', { class: 'help', text: f.help }) : null);
}
function modelField(path, label, listId, opts) {
  const input = h('input', { type: 'text', list: listId, value: getPath(form, path) ?? '', placeholder: opts?.placeholder || '', oninput: (e) => { setPath(form, path, e.target.value); markDirty(); } });
  return h('div', { class: 'field' }, h('span', { class: 'lbl', text: label }), input);
}
function llmFieldset() {
  const fs = h('fieldset', null, h('legend', { text: 'LLM provider' }));
  const radios = h('div', { class: 'radios' });
  for (const [v, t] of [['anthropic', 'Claude API'], ['lmstudio', 'LM Studio (local)']]) {
    radios.append(h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'prov', value: v, checked: form.llm.provider === v, onchange: () => { form.llm.provider = v; markDirty(); } }), t));
  }
  const fb = h('select', { onchange: (e) => { form.llm.fallbackProvider = e.target.value; markDirty(); } },
    ['none', 'anthropic', 'lmstudio'].map((o) => h('option', { value: o, text: o, selected: o === form.llm.fallbackProvider })));
  const dl = h('datalist', { id: 'claudeModels' }, MODELS.map((m) => h('option', { value: m })));
  const sel = h('select', { onchange: (e) => { if (e.target.value) { form.llm.anthropic.model = e.target.value; txt.value = e.target.value; markDirty(); } } },
    h('option', { value: '', text: 'Choose...' }), MODELS.map((m) => h('option', { value: m, text: m })));
  const txt = h('input', { type: 'text', value: form.llm.anthropic.model, placeholder: 'or type any model id', oninput: (e) => { form.llm.anthropic.model = e.target.value; markDirty(); } });
  const key = h('input', { type: 'password', autocomplete: 'new-password', placeholder: S.secrets.anthropicApiKey ? 'set' : 'sk-ant-...' });
  const keyState = h('span', { class: S.secrets.anthropicApiKey ? 'st-connected' : 'err', text: S.secrets.anthropicApiKey ? 'API key: set' : 'API key: not set' });
  const keyBtn = h('button', { class: 'small', text: 'Save key', onclick: guard(async () => {
    if (!key.value.trim()) return; const r = await api('POST', '/api/secrets', { key: 'anthropicApiKey', value: key.value });
    S.secrets = r.secrets; key.value = ''; toast('API key saved', 'ok'); renderSettingsForm();
  }) });
  const keyClr = h('button', { class: 'small', text: 'Remove key', onclick: guard(async () => {
    if (!confirm('Remove the stored API key?')) return; const r = await api('POST', '/api/secrets', { key: 'anthropicApiKey', value: '' });
    S.secrets = r.secrets; renderSettingsForm();
  }) });
  const testRes = (id) => h('span', { id, class: 'muted' });
  const tBtn = (name, id) => h('button', { class: 'small', text: 'Test connection', onclick: async () => {
    const out = $(`#${id}`); out.className = 'muted'; out.textContent = 'testing...';
    try { const r = await api('POST', `/api/providers/${name}/test`, {}); out.className = r.ok ? 'st-connected' : 'err'; out.textContent = r.message || (r.ok ? 'OK' : 'Failed'); }
    catch (e) { out.className = 'err'; out.textContent = e.message; }
  } });
  const num = (p, l) => fieldEl({ p, l, t: 'number' });
  const lmModel = h('select', { onchange: (e) => { form.llm.lmstudio.model = e.target.value; lmTxt.value = e.target.value; markDirty(); } });
  const lmTxt = h('input', { type: 'text', value: form.llm.lmstudio.model, placeholder: 'model id (blank = whatever is loaded)', oninput: (e) => { form.llm.lmstudio.model = e.target.value; markDirty(); } });
  const fillModels = () => {
    lmModel.textContent = ''; lmModel.append(h('option', { value: '', text: lmModels.length ? 'Choose loaded model...' : 'No models listed' }));
    for (const m of lmModels) lmModel.append(h('option', { value: m, text: m, selected: m === form.llm.lmstudio.model }));
  };
  fillModels();
  const refresh = h('button', { class: 'small', text: 'Refresh models', onclick: guard(async () => {
    const r = await api('GET', '/api/models/lmstudio'); lmModels = r.models || []; fillModels();
    toast(r.error ? `LM Studio: ${r.error}` : `${lmModels.length} model(s) found`, r.error ? 'error' : 'ok');
  }) });
  fs.append(h('div', { class: 'fgrid' },
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Active provider' }), radios),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Fallback provider' }), fb)),
  h('h4', { text: 'Claude API' }),
  h('div', { class: 'fgrid' },
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Model' }), h('div', { class: 'grp' }, txt, sel), dl),
    fieldEl({ p: 'llm.anthropic.effort', l: 'Effort', t: 'select', o: ['low', 'medium', 'high', 'xhigh', 'max'] }),
    num('llm.anthropic.maxTokens', 'Max output tokens'),
    fieldEl({ p: 'llm.anthropic.refusalFallback', l: 'Fall back to another model on refusal', t: 'bool' }),
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Anthropic API key ', keyState), h('div', { class: 'grp' }, key, keyBtn, S.secrets.anthropicApiKey ? keyClr : null)),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Check' }), h('div', { class: 'grp' }, tBtn('anthropic', 'tAnth'), testRes('tAnth')))),
  h('h4', { text: 'LM Studio' }),
  h('div', { class: 'fgrid' },
    fieldEl({ p: 'llm.lmstudio.baseUrl', l: 'Base URL', t: 'text' }),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Model' }), h('div', { class: 'grp' }, lmTxt, lmModel, refresh)),
    fieldEl({ p: 'llm.lmstudio.toolMode', l: 'Tool mode', t: 'select', o: ['auto', 'native', 'json'], help: 'auto tries native tools, falls back to JSON' }),
    num('llm.lmstudio.temperature', 'Temperature'), num('llm.lmstudio.maxTokens', 'Max output tokens'), num('llm.lmstudio.contextTokens', 'Context tokens'),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Check' }), h('div', { class: 'grp' }, tBtn('lmstudio', 'tLm'), testRes('tLm')))));
  return fs;
}
function renderSettingsForm() {
  if (!S.settings) return;
  form = clone(S.settings); original = clone(S.settings); settingsDirty = false; inputs.clear();
  const box = $('#settingsForm'); box.textContent = '';
  for (const g of FIELDS) {
    if (g.custom === 'llm') { box.append(llmFieldset()); continue; }
    box.append(h('fieldset', null, h('legend', { text: g.title }), h('div', { class: 'fgrid' }, g.fields.map(fieldEl))));
  }
  $('#saveMsg').textContent = '';
}
function diff(a, b) { // patch turning a into b
  const out = {};
  for (const k of Object.keys(b)) {
    if (isObj(b[k]) && isObj(a?.[k])) { const d = diff(a[k], b[k]); if (Object.keys(d).length) out[k] = d; }
    else if (JSON.stringify(a?.[k]) !== JSON.stringify(b[k])) out[k] = b[k];
  }
  return out;
}
$('#saveSettings').onclick = guard(async () => {
  const f = clone(form);
  const clearPw = f.web.clearPassword; delete f.web.clearPassword; delete f.web.passwordSet;
  const o = clone(original); delete o.web.passwordSet;
  const patch = diff(o, f);
  if (clearPw) { patch.web = patch.web || {}; patch.web.password = ''; }
  else if (!f.web.password && patch.web) delete patch.web.password;
  if (patch.web && !Object.keys(patch.web).length) delete patch.web;
  if (!Object.keys(patch).length) { toast('Nothing changed'); return; }
  const r = await api('PUT', '/api/settings', { patch });
  S.settings = r.settings; S.secrets = r.secrets; settingsDirty = false; renderSettingsForm();
  const box = $('#restartBox'); box.textContent = '';
  const rb = r.restartRequired?.bots || [], ra = r.restartRequired?.app || [];
  if (rb.length || ra.length) {
    box.classList.remove('hidden');
    if (rb.length) {
      box.append(h('div', { text: `Needs a bot restart to take effect: ${rb.join(', ')}.` }),
        h('button', { class: 'small', text: 'Restart running bots now', onclick: guard(async () => {
          for (const b of S.bots.values()) if (b.status?.connection && b.status.connection !== 'stopped') await api('POST', `/api/bots/${encodeURIComponent(b.name)}/restart`, {});
          box.classList.add('hidden');
        }) }));
    }
    if (ra.length) box.append(h('div', { text: `Needs a dashboard/app restart: ${ra.join(', ')}.` }));
  } else box.classList.add('hidden');
  toast('Settings saved - applied live', 'ok');
  $('#saveMsg').textContent = `Saved ${fmtTime()}`;
});
$('#resetSettings').onclick = () => renderSettingsForm();

// ---------- characters ----------
let editingChar = null; // name or '__new__'
function renderCharList() {
  const box = $('#charList'); box.textContent = '';
  for (const [n, c] of Object.entries(S.characters)) {
    box.append(h('button', { class: `item${editingChar === n ? ' active' : ''}`, onclick: () => { editingChar = n; renderCharList(); renderCharEditor(); } },
      n, c.enabled === false ? h('span', { class: 'muted', text: ' (disabled)' }) : null));
  }
  if (editingChar === null || (editingChar !== '__new__' && !S.characters[editingChar])) {
    editingChar = Object.keys(S.characters)[0] ?? null;
  }
  renderCharEditor();
}
$('#charAdd').onclick = () => { editingChar = '__new__'; renderCharList(); };
let charDraft = null;
function renderCharEditorVoices() { if (charDraft && $('#cVoice')) fillVoiceSel(); }
function fillVoiceSel() {
  const sel = $('#cVoice'); sel.textContent = '';
  sel.append(h('option', { value: '', text: '(browser default)' }));
  for (const v of S.voices) sel.append(h('option', { value: v.name, text: `${v.name} (${v.lang})`, selected: v.name === charDraft.voice.name }));
  if (charDraft.voice.name && !S.voices.some((v) => v.name === charDraft.voice.name)) sel.append(h('option', { value: charDraft.voice.name, text: `${charDraft.voice.name} (not on this device)`, selected: true }));
}
function renderCharEditor() {
  const box = $('#charEditor'); box.textContent = '';
  if (editingChar === null) { box.append(h('p', { class: 'muted', text: 'No characters. Add one.' })); return; }
  const isNew = editingChar === '__new__';
  charDraft = isNew ? { name: '', username: '', enabled: true, personality: '', defaultGoal: '', llm: { provider: '', model: '' }, voice: { name: '', rate: 1, pitch: 1 } }
    : clone(S.characters[editingChar]);
  charDraft.llm = charDraft.llm || { provider: '', model: '' }; charDraft.voice = charDraft.voice || { name: '', rate: 1, pitch: 1 };
  const d = charDraft;
  const fld = (label, el, help) => h('div', { class: 'field' }, h('span', { class: 'lbl', text: label }), el, help ? h('span', { class: 'help', text: help }) : null);
  const rate = h('input', { type: 'number', step: '0.1', min: '0.1', max: '3', value: d.voice.rate, oninput: (e) => { d.voice.rate = parseFloat(e.target.value) || 1; } });
  const pitch = h('input', { type: 'number', step: '0.1', min: '0', max: '2', value: d.voice.pitch, oninput: (e) => { d.voice.pitch = parseFloat(e.target.value); if (!Number.isFinite(d.voice.pitch)) d.voice.pitch = 1; } });
  box.append(
    h('h3', { text: isNew ? 'New character' : d.name }),
    h('div', { class: 'fgrid' },
      fld('Name (id)', h('input', { type: 'text', value: d.name, disabled: !isNew, maxlength: 16, minlength: 3, pattern: '[A-Za-z0-9_]{3,16}', required: true, oninput: (e) => { d.name = e.target.value; if (isNew && !d._userTouched) { d.username = e.target.value.slice(0, 16); $('#cUser').value = d.username; } } }), isNew ? '3-16 letters, digits or _ (no spaces)' : 'Cannot be renamed'),
      fld('Minecraft username', h('input', { id: 'cUser', type: 'text', value: d.username, maxlength: 16, minlength: 3, pattern: '[A-Za-z0-9_]{3,16}', required: true, oninput: (e) => { d.username = e.target.value; d._userTouched = true; } }), '3-16 letters, digits or _'),
      h('label', { class: 'field inline' }, h('input', { type: 'checkbox', checked: d.enabled !== false, onchange: (e) => { d.enabled = e.target.checked; } }), 'Enabled (auto-start at launch; disabled bots stay listed and can still be started)')),
    fld('Personality', h('textarea', { rows: 4, oninput: (e) => { d.personality = e.target.value; }, value: d.personality })),
    fld('Default goal', h('textarea', { rows: 3, oninput: (e) => { d.defaultGoal = e.target.value; }, value: d.defaultGoal })),
    h('h4', { text: 'LLM override' }),
    h('div', { class: 'fgrid' },
      fld('Provider', h('select', { onchange: (e) => { d.llm.provider = e.target.value; } },
        [['', '(use global)'], ['anthropic', 'Claude API'], ['lmstudio', 'LM Studio']].map(([v, t]) => h('option', { value: v, text: t, selected: v === d.llm.provider })))),
      fld('Model', h('input', { type: 'text', list: 'claudeModels', value: d.llm.model, placeholder: '(use global)', oninput: (e) => { d.llm.model = e.target.value; } }))),
    h('h4', { text: 'Voice (browser text-to-speech)' }),
    h('div', { class: 'fgrid' },
      fld('Voice', h('select', { id: 'cVoice', onchange: (e) => { d.voice.name = e.target.value; } })),
      fld('Rate', rate), fld('Pitch', pitch),
      h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Preview' }), h('button', { class: 'small', text: 'Preview voice', onclick: () => previewVoice(d.voice.name, d.voice.rate, d.voice.pitch, d.name) }))),
    h('div', { class: 'savebar' },
      h('button', { class: 'primary', text: isNew ? 'Create character' : 'Save character', onclick: guard(async () => {
        const re = /^[A-Za-z0-9_]{3,16}$/;
        if (!re.test(d.name) || !re.test(d.username)) { toast('Name and username must be 3-16 letters, digits or underscore', 'error'); return; }
        const body = clone(d); delete body._userTouched;
        const r = isNew ? await api('POST', '/api/characters', body) : await api('PUT', `/api/characters/${encodeURIComponent(d.name)}`, body);
        S.characters = r.characters; S.settings = r.settings; S.bots = new Map(r.bots.map((b) => [b.name, b]));
        editingChar = d.name; if (!settingsDirty) renderSettingsForm();
        renderBots(); renderTargets(); renderCharList(); refreshMemBots();
        toast('Saved (bot will reconnect if it was running and the username/LLM changed)', 'ok');
      }) }),
      isNew ? null : h('button', { class: 'danger', text: 'Delete', onclick: guard(async () => {
        if (!confirm(`Delete character ${d.name}? Its memory file is kept.`)) return;
        const r = await api('DELETE', `/api/characters/${encodeURIComponent(d.name)}`);
        S.characters = r.characters; S.settings = r.settings; S.bots = new Map(r.bots.map((b) => [b.name, b]));
        editingChar = null; if (!settingsDirty) renderSettingsForm();
        renderBots(); renderTargets(); renderCharList(); refreshMemBots();
      }) })));
  fillVoiceSel();
}

// ---------- memory ----------
let memData = null;
function refreshMemBots() {
  const sel = $('#memBot'); const cur = sel.value; sel.textContent = '';
  for (const n of S.bots.keys()) sel.append(h('option', { value: n, text: n }));
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}
const loadMemory = guard(async () => {
  const n = $('#memBot').value; if (!n) { $('#memView').textContent = ''; return; }
  const r = await api('GET', `/api/memory/${encodeURIComponent(n)}`);
  memData = r.memory || {}; renderMemory();
});
const fmtDate = (ts) => { if (!ts) return ''; const d = new Date(ts); return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString(); };
const coord = (o) => (Number.isFinite(o?.x) ? `${Math.round(o.x)}, ${Math.round(o.y)}, ${Math.round(o.z)}${o.dimension ? ` (${o.dimension})` : ''}` : '');
async function delEntry(section, key) {
  const n = $('#memBot').value;
  const r = await api('DELETE', `/api/memory/${encodeURIComponent(n)}/${section}/${encodeURIComponent(key)}`);
  memData = r.memory || {}; renderMemory(); $('#memMsg').textContent = `Deleted ${fmtTime()}`;
}
function renderMemory() {
  const box = $('#memView'); box.textContent = '';
  $('#memRaw').value = JSON.stringify(memData, null, 2);
  const sec = (title, rows, empty = '(none)') => {
    const el = h('div', { class: 'memsec' }, h('h4', { text: title }));
    if (!rows.length) el.append(h('div', { class: 'muted', text: empty }));
    for (const r of rows) el.append(r);
    box.append(el);
  };
  const row = (parts, section, key) => h('div', { class: 'memitem' }, h('span', null, ...parts),
    section ? h('button', { class: 'small danger', text: 'Delete', onclick: guard(() => delEntry(section, key)) }) : null);
  const dim = (t) => h('span', { class: 'muted', text: t });
  const m = memData || {};
  sec('Facts', (Array.isArray(m.facts) ? m.facts : []).map((f) => row([dim(`#${f.id} `), f.text ?? '', dim(f.ts ? `  ${fmtDate(f.ts)}` : '')], 'facts', f.id)));
  sec('Places', Object.entries(isObj(m.places) ? m.places : {}).map(([k, p]) => row([h('b', { text: p.name || k }), ` ${coord(p)}`, p.note ? dim(` - ${p.note}`) : '', dim(p.ts ? `  ${fmtDate(p.ts)}` : '')], 'places', k)));
  sec('Session summaries', (Array.isArray(m.sessionSummaries) ? m.sessionSummaries : []).map((x, i) => row([dim(`${fmtDate(x.ts)}  `), typeof x === 'string' ? x : x.text ?? ''], 'sessionSummaries', i)));
  sec('Deaths', (Array.isArray(m.deaths) ? m.deaths : []).map((x, i) => row([dim(`${fmtDate(x.ts)}  `), `${coord(x)} - ${x.cause || 'unknown'}`], 'deaths', i)));
  if (isObj(m.stats)) {
    sec('Stats', [row([`Sessions: ${m.stats.sessions ?? 0}`, dim(`   first seen ${fmtDate(m.stats.firstSeen)}   last seen ${fmtDate(m.stats.lastSeen)}`)])]);
  }
  const known = new Set(['version', 'facts', 'places', 'sessionSummaries', 'deaths', 'stats']);
  const extra = Object.keys(m).filter((k) => !known.has(k));
  if (extra.length) sec('Other (edit via raw JSON)', extra.map((k) => row([`${k}: ${JSON.stringify(m[k])}`])));
}
async function saveMem() {
  const n = $('#memBot').value;
  const r = await api('PUT', `/api/memory/${encodeURIComponent(n)}`, { memory: memData });
  memData = r.memory; renderMemory(); $('#memMsg').textContent = `Saved ${fmtTime()}`;
}
$('#memBot').onchange = loadMemory; $('#memReload').onclick = loadMemory;
$('#memSaveRaw').onclick = guard(async () => {
  let o; try { o = JSON.parse($('#memRaw').value); } catch (e) { toast(`Invalid JSON: ${e.message}`, 'error'); return; }
  if (!isObj(o)) { toast('Memory must be a JSON object', 'error'); return; }
  if (!confirm('This replaces the bot\'s ENTIRE memory with this JSON. Continue?')) return;
  memData = o; await saveMem(); toast('Memory saved', 'ok');
});
$('#memClear').onclick = guard(async () => {
  const n = $('#memBot').value; if (!n) return;
  if (!confirm(`Erase ALL memory of ${n}? This cannot be undone.`)) return;
  const r = await api('DELETE', `/api/memory/${encodeURIComponent(n)}`); memData = r.memory || {}; renderMemory(); toast('Memory cleared', 'ok');
});

// ---------- logs ----------
const logs = []; const LOG_CAP = 1500; const LV = { debug: 0, info: 1, warn: 2, error: 3 };
let logPaused = false, pausedCount = 0;
const logView = $('#logView');
function logVisible(l) { return (LV[l.level] ?? 1) >= LV[$('#logLevel').value] && (!$('#logBot').value || l.bot === $('#logBot').value); }
function logEl(l) {
  return h('div', { class: `logline lv-${l.level}` }, h('span', { class: 'ts', text: `${fmtTime(l.ts)} ` }), h('span', { text: `${(l.level || 'info').toUpperCase().padEnd(5)} ` }), l.bot ? h('span', { class: 'bot', text: `[${l.bot}] ` }) : null, h('span', { text: l.msg }));
}
function scrollLogs() { if ($('#logScroll').checked) logView.scrollTop = logView.scrollHeight; }
function rebuildLogs() {
  logView.textContent = ''; const frag = document.createDocumentFragment();
  for (const l of logs) if (logVisible(l)) frag.append(logEl(l));
  logView.append(frag); scrollLogs(); $('#logCount').textContent = `${logs.length} buffered`;
}
function addLog(l) {
  logs.push(l); if (logs.length > LOG_CAP) logs.splice(0, logs.length - LOG_CAP);
  if (logPaused) { pausedCount++; $('#logPause').textContent = `Resume (${pausedCount} new)`; return; }
  if (logVisible(l)) { logView.append(logEl(l)); while (logView.children.length > LOG_CAP) logView.firstChild.remove(); scrollLogs(); }
  $('#logCount').textContent = `${logs.length} buffered`;
}
$('#logLevel').onchange = $('#logBot').onchange = rebuildLogs;
$('#logPause').onclick = () => { logPaused = !logPaused; if (!logPaused) { pausedCount = 0; $('#logPause').textContent = 'Pause'; rebuildLogs(); } else $('#logPause').textContent = 'Resume'; };
$('#logClear').onclick = () => { logs.length = 0; rebuildLogs(); };

$('#firstRunLink').addEventListener('click', (e) => { e.preventDefault(); selectTab('settings'); });

// ---------- boot ----------
(async function boot() {
  selectTab(lsGet('tab', 'bots'));
  try {
    const a = await (await fetch('/api/auth', { credentials: 'same-origin' })).json();
    $('#logoutBtn').classList.toggle('hidden', !a.required);
    if (a.required && !a.authed) { showLogin(); return; }
  } catch { /* offline */ }
  await guard(loadState)();
  connectWs();
})();
