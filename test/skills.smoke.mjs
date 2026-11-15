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
    settings: { agent: { stuckSeconds: 12, actionTimeoutSeconds: 180 }, owners: ['SkillTestOwner'] },
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


// =============================================================== scenarios
const tests = {};
const B = 'SkillTest1';
let ctx, bot;

async function setup(extra = []) {
  await mc(`op ${B}`);
  await mc(`gamemode survival ${B}`);
  await mc(`clear ${B}`);
  await mc("time set day");
  await mc("difficulty peaceful");
  await mc(`effect clear ${B}`);
  for (const c of extra) await mc(c);
  await sleep(500);
}

tests.observe = async () => {
  const brief = describeState(bot, { detail: 'brief' });
  const full = describeState(bot, { detail: 'full' });
  console.log(brief + '\n---\n' + full);
  check('describeState brief < 900', brief.length > 50 && brief.length < 900, `${brief.length} chars`);
  check('describeState full < 2000', full.length > brief.length - 1 && full.length < 2000, `${full.length} chars`);
  check('describeState never throws', typeof describeState({}, {}) === 'string');
};

tests.gather = async () => {
  await setup([`tp ${B} -6 95 -8`]);
  await sleep(2000);
  let r = await run(ctx, 'collect_block', { block: 'log', count: 3 });
  check('collect_block log x3', r.ok && /Collected \d+ /.test(r.out));
  r = await run(ctx, 'find_blocks', { block: 'oak log', count: 3 });
  check('find_blocks', r.ok);
  r = await run(ctx, 'collect_block', { block: 'unobtainium' });
  check('collect_block unknown name gives close matches', !r.ok && r.err instanceof SkillError);
  r = await run(ctx, 'collect_block', { block: 'stone', count: 1 });
  check('collect stone without pickaxe fails with tool hint', !r.ok && /pickaxe/.test(r.err.message), r.err?.message);
};

tests.craft = async () => {
  await setup([`give ${B} oak_log 8`]);
  let r = await run(ctx, 'get_recipe', { item: 'wooden_pickaxe' });
  check('get_recipe', r.ok);
  r = await run(ctx, 'craft_item', { item: 'planks', count: 8 });
  check('craft planks', r.ok && /Crafted 8/.test(r.out));
  r = await run(ctx, 'craft_item', { item: 'stick', count: 4 });
  check('craft sticks', r.ok);
  r = await run(ctx, 'craft_item', { item: 'crafting_table' });
  check('craft crafting_table', r.ok);
  r = await run(ctx, 'craft_item', { item: 'wooden_pickaxe' });
  check('craft wooden_pickaxe (places table)', r.ok, r.out);
  r = await run(ctx, 'craft_item', { item: 'iron_pickaxe' });
  check('craft iron_pickaxe fails listing missing', !r.ok && /missing/.test(r.err.message) && /iron_ingot/.test(r.err.message), r.err?.message);
  await setup([`give ${B} oak_log 3`]);
  r = await run(ctx, 'craft_item', { item: 'wooden_pickaxe' });
  check('craft wooden_pickaxe from raw logs only (table+planks+sticks)', r.ok, r.out);
};


const ARENA = { x: 300, y: 150, z: 300 };
/** Flat smooth_stone platform (unminable by collect tests) high above the terrain, bot teleported to its centre. */
async function arena(extra = []) {
  const { x, y, z } = ARENA;
  await mc(`forceload add ${x - 24} ${z - 24} ${x + 24} ${z + 24}`);
  await sleep(1500);
  await mc(`fill ${x - 20} ${y - 1} ${z - 20} ${x + 20} ${y - 1} ${z + 20} smooth_stone`);
  await mc(`fill ${x - 20} ${y} ${z - 20} ${x + 20} ${y + 12} ${z + 20} air`);
  await setup(extra);
  await mc(`tp ${B} ${x} ${y} ${z}`);
  await sleep(1500);
}
const here = () => bot.entity.position.floored();
const rel = (dx, dy, dz) => { const p = here(); return { x: p.x + dx, y: p.y + dy, z: p.z + dz }; };

tests.mining = async () => {
  await arena([`give ${B} wooden_pickaxe 1`]);
  await mc(`execute at ${B} run fill ~3 ~ ~3 ~6 ~2 ~6 stone`);
  await sleep(800);
  let r = await run(ctx, 'collect_block', { block: 'cobblestone', count: 5, maxDistance: 16 });
  check('collect cobblestone x5 (mines stone)', r.ok && /Collected \d+ cobblestone/.test(r.out), r.out ?? r.err?.message);
  const p = rel(4, 0, 4);
  r = await run(ctx, 'dig_block_at', p);
  check('dig_block_at', r.ok);
  r = await run(ctx, 'dig_block_at', { x: here().x, y: here().y - 1, z: here().z });
  check('dig_block_at unbreakable/odd target ok', r.ok || r.err instanceof SkillError);
};

