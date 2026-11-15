// Crafting and smelting skills.
import {
  SkillError, goals, moveTo, checkAbort, sleep, fmtPos, intArg, resolveItem, inventoryCounts, formatCounts, findNearestBlock,
  placeNearby, withTimeout, goReach, findItem, countItem, normName, waitUntil, stopEverything,
} from './util.js';

const AUTO_INTERMEDIATE = /(_planks$|^stick$|^crafting_table$)/;
const WOOD_RE = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|crimson|warped|bamboo)_/;

// ------------------------------------------------------------------ recipe planner

function recipeIngredients(bot, recipe) {
  const out = [];
  for (const d of recipe.delta) {
    if (d.count < 0) out.push({ name: bot.registry.items[d.id]?.name ?? `item#${d.id}`, count: -d.count });
  }
  return out;
}

function allRecipes(bot, name) {
  const it = bot.registry.itemsByName[name];
  if (!it) return [];
  return bot.recipesAll(it.id, null, true);
}

/**
 * produce(name, qty, inv): plan crafting steps that yield at least `qty` more `name`.
 * Returns { ok, steps:[{recipe,times,name}], missing:{item:count}, inv }.
 */
function produce(bot, name, qty, inv, depth = 0) {
  const recipes = allRecipes(bot, name);
  if (!recipes.length) return { ok: false, steps: [], missing: { [name]: qty }, inv, noRecipe: true };
  let best = null;
  for (const r of recipes.slice(0, 20)) {
    const sim = { ...inv };
    const steps = [];
    const missing = {};
    const times = Math.ceil(qty / r.result.count);
    for (const ing of recipeIngredients(bot, r)) {
      const need = ing.count * times;
      const have = sim[ing.name] ?? 0;
      if (have >= need) { sim[ing.name] = have - need; continue; }
      const short = need - have;
      sim[ing.name] = 0;
      if (depth < 3 && AUTO_INTERMEDIATE.test(ing.name)) {
        const sub = produce(bot, ing.name, short, sim, depth + 1);
        if (sub.ok) {
          steps.push(...sub.steps);
          Object.assign(sim, sub.inv);
          sim[ing.name] = (sim[ing.name] ?? 0) - short;
          continue;
        }
        for (const [k, v] of Object.entries(sub.missing)) missing[k] = (missing[k] ?? 0) + v;
      } else {
        missing[ing.name] = (missing[ing.name] ?? 0) + short;
      }
    }
    const missCount = Object.values(missing).reduce((a, b) => a + b, 0);
    steps.push({ recipe: r, times, name });
    sim[name] = (sim[name] ?? 0) + times * r.result.count;
    const cand = { ok: missCount === 0, steps, missing, inv: sim, missCount };
    if (!best || cand.missCount < best.missCount || (cand.missCount === best.missCount && cand.steps.length < best.steps.length)) best = cand;
    if (best.ok && best.steps.length === 1) break;
  }
  return best;
}

function friendlyMissing(missing) {
  const parts = Object.entries(missing).map(([n, c]) => {
    if (/_log$/.test(n)) return `${c} log (any wood type)`;
    if (/_planks$/.test(n)) return `${c} planks (any type)`;
    return `${c} ${n}`;
  });
  return parts.join(', ');
}

function pickPlan(bot, names, qty, inv) {
  let best = null;
  for (const n of names) {
    const p = produce(bot, n, qty, inv);
    if (!p) continue;
    p.name = n;
    if (!best || (p.ok && !best.ok) || (p.ok === best.ok && (p.missCount ?? 0) < (best.missCount ?? 0))) best = p;
    if (best.ok) break;
  }
  return best;
}

