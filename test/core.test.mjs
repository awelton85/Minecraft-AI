// Unit tests for the provider-neutral pieces: run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractTextToolCalls, splitThinking, OpenAICompatProvider } from '../src/llm/openai.js';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { MemoryStore } from '../src/memory/MemoryStore.js';
import { deepMerge, SettingsManager } from '../src/config.js';

const known = new Set(['collect_block', 'chat']);

test('extractTextToolCalls: fenced json block', () => {
  const r = extractTextToolCalls('Getting wood.\n```json\n{"tool_calls":[{"name":"collect_block","args":{"block":"oak_log","count":3}}]}\n```', known);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].args, { block: 'oak_log', count: 3 });
  assert.equal(r.rest.trim(), 'Getting wood.');
});

test('extractTextToolCalls: hermes <tool_call> tags with string arguments', () => {
  const r = extractTextToolCalls('<tool_call>{"name":"chat","arguments":"{\\"text\\":\\"hi\\"}"}</tool_call>', known);
  assert.equal(r.calls[0].name, 'chat');
  assert.deepEqual(r.calls[0].args, { text: 'hi' });
});

test('extractTextToolCalls: ignores unknown tools and plain text', () => {
  assert.equal(extractTextToolCalls('```json\n{"name":"rm_rf","args":{}}\n```', known).calls.length, 0);
  assert.equal(extractTextToolCalls('Just chatting {not json}', known).calls.length, 0);
});

test('extractTextToolCalls: HTML-escaped JSON', () => {
  const r = extractTextToolCalls('```json\n{&#34;tool_calls&#34;: [{&#34;name&#34;: &#34;chat&#34;, &#34;args&#34;: {&#34;text&#34;: &#34;hi&#34;}}]}\n```', known);
  assert.deepEqual(r.calls[0].args, { text: 'hi' });
});

test('splitThinking removes <think> blocks', () => {
  const r = splitThinking('<think>plan stuff</think>Hello');
  assert.equal(r.text, 'Hello');
  assert.equal(r.thoughts, 'plan stuff');
});

const history = [
  { role: 'user', content: 'go get wood' },
  { role: 'assistant', text: 'ok', toolCalls: [{ id: 'call.1', name: 'collect_block', args: { block: 'oak_log' } }], raw: { provider: 'lmstudio', model: 'x' } },
  { role: 'tool', results: [{ id: 'call.1', name: 'collect_block', content: 'Collected 1', isError: false }] },
  { role: 'user', content: '[status] fine' },
];

test('Anthropic conversion rebuilds foreign assistant turns with matching sanitised ids', () => {
  const p = new AnthropicProvider({ apiKey: 'test', model: 'claude-opus-5-5' });
  const msgs = p.toApiMessages(history);
  assert.equal(msgs[1].content[1].type, 'tool_use');
  assert.equal(msgs[1].content[1].id, 'call_1');
  assert.equal(msgs[2].content[0].tool_use_id, 'call_1');
});

test('Anthropic conversion replays raw blocks unchanged for the same model, strips thinking on request', () => {
  const p = new AnthropicProvider({ apiKey: 'test', model: 'claude-opus-5-5' });
  const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name: 'chat', input: { text: 'hi' } }];
  const h = [{ role: 'user', content: 'hi' }, { role: 'assistant', text: '', toolCalls: [], raw: { provider: 'anthropic', model: 'claude-opus-5-5', content: raw } }];
  assert.deepEqual(p.toApiMessages(h)[1].content, raw);
  assert.equal(p.toApiMessages(h, { stripThinking: true })[1].content.length, 1);
});

test('OpenAI conversion: native and json tool modes', () => {
  const p = new OpenAICompatProvider({ model: 'm' });
  const tools = [{ name: 'collect_block', description: 'd', params: { type: 'object', properties: { block: { type: 'string' } }, required: ['block'] } }];
  const native = p.toApiMessages('SYS', history, 'native', tools);
  assert.equal(native[2].tool_calls[0].function.name, 'collect_block');
  assert.equal(native[3].role, 'tool');
  const json = p.toApiMessages('SYS', history, 'json', tools);
  assert.match(json[0].content, /tool_calls/);
  assert.ok(json.every((m) => m.role !== 'tool'));
  // tool results + status merge into one user message
  assert.equal(json.at(-1).role, 'user');
  assert.match(json.at(-1).content, /Tool results/);
});

test('MemoryStore persists facts and places', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-'));
  const m = await new MemoryStore('Bob', dir).load();
  const id = m.addFact('Owner likes spruce');
  m.addFact('owner likes spruce'); // duplicate ignored
  m.setPlace('Base', { x: 1.4, y: 64, z: -3 });
  await m.save();
  const m2 = await new MemoryStore('Bob', dir).load();
  assert.equal(m2.data.facts.length, 1);
  assert.equal(m2.getPlace('base').x, 1);
  assert.match(m2.toPromptText(), /spruce/);
  assert.ok(m2.removeFact(String(id)));
  assert.equal(m2.data.facts.length, 0);
});

test('deepMerge replaces arrays and merges objects', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, l: [1] }, { a: { c: 3 }, l: [2] }), { a: { b: 1, c: 3 }, l: [2] });
});

test('SettingsManager first run, save and characters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-'));
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(path.join(root, 'config', 'settings.default.json'), JSON.stringify({ server: { port: 1 }, characters: ['Alpha_1'] }));
  const sm = await new SettingsManager(root).load();
  assert.equal(sm.characters.Alpha_1.username, 'Alpha_1');
  await sm.saveSettings({ server: { port: 2 } });
  await sm.saveCharacter({ name: 'Beta_2', personality: 'grumpy' });
  const sm2 = await new SettingsManager(root).load();
  assert.equal(sm2.settings.server.port, 2);
  assert.deepEqual(sm2.settings.characters, ['Alpha_1', 'Beta_2']);
  await assert.rejects(sm2.saveCharacter({ name: '../evil' }));
  await sm2.setSecret('anthropicApiKey', 'k');
  assert.deepEqual(sm2.secretsStatus(), { anthropicApiKey: true, lmstudioApiKey: false });
});