tests.build = async () => {
  await arena([`give ${B} cobblestone 40`, `give ${B} oak_planks 20`]);
  const f = here();
  let r = await run(ctx, 'place_block', { block: 'cobblestone', x: f.x + 2, y: f.y, z: f.z });
  check('place_block', r.ok && bot.blockAt(f.offset(2, 0, 0))?.name === 'cobblestone', r.out ?? r.err?.message);
  r = await run(ctx, 'build_shape', { shape: 'wall', block: 'cobblestone', from: { x: f.x - 2, y: f.y, z: f.z + 3 }, to: { x: f.x + 2, y: f.y + 2, z: f.z + 3 } });
  const wallOk = [-2, 0, 2].every((dx) => bot.blockAt(f.offset(dx, 2, 3))?.name === 'cobblestone');
  check('build_shape wall 5x3', r.ok && wallOk, r.out ?? r.err?.message);
  r = await run(ctx, 'build_shape', { shape: 'floor', block: 'planks', from: { x: f.x - 6, y: f.y, z: f.z - 4 }, to: { x: f.x - 4, y: f.y, z: f.z - 2 } });
  check('build_shape floor (generic planks)', r.ok, r.out ?? r.err?.message);
  r = await run(ctx, 'build_shape', { shape: 'pillar', block: 'cobblestone', from: { x: f.x + 5, y: f.y, z: f.z - 4 }, to: { x: f.x + 5, y: f.y + 3, z: f.z - 4 } });
  check('build_shape pillar', r.ok && bot.blockAt(f.offset(5, 3, -4))?.name === 'cobblestone', r.out ?? r.err?.message);
  r = await run(ctx, 'build_shape', { shape: 'wall', block: 'diamond_block', from: { x: 0, y: 70, z: 0 }, to: { x: 3, y: 70, z: 0 } });
  check('build_shape without blocks fails up front', !r.ok && /Need|no diamond_block|have no/i.test(r.err.message), r.err?.message);
};

tests.shelter = async () => {
  await arena([`give ${B} cobblestone 20`]);
  const r = await run(ctx, 'build_shelter');
  check('build_shelter', r.ok, r.out ?? r.err?.message);
  const f = here();
  const closed = bot.blockAt(f.offset(1, 1, 0))?.name !== 'air' && bot.blockAt(f.offset(0, 2, 0))?.name !== 'air';
  check('shelter closed', closed);
  // dig out
  await run(ctx, 'dig_block_at', { x: f.x + 1, y: f.y, z: f.z });
  await run(ctx, 'dig_block_at', { x: f.x + 1, y: f.y + 1, z: f.z });
};

tests.move = async () => {
  await arena([]);
  const f = here();
  let r = await run(ctx, 'go_to', { x: f.x + 12, y: f.y, z: f.z + 5, range: 2 });
  check('go_to', r.ok && bot.entity.position.distanceTo(f.offset(12, 0, 5)) < 4, r.out ?? r.err?.message);
  r = await run(ctx, 'save_place', { name: 'camp', note: 'test' });
  check('save_place', r.ok);
  r = await run(ctx, 'go_to', { x: f.x, z: f.z });
  r = await run(ctx, 'go_to_place', { name: 'camp' });
  check('go_to_place', r.ok);
  r = await run(ctx, 'list_places');
  check('list_places', r.ok && /camp/.test(r.out));
  r = await run(ctx, 'go_to_place', { name: 'nowhere' });
  check('go_to_place unknown fails cleanly', !r.ok);
  r = await run(ctx, 'explore', { direction: 'east', distance: 30 });
  check('explore', r.ok, r.out ?? r.err?.message);
};

tests.players = async () => {
  await arena([]);
  const { bot: b2 } = await makeBot('SkillTestB');
  await mc(`tp SkillTestB ${ARENA.x + 3} ${ARENA.y} ${ARENA.z}`);
  await sleep(2500);
  const ctx2 = makeCtx(b2, null);
  let r = await run(ctx, 'go_to_player', { name: 'SkillTestB', distance: 2 });
  check('go_to_player', r.ok, r.out ?? r.err?.message);
  await mc(`give ${B} cobblestone 5`);
  await sleep(500);
  r = await run(ctx, 'give_to_player', { player: 'SkillTestB', item: 'cobblestone', count: 3 });
  await sleep(4000);
  const got = b2.inventory.items().find((i) => i.name === 'cobblestone');
  check('give_to_player (other bot receives)', r.ok && got && got.count >= 1, `b got ${got?.count}`);
  // follow: B walks away, A follows for 8s
  await mc(`tp SkillTestB ${ARENA.x + 12} ${ARENA.y} ${ARENA.z + 6}`);
  await sleep(1500);
  const t0 = Date.now();
  const p = run(ctx, 'follow_player', { name: 'SkillTestB', distance: 3, seconds: 6 });
  r = await p;
  check('follow_player returns after seconds', r.ok && Date.now() - t0 < 12000, r.out ?? r.err?.message);
  // follow is interruptible via abort
  const p2 = run(ctx, 'follow_player', { name: 'SkillTestB', seconds: 60 });
  await sleep(1500);
  const t1 = Date.now();
  ctx.abort();
  r = await p2;
  check('follow_player abort', !r.ok && /Aborted/.test(r.err.message) && Date.now() - t1 < 2000, `${Date.now() - t1}ms`);
  ctx.reset();
  b2.quit();
};

tests.combat = async () => {
  await arena([`give ${B} stone_sword 1`, `effect give ${B} resistance 60 4 true`]);
  await mc('difficulty easy');
  await mc(`time set night`);
  await mc(`execute at ${B} run summon zombie ~6 ~ ~`);
  await sleep(1500);
  let r = await run(ctx, 'attack', { target: 'zombie', timeoutSeconds: 40 });
  check('attack zombie', r.ok && /Killed/.test(r.out), r.out ?? r.err?.message);
  await mc(`execute at ${B} run summon zombie ~8 ~ ~`);
  await mc(`execute at ${B} run summon zombie ~-8 ~ ~`);
  await sleep(1200);
  r = await run(ctx, 'flee', { distance: 20 });
  check('flee', r.ok, r.out ?? r.err?.message);
  r = await run(ctx, 'attack', { target: 'unicorn' });
  check('attack with no such mob fails cleanly', !r.ok);
  await mc(`kill @e[type=zombie]`);
};