async function craftSteps(ctx, steps, table) {
  const bot = ctx.bot;
  for (const s of steps) {
    checkAbort(ctx);
    const tbl = s.recipe.requiresTable ? table : null;
    if (s.recipe.requiresTable && !table) throw new SkillError('A crafting table is required but none is available.');
    const resName = bot.registry.items[s.recipe.result.id]?.name;
    // NOTE: bot.craft(recipe, N) fires N crafts back-to-back and desyncs from the server on newer versions
    // (ingredients get stuck in the grid), so craft one at a time and confirm each result in the inventory.
    for (let i = 0; i < s.times; i++) {
      checkAbort(ctx);
      const before = countItem(bot, resName);
      try {
        await withTimeout(ctx, bot.craft(s.recipe, 1, tbl), 15000, `Crafting ${s.name}`);
      } catch (err) {
        if (err instanceof SkillError) throw err;
        throw new SkillError(`Crafting ${s.name} failed: ${err.message}`);
      }
      const ok = await waitUntil(ctx, () => countItem(bot, resName) >= before + s.recipe.result.count, 3000, 50);
      if (!ok) throw new SkillError(`Crafting ${s.name} did not produce anything (the server rejected the craft; inventory full or ingredients changed?).`);
      await sleep(ctx, 120);
    }
  }
}

/** Make sure a crafting table block is within reach; returns the Block. May place one from inventory. */
async function ensureTable(ctx) {
  const bot = ctx.bot;
  let table = findNearestBlock(ctx, 'crafting_table', 32);
  if (table) {
    if (bot.entity.position.distanceTo(table.position.offset(0.5, 0.5, 0.5)) > 3.8) {
      await moveTo(ctx, new goals.GoalGetToBlock(table.position.x, table.position.y, table.position.z), { label: 'crafting table', timeoutMs: 40000 });
    }
    return { table, placed: false };
  }
  if (!findItem(bot, 'crafting_table')) return null;
  const pos = await placeNearby(ctx, 'crafting_table');
  table = bot.blockAt(pos);
  return { table, placed: true };
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
  let needsTable = plan.steps.some((s) => s.recipe.requiresTable);
  let tableInfo = null;
  let tableSteps = [];
  if (needsTable) {
    const existing = findNearestBlock(ctx, 'crafting_table', 32);
    if (!existing && !findItem(bot, 'crafting_table')) {
      const tp = produce(bot, 'crafting_table', 1, inv);
      if (!tp.ok) {
        throw new SkillError(`Cannot craft ${target}: no crafting table nearby or in inventory, and cannot make one: missing ${friendlyMissing(tp.missing)}.`);
      }
      tableSteps = tp.steps;
      const plan2 = produce(bot, target, count, tp.inv);
      if (!plan2.ok) {
        throw new SkillError(`Cannot craft ${count} ${target}: missing ${friendlyMissing(plan2.missing)} (after reserving materials for a crafting table, which is needed too).`);
      }
      plan = plan2;
    }
  }
  if (!plan.ok) {
    throw new SkillError(`Cannot craft ${count} ${target}: missing ${friendlyMissing(plan.missing)}. Inventory: ${formatCounts(inv, 15)}.`);
  }
  const before = countItem(bot, target);
  if (tableSteps.length) {
    await craftSteps(ctx, tableSteps, null);
    notes.push('crafted crafting_table');
  }
  if (needsTable) {
    tableInfo = await ensureTable(ctx);
    if (!tableInfo) throw new SkillError('Crafting table could not be found or placed.');
    if (tableInfo.placed) notes.push(`placed crafting_table at ${fmtPos(tableInfo.table.position)}`);
  }
  const intermediates = plan.steps.filter((s) => s.name !== target);
  await craftSteps(ctx, plan.steps, tableInfo?.table ?? null);
  for (const s of intermediates) notes.push(`made ${s.times * s.recipe.result.count} ${s.name}`);
  const gained = countItem(bot, target) - before;
  if (gained <= 0) throw new SkillError(`Crafting ${target} did not produce anything (inventory full?).`);
  return `Crafted ${gained} ${target}${notes.length ? ' (' + [...new Set(notes)].join('; ') + ')' : ''}. Inventory now has ${countItem(bot, target)} ${target}.`;
}

function wildcard(name) {
  return name.replace(WOOD_RE, '*_');
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
for (const w of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']) {
  SMELTABLE[`${w}_log`] = 'charcoal';
}

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
  // fall back to generic item resolution for the error message
  const r = resolveItem(ctx, raw);
  const hit = r.names.find((n) => SMELTABLE[n] && inv[n]) ?? r.names.find((n) => SMELTABLE[n]);
  if (hit) return hit;
  throw new SkillError(`${raw} is not something I know how to smelt. Smeltable: ores/raw metals, sand, cobblestone, clay_ball, logs (charcoal), raw food.`);
}

