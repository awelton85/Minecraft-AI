// Smoke test for the web dashboard: node test/web.smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startWebServer } from '../src/web/server.js';
import { FakeManager, FakeSettings } from './web.fakes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcai-web-'));
const sm = new FakeSettings(root);
sm.settings.web = { ...sm.settings.web, host: '127.0.0.1', port: 0, https: true, password: '' };
const manager = new FakeManager(sm);
const logs = [];
const srv = await startWebServer({ settingsManager: sm, manager, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) }, rootDir: tmp });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const base = `https://127.0.0.1:${srv.port}`;
let cookie = '';
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* html */ }
  return { status: r.status, json: j, res: r };
};
let passed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.log(`FAIL ${name}\n${e.stack}`); process.exitCode = 1; } };

await t('cert generated with SANs', async () => {
  assert.ok(fs.existsSync(path.join(tmp, 'config/certs/cert.pem')));
  const x = new (await import('node:crypto')).X509Certificate(fs.readFileSync(path.join(tmp, 'config/certs/cert.pem')));
  assert.match(x.subjectAltName, /localhost/); assert.match(x.subjectAltName, /127\.0\.0\.1/);
});
await t('static index + state', async () => {
  const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.match(await r.text(), /Minecraft AI/);
  const s = await call('GET', '/api/state'); assert.equal(s.status, 200);
  assert.equal(s.json.bots[0].name, 'Steve_AI'); assert.equal(s.json.settings.web.password, ''); assert.equal(s.json.settings.web.passwordSet, false);
});
await t('bot controls', async () => {
  assert.equal((await call('POST', '/api/bots/Steve_AI/start')).status, 200);
  assert.equal((await call('POST', '/api/bots/Nope/start')).status, 404);
  assert.equal((await call('POST', '/api/bots/Steve_AI/autonomous', { value: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/bots/Steve_AI/autonomous', { value: false })).status, 200);
  assert.equal((await call('POST', '/api/bots/Steve_AI/goal', { text: 'mine iron' })).status, 200);
  assert.equal((await call('POST', '/api/bots/Steve_AI/stop-action')).status, 200);
  assert.equal((await call('POST', '/api/bots/start-all')).status, 200);
  assert.equal((await call('POST', '/api/bots/stop-all')).status, 200);
  assert.deepEqual(manager.calls.find((c) => c[0] === 'setGoal'), ['setGoal', 'Steve_AI', 'mine iron']);
});
await t('messages validated', async () => {
  assert.equal((await call('POST', '/api/message', { target: 'all', text: '' })).status, 400);
  assert.equal((await call('POST', '/api/message', { target: 'ghost', text: 'hi' })).status, 400);
  assert.equal((await call('POST', '/api/message', { target: 'Steve_AI', text: 'hi', from: 'voice' })).status, 200);
  assert.deepEqual(manager.calls.at(-1), ['sendMessage', 'Steve_AI', 'hi', 'voice']);
});
await t('bad json -> JSON error', async () => {
  const r = await fetch(base + '/api/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(r.status, 400); assert.ok((await r.json()).error);
});
await t('settings patch + validation + restart info', async () => {
  let r = await call('PUT', '/api/settings', { patch: { agent: { idleThinkSeconds: 'abc' } } }); assert.equal(r.status, 400);
  r = await call('PUT', '/api/settings', { patch: { bogus: 1 } }); assert.equal(r.status, 400);
  r = await call('PUT', '/api/settings', { patch: { llm: { anthropic: { effort: 'turbo' } } } }); assert.equal(r.status, 400);
  r = await call('PUT', '/api/settings', { patch: { agent: { idleThinkSeconds: 30 } } });
  assert.equal(r.status, 200); assert.equal(r.json.settings.agent.idleThinkSeconds, 30); assert.deepEqual(r.json.restartRequired.bots, []);
  r = await call('PUT', '/api/settings', { patch: { server: { port: 25570 } } });
  assert.equal(r.json.restartRequired.bots.length, 1);
});
await t('secrets never leak', async () => {
  let r = await call('POST', '/api/secrets', { key: 'anthropicApiKey', value: 'sk-ant-SECRET' });
  assert.equal(r.json.secrets.anthropicApiKey, true);
  assert.ok(!JSON.stringify((await call('GET', '/api/state')).json).includes('SECRET'));
  assert.equal((await call('POST', '/api/secrets', { key: 'other', value: 'x' })).status, 400);
});
await t('providers + models', async () => {
  assert.equal((await call('POST', '/api/providers/anthropic/test')).json.ok, true);
  assert.equal((await call('POST', '/api/providers/evil/test')).status, 400);
  assert.deepEqual((await call('GET', '/api/models/lmstudio')).json.models, ['qwen3-14b', 'llama-3.1-8b']);
});
await t('character CRUD keeps settings.characters consistent', async () => {
  let r = await call('POST', '/api/characters', { name: 'Alex_AI', username: 'Alex_AI', personality: 'p', voice: { name: '', rate: 1.2, pitch: 1 } });
  assert.equal(r.status, 200); assert.ok(r.json.settings.characters.includes('Alex_AI')); assert.ok(r.json.bots.some((b) => b.name === 'Alex_AI'));
  assert.equal((await call('POST', '/api/characters', { name: 'Alex_AI', username: 'Alex_AI' })).status, 409);
  assert.equal((await call('POST', '/api/characters', { name: '../x', username: 'abc' })).status, 400);
  r = await call('PUT', '/api/characters/Alex_AI', { name: 'Alex_AI', username: 'Alexx', enabled: true, personality: 'new', voice: { rate: 1, pitch: 1 } });
  assert.equal(r.status, 200); assert.equal(r.json.characters.Alex_AI.username, 'Alexx'); assert.equal(r.json.restartNeeded, true);
  r = await call('DELETE', '/api/characters/Alex_AI');
  assert.equal(r.status, 200); assert.ok(!r.json.settings.characters.includes('Alex_AI')); assert.ok(!r.json.characters.Alex_AI);
});
await t('memory', async () => {
  let r = await call('GET', '/api/memory/Steve_AI'); assert.equal(r.json.memory.facts.length, 1);
  r = await call('PUT', '/api/memory/Steve_AI', { memory: { facts: [] } }); assert.deepEqual(r.json.memory, { facts: [] });
  assert.equal((await call('PUT', '/api/memory/Steve_AI', { memory: [1] })).status, 400);
  r = await call('DELETE', '/api/memory/Steve_AI'); assert.deepEqual(r.json.memory, {});
});
await t('websocket events + commands', async () => {
  const ws = new WebSocket(`wss://127.0.0.1:${srv.port}/ws`, { rejectUnauthorized: false });
  const got = [];
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const wait = async (fn) => { for (let i = 0; i < 50; i++) { if (got.some(fn)) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout; got ' + JSON.stringify(got.map((g) => g.type))); };
  await wait((m) => m.type === 'hello'); await wait((m) => m.type === 'backlog');
  manager.emit('log', { ts: 1, bot: null, level: 'info', msg: 'hello log' });
  manager.emit('status', { bot: 'Steve_AI', status: { connection: 'error' } });
  await wait((m) => m.type === 'log' && m.data.msg === 'hello log'); await wait((m) => m.type === 'status');
  ws.send(JSON.stringify({ type: 'message', id: 'a', target: 'Steve_AI', text: 'via ws', from: 'voice' }));
  await wait((m) => m.type === 'ack' && m.id === 'a');
  await wait((m) => m.type === 'speech'); await wait((m) => m.type === 'thought'); await wait((m) => m.type === 'chat');
  ws.send(JSON.stringify({ type: 'message', id: 'b', target: 'zzz', text: 'x' }));
  await wait((m) => m.type === 'error' && m.id === 'b');
  ws.send('not json'); await wait((m) => m.type === 'error');
  ws.close();
});
await t('ws rejects foreign Origin', async () => {
  const ws = new WebSocket(`wss://127.0.0.1:${srv.port}/ws`, { rejectUnauthorized: false, headers: { Origin: 'https://evil.example' } });
  const code = await new Promise((res) => { ws.on('unexpected-response', (_q, r) => res(r.statusCode)); ws.on('error', () => res('err')); ws.on('open', () => res('open')); });
  assert.notEqual(code, 'open');
});
await srv.close();

// ---- password-protected instance ----
const sm2 = new FakeSettings(root);
sm2.settings.web = { ...sm2.settings.web, host: '127.0.0.1', port: 0, https: false, password: 'hunter2' };
const m2 = new FakeManager(sm2);
const srv2 = await startWebServer({ settingsManager: sm2, manager: m2, log: () => {}, rootDir: tmp });
const base2 = `http://127.0.0.1:${srv2.port}`;
await t('password: API and WS locked until login', async () => {
  assert.equal((await fetch(base2 + '/api/state')).status, 401);
  assert.equal((await fetch(base2 + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"bad"}' })).status, 401);
  const ws0 = new WebSocket(`ws://127.0.0.1:${srv2.port}/ws`);
  const r0 = await new Promise((res) => { ws0.on('unexpected-response', (_q, r) => res(r.statusCode)); ws0.on('open', () => res('open')); ws0.on('error', () => {}); });
  assert.equal(r0, 401);
  await new Promise((r) => setTimeout(r, 1100)); // brute-force delay
  const lr = await fetch(base2 + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"hunter2"}' });
  assert.equal(lr.status, 200);
  const sc = lr.headers.get('set-cookie'); assert.match(sc, /HttpOnly/);
  const ck = sc.split(';')[0];
  const s = await fetch(base2 + '/api/state', { headers: { cookie: ck } }); assert.equal(s.status, 200);
  const j = await s.json(); assert.equal(j.settings.web.passwordSet, true); assert.ok(!JSON.stringify(j).includes('hunter2'));
  const ws = new WebSocket(`ws://127.0.0.1:${srv2.port}/ws`, { headers: { cookie: ck } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.close();
});
await srv2.close();
console.log(`${passed} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
