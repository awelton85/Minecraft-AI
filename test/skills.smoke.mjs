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
  check('describeState full < 2500', full.length > brief.length - 1 && full.length < 2500, `${full.length} chars`);
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
  check('eat', r.ok || /full/.test(r.err?.message), r.out ?? r.err?.message);
  r = await run(ctx, 'toss_item', { item: 'dirt', count: 4 });
  check('toss_item', r.ok);
  r = await run(ctx, 'toss_item', { item: 'nonexistent_thing' });
  check('toss unknown item fails cleanly', !r.ok);
};

tests.smelt = async () => {
  await arena([`give ${B} raw_iron 3`, `give ${B} coal 2`, `give ${B} furnace 1`]);
  let r = await run(ctx, 'smelt_item', { input: 'raw iron', count: 3 });
  check('smelt_item raw_iron x3 (places furnace)', r.ok && countItem('iron_ingot') === 3, r.out ?? r.err?.message);
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
  check('sleep with bed', r.ok || /still night|woke/.test(r.err?.message ?? ''), r.out ?? r.err?.message);
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

const wanted = process.argv.slice(2);
export async function main() {
  const { bot: b1, mcData } = await makeBot(B);
  bot = b1;
  ctx = makeCtx(bot, mcData);
  const names = wanted.length ? wanted : Object.keys(tests);
  try {
    for (const n of names) {
      console.log(`\n=== ${n}`);
      try { await tests[n](); } catch (e) { check(`${n} (exception)`, false, e.stack); }
    }
  } finally {
    bot.quit();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