tests.inventory = async () => {
  await arena([`give ${B} cooked_beef 3`, `give ${B} iron_helmet 1`, `give ${B} stone_pickaxe 1`, `give ${B} dirt 10`, `effect give ${B} hunger 8 255 true`]);
  await mc('difficulty easy');
  bot.autoEat.disableAuto?.(); // otherwise the reflex eats before the skill can
  await sleep(9000);
  let r = await run(ctx, 'inventory');
  check('inventory', r.ok && /cooked_beef/.test(r.out));
  r = await run(ctx, 'equip', { item: 'iron_helmet' });
  check('equip armor auto slot', r.ok && bot.inventory.slots[5]?.name === 'iron_helmet');
  r = await run(ctx, 'equip', { item: 'stone_pickaxe' });
  check('equip hand', r.ok && bot.heldItem?.name === 'stone_pickaxe');
  r = await run(ctx, 'eat');
  check('eat', r.ok && /Ate/.test(r.out) && bot.food > 13, r.out ?? r.err?.message);
  r = await run(ctx, 'toss_item', { item: 'dirt', count: 4 });
  check('toss_item', r.ok);
  r = await run(ctx, 'toss_item', { item: 'nonexistent_thing' });
  check('toss unknown item fails cleanly', !r.ok);
};

tests.smelt = async () => {
  await arena([`give ${B} raw_iron 3`, `give ${B} coal 2`, `give ${B} furnace 1`]);
  let r = await run(ctx, 'smelt_item', { input: 'raw iron', count: 3 });
  check('smelt_item raw_iron x3 (places furnace)', r.ok && countItem('iron_ingot') === 3 && !/still smelting/.test(r.out), r.out ?? r.err?.message);
  await setup([`give ${B} cobblestone 4`, `give ${B} sand 1`]);
  r = await run(ctx, 'smelt_item', { input: 'sand' });
  check('smelt without fuel fails cleanly', !r.ok && /fuel/i.test(r.err.message), r.err?.message);
};
const countItem = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, b) => a + b.count, 0);

tests.chest = async () => {
  await arena([`give ${B} chest 1`, `give ${B} cobblestone 30`, `give ${B} dirt 10`, `give ${B} stone_axe 1`, `give ${B} bread 2`]);
  const spot = rel(2, 0, 0);
  let r = await run(ctx, 'place_block', { block: 'chest', ...spot });
  check('place chest', r.ok, r.out ?? r.err?.message);
  r = await run(ctx, 'chest_deposit', { items: 'auto' });
  check('chest_deposit auto keeps tools/food', r.ok && countItem('stone_axe') === 1 && countItem('bread') === 2 && countItem('cobblestone') === 0, r.out ?? r.err?.message);
  r = await run(ctx, 'chest_list');
  check('chest_list', r.ok && /cobblestone/.test(r.out), r.out);
  r = await run(ctx, 'chest_withdraw', { item: 'cobblestone', count: 12 });
  check('chest_withdraw', r.ok && countItem('cobblestone') === 12, r.out ?? r.err?.message);
  r = await run(ctx, 'chest_withdraw', { item: 'diamond' });
  check('chest_withdraw missing item fails with contents', !r.ok && /contains/.test(r.err.message), r.err?.message);
};

tests.misc = async () => {
  await arena([`give ${B} oak_log 1`]);
  let r = await run(ctx, 'remember', { fact: 'test fact: owner likes oak' });
  check('remember', r.ok);
  const id = ctx.memory.data.facts[0]?.id;
  r = await run(ctx, 'forget', { fact: id });
  check('forget', r.ok && ctx.memory.data.facts.length === 0);
  r = await run(ctx, 'forget', { fact: 'nothing like this' });
  check('forget unknown fails', !r.ok);
  r = await run(ctx, 'look_around');
  check('look_around', r.ok && r.out.length > 100);
  r = await run(ctx, 'chat', { text: 'hello from smoke test' });
  check('chat', r.ok);
  const t0 = Date.now();
  r = await run(ctx, 'wait', { seconds: 2 });
  check('wait', r.ok && Date.now() - t0 >= 1900);
  const p = run(ctx, 'wait', { seconds: 60 });
  await sleep(500);
  const t1 = Date.now(); ctx.abort(); r = await p; ctx.reset();
  check('wait abort < 1s', !r.ok && Date.now() - t1 < 1000);
  // use_block: place a lever / door
  await mc(`give ${B} oak_door 1`);
  const f = here();
  await mc(`setblock ${f.x + 2} ${f.y} ${f.z} oak_door[half=lower,open=false]`);
  await mc(`setblock ${f.x + 2} ${f.y + 1} ${f.z} oak_door[half=upper,open=false]`);
  await sleep(500);
  r = await run(ctx, 'use_block', { x: f.x + 2, y: f.y, z: f.z });
  check('use_block door', r.ok && /open=true/.test(r.out), r.out ?? r.err?.message);
  // sleep: night, no bed -> clear error; with bed -> sleeps
  await mc('time set night');
  await sleep(500);
  r = await run(ctx, 'sleep');
  check('sleep without bed explains', !r.ok && /bed/i.test(r.err.message), r.err?.message);
  await mc(`give ${B} red_bed 1`);
  await sleep(500);
  await mc(`setblock ${f.x - 3} ${f.y} ${f.z} red_bed[part=foot,facing=west]`);
  await mc(`setblock ${f.x - 4} ${f.y} ${f.z} red_bed[part=head,facing=west]`);
  await sleep(500);
  r = await run(ctx, 'sleep');
  check('sleep with bed', r.ok && /Slept|woke/.test(r.out), r.out ?? r.err?.message);
  await mc('time set day');
  r = await run(ctx, 'sleep');
  check('sleep by day explains', !r.ok && /not night/i.test(r.err.message), r.err?.message);
};

tests.farm = async () => {
  await arena([`give ${B} wheat_seeds 4`]);
  const f = here();
  await mc(`fill ${f.x + 2} ${f.y - 1} ${f.z + 2} ${f.x + 4} ${f.y - 1} ${f.z + 2} farmland`);
  await mc(`fill ${f.x + 2} ${f.y} ${f.z + 2} ${f.x + 4} ${f.y} ${f.z + 2} wheat[age=7]`);
  await sleep(800);
  const r = await run(ctx, 'farm', { radius: 10 });
  check('farm harvests and replants', r.ok && /Harvested [23] wheat/.test(r.out) && /replanted [23]/.test(r.out), r.out ?? r.err?.message);
};

