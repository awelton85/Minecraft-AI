// Shared helpers for skills: errors, abort handling, robust pathfinding, name resolution, inventory helpers.
//
// NOTE on plugin imports (all CommonJS except auto-eat): mineflayer-pathfinder is imported with a default import
// (`import pf from 'mineflayer-pathfinder'`) because its `goals` export is not visible as a named ESM export.
import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

const { Movements, goals } = pf;
export { Movements, goals, Vec3 };

export class SkillError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkillError';
  }
}

// ---------------------------------------------------------------- abort / timing

export function isAborted(ctx) {
  return !!ctx.signal?.aborted;
}

export function checkAbort(ctx) {
  if (isAborted(ctx)) throw new SkillError('Aborted');
}

/** Best-effort stop of everything physical the bot may be doing. */
export function haltPathfinder(bot) {
  // pathfinder.stop() only takes effect when the bot reaches the next path node and leaves stopPathing set;
  // setGoal(null) clears the path immediately.
  try { bot.pathfinder?.setGoal(null); } catch { /* ignore */ }
}

/** Close any container/crafting window the bot has open (leaked windows make later bot.craft calls fail). */
export function closeOpenWindow(bot) {
  try {
    const w = bot.currentWindow;
    if (w) bot.closeWindow(w);
  } catch { /* ignore */ }
}

/** ms left until the Agent's deadline (fallback: unlimited). */
export function timeLeft(ctx) {
  if (typeof ctx.timeLeftMs === 'function') { try { return Math.max(0, ctx.timeLeftMs()); } catch { /* ignore */ } }
  if (Number.isFinite(ctx.deadline)) return Math.max(0, ctx.deadline - Date.now());
  return Infinity;
}
/** min(want, time left minus a safety margin), at least `floor`. */
export function budgetMs(ctx, want, margin = 1500, floor = 1000) {
  return Math.max(floor, Math.min(want, timeLeft(ctx) - margin));
}
export const outOfTime = (ctx, margin = 1500) => timeLeft(ctx) <= margin;

export function stopEverything(ctx) {
  const bot = ctx.bot;
  haltPathfinder(bot);
  try { bot.pvp?.forceStop?.(); } catch { /* ignore */ }
  try { bot.stopDigging(); } catch { /* ignore */ }
  try { bot.clearControlStates(); } catch { /* ignore */ }
  closeOpenWindow(bot);
}

