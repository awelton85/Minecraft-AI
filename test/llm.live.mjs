// Live test with a REAL model: an owner asks the bot for logs and we check it actually gets them.
// Uses whatever provider/model is configured below; needs a running Minecraft server and LLM.
//   LMSTUDIO_URL=http://127.0.0.1:1234/v1 MC_PORT=25565 node test/llm.live.mjs
//   PROVIDER=anthropic ANTHROPIC_API_KEY=... node test/llm.live.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsManager } from '../src/config.js';
import { BotManager } from '../src/bot/BotManager.js';
import { log } from '../src/log.js';

const provider = process.env.PROVIDER || 'lmstudio';
const timeoutMin = Number(process.env.TIMEOUT_MIN || 15);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcai-live-'));
await fs.mkdir(path.join(root, 'config', 'characters'), { recursive: true });
const defaults = JSON.parse(await fs.readFile(new URL('../config/settings.default.json', import.meta.url), 'utf8'));
Object.assign(defaults, {
  server: { host: process.env.MC_HOST || '127.0.0.1', port: Number(process.env.MC_PORT || 25565), version: 'auto', auth: 'offline' },
  owners: ['Tester'],
  characters: ['Live_Bot'],
});
defaults.web.enabled = false;
defaults.agent.autonomous = false;
defaults.llm.provider = provider;
defaults.llm.lmstudio.baseUrl = process.env.LMSTUDIO_URL || defaults.llm.lmstudio.baseUrl;
defaults.llm.lmstudio.toolMode = process.env.TOOL_MODE || 'auto';
await fs.writeFile(path.join(root, 'config', 'settings.default.json'), JSON.stringify(defaults));

const sm = await new SettingsManager(root).load();
const manager = new BotManager({ settingsManager: sm, log, rootDir: root });
manager.on('thought', (t) => console.log('   thought:', t.text.slice(0, 240).replace(/\n/g, ' ')));
manager.on('chat', (c) => console.log(`   chat <${c.from}> ${c.text}`));
await manager.startAll();
const runner = await manager.getRunner('Live_Bot');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(500); } return false; };

if (!(await waitFor(() => runner.isReady(), 30_000))) { console.log('FAIL could not connect'); process.exit(1); }
const logs = () => runner.bot.inventory.items().filter((i) => i.name.endsWith('_log')).reduce((a, i) => a + i.count, 0);
const before = logs();
const t0 = Date.now();
manager.sendMessage('Live_Bot', process.env.REQUEST || 'Please collect 2 logs from the nearest tree.');
const ok = await waitFor(() => logs() >= before + 2, timeoutMin * 60_000);
console.log(`${ok ? 'PASS' : 'FAIL'} real model fulfilled the request (logs ${before} -> ${logs()}) in ${Math.round((Date.now() - t0) / 1000)}s`);
await manager.shutdown();
process.exit(ok ? 0 : 1);