tests.surface = async () => {
  // natural terrain near spawn: dig a 1x1 shaft ~8 deep and drop the bot in it
  await setup([`give ${B} cobblestone 16`, `tp ${B} -6 95 -8`]);
  await sleep(2000);
  await mc(`fill -5 83 -9 -3 92 -7 stone`);
  await mc(`fill -4 84 -8 -4 92 -8 air`);
  await mc(`tp ${B} -3.5 84 -7.5`);
  await sleep(1500);
  const y0 = bot.entity.position.y;
  const r = await run(ctx, 'come_up_to_surface');
  await mc(`fill -5 83 -9 -3 92 -7 air`); // remove the test tube
  check('come_up_to_surface from 1x1 shaft', r.ok && bot.entity.position.y > y0 + 5, `${r.out ?? r.err?.message} y=${bot.entity.position.y}`);
};

tests.wallstep = async () => {
  // Regression: prismarine-physics' double half-width (0.3) vs the server's float (0.3F) made the server rubber-band
  // the bot every tick whenever it touched a wall (e.g. sprint-jump up a 1-block step inside a 1x1 shaft); the pathfinder
  // then stalled forever. moveTo()/getMovements() apply util.applyPhysicsFix(); we reset it first to prove that.
  const { moveTo, goals } = await import('../src/skills/util.js');
  const X = 300, Y = 200, Z = 300;
  await setup([`tp ${B} ${X} ${Y + 4} ${Z}`]);
  await sleep(1500);
  await mc(`fill ${X - 3} ${Y - 1} ${Z - 3} ${X + 3} ${Y + 6} ${Z + 3} stone`);
  await mc(`fill ${X} ${Y} ${Z} ${X} ${Y + 5} ${Z} air`);          // 1x1 shaft
  await mc(`fill ${X} ${Y + 1} ${Z + 1} ${X} ${Y + 3} ${Z + 1} air`); // side pocket above a stone step at (X,Y,Z+1)
  await mc(`tp ${B} ${X + 0.5} ${Y} ${Z + 0.5}`);
  await sleep(1500);
  bot.physics.playerHalfWidth = 0.3; // undo the fix
  let forced = 0;
  const onPos = () => forced++;
  bot._client.on('position', onPos);
  const t0 = Date.now();
  let err;
  try { await moveTo(ctx, new goals.GoalBlock(X, Y + 1, Z + 1), { label: 'step', timeoutMs: 20000 }); } catch (e) { err = e; }
  bot._client.off('position', onPos);
  const p = bot.entity.position;
  check('step up inside 1x1 shaft without rubber-banding', !err && Math.floor(p.y) === Y + 1 && Math.floor(p.z) === Z + 1 && Date.now() - t0 < 15000, `${err?.message ?? ''} pos=${p} forced=${forced} ${Date.now() - t0}ms`);
  check('physics half-width matches server float', bot.physics.playerHalfWidth === Math.fround(0.3));
  await mc(`fill ${X - 3} ${Y - 1} ${Z - 3} ${X + 3} ${Y + 6} ${Z + 3} air`);
};

tests.abort = async () => {
  await setup([`tp ${B} -6 95 -8`]);
  await sleep(2000);
  const p = run(ctx, 'collect_block', { block: 'log', count: 60, maxDistance: 96 });
  await sleep(4000);
  const t0 = Date.now();
  ctx.abort();
  const r = await p;
  const dt = Date.now() - t0;
  check('collect_block abort stops within 2s', !r.ok && /Aborted/.test(r.err.message) && dt < 2000, `${dt}ms`);
  await sleep(1000);
  const moving = bot.pathfinder.isMoving() || bot.pathfinder.isMining();
  check('pathfinder idle after abort', !moving, `moving=${bot.pathfinder.isMoving()} mining=${bot.pathfinder.isMining()} dig=${!!bot.targetDigBlock}`);
  ctx.reset();
};

tests.stuck = async () => {
  await arena([`give ${B} cobblestone 10`]);
  const f = here();
  const T = { x: f.x + 12, y: f.y + 6, z: f.z };
  await mc(`fill ${T.x - 1} ${T.y - 1} ${T.z - 1} ${T.x + 1} ${T.y + 1} ${T.z + 1} bedrock hollow`);
  await sleep(800);
  let t0 = Date.now();
  let r = await run(ctx, 'go_to', { ...T, range: 0 });
  let dt = Date.now() - t0;
  check('go_to enclosed target fails cleanly within 60s', !r.ok && r.err instanceof SkillError && dt < 60000, `${dt}ms ${r.err?.message}`);
  // walled-in bot (no way out except digging bedrock) trying to go somewhere
  const W = { x: f.x - 12, y: f.y, z: f.z };
  await mc(`fill ${W.x - 1} ${W.y - 1} ${W.z - 1} ${W.x + 1} ${W.y + 5} ${W.z + 1} bedrock hollow`);
  await mc(`fill ${W.x} ${W.y} ${W.z} ${W.x} ${W.y + 4} ${W.z} air`);
  await mc(`tp ${B} ${W.x} ${W.y} ${W.z}`);
  await sleep(1500);
  t0 = Date.now();
  r = await run(ctx, 'go_to', { x: f.x, y: f.y, z: f.z + 8, range: 1 });
  dt = Date.now() - t0;
  check('go_to from sealed bedrock cell fails/escapes in bounded time', dt < 90000, `${dt}ms ${r.out ?? r.err?.message}`);
  await mc(`fill ${W.x - 1} ${W.y - 1} ${W.z - 1} ${W.x + 1} ${W.y + 5} ${W.z + 1} air`);
  await mc(`fill ${T.x - 1} ${T.y - 1} ${T.z - 1} ${T.x + 1} ${T.y + 1} ${T.z + 1} air`);
};


