// Crafting, smelting and furnace skills.
import {
  SkillError, goals, checkAbort, sleep, fmtPos, intArg, resolveItem, inventoryCounts, formatCounts, findNearestBlock,
  placeNearby, withTimeout, findItem, countItem, normName, waitUntil, moveTo, closeOpenWindow, timeLeft, budgetMs, vecFrom,
  blockAtSafe, digBlock, collectDrops, isAir,
} from './util.js';

const AUTO_INTERMEDIATE = /(^planks\*$|_planks$|^stick$|^crafting_table$)/;

// ------------------------------------------------------------------ recipe planner
// minecraft-data lists one recipe per wood type / log type / coal type. The game accepts ANY item of the tag, so we
// collapse those variants into "families" and mix types freely (instantiated per craft from the live inventory).

const FAMILIES = [
  ['planks*', /_planks$/],
  ['logs*', /(_log|_wood|_stem|_hyphae)$/],
  ['coal*', /^(coal|charcoal)$/],
];
const FAMILY_LABEL = { 'planks*': 'planks (any type)', 'logs*': 'log (any wood type)', 'coal*': 'coal or charcoal' };

function famOf(name, resultName) {
  for (const [f, re] of FAMILIES) {
    if (!re.test(name)) continue;
    if (f === 'logs*' && /_planks$/.test(resultName)) continue; // planks_from_X_log recipes are type specific
    return f;
  }
  return null;
}
const keyOf = (name, resultName) => famOf(name, resultName) ?? name;

function haveOf(inv, key) {
  if (!key.endsWith('*')) return inv[key] ?? 0;
  const re = FAMILIES.find(([f]) => f === key)[1];
  let n = 0;
  for (const [k, v] of Object.entries(inv)) if (re.test(k)) n += v;
  return n;
}
function takeFrom(inv, key, n) {
  if (!key.endsWith('*')) { inv[key] = (inv[key] ?? 0) - n; return; }
  const re = FAMILIES.find(([f]) => f === key)[1];
  const names = Object.keys(inv).filter((k) => re.test(k) && inv[k] > 0).sort((a, b) => inv[b] - inv[a]);
  for (const k of names) {
    const t = Math.min(inv[k], n);
    inv[k] -= t; n -= t;
    if (n <= 0) break;
  }
}