export async function smeltItem(ctx, rawInput, count = 1, rawFuel) {
  const bot = ctx.bot;
  const input = resolveSmeltInput(ctx, rawInput);
  const output = SMELTABLE[input];
  const have = countItem(bot, input);
  if (have === 0) throw new SkillError(`No ${input} in inventory to smelt. Inventory: ${formatCounts(inventoryCounts(bot), 15)}.`);
  const stack = bot.registry.itemsByName[input].stackSize ?? 64;
  const n = Math.min(count, have, stack);
  const notes = [];

  // fuel selection
  let fuelName;
  if (rawFuel) {
    const r = resolveItem(ctx, rawFuel);
    fuelName = r.names.find((x) => countItem(bot, x) > 0 && fuelValue(x) > 0) ?? r.names.find((x) => countItem(bot, x) > 0);
    if (!fuelName) throw new SkillError(`You have no ${rawFuel} to use as fuel.`);
  } else {
    const inv = inventoryCounts(bot);
    const cand = Object.keys(inv).filter((x) => fuelValue(x) > 0 && x !== input).sort((a, b) => fuelValue(b) - fuelValue(a));
    // prefer coal/charcoal, then planks/sticks, and logs last (logs are needed for crafting)
    cand.sort((a, b) => (/_log$/.test(a) ? 1 : 0) - (/_log$/.test(b) ? 1 : 0) || fuelValue(b) - fuelValue(a));
    fuelName = cand[0];
    if (!fuelName) throw new SkillError('No fuel in inventory (coal, charcoal, planks, logs or sticks). Collect some coal or wood first.');
  }
  const perFuel = fuelValue(fuelName) || 1;
  const fuelNeed = Math.min(countItem(bot, fuelName) - (fuelName === input ? n : 0), Math.ceil(n / perFuel));
  if (fuelNeed <= 0) throw new SkillError(`Not enough ${fuelName} to use as fuel.`);

  // furnace
  let furnaceBlock = findNearestBlock(ctx, 'furnace', 32);
  if (!furnaceBlock) {
    if (!findItem(bot, 'furnace')) {
      if (countItem(bot, 'cobblestone') >= 8) {
        await craftItem(ctx, 'furnace', 1);
        notes.push('crafted furnace');
      } else {
        throw new SkillError('No furnace nearby or in inventory, and I have fewer than 8 cobblestone to craft one. Mine cobblestone first.');
      }
    }
    const pos = await placeNearby(ctx, 'furnace');
    furnaceBlock = bot.blockAt(pos);
    notes.push(`placed furnace at ${fmtPos(pos)}`);
  } else if (bot.entity.position.distanceTo(furnaceBlock.position.offset(0.5, 0.5, 0.5)) > 3.5) {
    await moveTo(ctx, new goals.GoalGetToBlock(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z), { label: 'furnace', timeoutMs: 40000 });
  }

  let furnace;
  try {
    furnace = await withTimeout(ctx, bot.openFurnace(furnaceBlock), 8000, 'Opening furnace');
  } catch (err) {
    if (err instanceof SkillError) throw err;
    throw new SkillError(`Could not open furnace at ${fmtPos(furnaceBlock.position)}: ${err.message}`);
  }
  const startOut = countItem(bot, output);
  let timedOut = false;
  try {
    // clear leftovers of a different type
    const cur = furnace.inputItem();
    if (cur && cur.name !== input) await furnace.takeInput().catch(() => {});
    const stale = furnace.outputItem();
    if (stale) await furnace.takeOutput().catch(() => {});
    await withTimeout(ctx, furnace.putInput(bot.registry.itemsByName[input].id, null, n), 6000, 'Putting input in furnace');
    const fuelItem = furnace.fuelItem();
    if (!fuelItem || fuelItem.name === fuelName) {
      await withTimeout(ctx, furnace.putFuel(bot.registry.itemsByName[fuelName].id, null, fuelNeed), 6000, 'Putting fuel in furnace');
    } else {
      await furnace.takeFuel().catch(() => {});
      await withTimeout(ctx, furnace.putFuel(bot.registry.itemsByName[fuelName].id, null, fuelNeed), 6000, 'Putting fuel in furnace');
    }
    const budget = Math.min(170000, n * 10500 + 9000);
    const end = Date.now() + budget;
    while (Date.now() < end) {
      await sleep(ctx, 700);
      const out = furnace.outputItem();
      if (out && out.count >= 1 && (out.count >= n || !furnace.inputItem())) {
        await furnace.takeOutput().catch(() => {});
      }
      if (countItem(bot, output) - startOut >= n) break;
      if (!furnace.inputItem() && !furnace.outputItem()) break;
    }
    if (countItem(bot, output) - startOut < n) {
      timedOut = true;
      if (furnace.outputItem()) await furnace.takeOutput().catch(() => {});
    }
    if (furnace.inputItem()) await furnace.takeInput().catch(() => {});
    if (furnace.fuelItem()) await furnace.takeFuel().catch(() => {});
  } finally {
    try { furnace.close(); } catch { /* ignore */ }
  }
  const got = countItem(bot, output) - startOut;
  if (got <= 0) throw new SkillError(`Smelting produced nothing within the time limit (input ${input}, fuel ${fuelName}). The furnace at ${fmtPos(furnaceBlock.position)} may be blocked.`);
  return `Smelted ${got} ${input} into ${output} using ${fuelName}${timedOut ? ` (stopped early, wanted ${n})` : ''}${notes.length ? ' (' + notes.join('; ') + ')' : ''}. Inventory has ${countItem(bot, output)} ${output}.`;
}

