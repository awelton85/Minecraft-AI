// End-to-end test of the whole stack (settings -> manager -> runner -> agent -> skills) against a
// local Minecraft server, using a scripted fake LLM so no API key is needed.
//   MC_HOST=127.0.0.1 MC_PORT=25565 MC_CONSOLE="<cmd to run a server console command>" node test/agent.e2e.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { SettingsManager } from '../src/config.js';
import { BotManager } from '../src/bot/BotManager.js';
import { Agent } from '../src/agent/Agent.js';
import { log } from '../src/log.js';

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25565);
const consoleCmd = (c) => process.env.MC_CONSOLE && execSync(`${process.env.MC_CONSOLE} ${JSON.stringify(c)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };

// ---- scripted LLM: replies are chosen by looking at the latest user message
const calls = [];
class ScriptedProvider {
  constructor() { this.name = 'scripted'; this.model = 'script'; this.maxContextChars = 1e9; }
  async chat({ system, messages, tools, toolChoice }) {
    calls.push({ system, messages: structuredClone(messages), tools: tools.map((t) => t.name), toolChoice });
    const last = messages.at(-1);
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    const id = () => `call_${calls.length}_${Math.random().toString(36).slice(2, 6)}`;
    if (toolChoice === 'none') return { text: 'SUMMARY: tested things.', toolCalls: [], raw: {}, stopReason: 'end_turn' };
    if (last.role === 'user' && /says: "get wood"/.test(lastUser)) {
      return { text: 'Owner wants wood.', toolCalls: [{ id: id(), name: 'chat', args: { text: 'On it!' } }, { id: id(), name: 'collect_block', args: { block: 'log', count: 2 } }], raw: {}, stopReason: 'tool_use' };
    }
    if (last.role === 'user' && /says: "bad tool"/.test(lastUser)) {
      return { text: '', toolCalls: [{ id: id(), name: 'go_to', args: { x: 0, y: -500, z: 0 } }], raw: {}, stopReason: 'tool_use' };
    }
    if (last.role === 'user' && /says: "walk far"/.test(lastUser)) {
      return { text: '', toolCalls: [{ id: id(), name: 'explore', args: { distance: 200 } }], raw: {}, stopReason: 'tool_use' };
    }
    if (last.role === 'user' && /says: "remember"/.test(lastUser)) {
      return { text: '', toolCalls: [{ id: id(), name: 'remember', args: { fact: 'The tester likes birch' } }], raw: {}, stopReason: 'tool_use' };
    }
    return { text: 'Done for now.', toolCalls: [], raw: {}, stopReason: 'end_turn' };
  }
  async test() { return 'ok'; }
}
Agent.prototype.getProvider = function () { this.provider ||= new ScriptedProvider(); return this.provider; };

// ---- isolated config
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcai-e2e-'));
await fs.mkdir(path.join(root, 'config', 'characters'), { recursive: true });
const defaults = JSON.parse(await fs.readFile(new URL('../config/settings.default.json', import.meta.url), 'utf8'));
defaults.server = { host: HOST, port: PORT, version: 'auto', auth: 'offline' };
defaults.owners = ['Tester'];
defaults.agent.autonomous = false;
defaults.reconnect = { enabled: true, initialDelaySeconds: 1, maxDelaySeconds: 5 };
defaults.characters = ['E2E_Bot'];
defaults.web.enabled = false;
await fs.writeFile(path.join(root, 'config', 'settings.default.json'), JSON.stringify(defaults));
log.consoleLevel = process.env.LOG_LEVEL || 'info';

const sm = await new SettingsManager(root).load();
const manager = new BotManager({ settingsManager: sm, log, rootDir: root });
const chats = [];
manager.on('chat', (c) => chats.push(c));
if (process.env.SHOW_THOUGHTS) manager.on('thought', (t) => console.log('   thought:', t.text.slice(0, 300)));
await manager.startAll();
const runner = await manager.getRunner('E2E_Bot');
const waitFor = async (fn, ms, step = 250) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; };

check('connects and spawns', await waitFor(() => runner.isReady(), 30000));
const logCount = () => runner.bot?.inventory.items().filter((i) => i.name.endsWith('_log')).reduce((a, i) => a + i.count, 0) || 0;
consoleCmd('clear E2E_Bot');
if (process.env.E2E_START) consoleCmd(`tp E2E_Bot ${process.env.E2E_START}`); // e.g. "4.5 94 -3.5": a known open spot
check('inventory cleared', await waitFor(() => logCount() === 0, 10000));

// 1. a chat command flows through the agent into skills
manager.sendMessage('E2E_Bot', 'get wood');
check('collects wood on request', await waitFor(() => logCount() >= 2, 120000), `logs=${logCount()}`);
check('bot spoke in chat', await waitFor(() => chats.some((c) => c.from === 'E2E_Bot' && /On it/.test(c.text)), 10000));
const first = calls.find((c) => c.messages.some((m) => m.role === 'user' && /get wood/.test(m.content)));
check('system prompt mentions owner + memory', first && /Tester/.test(first.system) && /memory/i.test(first.system));
check('observation included', first && /SURROUNDINGS/.test(first.messages.at(-1).content));
await waitFor(() => !runner.agent.thinking, 20000);

// 2. failures are reported back to the model, not thrown
manager.sendMessage('E2E_Bot', 'bad tool');
await waitFor(() => calls.some((c) => c.messages.some((m) => m.role === 'tool' && m.results.some((r) => r.name === 'go_to'))), 60000);
const toolMsg = calls.flatMap((c) => c.messages).find((m) => m.role === 'tool' && m.results.some((r) => r.name === 'go_to'));
check('failed skill returns isError result', toolMsg?.results[0].isError === true, toolMsg?.results[0].content.slice(0, 100));
await waitFor(() => !runner.agent.thinking, 20000);

// 3. "stop" aborts a long interruptible action quickly
manager.sendMessage('E2E_Bot', 'walk far');
await waitFor(() => runner.agent.currentAction?.name === 'explore', 20000);
await sleep(2000);
const t0 = Date.now();
manager.sendMessage('E2E_Bot', 'stop');
const stopped = await waitFor(() => !runner.agent.currentAction, 5000, 50);
check('stop aborts current action', stopped, `${Date.now() - t0}ms`);
await waitFor(() => !runner.agent.thinking, 20000);

// 4. memory tool persists
manager.sendMessage('E2E_Bot', 'remember');
check('remember writes memory', await waitFor(() => runner.memory.data.facts.some((f) => /birch/.test(f.text)), 30000));

// 5. auto-reconnect after a kick
if (process.env.MC_CONSOLE) {
  consoleCmd('kick E2E_Bot testing reconnect');
  check('notices disconnect', await waitFor(() => !runner.isReady(), 10000));
  check('reconnects automatically', await waitFor(() => runner.isReady(), 30000), `attempts=${runner.reconnectAttempts}`);
}

// 6. compaction replaces history with a summary stored in memory
await waitFor(() => !runner.agent.thinking, 20000);
const before = runner.agent.history.length;
await runner.agent.compact('test');
check('compaction summarises into memory', runner.agent.history.length === 0 && runner.memory.data.sessionSummaries.some((s) => /SUMMARY/.test(s.text)), `history ${before} -> ${runner.agent.history.length}`);

await manager.shutdown();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