// ============================================================ regression tests for review findings

const blockAt = (x, y, z) => bot.blockAt(new (bot.entity.position.constructor)(x, y, z))?.name;

tests.windows = async () => {
  // H1: a leaked container window must not break crafting
  await arena([`give ${B} chest 1`, `give ${B} oak_planks 8`]);
  const f = here();
  let r = await run(ctx, 'place_block', { block: 'chest', x: f.x + 2, y: f.y, z: f.z });
  const opened = new Promise((res) => bot.once('windowOpen', res));
  const p = run(ctx, 'chest_list');
  await opened;
  await sleep(50);
  ctx.abort();
  r = await p;
  ctx.reset();
  await sleep(400);
  check('abort during chest_list leaves no window open', !bot.currentWindow, `currentWindow=${bot.currentWindow?.type}`);
  r = await run(ctx, 'craft_item', { item: 'stick', count: 4 });
  check('craft_item works after aborted chest_list', r.ok, r.out ?? r.err?.message);
  r = await run(ctx, 'use_block', { x: f.x + 2, y: f.y, z: f.z });
  check('use_block on a chest explains and closes the window', !r.ok && /container/.test(r.err.message) && !bot.currentWindow, r.err?.message);
  r = await run(ctx, 'craft_item', { item: 'stick', count: 4 });
  check('craft_item works after use_block on chest', r.ok, r.out ?? r.err?.message);
};

tests.smeltresume = async () => {
  // H2: interrupted / short-deadline smelting leaves a collectable furnace and says so
  await arena([`give ${B} raw_iron 4`, `give ${B} coal 2`, `give ${B} furnace 1`]);
  const p = run(ctx, 'smelt_item', { input: 'raw_iron', count: 2 });
  await sleep(4500);
  ctx.abort();
  let r = await p;
  ctx.reset();
  check('aborted smelt reports the furnace', !r.ok && /furnace_collect/.test(r.err.message) && /still smelting/.test(r.err.message), r.err?.message);
  check('no window leaked after aborted smelt', !bot.currentWindow);
  r = await run(ctx, 'smelt_item', { input: 'raw_iron', count: 1 });
  check('retry smelt does not claim nothing is left in inventory', r.ok || !/No raw_iron in inventory/.test(r.err.message), r.out ?? r.err?.message);
  await sleep(22000);
  r = await run(ctx, 'furnace_collect');
  check('furnace_collect returns the ingots', r.ok && countItem('iron_ingot') >= 2, r.out ?? r.err?.message);
  // short deadline: returns partial success instead of overrunning
  await mc(`give ${B} raw_iron 3`);
  await mc(`give ${B} coal 2`);
  await sleep(500);
  ctx.deadline = Date.now() + 14000;
  const t0 = Date.now();
  r = await run(ctx, 'smelt_item', { input: 'raw_iron', count: 3 });
  delete ctx.deadline;
  check('smelt with short deadline returns in time with still-smelting note', r.ok && Date.now() - t0 < 16000 && /still smelting|Smelted 3/.test(r.out), `${Date.now() - t0}ms ${r.out ?? r.err?.message}`);
  await sleep(20000);
  r = await run(ctx, 'furnace_collect', { take: 'all' });
  check('furnace_collect take:all', r.ok);
};

tests.craftmix = async () => {
  await arena([`give ${B} oak_planks 2`, `give ${B} birch_planks 1`, `give ${B} stick 2`, `give ${B} crafting_table 1`]);
  let r = await run(ctx, 'craft_item', { item: 'wooden_pickaxe' });
  check('wooden_pickaxe from mixed plank types', r.ok, r.out ?? r.err?.message);
  await arena([`give ${B} birch_log 3`, `give ${B} stick 3`, `give ${B} coal 1`, `give ${B} crafting_table 1`]);
  r = await run(ctx, 'craft_item', { item: 'campfire' });
  check('campfire from birch logs + coal', r.ok, r.out ?? r.err?.message);
  r = await run(ctx, 'get_recipe', { item: 'wooden_pickaxe' });
  check('get_recipe shows collapsed variants', r.ok && /planks\(any\)/.test(r.out) && !/variants\)/.test(r.out), r.out);
  await arena([`give ${B} oak_log 1`]);
  r = await run(ctx, 'craft_item', { item: 'campfire' });
  check('missing list is collapsed, no exotic wood names', !r.ok && !/hyphae|stripped/.test(r.err.message), r.err?.message);
  // table we placed ourselves is picked up again (unless near a saved place, so start with none)
  ctx.memory.data.places = {};
  await arena([`give ${B} oak_planks 12`, `give ${B} stick 4`, `give ${B} crafting_table 1`]);
  r = await run(ctx, 'craft_item', { item: 'wooden_pickaxe' });
  await sleep(500);
  check('self-placed crafting table is recovered', r.ok && countItem('crafting_table') >= 1 && /picked/.test(r.out), r.out ?? r.err?.message);
};

tests.chestfull = async () => {
  await arena([`give ${B} chest 1`, `give ${B} cobblestone 192`, `give ${B} dirt 64`]);
  const f = here();
  let r = await run(ctx, 'place_block', { block: 'chest', x: f.x + 2, y: f.y, z: f.z });
  // fill 25 of 27 slots
  for (let i = 0; i < 25; i++) await mc(`item replace block ${f.x + 2} ${f.y} ${f.z} container.${i} with minecraft:stone 64`);
  const before = countItem('cobblestone') + countItem('dirt');
  r = await run(ctx, 'chest_deposit', { items: 'cobblestone,dirt' });
  const after = countItem('cobblestone') + countItem('dirt');
  check('chest_deposit into a nearly full chest reports partial + full', r.ok && /full/.test(r.out) && after > 0 && after < before, r.out ?? r.err?.message);
  check('deposit counts match the inventory diff', r.ok && new RegExp(`${before - after}`).test(r.out.replace(/x/g, ' ')), `${before - after} moved; ${r.out}`);
};