const abstractCache = new WeakMap();
/** Abstract recipes for an item: [{ recipe (template), ings: [{key,count}], resultCount, requiresTable }] */
function abstractRecipes(bot, name) {
  let m = abstractCache.get(bot.registry);
  if (!m) abstractCache.set(bot.registry, (m = new Map()));
  if (m.has(name)) return m.get(name);
  const it = bot.registry.itemsByName[name];
  const out = [];
  if (it) {
    const seen = new Set();
    for (const r of bot.recipesAll(it.id, null, true)) {
      const counts = {};
      for (const d of r.delta) {
        if (d.count >= 0) continue;
        const ing = bot.registry.items[d.id]?.name ?? `item#${d.id}`;
        const k = keyOf(ing, name);
        counts[k] = (counts[k] ?? 0) - d.count;
      }
      const ings = Object.entries(counts).map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
      const sig = `${r.requiresTable}|${r.result.count}|${ings.map((i) => `${i.key}:${i.count}`).join(',')}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ recipe: r, ings, resultCount: r.result.count, requiresTable: !!r.requiresTable });
    }
  }
  m.set(name, out);
  return out;
}

/** Plan: produce at least `qty` more of `name` (a real item name or a family key). */
function produce(bot, name, qty, inv, depth = 0) {
  if (name.endsWith('*')) {
    const re = FAMILIES.find(([f]) => f === name)[1];
    let best = null;
    for (const n of Object.keys(bot.registry.itemsByName).filter((x) => re.test(x))) {
      const p = produce(bot, n, qty, inv, depth);
      if (!p.noRecipe && (!best || (p.ok && !best.ok) || (p.ok === best.ok && p.missCount < best.missCount) || (p.ok === best.ok && p.missCount === best.missCount && p.steps.length < best.steps.length))) best = p;
      if (best?.ok && best.steps.length === 1) break;
    }
    return best ?? { ok: false, steps: [], missing: { [name]: qty }, inv, noRecipe: true, missCount: qty };
  }
  const recipes = abstractRecipes(bot, name);
  if (!recipes.length) return { ok: false, steps: [], missing: { [name]: qty }, inv, noRecipe: true, missCount: qty };
  let best = null;
  for (const ar of recipes) {
    const sim = { ...inv };
    const steps = [];
    const missing = {};
    const times = Math.ceil(qty / ar.resultCount);
    for (const ing of ar.ings) {
      const need = ing.count * times;
      const have = haveOf(sim, ing.key);
      if (have >= need) { takeFrom(sim, ing.key, need); continue; }
      const short = need - have;
      takeFrom(sim, ing.key, have);
      if (depth < 3 && AUTO_INTERMEDIATE.test(ing.key)) {
        const sub = produce(bot, ing.key, short, sim, depth + 1);
        if (sub.ok) {
          steps.push(...sub.steps);
          Object.assign(sim, sub.inv);
          takeFrom(sim, ing.key, short);
          continue;
        }
        for (const [k, v] of Object.entries(sub.missing)) missing[k] = (missing[k] ?? 0) + v;
      } else {
        missing[ing.key] = (missing[ing.key] ?? 0) + short;
      }
    }
    const missCount = Object.values(missing).reduce((a, b) => a + b, 0);
    steps.push({ ar, times, name });
    sim[name] = (sim[name] ?? 0) + times * ar.resultCount;
    const cand = { ok: missCount === 0, steps, missing, inv: sim, missCount };
    if (!best || cand.missCount < best.missCount || (cand.missCount === best.missCount && cand.steps.length < best.steps.length)) best = cand;
  }
  return best;
}

function friendlyMissing(missing) {
  const agg = {};
  for (const [n, c] of Object.entries(missing)) {
    const label = FAMILY_LABEL[n] ?? (/_log$/.test(n) ? 'log (any wood type)' : /_planks$/.test(n) ? 'planks (any type)' : n);
    agg[label] = (agg[label] ?? 0) + c;
  }
  return Object.entries(agg).map(([l, c]) => `${c} ${l}`).join(', ');
}

function pickPlan(bot, names, qty, inv) {
  let best = null;
  for (const n of names) {
    const p = produce(bot, n, qty, inv);
    p.name = n;
    if (!best || (p.ok && !best.ok) || (p.ok === best.ok && p.missCount < best.missCount)) best = p;
    if (best.ok) break;
  }
  return best;
}

/** Concrete recipe for one craft: every family slot gets a real item type that is in the live inventory. */
function instantiate(bot, ar, resultName) {
  const inv = inventoryCounts(bot);
  const pickFor = (id) => {
    const nm = bot.registry.items[id]?.name;
    const f = nm && famOf(nm, resultName);
    if (!f) return id;
    const re = FAMILIES.find(([k]) => k === f)[1];
    const best = Object.entries(inv).filter(([k, v]) => re.test(k) && v > 0).sort((a, b) => b[1] - a[1])[0];
    if (!best) return id;
    inv[best[0]]--;
    return bot.registry.itemsByName[best[0]].id;
  };
  const r = ar.recipe;
  const copy = { ...r };
  if (r.inShape) copy.inShape = r.inShape.map((row) => row.map((c) => (c.id === -1 ? { ...c } : { ...c, id: pickFor(c.id) })));
  if (r.ingredients) copy.ingredients = r.ingredients.map((c) => ({ ...c, id: pickFor(c.id) }));
  return copy;
}

async function pacedClicks(bot, fn, delayMs = 100) {
  // mineflayer's craft() fires window clicks back-to-back; on Paper 26.1 about half of the 3x3 crafts are then rejected.
  const orig = bot.clickWindow;
  bot.clickWindow = async (...a) => {
    const r = await orig.apply(bot, a);
    await new Promise((res) => setTimeout(res, delayMs));
    return r;
  };
  try {
    return await fn();
  } finally {
    bot.clickWindow = orig;
  }
}

async function craftSteps(ctx, steps, table) {
  return pacedClicks(ctx.bot, () => craftStepsInner(ctx, steps, table));
}

async function craftStepsInner(ctx, steps, table) {
  const bot = ctx.bot;
  for (const s of steps) {
    const resName = bot.registry.items[s.ar.recipe.result.id]?.name;
    if (s.ar.requiresTable && !table) throw new SkillError('A crafting table is required but none is available.');
    // bot.craft(recipe, N) fires N crafts back-to-back and desyncs from the server: craft one at a time and verify.
    for (let i = 0; i < s.times; i++) {
      checkAbort(ctx);
      closeOpenWindow(bot); // never craft with a stale window open
      const before = countItem(bot, resName);
      const concrete = instantiate(bot, s.ar, resName);
      try {
        await withTimeout(ctx, bot.craft(concrete, 1, s.ar.requiresTable ? table : null), 15000, `Crafting ${s.name}`, () => closeOpenWindow(bot));
      } catch (err) {
        closeOpenWindow(bot);
        if (err instanceof SkillError) throw err;
        throw new SkillError(`Crafting ${s.name} failed: ${err.message}`);
      }
      const ok = await waitUntil(ctx, () => countItem(bot, resName) >= before + s.ar.resultCount, 3000, 50);
      if (!ok) {
        closeOpenWindow(bot);
        throw new SkillError(`Crafting ${s.name} did not produce anything (the server rejected the craft; inventory full or ingredients changed?).`);
      }
      await sleep(ctx, 120);
    }
  }
  closeOpenWindow(bot);
}

/** A crafting table within reach: prefer an existing one nearby (walk to it), else place one from inventory. */
async function ensureTable(ctx) {
  const bot = ctx.bot;
  const table = findNearestBlock(ctx, 'crafting_table', 32);
  if (table) {
    if (bot.entity.position.distanceTo(table.position.offset(0.5, 0.5, 0.5)) <= 3.8) return { table, placed: false };
    try {
      await moveTo(ctx, new goals.GoalGetToBlock(table.position.x, table.position.y, table.position.z), { label: 'crafting table', timeoutMs: 40000, dig: false });
      return { table, placed: false };
    } catch (err) {
      if (err.message === 'Aborted' || !findItem(bot, 'crafting_table')) throw err;
      ctx.log?.(`nearby crafting table unreachable (${err.message}); placing my own`);
    }
  }
  if (!findItem(bot, 'crafting_table')) return null;
  const pos = await placeNearby(ctx, 'crafting_table');
  return { table: bot.blockAt(pos), placed: true };
}

/** Pick the table we placed back up, unless it is near a saved place (a base). */
async function recoverTable(ctx, info) {
  try {
    const t = info.table;
    const places = ctx.memory?.listPlaces?.() ?? [];
    if (places.some((p) => Math.hypot(p.x - t.position.x, p.z - t.position.z) < 40)) return false;
    const cur = blockAtSafe(ctx.bot, t.position);
    if (cur?.name !== 'crafting_table') return false;
    if (ctx.bot.entity.position.distanceTo(t.position.offset(0.5, 0.5, 0.5)) > 4) return false;
    await digBlock(ctx, cur, { timeoutMs: 6000 });
    await collectDrops(ctx, t.position.offset(0.5, 0.5, 0.5), { radius: 4, maxMs: 2500 });
    return true;
  } catch (e) {
    if (e.message === 'Aborted') throw e;
    return false;
  }
}

export async function craftItem(ctx, rawName, count = 1) {
  const bot = ctx.bot;
  const res = resolveItem(ctx, rawName);
  const inv = inventoryCounts(bot);
  let plan = pickPlan(bot, res.names, count, inv);
  if (!plan) throw new SkillError(`No recipe found for ${rawName}.`);
  if (plan.noRecipe) throw new SkillError(`${plan.name} cannot be crafted (no crafting recipe). It may be a raw resource: mine it (collect_block) or smelt_item.`);
  const target = plan.name;
  const notes = [];
  const needsTable = plan.steps.some((s) => s.ar.requiresTable);
  let tableSteps = [];
  if (needsTable) {
    const existing = findNearestBlock(ctx, 'crafting_table', 32);
    if (!existing && !findItem(bot, 'crafting_table')) {
      const tp = produce(bot, 'crafting_table', 1, inv);
      if (!tp.ok) throw new SkillError(`Cannot craft ${target}: no crafting table nearby or in inventory, and cannot make one: missing ${friendlyMissing(tp.missing)}.`);
      tableSteps = tp.steps;
      const plan2 = produce(bot, target, count, tp.inv);
      if (!plan2.ok) throw new SkillError(`Cannot craft ${count} ${target}: missing ${friendlyMissing(plan2.missing)} (after reserving materials for a crafting table, which is needed too).`);
      plan = plan2;
    }
  }
  if (!plan.ok) throw new SkillError(`Cannot craft ${count} ${target}: missing ${friendlyMissing(plan.missing)}. Inventory: ${formatCounts(inv, 15)}.`);
  const before = countItem(bot, target);
  if (tableSteps.length) {
    await craftSteps(ctx, tableSteps, null);
    notes.push('crafted crafting_table');
  }
  let tableInfo = null;
  if (needsTable) {
    tableInfo = await ensureTable(ctx);
    if (!tableInfo) throw new SkillError('Crafting table could not be found or placed.');
    if (tableInfo.placed) notes.push(`placed crafting_table at ${fmtPos(tableInfo.table.position)}`);
  }
  const intermediates = plan.steps.filter((s) => s.name !== target);
  try {
    await craftSteps(ctx, plan.steps, tableInfo?.table ?? null);
  } finally {
    if (tableInfo?.placed && !ctx.signal?.aborted) {
      if (await recoverTable(ctx, tableInfo)) {
        const i = notes.findIndex((n) => n.startsWith('placed crafting_table'));
        if (i >= 0) notes.splice(i, 1);
        notes.push('picked the crafting_table back up');
      }
    }
  }
  for (const s of intermediates) notes.push(`made ${s.times * s.ar.resultCount} ${s.name}`);
  const gained = countItem(bot, target) - before;
  if (gained <= 0) throw new SkillError(`Crafting ${target} did not produce anything (inventory full?).`);
  return `Crafted ${gained} ${target}${notes.length ? ' (' + [...new Set(notes)].join('; ') + ')' : ''}. Inventory now has ${countItem(bot, target)} ${target}.`;
}

// ------------------------------------------------------------------ smelting

const SMELTABLE = {
  raw_iron: 'iron_ingot', iron_ore: 'iron_ingot', deepslate_iron_ore: 'iron_ingot',
  raw_gold: 'gold_ingot', gold_ore: 'gold_ingot', deepslate_gold_ore: 'gold_ingot', nether_gold_ore: 'gold_nugget',
  raw_copper: 'copper_ingot', copper_ore: 'copper_ingot', deepslate_copper_ore: 'copper_ingot',
  ancient_debris: 'netherite_scrap', sand: 'glass', red_sand: 'glass', cobblestone: 'stone', stone: 'smooth_stone', clay_ball: 'brick',
  clay: 'terracotta', netherrack: 'nether_brick', cactus: 'green_dye', kelp: 'dried_kelp', potato: 'baked_potato', beef: 'cooked_beef',
  porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod',
  salmon: 'cooked_salmon', coal_ore: 'coal', deepslate_coal_ore: 'coal', lapis_ore: 'lapis_lazuli', redstone_ore: 'redstone',
  diamond_ore: 'diamond', emerald_ore: 'emerald', quartz_ore: 'quartz', wet_sponge: 'sponge', sea_pickle: 'lime_dye',
};
for (const w of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']) SMELTABLE[`${w}_log`] = 'charcoal';

const FUEL_ITEMS = [
  ['coal', 8], ['charcoal', 8], ['coal_block', 80], ['blaze_rod', 12], ['dried_kelp_block', 20],
  ['_planks', 1.5], ['_log', 1.5], ['stick', 0.5], ['bamboo', 0.25],
];
function fuelValue(name) {
  for (const [k, v] of FUEL_ITEMS) if (k.startsWith('_') ? name.endsWith(k) : name === k) return v;
  return 0;
}

function resolveSmeltInput(ctx, raw) {
  const bot = ctx.bot;
  const norm = normName(raw);
  const inv = inventoryCounts(bot);
  const cands = [norm, `raw_${norm}`, `${norm}_ore`, norm.replace(/s$/, ''), `raw_${norm.replace(/s$/, '')}`];
  if (norm === 'log' || norm === 'logs' || norm === 'wood') {
    const l = Object.keys(inv).find((n) => n.endsWith('_log'));
    if (l) cands.unshift(l);
  }
  if (norm === 'iron' || norm === 'gold' || norm === 'copper') cands.unshift(`raw_${norm}`);
  for (const c of cands) if (SMELTABLE[c] && inv[c]) return c;
  for (const c of cands) if (SMELTABLE[c]) return c;
  const r = resolveItem(ctx, raw);
  const hit = r.names.find((n) => SMELTABLE[n] && inv[n]) ?? r.names.find((n) => SMELTABLE[n]);
  if (hit) return hit;
  throw new SkillError(`${raw} is not something I know how to smelt. Smeltable: ores/raw metals, sand, cobblestone, clay_ball, logs (charcoal), raw food.`);
}

/** Plain bounded promise (NOT tied to ctx.signal): used for cleanup that must still run after an abort. */
function bound(p, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

const lastSmelt = new WeakMap(); // bot -> { pos, input, output, n, t }

async function openFurnaceBlock(ctx, furnaceBlock) {
  const bot = ctx.bot;
  if (bot.entity.position.distanceTo(furnaceBlock.position.offset(0.5, 0.5, 0.5)) > 3.5) {
    await moveTo(ctx, new goals.GoalGetToBlock(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z), { label: 'furnace', timeoutMs: 40000, dig: false });
  }
  closeOpenWindow(bot);
  try {
    return await withTimeout(ctx, bot.openFurnace(furnaceBlock), 8000, 'Opening furnace', () => closeOpenWindow(bot));
  } catch (err) {
    closeOpenWindow(bot);
    if (err instanceof SkillError) throw err;
    throw new SkillError(`Could not open furnace at ${fmtPos(furnaceBlock.position)}: ${err.message}`);
  }
}

async function takeOut(furnace, what) {
  const it = what === 'output' ? furnace.outputItem() : what === 'input' ? furnace.inputItem() : furnace.fuelItem();
  if (!it) return null;
  const fn = what === 'output' ? furnace.takeOutput : what === 'input' ? furnace.takeInput : furnace.takeFuel;
  const got = await bound(fn.call(furnace), 4000);
  return got ? { name: got.name, count: got.count } : null;
}

function furnaceState(furnace) {
  const i = furnace.inputItem(), f = furnace.fuelItem(), o = furnace.outputItem();
  return `input ${i ? `${i.name}x${i.count}` : 'empty'}, fuel ${f ? `${f.name}x${f.count}` : 'empty'}, output ${o ? `${o.name}x${o.count}` : 'empty'}`;
}

export async function smeltItem(ctx, rawInput, count = 1, rawFuel) {
  const bot = ctx.bot;
  const input = resolveSmeltInput(ctx, rawInput);
  const output = SMELTABLE[input];
  const have = countItem(bot, input);
  if (have === 0) {
    const last = lastSmelt.get(bot);
    const hint = last && last.input === input ? ` ${last.n} ${input} may still be in the furnace at ${fmtPos(last.pos)}: use furnace_collect.` : '';
    throw new SkillError(`No ${input} in inventory to smelt. Inventory: ${formatCounts(inventoryCounts(bot), 15)}.${hint}`);
  }
  const stack = bot.registry.itemsByName[input].stackSize ?? 64;
  let n = Math.min(count, have, stack);
  const notes = [];

  // fuel
  let fuelName;
  if (rawFuel) {
    const r = resolveItem(ctx, rawFuel);
    fuelName = r.names.find((x) => countItem(bot, x) > 0 && fuelValue(x) > 0) ?? r.names.find((x) => countItem(bot, x) > 0);
    if (!fuelName) throw new SkillError(`You have no ${rawFuel} to use as fuel.`);
    if (!fuelValue(fuelName)) throw new SkillError(`${fuelName} is not a furnace fuel.`);
  } else {
    const inv = inventoryCounts(bot);
    const cand = Object.keys(inv).filter((x) => fuelValue(x) > 0 && x !== input);
    cand.sort((a, b) => (/_log$/.test(a) ? 1 : 0) - (/_log$/.test(b) ? 1 : 0) || fuelValue(b) - fuelValue(a));
    fuelName = cand[0];
    if (!fuelName) throw new SkillError('No fuel in inventory (coal, charcoal, planks, logs or sticks). Collect some coal or wood first.');
  }
  const perFuel = fuelValue(fuelName) || 1;
  const fuelAvail = countItem(bot, fuelName) - (fuelName === input ? n : 0);
  if (fuelAvail <= 0) throw new SkillError(`Not enough ${fuelName} to use as fuel.`);
  let fuelNeed = Math.ceil(n / perFuel);
  if (fuelNeed > fuelAvail) {
    n = Math.max(1, Math.floor(fuelAvail * perFuel));
    fuelNeed = fuelAvail;
    notes.push(`only enough ${fuelName} for ${n}`);
  }

  // furnace: nearest, else place/craft one. An unreachable one falls back to placing our own.
  let furnaceBlock = findNearestBlock(ctx, 'furnace', 32);
  let furnace = null;
  if (furnaceBlock) {
    try {
      furnace = await openFurnaceBlock(ctx, furnaceBlock);
    } catch (err) {
      if (err.message === 'Aborted') throw err;
      if (!findItem(bot, 'furnace') && countItem(bot, 'cobblestone') < 8) throw err;
      ctx.log?.(`furnace unusable (${err.message}); placing my own`);
      furnaceBlock = null;
    }
  }
  if (!furnace) {
    if (!findItem(bot, 'furnace')) {
      if (countItem(bot, 'cobblestone') >= 8) {
        await craftItem(ctx, 'furnace', 1);
        notes.push('crafted furnace');
      } else throw new SkillError('No furnace nearby or in inventory, and I have fewer than 8 cobblestone to craft one. Mine cobblestone first.');
    }
    const pos = await placeNearby(ctx, 'furnace');
    furnaceBlock = bot.blockAt(pos);
    notes.push(`placed furnace at ${fmtPos(pos)}`);
    furnace = await openFurnaceBlock(ctx, furnaceBlock);
  }
  const fpos = furnaceBlock.position;

  let taken = 0;
  let aborted = false;
  const collect = async () => {
    const out = furnace.outputItem();
    if (out && out.name === output) {
      const t = await takeOut(furnace, 'output');
      if (t) taken += t.count;
    }
  };
  try {
    const cur = furnace.inputItem();
    if (cur && cur.name !== input) {
      throw new SkillError(`The furnace at ${fmtPos(fpos)} is busy smelting ${cur.name}x${cur.count}. Use furnace_collect (take: "all") first, or wait.`);
    }
    const stale = furnace.outputItem();
    if (stale && stale.name !== output) await takeOut(furnace, 'output');
    const inId = bot.registry.itemsByName[input].id;
    const room = stack - (cur?.count ?? 0);
    n = Math.min(n, room);
    if (n <= 0) throw new SkillError(`The furnace input slot at ${fmtPos(fpos)} is already full of ${input}.`);
    await withTimeout(ctx, furnace.putInput(inId, null, n), 6000, 'Putting input in furnace', () => closeOpenWindow(bot));
    const fuelItem = furnace.fuelItem();
    const burning = (furnace.fuel ?? 0) > 0;
    if (!fuelItem || fuelItem.name === fuelName || !burning) {
      if (fuelItem && fuelItem.name !== fuelName) await takeOut(furnace, 'fuel');
      await withTimeout(ctx, furnace.putFuel(bot.registry.itemsByName[fuelName].id, null, fuelNeed), 6000, 'Putting fuel in furnace', () => closeOpenWindow(bot));
    } else notes.push(`the furnace already burns ${fuelItem.name}`);
    lastSmelt.set(bot, { pos: fpos, input, output, n, t: Date.now() });

    const need = n + (cur?.count ?? 0);
    const wantMs = need * 10300 + 1500;
    const end = Date.now() + Math.min(wantMs, Math.max(0, timeLeft(ctx) - 5000), 170000);
    while (Date.now() < end) {
      await sleep(ctx, 700);
      const o = furnace.outputItem();
      if (o && (o.count >= need - taken || !furnace.inputItem())) await collect();
      if (taken >= need) break;
      if (!furnace.inputItem() && !furnace.outputItem()) break;
    }
    await collect();
  } catch (err) {
    if (err.message !== 'Aborted') {
      closeOpenWindow(bot);
      throw err;
    }
    aborted = true;
  }
  // cleanup that must run even after an abort: 3 s bounded, not tied to ctx.signal
  try {
    if (furnace.outputItem()?.name === output) { const t = await takeOut(furnace, 'output'); if (t) taken += t.count; }
  } catch { /* ignore */ }
  const left = furnace.inputItem();
  const stillIn = left ? left.count : 0;
  const fuelLeft = furnace.fuelItem();
  closeOpenWindow(bot);
  const msgTail = stillIn > 0 ? ` ${stillIn} ${left.name} still smelting in the furnace at ${fmtPos(fpos)} (fuel left ${fuelLeft ? fuelLeft.name + 'x' + fuelLeft.count : 'none'}): call furnace_collect later.` : '';
  const head = `Smelted ${taken} ${input} into ${output} using ${fuelName}${notes.length ? ' (' + notes.join('; ') + ')' : ''}.`;
  if (aborted) throw new SkillError(`Aborted. ${head}${msgTail}`);
  if (taken <= 0 && stillIn <= 0) throw new SkillError(`Smelting produced nothing (input ${input}, fuel ${fuelName}). The furnace at ${fmtPos(fpos)} may be blocked.`);
  await sleep(ctx, 200).catch(() => {});
  return `${head}${msgTail}${taken > 0 ? ` Inventory has ${countItem(bot, output)} ${output}.` : ''}`;
}

export async function furnaceCollect(ctx, args = {}) {
  const bot = ctx.bot;
  let block;
  if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
    block = blockAtSafe(bot, vecFrom(args));
    if (!block || !/furnace|smoker/.test(block.name)) throw new SkillError(`No furnace at ${fmtPos(vecFrom(args))} (found ${block?.name ?? 'nothing'}).`);
  } else {
    const last = lastSmelt.get(bot);
    const b = last && blockAtSafe(bot, last.pos);
    block = b && /furnace|smoker/.test(b.name) ? b : findNearestBlock(ctx, ['furnace', 'blast_furnace', 'smoker'], 40);
    if (!block) throw new SkillError('No furnace within 40 blocks. Give x,y,z of the furnace.');
  }
  const furnace = await openFurnaceBlock(ctx, block);
  const got = {};
  try {
    const add = (t) => { if (t) got[t.name] = (got[t.name] ?? 0) + t.count; };
    add(await takeOut(furnace, 'output'));
    if (args.take === 'all') { add(await takeOut(furnace, 'input')); add(await takeOut(furnace, 'fuel')); }
    const state = furnaceState(furnace);
    const prog = furnace.progress != null && furnace.inputItem() ? ` progress ${Math.round(furnace.progress * 100)}%` : '';
    closeOpenWindow(bot);
    await sleep(ctx, 300);
    return `${Object.keys(got).length ? 'Took ' + formatCounts(got, 10) : 'Nothing to take yet'} from the furnace at ${fmtPos(block.position)}. Now: ${state}${prog}.`;
  } finally {
    closeOpenWindow(bot);
  }
}

// ------------------------------------------------------------------ skills

export const craftSkills = [
  {
    name: 'craft_item',
    description: 'Craft `count` ITEMS (e.g. count 8 planks). Uses/places a crafting table as needed and auto-crafts planks, sticks and a table. Mixed wood types are fine. Errors list exactly what is missing.',
    params: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'e.g. wooden_pickaxe, planks, stick, torch' },
        count: { type: 'integer', minimum: 1, maximum: 256 },
      },
      required: ['item'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      return craftItem(ctx, args.item, intArg(args.count, 1, 1, 256));
    },
  },
  {
    name: 'get_recipe',
    description: 'Show how an item is crafted (ingredients, yield, table needed) and what you currently lack. "*" = any wood type.',
    params: {
      type: 'object',
      properties: { item: { type: 'string' } },
      required: ['item'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const res = resolveItem(ctx, args.item);
      const inv = inventoryCounts(bot);
      const lines = [];
      for (const name of res.names.slice(0, res.generic ? 3 : 1)) {
        const recipes = abstractRecipes(bot, name);
        if (!recipes.length) {
          lines.push(`${name}: no crafting recipe (raw resource, or obtained by smelting/mining/trading).`);
          continue;
        }
        const fmtI = (i) => `${i.count} ${i.key.endsWith('*') ? i.key.replace('*', '(any)') : i.key}`;
        const plan = produce(bot, name, 1, inv);
        // the recipe the plan uses first, then the others
        const used = plan.steps.at(-1)?.ar;
        const ordered = used ? [used, ...recipes.filter((r) => r !== used)] : recipes;
        const out = ordered.slice(0, 3).map((r) => `${r.ings.map(fmtI).join(' + ')} -> ${r.resultCount} ${name}${r.requiresTable ? ' [crafting table]' : ' [no table]'}`);
        const status = plan.ok ? 'You can craft it now.' : `You lack: ${friendlyMissing(plan.missing)}.`;
        lines.push(`${name}: ${out.join(' | ')}${recipes.length > 3 ? ` (+${recipes.length - 3} variants)` : ''}. ${status}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'smelt_item',
    description: 'Load a furnace (uses nearby one, else places/crafts one; needs fuel) and collect the result (~10s per item). If time runs short the rest keeps smelting: the reply says so; collect later with furnace_collect. Input e.g. raw_iron, sand, cobblestone, log (charcoal), beef.',
    params: {
      type: 'object',
      properties: {
        input: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 64 },
        fuel: { type: 'string', description: 'optional: coal, charcoal, oak_planks...' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      return smeltItem(ctx, args.input, intArg(args.count, 1, 1, 64), args.fuel);
    },
  },
  {
    name: 'furnace_collect',
    description: 'Take the smelted output out of the nearest furnace (or the one at x,y,z / last used). take:"all" also takes back unsmelted input and fuel.',
    params: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, take: { type: 'string', enum: ['output', 'all'] } },
      additionalProperties: false,
    },
    async run(ctx, args) {
      return furnaceCollect(ctx, args);
    },
  },
];
