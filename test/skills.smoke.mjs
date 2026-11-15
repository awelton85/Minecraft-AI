// End-to-end smoke script for the skills library. NOT a unit test: it needs a running Minecraft server
// (offline mode) and, for full coverage, op access via the server console (see MC_CONSOLE below).
//
//   node test/skills.smoke.mjs [testName ...]
//
// env: MC_HOST (127.0.0.1) MC_PORT (25565) MC_CONSOLE (path to a script that sends a server console command,
//      e.g. "/path/mc.sh"); tests that need console commands are skipped when it is not set.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import collectBlock from 'mineflayer-collectblock';
import pvp from 'mineflayer-pvp';
import tool from 'mineflayer-tool';
import { loader as autoEat } from 'mineflayer-auto-eat';
import armorManager from 'mineflayer-armor-manager';
import minecraftData from 'minecraft-data';
import { skills, getSkill, describeState } from '../src/skills/index.js';
import { SkillError } from '../src/skills/util.js';

const execFileP = promisify(execFile);
const HOST = process.env.MC_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MC_PORT ?? 25565);
const CONSOLE = process.env.MC_CONSOLE ?? '';

export async function mc(cmd) {
  if (!CONSOLE) throw new Error('MC_CONSOLE not set');
  await execFileP(CONSOLE, [cmd]);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal in-memory MemoryStore (contract in docs/ARCHITECTURE.md). */
export class FakeMemory {
  constructor() { this.data = { facts: [], places: {} }; this.n = 0; }
  addFact(text) { const id = `f${++this.n}`; this.data.facts.push({ id, text }); return id; }
  removeFact(k) { const i = this.data.facts.findIndex((f) => f.id === k || f.text === k); if (i < 0) return false; this.data.facts.splice(i, 1); return true; }
  setPlace(name, p) { this.data.places[name.toLowerCase()] = { name, ...p }; }
  getPlace(name) { return this.data.places[String(name).toLowerCase()]; }
  listPlaces() { return Object.values(this.data.places); }
  removePlace(name) { return delete this.data.places[String(name).toLowerCase()]; }
  addSessionSummary() {}
  recordDeath() {}
  toPromptText() { return ''; }
}

/** Create a bot the way BotRunner is expected to: plugins loaded, Movements configured. */
export async function makeBot(username) {
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username, auth: 'offline', version: process.env.MC_VERSION || undefined });
  bot.loadPlugin(pf.pathfinder);
  bot.loadPlugin(collectBlock.plugin);
  bot.loadPlugin(pvp.plugin);
  bot.loadPlugin(tool.plugin);
  bot.loadPlugin(autoEat);
  bot.loadPlugin(armorManager);
  bot.on('error', (e) => console.log(`[${username}] error`, e.message));
  bot.on('kicked', (r) => console.log(`[${username}] kicked`, JSON.stringify(r)));
  await new Promise((res, rej) => {
    bot.once('spawn', res);
    bot.once('error', rej);
    setTimeout(() => rej(new Error('spawn timeout')), 30000);
  });
  const mcData = minecraftData(bot.version);
  const movements = new pf.Movements(bot);
  bot.pathfinder.setMovements(movements);
  bot.pvp.movements = movements; // otherwise pvp installs its own Movements
  bot.autoEat.enableAuto?.();
  await sleep(1500);
  return { bot, mcData, movements };
}

export function makeCtx(bot, mcData, extra = {}) {
  const ac = new AbortController();
  const ctx = {
    bot, mcData,
    get signal() { return ctx._ac.signal; },
    _ac: ac,
    log: (m) => { if (process.env.DEBUG) console.log('   [log]', m); },
    say: async (t) => { bot.chat(t); },
    memory: new FakeMemory(),
    settings: { agent: { stuckSeconds: 12, actionTimeoutSeconds: 180 } },
    character: { name: bot.username },
    manager: { botUsernames: () => [bot.username] },
    abort() { ctx._ac.abort(); },
    reset() { ctx._ac = new AbortController(); },
    ...extra,
  };
  return ctx;
}

const results = [];
export async function run(ctx, name, args = {}) {
  const t0 = Date.now();
  const skill = getSkill(name);
  if (!skill) throw new Error(`no such skill ${name}`);
  try {
    const out = await skill.run(ctx, args);
    console.log(`  ok   ${name}(${JSON.stringify(args)}) [${Date.now() - t0}ms] -> ${String(out).slice(0, 300)}`);
    return { ok: true, out };
  } catch (err) {
    console.log(`  fail ${name}(${JSON.stringify(args)}) [${Date.now() - t0}ms] -> ${err instanceof SkillError ? 'SkillError: ' : err.stack}${err.message}`);
    return { ok: false, err };
  }
}
export function check(name, cond, info = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' - ' + info : ''}`);
}

export { skills, getSkill, describeState, SkillError, pf };
export { results };