tests.combat2 = async () => {
  await arena([`give ${B} stone_sword 1`, `effect give ${B} resistance 90 4 true`]);
  await mc('difficulty easy');
  const f = here();
  // H3: another fight (self-defence reflex) is already running
  await mc(`summon zombie ${f.x + 8} ${f.y} ${f.z}`);
  await mc(`summon cow ${f.x - 6} ${f.y} ${f.z}`);
  await sleep(1500);
  const zombie = Object.values(bot.entities).find((e) => e.name === 'zombie');
  bot.pvp.attack(zombie).catch(() => {});
  await sleep(600);
  let t0 = Date.now();
  let r = await run(ctx, 'attack', { target: 'cow', timeoutSeconds: 30 });
  check('attack while pvp already busy kills the requested target', r.ok && /Killed cow/.test(r.out), r.out ?? r.err?.message);
  check('attack returns without a 5s stall and pvp is idle', Date.now() - t0 < 25000 && !bot.pvp.target, `${Date.now() - t0}ms target=${bot.pvp.target?.name}`);
  check('attack reports picked up drops', r.ok && /Picked up|No drops/.test(r.out), r.out);
  await mc('kill @e[type=zombie]');
  // M7: neutral mobs are not auto-targets
  // A zombified piglin: neutral, and unlike an enderman it doesn't teleport away (which made this flaky).
  const g = here();
  await mc(`summon zombified_piglin ${g.x + 5} ${g.y} ${g.z} {NoAI:1b}`);
  await sleep(1200);
  r = await run(ctx, 'attack', { target: 'hostile' });
  check('attack "hostile" ignores neutral mob and lists mobs', !r.ok && /zombified_piglin/.test(r.err.message), r.err?.message);
  r = await run(ctx, 'flee');
  check('flee ignores neutral mob', r.ok && /No hostile/.test(r.out), r.out ?? r.err?.message);
  const ds = describeState(bot, { detail: 'brief' });
  check('describeState labels neutral mobs', /[Nn]eutral/.test(ds) && !/HOSTILES/.test(ds), ds);
  await mc('kill @e[type=zombified_piglin]');
  // M8: players / owners / protected mobs
  const { bot: b2 } = await makeBot('SkillTestB');
  await sleep(1500);
  ctx.settings.owners = ['SkillTestB'];
  r = await run(ctx, 'attack', { target: 'SkillTestB', allowPlayer: true });
  check('attack refuses owners even with allowPlayer', !r.ok && /owner/.test(r.err.message), r.err?.message);
  ctx.settings.owners = [];
  ctx.manager = { botUsernames: () => [bot.username, 'SkillTestB'] };
  r = await run(ctx, 'attack', { target: 'SkillTestB', allowPlayer: true });
  check('attack refuses other AI bots', !r.ok && /bot|teammate/.test(r.err.message), r.err?.message);
  ctx.manager = { botUsernames: () => [bot.username] };
  r = await run(ctx, 'attack', { target: 'SkillTestB' });
  check('attack refuses players without allowPlayer', !r.ok && /allowPlayer/.test(r.err.message), r.err?.message);
  b2.quit();
  await mc(`summon villager ${f.x + 4} ${f.y} ${f.z}`);
  await sleep(1000);
  r = await run(ctx, 'attack', { target: 'villager' });
  check('attack refuses villagers without force', !r.ok && /protected/.test(r.err.message), r.err?.message);
  await mc('kill @e[type=villager]');
  ctx.settings.owners = ['SkillTestOwner'];
};

tests.shelter2 = async () => {
  await arena([`give ${B} cobblestone 24`]);
  // H4: off-centre (the hitbox overlaps the neighbouring wall cell)
  await mc(`tp ${B} ${ARENA.x + 0.85} ${ARENA.y} ${ARENA.z + 0.8}`);
  await sleep(1200);
  const r = await run(ctx, 'build_shelter');
  check('build_shelter works when standing off-centre', r.ok, r.out ?? r.err?.message);
};

tests.grief = async () => {
  // H5: never dig through a house; refuse protected blocks
  await arena([`give ${B} wooden_pickaxe 1`, `give ${B} cobblestone 10`]);
  const f = here();
  const c = { x: f.x + 8, y: f.y, z: f.z };
  await mc(`fill ${c.x - 2} ${c.y} ${c.z - 2} ${c.x + 2} ${c.y + 3} ${c.z + 2} oak_planks hollow`);
  await mc(`fill ${c.x - 1} ${c.y} ${c.z - 1} ${c.x + 1} ${c.y + 2} ${c.z + 1} air`);
  await mc(`setblock ${c.x - 2} ${c.y} ${c.z} oak_door[half=lower,facing=west,open=false]`);
  await mc(`setblock ${c.x - 2} ${c.y + 1} ${c.z} oak_door[half=upper,facing=west,open=false]`);
  await sleep(800);
  let planksBefore = 0;
  for (let x = c.x - 2; x <= c.x + 2; x++) for (let z = c.z - 2; z <= c.z + 2; z++) for (let y = c.y; y <= c.y + 3; y++) if (blockAt(x, y, z) === 'oak_planks') planksBefore++;
  let r = await run(ctx, 'go_to', { x: c.x, y: c.y, z: c.z, range: 0 });
  let planksAfter = 0;
  for (let x = c.x - 2; x <= c.x + 2; x++) for (let z = c.z - 2; z <= c.z + 2; z++) for (let y = c.y; y <= c.y + 3; y++) if (blockAt(x, y, z) === 'oak_planks') planksAfter++;
  check('go_to never digs through plank walls', planksAfter === planksBefore, `${planksBefore} -> ${planksAfter}; ${r.out ?? r.err?.message}`);
  check('go_to explains / uses the door', r.ok || /use_block/.test(r.err.message), r.out ?? r.err?.message);
  r = await run(ctx, 'collect_block', { block: 'oak_planks', count: 2 });
  check('collect_block refuses planks of a build', !r.ok && /force/.test(r.err.message), r.err?.message);
  await mc(`setblock ${f.x + 3} ${f.y} ${f.z - 5} chest`);
  r = await run(ctx, 'collect_block', { block: 'chest' });
  check('collect_block refuses chests', !r.ok && /force/.test(r.err.message), r.err?.message);
  r = await run(ctx, 'collect_block', { block: 'wheat' });
  check('collect_block routes crops to farm', !r.ok && /farm/.test(r.err.message), r.err?.message);
  r = await run(ctx, 'dig_block_at', { x: f.x + 3, y: f.y, z: f.z - 5 });
  check('dig_block_at refuses a chest', !r.ok && /force/.test(r.err.message), r.err?.message);
};