/** Resolve after ms, or throw SkillError('Aborted') as soon as the signal fires. */
export function sleep(ctx, ms) {
  return new Promise((resolve, reject) => {
    if (isAborted(ctx)) return reject(new SkillError('Aborted'));
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); cleanup(); reject(new SkillError('Aborted')); };
    const cleanup = () => ctx.signal?.removeEventListener('abort', onAbort);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Await `promise` but give up after `ms` (SkillError `${label} timed out`) or when ctx.signal aborts.
 * `onCancel` is called when we give up so the caller can stop the underlying activity.
 */
export function withTimeout(ctx, promise, ms, label = 'Operation', onCancel) {
  return new Promise((resolve, reject) => {
    if (isAborted(ctx)) {
      try { onCancel?.(); } catch { /* ignore */ }
      promise.catch(() => {});
      return reject(new SkillError('Aborted'));
    }
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      ctx.signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const t = setTimeout(() => {
      try { onCancel?.(); } catch { /* ignore */ }
      finish(reject, new SkillError(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    const onAbort = () => {
      try { onCancel?.(); } catch { /* ignore */ }
      finish(reject, new SkillError('Aborted'));
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    promise.then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}

/** Wait until predicate() is truthy, polling every 100ms. Bounded and abortable. Returns true / false(timeout). */
export async function waitUntil(ctx, predicate, ms, pollMs = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    checkAbort(ctx);
    try { if (predicate()) return true; } catch { /* ignore */ }
    await sleep(ctx, pollMs);
  }
  try { return !!predicate(); } catch { return false; }
}

// ---------------------------------------------------------------- misc small helpers

export const fmt = (n) => (Number.isFinite(n) ? Math.round(n) : n);
export function fmtPos(p) {
  return `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
}
export function vecFrom(args, keys = ['x', 'y', 'z']) {
  const v = keys.map((k) => Number(args?.[k]));
  if (v.some((n) => !Number.isFinite(n))) throw new SkillError('x, y and z must be numbers.');
  return new Vec3(Math.floor(v[0]), Math.floor(v[1]), Math.floor(v[2]));
}
export function intArg(v, def, min = 1, max = 100000) {
  if (v === undefined || v === null || v === '') return def;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) throw new SkillError(`Expected a number, got "${v}".`);
  return Math.max(min, Math.min(max, n));
}
export function numArg(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new SkillError(`Expected a number, got "${v}".`);
  return n;
}

export function botPos(bot) {
  return bot.entity.position;
}
export function feetPos(bot) {
  return bot.entity.position.floored();
}

export function blockAtSafe(bot, pos) {
  try { return bot.blockAt(pos); } catch { return null; }
}

export function isSolid(block) {
  return !!block && block.boundingBox === 'block';
}
export function isAir(block) {
  return !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
}
export function isLiquid(block) {
  return !!block && (block.name === 'water' || block.name === 'lava');
}

/**
 * Runtime patch for a prismarine-physics / vanilla-server mismatch (do NOT edit node_modules).
 * The server's player hitbox half-width is the float 0.3F (0.30000001192...), prismarine-physics uses the double 0.3.
 * When the client clips against a wall it therefore ends up ~1.2e-8 blocks inside it, and recent Paper (1.21.x / 26.x)
 * rejects such a position and rubber-bands the bot (teleport packet every tick). mineflayer then sets
 * onGround=false on each forced move, so the bot looks "collided, airborne, zero velocity, no controls" and the
 * pathfinder stalls forever, e.g. on a sprint-jump up a 1-block step in a 1x1 shaft where the bot touches the wall
 * while still below the block top. Using the float value makes client clipping match the server exactly.
 * Idempotent; the pathfinder simulates with bot.physics too, so its planning is consistent.
 */
export function applyPhysicsFix(bot) {
  const ph = bot?.physics;
  if (ph && typeof ph.playerHalfWidth === 'number' && ph.playerHalfWidth === 0.3) ph.playerHalfWidth = Math.fround(0.3);
}

// Blocks that are almost always somebody's build / functional blocks: the pathfinder must never dig them.
const PROTECTED_RE = /(chest|barrel|furnace|smoker|crafting_table|_bed$|spawner|bookshelf|^obsidian$|^bedrock$|shulker_box|_door$|trapdoor|fence|_gate$|_wall$|glass|_wool$|carpet|torch|lantern|ladder|_sign$|farmland|^(wheat|carrots|potatoes|beetroots|melon|pumpkin|sweet_berry_bush|nether_wart|sugar_cane|bamboo)$|_planks$|brick|stairs|_slab$|concrete|terracotta|^stripped_|^polished_|^smooth_|^cut_|^chiseled_|_button$|_pressure_plate$|lever|^hay_block$|^bell$|anvil|enchanting|beacon|banner|^item_frame|painting|_head$|^cauldron|^composter|^lectern|^loom|^grindstone|^stonecutter|^smithing|^cartography|^jukebox|^note_block|^tnt$|^rail|_rail$|^redstone|^repeater|^comparator|^observer|^piston|^dispenser|^dropper|^hopper|^end_portal|^nether_portal|^respawn_anchor|^lodestone|^conduit)/;
/** Cheap blocks the pathfinder may use for scaffolding / bridges. */
const SCAFFOLD_ITEMS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff'];

export const isProtectedBlockName = (name) => PROTECTED_RE.test(name);

/** Per-bot cached Movements; collectblock / pvp replace pathfinder movements so we re-apply ours before moving. */
const movementCache = new WeakMap();
export function getMovements(ctx, { dig = true } = {}) {
  const bot = ctx.bot;
  applyPhysicsFix(bot);
  let m = movementCache.get(bot);
  if (!m) {
    m = new Movements(bot);
    m.allowSprinting = true;
    m.allowParkour = true;
    m.digCost = 4; // prefer walking around to digging
    for (const b of Object.values(bot.registry.blocksByName)) {
      if (PROTECTED_RE.test(b.name)) m.blocksCantBreak.add(b.id);
    }
    // scaffolding: cheap junk only, never planks / stone / building materials
    m.scafoldingBlocks.length = 0;
    for (const n of SCAFFOLD_ITEMS) {
      const it = bot.registry.itemsByName[n];
      if (it) m.scafoldingBlocks.push(it.id);
    }
    movementCache.set(bot, m);
  }
  m.canDig = dig;
  return m;
}

// ---------------------------------------------------------------- name resolution

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

export function normName(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/^minecraft:/, '').replace(/[\s\-]+/g, '_').replace(/[^a-z0-9_]/g, '');
  s = s.replace(/^(any|some|a|an|the)_/, '');
  return s;
}

function closeMatches(name, all, n = 6) {
  const hits = all.filter((x) => x.includes(name) || (name.length > 3 && name.includes(x)));
  const scored = all.map((x) => [x, levenshtein(name, x)]).filter(([, d]) => d <= Math.max(3, Math.floor(name.length / 3)));
  scored.sort((a, b) => a[1] - b[1]);
  const out = [];
  for (const x of [...hits.slice(0, n), ...scored.map(([x]) => x)]) if (!out.includes(x)) out.push(x);
  return out.slice(0, n);
}

const ALIASES = {
  wood: 'log', tree: 'log', trunk: 'log', timber: 'log',
  cobble: 'cobblestone', stone_block: 'stone',
  craftingtable: 'crafting_table', workbench: 'crafting_table', crafting: 'crafting_table',
  planks: 'planks', plank: 'planks',
  pickaxe_wood: 'wooden_pickaxe', wood_pickaxe: 'wooden_pickaxe', wood_axe: 'wooden_axe', wood_sword: 'wooden_sword',
  wood_shovel: 'wooden_shovel', wood_hoe: 'wooden_hoe', wood_door: 'oak_door', wood_slab: 'oak_slab',
  gold: 'gold_ingot', iron: 'iron_ingot', lapis: 'lapis_lazuli', sticks: 'stick',
  seeds: 'wheat_seeds', grass: 'short_grass', tall_grass: 'tall_grass', torches: 'torch',
  pick: 'pickaxe', bonemeal: 'bone_meal', sugarcane: 'sugar_cane', quartz: 'quartz_block', steak: 'cooked_beef', redstone_dust: 'redstone',
};

function nameCandidates(norm) {
  const out = [norm];
  if (ALIASES[norm]) out.push(ALIASES[norm]);
  if (norm.endsWith('ies')) out.push(norm.slice(0, -3) + 'y');
  if (norm.endsWith('es')) out.push(norm.slice(0, -2));
  if (norm.endsWith('s')) out.push(norm.slice(0, -1));
  else out.push(norm + 's');
  // "oak wood" / "oak_wood" -> the user almost always means the log
  if (/_wood$/.test(norm)) out.push(norm.replace(/_wood$/, '_log'));
  return [...new Set(out)];
}

function resolveFrom(ctx, raw, table, kind) {
  const norm = normName(raw);
  if (!norm) throw new SkillError(`Empty ${kind} name.`);
  const all = Object.keys(table);
  const set = new Set(all);
  for (const c of nameCandidates(norm)) {
    if (set.has(c)) return { names: [c], generic: false, query: norm };
  }
  // generic: suffix match on the (singularised) token, e.g. log -> oak_log, birch_log ...
  for (const c of nameCandidates(norm)) {
    const base = ALIASES[c] ?? c;
    const suffix = '_' + base;
    const hits = all.filter((n) => n.endsWith(suffix) && !n.startsWith('stripped_') && !n.startsWith('potted_'));
    if (hits.length) return { names: hits, generic: true, query: norm };
    const pre = all.filter((n) => n.endsWith('_' + base.replace(/s$/, '')) && !n.startsWith('stripped_'));
    if (pre.length) return { names: pre, generic: true, query: norm };
  }
  const close = closeMatches(norm, all);
  throw new SkillError(
    `Unknown ${kind} "${raw}".` + (close.length ? ` Close matches: ${close.join(', ')}.` : ' No similar names found; use exact Minecraft names like oak_log or iron_ingot.')
  );
}

/** Resolve a free-form name to item name(s). Returns { names, generic }. Throws SkillError listing close matches. */
export function resolveItem(ctx, raw) {
  const norm = normName(raw);
  const names = ctx.bot.registry.itemsByName;
  if (!names[norm]) {
    if (norm === 'fish') return { names: ['cod', 'salmon', 'cooked_cod', 'cooked_salmon', 'tropical_fish'].filter((n) => names[n]), generic: true, query: norm };
    if (['food', 'meat', 'foods'].includes(norm)) return { names: Object.keys(ctx.bot.registry.foodsByName ?? {}), generic: true, query: norm };
    if (norm === 'meat') return { names: ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton'], generic: true, query: norm };
  }
  return resolveFrom(ctx, raw, ctx.bot.registry.itemsByName, 'item');
}

/** Resolve a free-form name to block name(s). Also maps drop items (coal, diamond, raw_iron) to the ore blocks. */
export function resolveBlock(ctx, raw) {
  const reg = ctx.bot.registry;
  const norm = normName(raw);
  let r;
  try {
    const stem = norm.replace(/^raw_/, '').replace(/s$/, '');
    if (!reg.blocksByName[norm] && reg.blocksByName[`${stem}_ore`]) {
      r = { names: [`${stem}_ore`], generic: false, query: norm };
    } else r = resolveFrom(ctx, raw, reg.blocksByName, 'block');
  } catch (err) {
    // maybe an item that is dropped by some block (coal, diamond, raw_iron, redstone, ...)
    const items = reg.itemsByName;
    const cand = nameCandidates(norm).find((c) => items[c]);
    if (cand) {
      const id = items[cand].id;
      const blocks = Object.values(reg.blocksByName).filter((b) => b.drops?.includes(id)).map((b) => b.name);
      if (blocks.length) return { names: blocks, generic: true, query: norm };
    }
    throw err;
  }
  // exact ore: include deepslate variant
  if (!r.generic && r.names[0].endsWith('_ore') && !r.names[0].startsWith('deepslate_')) {
    const d = 'deepslate_' + r.names[0];
    if (reg.blocksByName[d]) r.names.push(d);
  }
  // natural stone is mined as "stone" but drops cobblestone; people ask for the drop
  if (!r.generic && r.names[0] === 'cobblestone') r.names.push('stone');
  if (!r.generic && r.names[0] === 'cobbled_deepslate') r.names.push('deepslate');
  if (!r.generic && r.names[0] === 'dirt') r.names.push('grass_block');
  if (!r.generic && r.names[0] === 'sand' && reg.blocksByName.red_sand) r.names.push('red_sand');
  return r;
}

export function blockIdsFor(ctx, names) {
  return names.map((n) => ctx.bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined);
}

// ---------------------------------------------------------------- inventory helpers

export function inventoryItems(bot) {
  return bot.inventory.items();
}

export function countItem(bot, names) {
  const set = new Set([].concat(names));
  let n = 0;
  for (const it of bot.inventory.items()) if (set.has(it.name)) n += it.count;
  return n;
}

/** Counts across inventory slots, including the armor/off-hand slots only when `all` is true. */
export function inventoryCounts(bot) {
  const m = {};
  for (const it of bot.inventory.items()) m[it.name] = (m[it.name] ?? 0) + it.count;
  return m;
}

export function findItem(bot, names) {
  const set = new Set([].concat(names));
  return bot.inventory.items().find((it) => set.has(it.name)) ?? null;
}

export function formatCounts(counts, max = 40) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return 'nothing';
  const shown = entries.slice(0, max).map(([n, c]) => `${n}x${c}`);
  if (entries.length > max) shown.push(`+${entries.length - max} more`);
  return shown.join(', ');
}

export function freeSlots(bot) {
  return bot.inventory.slots.slice(bot.inventory.inventoryStart, bot.inventory.inventoryEnd).filter((s) => !s).length;
}

const TOOL_RE = /(_pickaxe|_axe|_shovel|_hoe|_sword|^bow$|^crossbow$|^trident$|^shield$|^fishing_rod$|^shears$|_helmet$|_chestplate$|_leggings$|_boots$|^flint_and_steel$|^elytra$)/;
export const isToolOrArmor = (name) => TOOL_RE.test(name);

export function foodInfo(bot) {
  return bot.registry.foodsByName ?? {};
}
export function isFoodName(bot, name) {
  return !!bot.registry.foodsByName?.[name];
}

/** Names of blocks the bot can place that are cheap & solid (for shelters, towers, bridges). */
const JUNK_BLOCKS = ['cobblestone', 'dirt', 'netherrack', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'sand', 'gravel', 'deepslate', 'blackstone', 'tuff'];
export function findPlaceableJunk(bot) {
  const items = bot.inventory.items();
  for (const n of JUNK_BLOCKS) {
    const it = items.find((i) => i.name === n);
    if (it) return it;
  }
  const planks = items.find((i) => i.name.endsWith('_planks'));
  if (planks) return planks;
  return items.find((i) => bot.registry.blocksByName[i.name]?.boundingBox === 'block' && !/(chest|furnace|crafting|bed|door|table|barrel|tnt|sapling|ore$|_log$)/.test(i.name)) ?? null;
}

export async function equipItem(ctx, item, dest = 'hand') {
  if (!item) throw new SkillError('No such item to equip.');
  if (dest === 'hand' && bot_held(ctx.bot)?.type === item.type) return;
  await withTimeout(ctx, ctx.bot.equip(item, dest), 5000, `Equipping ${item.name}`);
}
function bot_held(bot) {
  return bot.heldItem;
}

// ---------------------------------------------------------------- digging / placing

/** Equip the best tool and dig a block, bounded by time. Throws SkillError on failure. */
export async function digBlock(ctx, block, { timeoutMs } = {}) {
  const bot = ctx.bot;
  const b = blockAtSafe(bot, block.position);
  if (!b || isAir(b)) return false;
  if (b.name === 'bedrock' || b.hardness === -1 || b.hardness === null) throw new SkillError(`${b.name} at ${fmtPos(b.position)} cannot be broken.`);
  await equipTool(ctx, b);
  const t = timeoutMs ?? Math.min(30000, Math.max(5000, (bot.digTime(b) || 1000) * 2 + 3000));
  try {
    await withTimeout(ctx, bot.dig(b), t, `Digging ${b.name}`, () => { try { bot.stopDigging(); } catch { /* */ } });
  } catch (err) {
    if (err instanceof SkillError) throw err;
    throw new SkillError(`Could not dig ${b.name} at ${fmtPos(b.position)}: ${err.message}`);
  }
  return true;
}

/** Equip the best tool for a block (bounded; falls back to whatever is held). */
export async function equipTool(ctx, block, opts = { requireHarvest: false }) {
  try {
    await withTimeout(ctx, ctx.bot.tool.equipForBlock(block, opts), 5000, 'Equipping tool');
  } catch (e) {
    if (e.message === 'Aborted') throw e;
  }
}

const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(-1, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1)];
export { FACES };

// right-clicking these opens a GUI / toggles them instead of placing a block against them
const INTERACTIVE_RE = /(crafting_table|chest|barrel|furnace|smoker|anvil|enchanting_table|_bed$|door|trapdoor|button|lever|fence_gate|shulker_box|hopper|dispenser|dropper|loom|cartography_table|grindstone|smithing_table|stonecutter|note_block|jukebox|beacon|brewing_stand|cauldron|lectern|bell|_sign$|composter|repeater|comparator|daylight_detector|respawn_anchor|decorated_pot|crafter)/;
export const isInteractive = (b) => !!b && INTERACTIVE_RE.test(b.name);

/** Find a solid neighbour of `pos` to place against. Returns { ref, face } or null. Prefers the block below. */
export function findPlacementRef(bot, pos, avoid = []) {
  let fallback = null;
  for (const d of FACES) {
    const n = pos.plus(d);
    if (avoid.some((a) => a.equals(n))) continue;
    const b = blockAtSafe(bot, n);
    if (isSolid(b) && !isLiquid(b)) {
      if (isInteractive(b)) { fallback ??= { ref: b, face: d.scaled(-1), sneak: true }; continue; }
      return { ref: b, face: d.scaled(-1) };
    }
  }
  return fallback;
}

function bodyOverlaps(bot, pos) {
  const p = bot.entity.position;
  const w = 0.3;
  return p.x + w > pos.x && p.x - w < pos.x + 1 && p.z + w > pos.z && p.z - w < pos.z + 1 && p.y + 1.8 > pos.y && p.y < pos.y + 1;
}

/**
 * Place `item` (inventory item object) at the empty block position `pos`. Moves into reach if needed.
 * Throws SkillError on failure; returns true. `stand` option: keep the bot where it is (no walking).
 */
export async function placeItemAt(ctx, item, pos, { stand = false } = {}) {
  const bot = ctx.bot;
  checkAbort(ctx);
  const existing = blockAtSafe(bot, pos);
  if (existing && !isAir(existing) && !isLiquid(existing) && existing.boundingBox !== 'empty') {
    if (existing.name === item.name) return true;
    throw new SkillError(`Cannot place ${item.name} at ${fmtPos(pos)}: ${existing.name} is already there.`);
  }
  const target = findPlacementRef(bot, pos);
  if (!target) throw new SkillError(`No solid block next to ${fmtPos(pos)} to place against (it is floating in air).`);
  const center = pos.offset(0.5, 0.5, 0.5);
  if (bot.entity.position.distanceTo(center) > 4.3 && !stand) {
    await moveTo(ctx, new goals.GoalNear(pos.x, pos.y, pos.z, 3), { label: 'reach placement spot', timeoutMs: 30000, dig: false });
  }
  if (bodyOverlaps(bot, pos) && !stand) {
    // step out of the way
    for (const d of [new Vec3(2, 0, 0), new Vec3(-2, 0, 0), new Vec3(0, 0, 2), new Vec3(0, 0, -2)]) {
      const t = pos.plus(d);
      try {
        await moveTo(ctx, new goals.GoalNear(t.x, t.y, t.z, 0), { label: 'step aside', timeoutMs: 8000, noUnstick: true, dig: false });
        break;
      } catch (e) { if (e.message === 'Aborted') throw e; }
    }
  }
  await equipItem(ctx, item);
  try {
    if (target.sneak) bot.setControlState('sneak', true); // placing against a GUI block needs sneaking
    await withTimeout(ctx, bot.lookAt(center, true), 2000, 'Looking at target');
    await withTimeout(ctx, bot.placeBlock(target.ref, target.face), 7000, 'Placing block');
  } catch (err) {
    if (err instanceof SkillError) throw err;
    throw new SkillError(`Failed to place ${item.name} at ${fmtPos(pos)}: ${err.message}`);
  } finally {
    if (target.sneak) bot.setControlState('sneak', false);
  }
  return true;
}

// ---------------------------------------------------------------- movement

export function inHole(bot, at) {
  const f = at ? new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z)) : feetPos(bot);
  let walls = 0;
  for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
    if (isSolid(blockAtSafe(bot, f.plus(d))) && isSolid(blockAtSafe(bot, f.plus(d).offset(0, 1, 0)))) walls++;
  }
  return walls >= 3;
}

/** Build a 1x1 pillar of `count` blocks under the bot. Returns number of blocks placed. */
export async function towerUp(ctx, count = 4) {
  const bot = ctx.bot;
  let placed = 0;
  bot.pathfinder?.stop();
  bot.clearControlStates();
  for (let i = 0; i < count; i++) {
    checkAbort(ctx);
    const item = findPlaceableJunk(bot);
    if (!item) break;
    const baseY = Math.floor(bot.entity.position.y);
    // clear the block above head if diggable
    const above = blockAtSafe(bot, feetPos(bot).offset(0, 2, 0));
    if (above && isSolid(above) && above.hardness !== -1 && !/(bedrock|obsidian)/.test(above.name)) {
      try { await digBlock(ctx, above); } catch { break; }
    } else if (above && isSolid(above)) break;
    await equipItem(ctx, item);
    bot.setControlState('jump', true);
    const ok = await waitUntil(ctx, () => bot.entity.position.y > baseY + 0.8, 800, 50).catch(() => false);
    bot.setControlState('jump', false);
    if (!ok) break;
    const below = blockAtSafe(bot, new Vec3(Math.floor(bot.entity.position.x), baseY, Math.floor(bot.entity.position.z)));
    if (!below || !isAir(below)) {
      // already something there, nothing to place; just continue
      continue;
    }
    const refBlock = blockAtSafe(bot, below.position.offset(0, -1, 0));
    if (!isSolid(refBlock)) break;
    try {
      await withTimeout(ctx, bot.placeBlock(refBlock, new Vec3(0, 1, 0)), 4000, 'Placing tower block');
      placed++;
    } catch (e) {
      if (e.message === 'Aborted') throw e;
      break;
    }
    await sleep(ctx, 150);
  }
  bot.clearControlStates();
  return placed;
}

function facingDir(bot) {
  const yaw = bot.entity.yaw;
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  if (Math.abs(dx) > Math.abs(dz)) return new Vec3(Math.sign(dx), 0, 0);
  return new Vec3(0, 0, Math.sign(dz));
}

/** One unstick attempt: tower out of a hole, dig the obstacle in front, jump forward, or step back. */
export async function unstick(ctx) {
  const bot = ctx.bot;
  stopEverything(ctx);
  ctx.log?.('unstick attempt');
  if (inHole(bot)) {
    const n = await towerUp(ctx, 4).catch(() => 0);
    if (n > 0) return 'towered up';
  }
  const f = feetPos(bot);
  const dir = facingDir(bot);
  let dug = false;
  for (const dy of [1, 0]) {
    const b = blockAtSafe(bot, f.plus(dir).offset(0, dy, 0));
    if (b && isSolid(b) && !isProtectedBlockName(b.name) && b.hardness !== -1) {
      try { dug = (await digBlock(ctx, b, { timeoutMs: 8000 })) || dug; } catch (e) { if (e.message === 'Aborted') throw e; }
    }
  }
  bot.setControlState('forward', true);
  bot.setControlState('jump', true);
  await sleep(ctx, 600);
  bot.clearControlStates();
  if (!dug) {
    bot.setControlState('back', true);
    await sleep(ctx, 500);
    bot.clearControlStates();
  }
  return dug ? 'dug obstacle' : 'jumped / stepped back';
}

/**
 * Walk to a pathfinder goal with a stuck watchdog. Resolves when the goal is reached.
 * Throws SkillError on: abort, no path, overall timeout, stuck (after one unstick attempt).
 * opts: { timeoutMs=120000, label, dig=true, noUnstick=false }
 */
export async function moveTo(ctx, goal, opts = {}) {
  const bot = ctx.bot;
  if (!bot.pathfinder) throw new SkillError('Pathfinder is not loaded.');
  applyPhysicsFix(bot);
  checkAbort(ctx);
  const label = opts.label ?? 'destination';
  const timeoutMs = budgetMs(ctx, opts.timeoutMs ?? 120000);
  const stuckMs = Math.max(2, ctx.settings?.agent?.stuckSeconds ?? 12) * 1000;

  if (goal.isEnd?.(bot.entity.position.floored()) && !goal.dynamic) return;

  bot.pathfinder.setMovements(getMovements(ctx, { dig: opts.dig !== false }));

  let unstuckTried = !!opts.noUnstick;
  const start = Date.now();
  let lastPos = bot.entity.position.clone();
  let lastProgress = Date.now();

  const attempt = () => new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      bot.removeListener('goal_reached', onReached);
      bot.removeListener('path_update', onPath);
      bot.removeListener('path_stop', onStop);
      ctx.signal?.removeEventListener('abort', onAbort);
      if (err) {
        haltPathfinder(bot);
        bot.clearControlStates();
        reject(err);
      } else resolve();
    };
    const onReached = () => finish();
    const onPath = (r) => {
      if (r.path.length === 0 && (r.status === 'noPath' || r.status === 'timeout')) {
        const e = new SkillError(`No path to ${label} (${r.status === 'timeout' ? 'pathfinding gave up after a long search' : 'no route exists'}). It may be enclosed, too far, or blocked.${doorHint(bot, goal)}`);
        e.code = 'nopath';
        finish(e);
      }
    };
    const onStop = () => { if (!done) finish(new SkillError(`Movement to ${label} was interrupted.`)); };
    const onAbort = () => finish(new SkillError('Aborted'));
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    bot.on('goal_reached', onReached);
    bot.on('path_update', onPath);
    bot.on('path_stop', onStop);
    const timer = setInterval(() => {
      if (done) return;
      const now = Date.now();
      if (!bot.entity) return finish(new SkillError('Bot disconnected.'));
      if (now - start > timeoutMs) {
        const e = new SkillError(`Timed out after ${Math.round(timeoutMs / 1000)}s trying to reach ${label}.`);
        e.code = 'timeout';
        return finish(e);
      }
      const p = bot.entity.position;
      if (p.distanceTo(lastPos) > 0.6 || bot.pathfinder.isMining?.() || bot.pathfinder.isBuilding?.()) {
        lastPos = p.clone();
        lastProgress = now;
        return;
      }
      if (now - lastProgress > stuckMs) finish(new SkillError('__stuck__'));
    }, 400);
    if (goal.isEnd?.(bot.entity.position.floored())) return finish();
    bot.pathfinder.setGoal(goal);
  });

  for (;;) {
    try {
      await attempt();
      return;
    } catch (err) {
      if (err.message !== '__stuck__') throw err;
      if (unstuckTried) {
        const e = new SkillError(`Got stuck near ${fmtPos(bot.entity.position)} while moving to ${label} (no progress for ${Math.round(stuckMs / 1000)}s, unstick failed). Try a different route, dig through, or build/tower.${doorHint(bot, goal)}`);
        e.code = 'stuck';
        throw e;
      }
      unstuckTried = true;
      try { await unstick(ctx); } catch (e) { if (e.message === 'Aborted') throw e; }
      lastPos = bot.entity.position.clone();
      lastProgress = Date.now();
      checkAbort(ctx);
      bot.pathfinder.setMovements(getMovements(ctx, { dig: opts.dig !== false }));
    }
  }
}

/** If there is a closed door close to the goal, tell the model to open it instead of digging. */
function doorHint(bot, goal) {
  try {
    const g = goal?.pos ?? (goal && Number.isFinite(goal.x) && Number.isFinite(goal.z) ? { x: goal.x, y: goal.y ?? bot.entity.position.y, z: goal.z } : null);
    if (!g) return '';
    const door = scanBlocks(bot, doorIds(bot), { point: new Vec3(Math.floor(g.x), Math.floor(g.y), Math.floor(g.z)), maxDistance: 6, count: 4 })
      .map((p) => bot.blockAt(p)).find((b) => b && !b.getProperties?.().open);
    return door ? ` There is a closed ${door.name} at ${fmtPos(door.position)}: try use_block on it, then go_to again.` : '';
  } catch { return ''; }
}
const doorIdCache = new WeakMap();
function doorIds(bot) {
  let ids = doorIdCache.get(bot.registry);
  if (!ids) {
    ids = new Set(Object.values(bot.registry.blocksByName).filter((b) => /(_door|_trapdoor|_fence_gate)$/.test(b.name) && !b.name.startsWith('iron_')).map((b) => b.id));
    doorIdCache.set(bot.registry, ids);
  }
  return ids;
}

/** Walk to within `range` blocks of a position. */
export function goNear(ctx, pos, range = 2, opts = {}) {
  return moveTo(ctx, new goals.GoalNear(pos.x, pos.y, pos.z, range), { label: opts.label ?? fmtPos(pos), ...opts });
}

/** Walk until the bot can interact with (look at / reach) the block. */
export function goReach(ctx, pos, opts = {}) {
  return moveTo(ctx, new goals.GoalGetToBlock(pos.x, pos.y, pos.z), { label: fmtPos(pos), ...opts });
}

// ---------------------------------------------------------------- players / entities

export function findPlayerEntity(bot, name) {
  const n = String(name ?? '').toLowerCase();
  for (const [uname, p] of Object.entries(bot.players)) {
    if (uname.toLowerCase() === n && p.entity) return p.entity;
  }
  return null;
}

export function playerExists(bot, name) {
  const n = String(name ?? '').toLowerCase();
  return Object.keys(bot.players).some((u) => u.toLowerCase() === n);
}

// Neutral mobs only attack when provoked (or at certain times); never auto-target / flee from / treat them as a threat.
export const NEUTRAL_NAMES = new Set(['enderman', 'zombified_piglin', 'piglin', 'bee', 'wolf', 'polar_bear', 'llama', 'goat', 'dolphin', 'iron_golem']);
export const PROTECTED_MOBS = new Set(['villager', 'wandering_trader', 'iron_golem', 'snow_golem', 'cat', 'wolf', 'horse', 'donkey', 'mule', 'parrot', 'allay', 'axolotl', 'armadillo', 'camel', 'llama']);
export const HOSTILE_NAMES = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch',
  'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'blaze', 'ghast', 'wither_skeleton',
  'piglin_brute', 'hoglin', 'zoglin', 'guardian', 'elder_guardian', 'silverfish', 'endermite', 'shulker', 'warden', 'breeze', 'creaking',
]);

const SPIDERS = new Set(['spider', 'cave_spider']);
const isNight = (bot) => { const t = bot?.time?.timeOfDay; return typeof t === 'number' && t >= 12500 && t <= 23500; };
/** Neutral = only fights when provoked (spiders are neutral by day when `bot` is given). */
export function isNeutral(e, bot) {
  if (!e) return false;
  if (SPIDERS.has(e.name)) return !!bot && !isNight(bot);
  return NEUTRAL_NAMES.has(e.name);
}
/** Hostile and actually a threat: neutral mobs (enderman, piglins, spiders ...) are excluded. */
export function isHostile(e, bot) {
  if (!e || e.type === 'player') return false;
  if (isNeutral(e, bot)) return false;
  return e.type === 'hostile' || HOSTILE_NAMES.has(e.name);
}

// ---------------------------------------------------------------- higher level inventory / world helpers

/** Resolve `raw` to something in the inventory (generic names pick the type with the most items). */
export function pickInventoryItem(ctx, raw) {
  const r = resolveItem(ctx, raw);
  const counts = {};
  for (const it of ctx.bot.inventory.items()) if (r.names.includes(it.name)) counts[it.name] = (counts[it.name] ?? 0) + it.count;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!best) {
    throw new SkillError(`You have no ${r.generic ? raw + ' (' + r.names.slice(0, 4).join('/') + '...)' : r.names[0]} in your inventory. Inventory: ${formatCounts(inventoryCounts(ctx.bot), 20)}.`);
  }
  return { item: ctx.bot.inventory.items().find((i) => i.name === best[0]), name: best[0], total: best[1] };
}

/** Nearest block with any of these names within maxDistance (loaded chunks only), or null. */
export function findNearestBlock(ctx, names, maxDistance = 32) {
  const ids = blockIdsFor(ctx, [].concat(names));
  if (!ids.length) return null;
  const p = scanBlocks(ctx.bot, new Set(ids), { maxDistance, count: 1 })[0];
  return p ? ctx.bot.blockAt(p) : null;
}

/** Find an empty spot next to the bot (with solid floor) where a utility block (table/furnace/chest) can be placed. */
export function findAdjacentSpot(bot, radius = 2, exclude = []) {
  const f = feetPos(bot);
  const cands = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx === 0 && dz === 0) continue;
      for (const dy of [0, 1, -1]) {
        const p = f.offset(dx, dy, dz);
        const here = blockAtSafe(bot, p);
        const above = blockAtSafe(bot, p.offset(0, 1, 0));
        const below = blockAtSafe(bot, p.offset(0, -1, 0));
        if (exclude.some((x) => x.equals(p))) continue;
        if (here && isAir(here) && isAir(above) && isSolid(below) && !isLiquid(below) && !isInteractive(below)) {
          cands.push({ p, d: Math.abs(dx) + Math.abs(dz) + Math.abs(dy) });
        }
      }
    }
  }
  cands.sort((a, b) => a.d - b.d);
  return cands[0]?.p ?? null;
}

/** Place a utility block (crafting_table, furnace, chest...) from inventory next to the bot. Returns its position. */
export async function placeNearby(ctx, itemName) {
  const bot = ctx.bot;
  const item = findItem(bot, itemName);
  if (!item) throw new SkillError(`No ${itemName} in inventory to place.`);
  const failed = [];
  let lastErr;
  for (let i = 0; i < 4; i++) {
    const spot = findAdjacentSpot(bot, 2, failed);
    if (!spot) throw new SkillError(lastErr ? `Could not place ${itemName}: ${lastErr.message}` : `No free flat spot next to me to place a ${itemName}. Move to open ground first.`);
    try {
      await placeItemAt(ctx, item, spot, { stand: true });
      return spot;
    } catch (e) {
      if (e.message === 'Aborted') throw e;
      lastErr = e;
      failed.push(spot);
      await sleep(ctx, 150);
    }
  }
  throw new SkillError(`Could not place ${itemName}: ${lastErr?.message ?? 'unknown error'}.`);
}

/** Items on the ground near a position (entity name "item"). */
export function droppedItemsNear(bot, pos, radius = 6) {
  return Object.values(bot.entities).filter((e) => (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(pos) <= radius);
}

/** All dropped item entities within radius of `pos` (default: the bot), nearest first, with the item name/count when known. */
export function listDrops(bot, pos = bot.entity.position, radius = 16) {
  return droppedItemsNear(bot, pos, radius)
    .map((e) => {
      let it = null;
      try { it = e.getDroppedItem?.(); } catch { /* ignore */ }
      return { e, name: it?.name ?? '?', count: it?.count ?? 1, d: e.position.distanceTo(bot.entity.position) };
    })
    .sort((a, b) => a.d - b.d);
}

/** Walk over to nearby dropped items so they get picked up (bounded, never digs). Returns {name: gained}. */
export async function collectDrops(ctx, pos, { radius = 6, maxMs = 6000, filter } = {}) {
  const bot = ctx.bot;
  const before = inventoryCounts(bot);
  const end = Date.now() + Math.min(maxMs, Math.max(2500, timeLeft(ctx) - 500)); // the Agent deadline already leaves ~10s of slack
  let guard = 0;
  const skipped = new Set();
  while (Date.now() < end && guard++ < 12) {
    checkAbort(ctx);
    const drops = listDrops(bot, pos, radius).filter((d) => !skipped.has(d.e.id) && (!filter || filter(d)));
    if (!drops.length) break;
    const d = drops[0];
    if (d.d > 1.0) {
      try {
        await moveTo(ctx, new goals.GoalNear(d.e.position.x, d.e.position.y, d.e.position.z, 0.7), { timeoutMs: Math.max(1500, end - Date.now()), noUnstick: true, dig: false, label: 'dropped item' });
      } catch (err) { if (err.message === 'Aborted') throw err; skipped.add(d.e.id); continue; }
    }
    await sleep(ctx, 250);
    if (bot.entities[d.e.id]) skipped.add(d.e.id); // still there after reaching it: inventory full / not pickable
  }
  await sleep(ctx, 150);
  const after = inventoryCounts(bot);
  const gained = {};
  for (const [n, c] of Object.entries(after)) if (c > (before[n] ?? 0)) gained[n] = c - (before[n] ?? 0);
  return gained;
}

// ---------------------------------------------------------------- fast block scanning

const stateToBlock = new WeakMap();
function stateMap(registry) {
  let m = stateToBlock.get(registry);
  if (!m) {
    m = new Int32Array(Math.max(...Object.keys(registry.blocksByStateId).map(Number)) + 2).fill(-1);
    for (const [sid, b] of Object.entries(registry.blocksByStateId)) m[sid] = b.id;
    stateToBlock.set(registry, m);
  }
  return m;
}

function scanCore(bot, idSet, { point, maxDistance }, onHit) {
  const p = (point ?? bot.entity.position).floored();
  const map = stateMap(bot.registry);
  const minY = bot.game?.minY ?? -64;
  const nSections = (bot.game?.height ?? 384) >> 4;
  const r = Math.ceil(maxDistance);
  const x0 = (p.x - r) >> 4, x1 = (p.x + r) >> 4, z0 = (p.z - r) >> 4, z1 = (p.z + r) >> 4;
  const s0 = Math.max(0, (p.y - r - minY) >> 4), s1 = Math.min(nSections - 1, (p.y + r - minY) >> 4);
  const maxSq = maxDistance * maxDistance;
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const col = bot.world.getColumn(cx, cz);
      if (!col) continue;
      for (let si = s0; si <= s1; si++) {
        const sec = col.sections[si];
        if (!sec || !sec.data) continue;
        const data = sec.data;
        let states = null;
        if (data.palette) states = data.palette;
        else if (data.value !== undefined) states = [data.value]; // uniform section: skip unless it is the wanted block
        if (states) {
          let any = false;
          for (const sid of states) if (idSet.has(map[sid])) { any = true; break; }
          if (!any) continue;
        }
        const baseX = cx << 4, baseZ = cz << 4, baseY = si * 16 + minY;
        for (let y = 0; y < 16; y++) {
          const wy = baseY + y;
          const dy = wy - p.y;
          if (dy * dy > maxSq) continue;
          for (let z = 0; z < 16; z++) {
            const dz = baseZ + z - p.z;
            for (let x = 0; x < 16; x++) {
              const bid = map[data.get((y << 8) | (z << 4) | x)];
              if (!idSet.has(bid)) continue;
              const dx = baseX + x - p.x;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > maxSq) continue;
              onHit(baseX + x, wy, baseZ + z, bid, d2);
            }
          }
        }
      }
    }
  }
  return p;
}

/**
 * Find blocks whose block id is in `ids` (Set<number>) around `point`. Much faster than bot.findBlocks on 1.21.5+/26.x,
 * where uniform (all-air / all-stone) chunk sections are SingleValueContainers without a palette and findBlocks
 * brute-forces all 4096 blocks of every one. Returns Vec3[] sorted by distance, at most `count`.
 */
export function scanBlocks(bot, ids, { point, maxDistance = 32, count = 64, filter } = {}) {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  const out = [];
  const p = scanCore(bot, idSet, { point, maxDistance }, (x, y, z) => {
    const v = new Vec3(x, y, z);
    if (!filter || filter(v)) out.push(v);
  });
  out.sort((a, b) => a.distanceSquared(p) - b.distanceSquared(p));
  return out.length > count ? out.slice(0, count) : out;
}

/**
 * One pass over the world for several block groups. groupOf: Map<blockId, groupName>.
 * Returns { group: [{pos: Vec3, id, d}] } with the `perGroup` nearest hits of each group.
 */
export function scanGroups(bot, groupOf, { point, maxDistance = 24, perGroup = 3 } = {}) {
  const res = {};
  const idSet = new Set(groupOf.keys());
  scanCore(bot, idSet, { point, maxDistance }, (x, y, z, bid, d2) => {
    const g = groupOf.get(bid);
    const arr = (res[g] ??= []);
    if (arr.length >= perGroup && d2 >= arr[arr.length - 1].d2) return;
    arr.push({ x, y, z, id: bid, d2 });
    arr.sort((a, b) => a.d2 - b.d2);
    if (arr.length > perGroup) arr.pop();
  });
  for (const g of Object.keys(res)) res[g] = res[g].map((h) => ({ pos: new Vec3(h.x, h.y, h.z), id: h.id, d: Math.sqrt(h.d2) }));
  return res;
}

/**
 * Highest non-air block of every column within `radius` of the bot (cheap: skips uniform air sections).
 * Returns Vec3[] of the cell ABOVE the top block, nearest first.
 */
export function surfaceCells(bot, { point, radius = 32, max = 80 } = {}) {
  const p = (point ?? bot.entity.position).floored();
  const map = stateMap(bot.registry);
  const air = new Set(['air', 'cave_air', 'void_air'].map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined));
  const minY = bot.game?.minY ?? -64;
  const nSections = (bot.game?.height ?? 384) >> 4;
  const out = [];
  for (let x = p.x - radius; x <= p.x + radius; x += 1) {
    for (let z = p.z - radius; z <= p.z + radius; z += 1) {
      if ((x - p.x) ** 2 + (z - p.z) ** 2 > radius * radius) continue;
      const col = bot.world.getColumn(x >> 4, z >> 4);
      if (!col) continue;
      let found = false;
      for (let si = nSections - 1; si >= 0 && !found; si--) {
        const sec = col.sections[si];
        if (!sec?.data) continue;
        if (sec.data.value !== undefined && !sec.data.palette && air.has(map[sec.data.value])) continue;
        for (let y = 15; y >= 0; y--) {
          const bid = map[sec.data.get((y << 8) | ((z & 15) << 4) | (x & 15))];
          if (!air.has(bid)) {
            out.push({ v: new Vec3(x, si * 16 + minY + y + 1, z), d: (x - p.x) ** 2 + (z - p.z) ** 2 });
            found = true;
            break;
          }
        }
      }
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, max).map((o) => o.v);
}

/** Goal to get within reach of a block. Non-solid blocks (crops, flowers, cane) cannot be ray-cast, so use a distance goal. */
export function goalForBlock(bot, pos, block) {
  const b = block ?? blockAtSafe(bot, pos);
  if (b && b.boundingBox === 'block') return new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 });
  return new goals.GoalNear(pos.x, pos.y, pos.z, 3);
}