// ------------------------------------------------------------------ skills

export const craftSkills = [
  {
    name: 'craft_item',
    description: 'Craft `count` of an item (the number of ITEMS wanted, e.g. count 8 planks). Finds a nearby crafting table, or places one from inventory, or crafts one from planks if needed. Auto-crafts simple intermediates (planks from logs, sticks, crafting_table). On missing ingredients, the error lists exactly what is missing. Use get_recipe to see ingredients first.',
    params: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'e.g. "wooden_pickaxe", "planks", "stick", "crafting_table", "torch"' },
        count: { type: 'integer', minimum: 1, maximum: 256, description: 'default 1' },
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
    description: 'Show how an item is crafted: ingredients, yield and whether a crafting table is needed. "*" means any wood type. Also tells what you currently lack.',
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
        const recipes = allRecipes(bot, name);
        if (!recipes.length) {
          lines.push(`${name}: no crafting recipe (raw resource, or obtained by smelting/mining/trading).`);
          continue;
        }
        const seen = new Set();
        const out = [];
        for (const r of recipes) {
          const ing = recipeIngredients(bot, r).map((i) => `${i.count} ${wildcard(i.name)}`).join(' + ');
          const line = `${ing} -> ${r.result.count} ${wildcard(name)}${r.requiresTable ? ' [crafting table]' : ' [no table needed]'}`;
          if (seen.has(line)) continue;
          seen.add(line);
          out.push(line);
        }
        const plan = produce(bot, name, 1, inv);
        const status = plan.ok ? 'You can craft it now.' : `You lack: ${friendlyMissing(plan.missing)}.`;
        lines.push(`${name}: ${out.slice(0, 3).join(' | ')}${out.length > 3 ? ` (+${out.length - 3} variants)` : ''}. ${status}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'smelt_item',
    description: 'Smelt items in a furnace: uses a nearby furnace, or places/crafts one (needs 8 cobblestone). Waits for the result (about 10s per item) and collects it. Input examples: raw_iron, iron_ore, sand, cobblestone, log (makes charcoal), beef. Fuel is chosen automatically (coal first) unless `fuel` is given.',
    params: {
      type: 'object',
      properties: {
        input: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 64, description: 'default 1' },
        fuel: { type: 'string', description: 'optional: coal, charcoal, oak_planks, ...' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      return smeltItem(ctx, args.input, intArg(args.count, 1, 1, 64), args.fuel);
    },
  },
];