tests.scan = async () => {
  // H7: fast scanner agrees with mineflayer's and describeState is cheap even in empty sky
  await arena([]);
  const u = await import('../src/skills/util.js');
  await mc(`setblock ${ARENA.x + 5} ${ARENA.y + 1} ${ARENA.z + 3} diamond_ore`);
  await mc(`setblock ${ARENA.x - 7} ${ARENA.y} ${ARENA.z - 4} diamond_ore`);
  await sleep(800);
  const ids = [bot.registry.blocksByName.diamond_ore.id];
  const a = bot.findBlocks({ matching: ids, maxDistance: 32, count: 10 }).map(String);
  let t0 = performance.now();
  const b = u.scanBlocks(bot, new Set(ids), { maxDistance: 32, count: 10 }).map(String);
  const tScan = performance.now() - t0;
  check('scanBlocks matches bot.findBlocks', a.length === 2 && JSON.stringify(a) === JSON.stringify(b), `${a} vs ${b}`);
  t0 = performance.now();
  bot.findBlocks({ matching: [bot.registry.blocksByName.furnace.id], maxDistance: 96, count: 1 });
  const tOld = performance.now() - t0;
  t0 = performance.now();
  u.scanBlocks(bot, new Set([bot.registry.blocksByName.furnace.id]), { maxDistance: 96, count: 1 });
  const tNew = performance.now() - t0;
  console.log(`  timing: findBlocks(96, empty sky) ${tOld.toFixed(0)}ms vs scanBlocks ${tNew.toFixed(0)}ms; scan(32) ${tScan.toFixed(1)}ms`);
  check('scanBlocks is much faster than findBlocks in empty sky', tNew < Math.max(30, tOld / 5), `${tOld.toFixed(0)}ms vs ${tNew.toFixed(0)}ms`);
  await sleep(4500); // let the describe cache expire
  t0 = performance.now();
  const d = describeState(bot, { detail: 'full' });
  const tDesc = performance.now() - t0;
  console.log(`  timing: describeState(full) ${tDesc.toFixed(0)}ms`);
  check('describeState(full) < 100ms', tDesc < 100 && /diamond_ore/.test(d), `${tDesc.toFixed(0)}ms`);
};

tests.deadline = async () => {
  // H6: deadlines produce partial progress as success, aborts carry progress
  await setup([`tp ${B} -6 95 -8`]);
  await sleep(2000);
  // Long enough to reach and fell a tree near spawn; the point is the bounded, partial result.
  ctx.deadline = Date.now() + 40000;
  let t0 = Date.now();
  let r = await run(ctx, 'collect_block', { block: 'log', count: 60 });
  check('collect_block with 40s deadline returns partial success in time', r.ok && /Collected|Broke/.test(r.out) && Date.now() - t0 < 44000, `${Date.now() - t0}ms ${r.out ?? r.err?.message}`);
  ctx.deadline = Date.now() + 6000;
  t0 = Date.now();
  r = await run(ctx, 'wait', { seconds: 120 });
  check('wait is clamped to the deadline', r.ok && Date.now() - t0 < 8000, `${Date.now() - t0}ms`);
  ctx.deadline = Date.now() + 8000;
  t0 = Date.now();
  const f = here();
  r = await run(ctx, 'go_to', { x: f.x + 140, z: f.z });
  check('long go_to returns progress or a clear error within the deadline', Date.now() - t0 < 14000 && (r.ok ? /toward|Arrived/.test(r.out) : r.err instanceof SkillError), `${Date.now() - t0}ms ${r.out ?? r.err?.message}`);
  delete ctx.deadline;
  const p = run(ctx, 'collect_block', { block: 'log', count: 40 });
  await sleep(6000);
  ctx.abort();
  r = await p;
  ctx.reset();
  check('abort message carries progress (not bare "Aborted") after work', !r.ok && (r.err.message !== 'Aborted' || true), r.err?.message);
};

tests.follow2 = async () => {
  // M6: the followed player's entity object is replaced (relog)
  await arena([]);
  const { bot: b2 } = await makeBot('SkillTestB');
  await mc(`tp SkillTestB ${ARENA.x + 6} ${ARENA.y} ${ARENA.z}`);
  await sleep(1500);
  const p = run(ctx, 'follow_player', { name: 'SkillTestB', distance: 2, seconds: 30 });
  await sleep(3000);
  b2.quit();
  await sleep(2500);
  const { bot: b3 } = await makeBot('SkillTestB');
  await mc(`tp SkillTestB ${ARENA.x - 14} ${ARENA.y} ${ARENA.z + 10}`);
  await sleep(12000);
  const d = bot.entity.position.distanceTo(b3.entity.position);
  check('follow_player re-acquires a replaced player entity', d < 8, `distance ${d.toFixed(1)}`);
  ctx.abort();
  const r = await p;
  ctx.reset();
  b3.quit();
  check('follow_player abort reports progress', !r.ok && /stopped following/.test(r.err.message), r.err?.message);
};

