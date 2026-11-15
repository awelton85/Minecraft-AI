// Web dashboard server: express REST API + ws on the same (optionally HTTPS) listener.
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validCharacterName } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'mcai_token';
const EVENTS = ['log', 'chat', 'speech', 'thought', 'status'];
const NAME_MSG = 'must be 3-16 letters, digits or underscore (A-Z a-z 0-9 _)';
const LOG_BACKLOG = 500;
const CHAT_BACKLOG = 200;

// SettingsManager validation errors (duplicate username, ...) are the user's input problem: 400.
const saveCharWith = async (sm, p) => {
  try { await sm.saveCharacter(p); } catch (e) { throw e.status ? e : new HttpError(400, e.message); }
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

async function ensureCert(rootDir, log) {
  const dir = path.join(rootDir, 'config', 'certs');
  const keyF = path.join(dir, 'key.pem');
  const certF = path.join(dir, 'cert.pem');
  const metaF = path.join(dir, 'meta.json');
  const ips = ['127.0.0.1', ...lanAddresses()];
  const hostname = os.hostname();
  const names = ['localhost', hostname];
  const want = [...ips, ...names].sort();
  try {
    const meta = JSON.parse(fs.readFileSync(metaF, 'utf8'));
    const have = new Set(meta.names || []);
    if (fs.existsSync(keyF) && fs.existsSync(certF) && want.every((n) => have.has(n)) &&
        new Date(meta.notAfter) > new Date(Date.now() + 30 * 864e5)) {
      return { key: fs.readFileSync(keyF), cert: fs.readFileSync(certF) };
    }
  } catch { /* regenerate */ }
  const selfsigned = await import('selfsigned');
  const notBefore = new Date(Date.now() - 864e5);
  const notAfter = new Date(Date.now() + 3650 * 864e5);
  const altNames = [
    ...names.map((n) => ({ type: 2, value: n })),
    ...ips.map((ip) => ({ type: 7, ip })),
    { type: 7, ip: '::1' },
  ];
  const pems = await selfsigned.generate([{ name: 'commonName', value: hostname || 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyF, pems.private, { mode: 0o600 });
  fs.writeFileSync(certF, pems.cert);
  fs.writeFileSync(metaF, JSON.stringify({ names: want, notAfter: notAfter.toISOString() }, null, 2));
  logTo(log, 'info', `Generated self-signed certificate in ${dir}`);
  return { key: Buffer.from(pems.private), cert: Buffer.from(pems.cert) };
}

function logTo(log, level, msg) {
  try {
    if (log && typeof log[level] === 'function') log[level](msg);
    else if (typeof log === 'function') log(msg);
    else console.log(`[web] ${msg}`);
  } catch { /* ignore */ }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Validate a settings patch against the shape of the current settings.
function validatePatch(patch, shape, pathStr = '') {
  if (!isObj(patch)) throw bad(`${pathStr || 'patch'} must be an object`);
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw bad('invalid key');
    const p = pathStr ? `${pathStr}.${k}` : k;
    if (!(k in shape)) throw bad(`Unknown setting: ${p}`);
    const s = shape[k];
    if (isObj(s)) validatePatch(v, s, p);
    else if (Array.isArray(s)) {
      if (!Array.isArray(v) || v.length > 200 || v.some((x) => typeof x !== 'string' || x.length > 100)) {
        throw bad(`${p} must be an array of strings`);
      }
    } else if (typeof s === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${p} must be a number`);
    } else if (typeof s === 'boolean') {
      if (typeof v !== 'boolean') throw bad(`${p} must be true or false`);
    } else if (typeof s === 'string') {
      if (typeof v !== 'string' || v.length > 2000) throw bad(`${p} must be a string`);
    }
  }
}

const ENUMS = {
  'llm.provider': ['anthropic', 'lmstudio'],
  'llm.fallbackProvider': ['none', 'anthropic', 'lmstudio'],
  'llm.anthropic.effort': ['low', 'medium', 'high', 'xhigh', 'max'],
  'llm.lmstudio.toolMode': ['auto', 'native', 'json'],
  'agent.botsTalkToBots': ['never', 'when-addressed', 'always'],
  'server.auth': ['offline', 'microsoft', 'mojang'],
};
function checkEnums(patch, prefix = '') {
  for (const [k, v] of Object.entries(patch)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) checkEnums(v, p);
    else if (ENUMS[p] && !ENUMS[p].includes(v)) throw bad(`${p} must be one of ${ENUMS[p].join(', ')}`);
  }
}
function checkRanges(patch, current) {
  const merged = (path) => {
    const v = path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), patch);
    return v !== undefined ? v : path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), current);
  };
  const rules = [
    ['server.port', 1, 65535, true], ['web.port', 1, 65535, true],
    ['agent.idleThinkSeconds', 5], ['agent.maxStepsPerTurn', 1, 50], ['agent.actionTimeoutSeconds', 10],
    ['agent.historyCompactAt', 10], ['agent.stuckSeconds', 3], ['agent.chatMaxLength', 20, 256],
    ['reconnect.initialDelaySeconds', 1], ['reconnect.maxDelaySeconds', 1],
    ['llm.anthropic.maxTokens', 256], ['llm.lmstudio.maxTokens', 256], ['llm.lmstudio.contextTokens', 12288],
    ['llm.lmstudio.temperature', 0, 2],
  ];
  for (const [p, min, max, int] of rules) {
    const raw = p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), patch);
    if (raw === undefined) continue;
    if (int && !Number.isInteger(raw)) throw bad(`${p} must be a whole number`);
    if (raw < min) throw bad(`${p} must be >= ${min}`);
    if (max !== undefined && raw > max) throw bad(`${p} must be <= ${max}`);
  }
  if (patch.reconnect && (patch.reconnect.initialDelaySeconds !== undefined || patch.reconnect.maxDelaySeconds !== undefined) &&
      merged('reconnect.maxDelaySeconds') < merged('reconnect.initialDelaySeconds')) {
    throw bad('reconnect.maxDelaySeconds must be >= reconnect.initialDelaySeconds');
  }
}

function sanitizeProfile(p, { requireName } = {}) {
  if (!isObj(p)) throw bad('character must be an object');
  const out = {};
  if (!validCharacterName(p.name)) throw bad(`Character name ${NAME_MSG}`);
  out.name = p.name;
  const username = p.username ?? p.name;
  if (!validCharacterName(username)) throw bad(`Minecraft username ${NAME_MSG}`);
  out.username = username;
  out.enabled = p.enabled === undefined ? true : !!p.enabled;
  for (const k of ['personality', 'defaultGoal']) {
    const v = p[k] ?? '';
    if (typeof v !== 'string' || v.length > 5000) throw bad(`${k} must be a string (max 5000 chars)`);
    out[k] = v;
  }
  const llm = p.llm ?? {};
  if (!isObj(llm)) throw bad('llm must be an object');
  const prov = llm.provider ?? '';
  if (!['', 'anthropic', 'lmstudio'].includes(prov)) throw bad('llm.provider must be empty, anthropic or lmstudio');
  if (typeof (llm.model ?? '') !== 'string' || (llm.model ?? '').length > 200) throw bad('llm.model must be a string');
  out.llm = { provider: prov, model: llm.model ?? '' };
  const v = p.voice ?? {};
  if (!isObj(v)) throw bad('voice must be an object');
  const rate = v.rate ?? 1, pitch = v.pitch ?? 1;
  if (typeof rate !== 'number' || rate < 0.1 || rate > 10) throw bad('voice.rate must be 0.1-10');
  if (typeof pitch !== 'number' || pitch < 0 || pitch > 2) throw bad('voice.pitch must be 0-2');
  if (typeof (v.name ?? '') !== 'string' || (v.name ?? '').length > 200) throw bad('voice.name must be a string');
  out.voice = { name: v.name ?? '', rate, pitch };
  return out;
}

export async function startWebServer({ settingsManager, manager, log, rootDir }) {
  const sm = settingsManager;
  const web = () => sm.settings.web || {};
  const useHttps = web().https !== false;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const tokens = new Map(); // token -> expiry
  const failures = new Map(); // ip -> { n, until }
  const passwordRequired = () => typeof web().password === 'string' && web().password.length > 0;
  const tokenValid = (t) => {
    const exp = t && tokens.get(t);
    if (!exp) return false;
    if (exp < Date.now()) { tokens.delete(t); return false; }
    return true;
  };
  const isAuthed = (req) => !passwordRequired() || tokenValid(parseCookies(req.headers.cookie)[COOKIE]);

  const wrap = (fn) => async (req, res) => {
    try {
      const r = await fn(req, res);
      if (!res.headersSent) res.json(r === undefined ? { ok: true } : r);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) logTo(log, 'error', `API ${req.method} ${req.path}: ${e.stack || e}`);
      if (!res.headersSent) res.status(status).json({ error: e.message || String(e) });
    }
  };

  // ---- host / origin / content-type guards ----
  const allowedHosts = () => {
    const set = new Set(['localhost', '127.0.0.1', '::1', os.hostname().toLowerCase(), ...lanAddresses()]);
    const wh = web().host; if (wh && wh !== '0.0.0.0' && wh !== '::') set.add(String(wh).toLowerCase());
    return set;
  };
  const hostName = (hostHeader) => {
    const m = String(hostHeader || '').toLowerCase().match(/^(\[[^\]]+\]|[^:]*)(?::\d+)?$/);
    return m ? m[1].replace(/^\[|\]$/g, '') : '';
  };
  const hostOk = (req) => allowedHosts().has(hostName(req.headers.host));
  app.use((req, res, next) => {
    if (!hostOk(req)) return res.status(403).json({ error: 'Host not allowed (DNS rebinding protection). Use localhost, this machine\'s name or its LAN IP.' });
    next();
  });
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.headers.origin;
    if (origin) {
      let oh = ''; try { oh = new URL(origin).host; } catch { /* */ }
      if (oh !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) return res.status(415).json({ error: 'Content-Type must be application/json' });
    next();
  });

  // ---- auth ----
  const api = express.Router();
  api.get('/auth', (req, res) => res.json({ required: passwordRequired(), authed: isAuthed(req) }));
  api.post('/login', wrap((req, res) => {
    const ip = req.socket.remoteAddress || '?';
    const f = failures.get(ip);
    if (f && f.until > Date.now()) throw new HttpError(429, 'Too many attempts, wait a few seconds');
    const pw = req.body?.password;
    if (typeof pw !== 'string') throw bad('password required');
    if (passwordRequired()) {
      const a = crypto.createHash('sha256').update(pw).digest();
      const b = crypto.createHash('sha256').update(web().password).digest();
      if (!crypto.timingSafeEqual(a, b)) {
        const n = (f?.n || 0) + 1;
        failures.set(ip, { n, until: Date.now() + Math.min(n, 10) * 1000 });
        throw new HttpError(401, 'Wrong password');
      }
    }
    failures.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, Date.now() + 30 * 864e5);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${30 * 86400}${useHttps ? '; Secure' : ''}`);
    return { ok: true };
  }));
  api.post('/logout', wrap((req, res) => {
    tokens.delete(parseCookies(req.headers.cookie)[COOKIE]);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
  }));
  api.use((req, res, next) => {
    if (isAuthed(req)) return next();
    res.status(401).json({ error: 'Login required' });
  });

  // ---- helpers ----
  const publicSettings = () => {
    const s = JSON.parse(JSON.stringify(sm.settings));
    if (s.web) { s.web.passwordSet = !!s.web.password; s.web.password = ''; }
    return s;
  };
  const botNames = () => manager.list().map((b) => b.name);
  const botName = (req) => {
    const n = req.params.name;
    if (!botNames().includes(n) && !(sm.characters && n in sm.characters)) throw new HttpError(404, `Unknown bot: ${n}`);
    return n;
  };
  const characters = () => JSON.parse(JSON.stringify(sm.characters || {}));
  const fullState = () => ({
    bots: manager.list(),
    settings: publicSettings(),
    characters: characters(),
    secrets: sm.secretsStatus(),
    usernames: manager.botUsernames?.() || [],
  });

  // ---- state / bots ----
  api.get('/state', wrap(() => fullState()));
  api.get('/bots', wrap(() => ({ bots: manager.list() })));
  api.post('/bots/start-all', wrap(async () => { await manager.startAll(); return { bots: manager.list() }; }));
  api.post('/bots/stop-all', wrap(async () => { await manager.stopAll(); return { bots: manager.list() }; }));
  for (const act of ['start', 'stop', 'restart']) {
    api.post(`/bots/:name/${act}`, wrap(async (req) => { await manager[act](botName(req)); return { ok: true }; }));
  }
  api.post('/bots/:name/stop-action', wrap((req) => { manager.stopAction(botName(req)); }));
  api.post('/bots/:name/autonomous', wrap((req) => {
    if (typeof req.body?.value !== 'boolean') throw bad('value must be boolean');
    manager.setAutonomous(botName(req), req.body.value);
  }));
  api.post('/bots/:name/reset-conversation', wrap(async (req) => {
    if (typeof manager.resetConversation !== 'function') throw new HttpError(501, 'resetConversation not supported');
    await manager.resetConversation(botName(req));
  }));
  api.post('/bots/:name/goal', wrap((req) => {
    const t = req.body?.text;
    if (typeof t !== 'string' || t.length > 2000) throw bad('text must be a string (max 2000)');
    manager.setGoal(botName(req), t.trim());
  }));
  const doMessage = (target, text, from) => {
    if (typeof text !== 'string' || !text.trim()) throw bad('text required');
    if (text.length > 1000) throw bad('text too long (max 1000)');
    if (typeof target !== 'string') throw bad('target required');
    if (target !== 'all' && !botNames().includes(target)) throw bad(`Unknown target: ${target}`);
    const f = from === 'voice' ? 'voice' : 'dashboard';
    manager.sendMessage(target, text.trim(), f);
  };
  api.post('/message', wrap((req) => doMessage(req.body?.target, req.body?.text, req.body?.from)));

  // ---- settings ----
  api.get('/settings', wrap(() => ({ settings: publicSettings(), secrets: sm.secretsStatus() })));
  api.put('/settings', wrap(async (req) => {
    const patch = req.body?.patch ?? req.body;
    if (!isObj(patch)) throw bad('patch must be an object');
    const shape = sm.settings;
    // web.password is a string in defaults, so it validates; passwordSet is display-only
    if (patch.web) { patch.web = { ...patch.web }; delete patch.web.passwordSet; if (patch.web.password === undefined) delete patch.web.password; }
    validatePatch(patch, shape);
    checkEnums(patch);
    checkRanges(patch, sm.settings);
    const before = JSON.parse(JSON.stringify(sm.settings));
    await sm.saveSettings(patch);
    if ((before.web?.password || '') !== (sm.settings.web?.password || '')) {
      // Password changed: end every existing session and live connection (they re-login).
      tokens.clear();
      for (const c of wss.clients) { try { c.close(4001, 'password changed'); } catch { /* ignore */ } }
    }
    const after = sm.settings;
    const restartBots = [];
    const restartApp = [];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(before.server, after.server)) restartBots.push('Server connection (host/port/version/auth)');
    if (!same(before.owners, after.owners) || before.listenToEveryone !== after.listenToEveryone) { /* live */ }
    if (!same(before.characters, after.characters)) restartBots.push('Active character list');
    for (const k of ['host', 'port', 'https', 'enabled']) {
      if (before.web?.[k] !== after.web?.[k]) restartApp.push(`web.${k}`);
    }
    return {
      settings: publicSettings(),
      secrets: sm.secretsStatus(),
      restartRequired: { bots: restartBots, app: restartApp },
    };
  }));
  api.post('/secrets', wrap(async (req) => {
    const { key, value } = req.body || {};
    if (key !== 'anthropicApiKey') throw bad('Unknown secret key');
    if (typeof value !== 'string' || value.length > 500) throw bad('value must be a string');
    await sm.setSecret(key, value.trim());
    return { secrets: sm.secretsStatus() };
  }));
  api.post('/providers/:name/test', wrap(async (req) => {
    if (!['anthropic', 'lmstudio'].includes(req.params.name)) throw bad('Unknown provider');
    return await manager.testProvider(req.params.name);
  }));
  api.get('/models/lmstudio', wrap(async () => {
    try { return { models: await manager.listModels('lmstudio') }; }
    catch (e) { return { models: [], error: e.message || String(e) }; }
  }));

  // ---- characters ----
  const saveChar = (p) => saveCharWith(sm, p);
  api.get('/characters', wrap(() => ({ characters: characters() })));
  api.post('/characters', wrap(async (req) => {
    const p = sanitizeProfile(req.body);
    if (sm.characters?.[p.name]) throw new HttpError(409, `Character ${p.name} already exists`);
    await saveChar(p);
    return { characters: characters(), settings: publicSettings(), bots: manager.list() };
  }));
  api.put('/characters/:name', wrap(async (req) => {
    if (!validCharacterName(req.params.name) || !sm.characters?.[req.params.name]) throw new HttpError(404, 'Unknown character');
    const p = sanitizeProfile({ ...req.body, name: req.params.name });
    const old = sm.characters[req.params.name];
    await saveChar(p);
    return { characters: characters(), settings: publicSettings(), bots: manager.list() };
  }));
  api.delete('/characters/:name', wrap(async (req) => {
    const n = req.params.name;
    if (!validCharacterName(n) || !sm.characters?.[n]) throw new HttpError(404, 'Unknown character');
    try { if (botNames().includes(n)) await manager.stop(n); } catch { /* best effort */ }
    await sm.deleteCharacter(n);
    return { characters: characters(), settings: publicSettings(), bots: manager.list() };
  }));

  // ---- memory ----
  api.get('/memory/:name', wrap((req) => ({ memory: manager.getMemory(botName(req)) })));
  api.put('/memory/:name', wrap(async (req) => {
    const m = req.body?.memory;
    if (!isObj(m)) throw bad('memory must be an object');
    await manager.saveMemory(botName(req), m);
    return { memory: manager.getMemory(req.params.name) };
  }));
  const memEntry = (section, keyFn) => wrap(async (req) => {
    const n = botName(req);
    const key = keyFn(req);
    if (typeof manager.deleteMemoryEntry !== 'function') throw new HttpError(501, 'deleteMemoryEntry not supported');
    const ok = await manager.deleteMemoryEntry(n, section, key);
    if (ok === false) throw new HttpError(404, 'Entry not found');
    return { memory: manager.getMemory(n) };
  });
  const idx = (req) => { const i = Number(req.params.key); if (!Number.isInteger(i) || i < 0) throw bad('index must be a non-negative integer'); return i; };
  const sid = (req) => { const k = req.params.key; if (!k || k.length > 200) throw bad('invalid key'); return k; };
  api.delete('/memory/:name/facts/:key', memEntry('facts', sid));
  api.delete('/memory/:name/places/:key', memEntry('places', sid));
  api.delete('/memory/:name/sessionSummaries/:key', memEntry('sessionSummaries', idx));
  api.delete('/memory/:name/deaths/:key', memEntry('deaths', idx));
  api.delete('/memory/:name', wrap(async (req) => {
    await manager.clearMemory(botName(req));
    return { memory: manager.getMemory(req.params.name) };
  }));

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));
  // JSON error handler (bad JSON bodies etc.)
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'Internal error' : err.message });
  });

  // ---- listener ----
  const wantHost = web().host || '0.0.0.0';
  const wantPort = web().port ?? 3000;
  let server;
  if (useHttps) {
    const { key, cert } = await ensureCert(rootDir, log);
    server = https.createServer({ key, cert }, app);
  } else {
    server = http.createServer(app);
  }

  // ---- websocket ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const logBuf = [];
  const chatBuf = [];
  const push = (buf, item, cap) => { buf.push(item); if (buf.length > cap) buf.splice(0, buf.length - cap); };
  const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const broadcast = (obj) => {
    const s = JSON.stringify(obj);
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s);
  };

  const listeners = {};
  for (const ev of EVENTS) {
    listeners[ev] = (data) => {
      if (ev === 'log') push(logBuf, data, LOG_BACKLOG);
      else if (ev === 'chat') push(chatBuf, data, CHAT_BACKLOG);
      broadcast({ type: ev, data });
    };
    manager.on(ev, listeners[ev]);
  }

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/ws') { socket.destroy(); return; }
      if (!hostOk(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      const origin = req.headers.origin;
      if (origin) {
        let oh; try { oh = new URL(origin).host; } catch { oh = ''; }
        if (oh !== req.headers.host) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      }
      if (!isAuthed(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch { socket.destroy(); }
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (e) => logTo(log, 'debug', `WebSocket error: ${e.message}`));
    send(ws, { type: 'hello', data: { bots: manager.list(), passwordRequired: passwordRequired() } });
    send(ws, { type: 'backlog', data: { logs: logBuf, chats: chatBuf } });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', error: 'invalid JSON' }); }
      try {
        if (m.type === 'ping') return send(ws, { type: 'pong' });
        {
          if (m.type === 'message') {
            doMessage(m.target, m.text, m.from);
            return send(ws, { type: 'ack', id: m.id ?? null });
          }
          if (m.type === 'command') {
            if (typeof m.name !== 'string' || !botNames().includes(m.name)) throw bad('unknown bot');
            const acts = {
              stopAction: () => manager.stopAction(m.name),
              setAutonomous: () => { if (typeof m.value !== 'boolean') throw bad('value must be boolean'); manager.setAutonomous(m.name, m.value); },
              setGoal: () => { if (typeof m.value !== 'string') throw bad('value must be string'); manager.setGoal(m.name, m.value); },
            };
            if (!acts[m.action]) throw bad('unknown action');
            acts[m.action]();
            return send(ws, { type: 'ack', id: m.id ?? null });
          }
        }
        send(ws, { type: 'error', error: 'unknown message type', id: m.id ?? null });
      } catch (e) {
        send(ws, { type: 'error', error: e.message || String(e), id: m?.id ?? null });
      }
    });
  });
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  hb.unref?.();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wantPort, wantHost, resolve);
  });
  const port = server.address().port;
  const scheme = useHttps ? 'https' : 'http';
  const addrs = wantHost === '0.0.0.0' || wantHost === '::' ? lanAddresses() : [];
  const urls = [`${scheme}://localhost:${port}`, ...addrs.map((a) => `${scheme}://${a}:${port}`)];
  if (wantHost !== '0.0.0.0' && wantHost !== '::' && wantHost !== '127.0.0.1' && wantHost !== 'localhost') urls.push(`${scheme}://${wantHost}:${port}`);
  for (const u of urls) logTo(log, 'info', `Dashboard: ${u}`);
  if (useHttps) logTo(log, 'info', 'Browser will warn about the self-signed certificate: choose Advanced -> Proceed.');
  if (!passwordRequired() && addrs.length) logTo(log, 'warn', 'Dashboard has no password and is reachable on the LAN. Set one in Settings -> Web.');
  const url = addrs[0] ? `${scheme}://${addrs[0]}:${port}` : `${scheme}://localhost:${port}`;

  return {
    url,
    urls,
    port,
    async close() {
      clearInterval(hb);
      for (const ev of EVENTS) manager.off(ev, listeners[ev]);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}