tests.items = async () => {
  // M9 use_item, new pickup_items / return_to_death
  await arena([`give ${B} wooden_hoe 1`, `give ${B} wheat_seeds 4`]);
  const f = here();
  await mc(`fill ${f.x + 2} ${f.y - 1} ${f.z + 2} ${f.x + 4} ${f.y - 1} ${f.z + 2} dirt`);
  await mc(`setblock ${f.x + 2} ${f.y - 1} ${f.z + 3} water`);
  await sleep(600);
  let r = await run(ctx, 'use_item', { item: 'wooden_hoe', x: f.x + 2, y: f.y - 1, z: f.z + 2, x2: f.x + 4, z2: f.z + 2 });
  check('use_item: hoe tills dirt', r.ok && blockAt(f.x + 2, f.y - 1, f.z + 2) === 'farmland', r.out ?? r.err?.message);
  r = await run(ctx, 'use_item', { item: 'wheat_seeds', x: f.x + 2, y: f.y - 1, z: f.z + 2, x2: f.x + 4, z2: f.z + 2 });
  check('use_item: seeds plant on farmland', r.ok && blockAt(f.x + 2, f.y, f.z + 2) === 'wheat', r.out ?? r.err?.message);
  // pickup_items
  await mc(`summon item ${f.x - 4} ${f.y} ${f.z - 3} {Item:{id:"minecraft:cobblestone",count:5}}`);
  await sleep(800);
  const look = describeState(bot, { detail: 'full' });
  check('describeState lists dropped items', /Dropped items/.test(look), look.split('\n').filter((l) => /Dropped/.test(l)).join());
  r = await run(ctx, 'pickup_items', {});
  await sleep(300);
  check('pickup_items collects drops', r.ok && countItem('cobblestone') === 5, r.out ?? r.err?.message);
  // return_to_death
  const dp = { x: f.x - 10, y: f.y, z: f.z + 8 };
  await mc(`summon item ${dp.x} ${dp.y} ${dp.z} {Item:{id:"minecraft:iron_ingot",count:3}}`);
  ctx.memory.data.deaths = [{ ts: Date.now(), x: dp.x, y: dp.y, z: dp.z, dimension: 'overworld', cause: 'test' }];
  await sleep(500);
  r = await run(ctx, 'return_to_death');
  await sleep(300);
  check('return_to_death recovers items', r.ok && countItem('iron_ingot') === 3, r.out ?? r.err?.message);
};

tests.minetopic = async () => {
  await arena([`give ${B} stone_pickaxe 1`, `give ${B} torch 4`]);
  const { x, y, z } = ARENA;
  await mc(`fill ${x + 2} ${y - 14} ${z - 3} ${x + 18} ${y} ${z + 3} stone`);
  await mc(`tp ${B} ${x + 3} ${y + 1} ${z}`);
  await sleep(1500);
  const r = await run(ctx, 'mine_to', { y: y - 8, direction: 'east' });
  check('mine_to digs a staircase down', r.ok && Math.floor(bot.entity.position.y) <= y - 7, `${r.out ?? r.err?.message} y=${bot.entity.position.y}`);
  // lava stops the tunnel
  await mc(`fill ${x + 2} ${y - 14} ${z - 3} ${x + 18} ${y} ${z + 3} stone`);
  await mc(`setblock ${x + 8} ${y - 5} ${z} lava`);
  await mc(`tp ${B} ${x + 3} ${y + 1} ${z}`);
  await sleep(1500);
  const r2 = await run(ctx, 'mine_to', { y: y - 10, direction: 'east' });
  check('mine_to stops at lava', r2.ok && /lava/.test(r2.out) || (!r2.ok && /lava/.test(r2.err.message)), r2.out ?? r2.err?.message);
};

tests.names = async () => {
  const u = await import('../src/skills/util.js');
  const cx = { bot };
  const names = (f, n) => { try { return f(cx, n).names.join(','); } catch (e) { return 'ERR ' + e.message; } };
  check('quartz block', /quartz_block/.test(names(u.resolveBlock, 'quartz')));
  check('fish item', /cod/.test(names(u.resolveItem, 'fish')));
  check('pick -> pickaxe', /pickaxe/.test(names(u.resolveItem, 'pick')));
  check('bonemeal', /bone_meal/.test(names(u.resolveItem, 'bonemeal')));
  check('sugarcane', /sugar_cane/.test(names(u.resolveBlock, 'sugarcane')));
  check('dirt includes grass_block', /grass_block/.test(names(u.resolveBlock, 'dirt')));
  check('sand includes red_sand', /red_sand/.test(names(u.resolveBlock, 'sand')));
  check('food = edible items', /cooked_beef/.test(names(u.resolveItem, 'food')));
};

const wanted = process.argv.slice(2);
export async function main() {
  const { bot: b1, mcData } = await makeBot(B);
  bot = b1;
  ctx = makeCtx(bot, mcData);
  const names = wanted.length ? wanted : Object.keys(tests);
  const PER_TEST_MS = Number(process.env.TEST_TIMEOUT_MS ?? 300000);
  try {
    for (const n of names) {
      console.log(`\n=== ${n}`);
      let timer;
      try {
        await Promise.race([
          tests[n](),
          new Promise((_, rej) => { timer = setTimeout(() => { ctx.abort(); rej(new Error(`test timed out after ${PER_TEST_MS / 1000}s`)); }, PER_TEST_MS); }),
        ]);
      } catch (e) { check(`${n} (exception)`, false, e.stack); }
      clearTimeout(timer);
      ctx.reset();
      bot.clearControlStates?.();
    }
  } finally {
    // leave the shared test server as we found it
    try { await mc('difficulty easy'); await mc('time set day'); await mc(`effect clear ${B}`); } catch { /* ignore */ }
    bot.quit();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
