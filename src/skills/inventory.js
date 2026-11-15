// Inventory, equipment, food and chest skills.
import {
  SkillError, goals, Vec3, moveTo, checkAbort, sleep, fmtPos, vecFrom, intArg, resolveItem, pickInventoryItem, inventoryCounts,
  formatCounts, countItem, isToolOrArmor, findNearestBlock, goReach, withTimeout, blockAtSafe, findPlayerEntity, playerExists,
  freeSlots, normName, equipItem, isFoodName, waitUntil,
} from './util.js';

const CONTAINER_NAMES = ['chest', 'trapped_chest', 'barrel'];
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']);

function armorDest(name) {
  if (name.endsWith('_helmet') || name === 'turtle_helmet' || name.endsWith('_head') || name === 'carved_pumpkin') return 'head';
  if (name.endsWith('_chestplate') || name === 'elytra') return 'torso';
  if (name.endsWith('_leggings')) return 'legs';
  if (name.endsWith('_boots')) return 'feet';
  if (name === 'shield' || name === 'totem_of_undying') return 'off-hand';
  return 'hand';
}

async function openChestAt(ctx, args) {
  const bot = ctx.bot;
  let block;
  if (args && args.x !== undefined && args.y !== undefined && args.z !== undefined) {
    block = blockAtSafe(bot, vecFrom(args));
    if (!block || !CONTAINER_NAMES.includes(block.name)) throw new SkillError(`There is no chest/barrel at ${fmtPos(vecFrom(args))} (found ${block?.name ?? 'nothing'}).`);
  } else {
    block = findNearestBlock(ctx, CONTAINER_NAMES, 40);
    if (!block) throw new SkillError('No chest within 40 blocks. Place one (place_block chest) or give x,y,z of a known chest.');
  }
  if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 3.8) {
    await moveTo(ctx, new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z), { label: 'chest', timeoutMs: 45000 });
  }
  let win;
  try {
    win = await withTimeout(ctx, bot.openContainer(block), 8000, 'Opening chest');
  } catch (err) {
    if (err instanceof SkillError) throw err;
    throw new SkillError(`Could not open the ${block.name} at ${fmtPos(block.position)}: ${err.message}`);
  }
  return { block, win };
}

function closeQuiet(win) {
  try { win.close(); } catch { /* ignore */ }
}

function contentsOf(win) {
  const counts = {};
  for (const it of win.containerItems()) counts[it.name] = (counts[it.name] ?? 0) + it.count;
  return counts;
}

export const inventorySkills = [
  {
    name: 'inventory',
    description: 'List everything in your inventory with counts, plus equipped armor, held item, off-hand and free slots.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const bot = ctx.bot;
      const eq = [];
      for (const d of ['head', 'torso', 'legs', 'feet', 'off-hand']) {
        try {
          const it = bot.inventory.slots[bot.getEquipmentDestSlot(d)];
          if (it) eq.push(`${d}: ${it.name}`);
        } catch { /* ignore */ }
      }
      return `Holding: ${bot.heldItem ? bot.heldItem.name + 'x' + bot.heldItem.count : 'nothing'}. Equipped: ${eq.length ? eq.join(', ') : 'nothing'}.\nItems: ${formatCounts(inventoryCounts(bot), 60)}.\nFree slots: ${freeSlots(bot)}/36.`;
    },
  },
  {
    name: 'equip',
    description: 'Equip an item from inventory. destination: hand (default, for tools/weapons/blocks), off-hand (shield etc.), head, torso, legs, feet. Armor pieces automatically go to the right slot when destination is omitted.',
    params: {
      type: 'object',
      properties: {
        item: { type: 'string' },
        destination: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] },
      },
      required: ['item'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const { item, name } = pickInventoryItem(ctx, args.item);
      const dest = args.destination ?? armorDest(name);
      try {
        await withTimeout(ctx, ctx.bot.equip(item, dest), 6000, `Equipping ${name}`);
      } catch (err) {
        if (err instanceof SkillError) throw err;
        throw new SkillError(`Could not equip ${name} to ${dest}: ${err.message}`);
      }
      return `Equipped ${name} in ${dest}.`;
    },
  },
  {
    name: 'toss_item',
    description: 'Drop items from inventory on the ground. count defaults to 1; use a big number to drop all of that item.',
    params: {
      type: 'object',
      properties: { item: { type: 'string' }, count: { type: 'integer', minimum: 1 } },
      required: ['item'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const { item, name, total } = pickInventoryItem(ctx, args.item);
      const n = Math.min(intArg(args.count, 1, 1, 100000), total);
      await withTimeout(ctx, ctx.bot.toss(item.type, null, n), 6000, 'Tossing');
      return `Dropped ${n} ${name}.`;
    },
  },
  {
    name: 'give_to_player',
    description: 'Walk to a nearby player, face them and drop items at their feet so they can pick them up. Player must be visible/loaded.',
    params: {
      type: 'object',
      properties: { player: { type: 'string' }, item: { type: 'string' }, count: { type: 'integer', minimum: 1 } },
      required: ['player', 'item'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const { item, name, total } = pickInventoryItem(ctx, args.item);
      const n = Math.min(intArg(args.count, 1, 1, 100000), total);
      let e = findPlayerEntity(bot, args.player);
      if (!e) {
        if (playerExists(bot, args.player)) throw new SkillError(`${args.player} is online but too far away; go_to their coordinates first.`);
        throw new SkillError(`Player "${args.player}" is not online.`);
      }
      if (e.position.distanceTo(bot.entity.position) > 3) {
        await moveTo(ctx, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), { label: args.player });
        e = findPlayerEntity(bot, args.player) ?? e;
      }
      await withTimeout(ctx, bot.lookAt(e.position.offset(0, e.height ?? 1.6, 0), true), 2000, 'Looking at player');
      await withTimeout(ctx, bot.toss(item.type, null, n), 6000, 'Tossing');
      await sleep(ctx, 400);
      return `Gave ${n} ${name} to ${args.player} (dropped at their feet).`;
    },
  },
  {
    name: 'eat',
    description: 'Eat food from inventory. Without arguments eats the best food (highest food value, avoiding rotten flesh / spider eyes / poisonous items) until hunger is nearly full. Optionally name a specific food. Fails if food is already full or you have none.',
    params: {
      type: 'object',
      properties: { food: { type: 'string', description: 'optional, e.g. "cooked_beef", "bread", "apple"' } },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const startFood = bot.food;
      if (startFood >= 20 && bot.game?.gameMode !== 'creative') throw new SkillError('Food is already full (20/20).');
      const foods = bot.registry.foodsByName;
      let eaten = [];
      for (let i = 0; i < 6; i++) {
        checkAbort(ctx);
        if (bot.food >= 20) break;
        let cands;
        if (args.food) {
          const r = resolveItem(ctx, args.food);
          cands = bot.inventory.items().filter((it) => r.names.includes(it.name) && foods[it.name]);
          if (!cands.length) throw new SkillError(`You have no ${args.food} that can be eaten. Inventory: ${formatCounts(inventoryCounts(bot), 15)}.`);
        } else {
          cands = bot.inventory.items().filter((it) => foods[it.name] && !BAD_FOOD.has(it.name));
          if (!cands.length) {
            const bad = bot.inventory.items().filter((it) => foods[it.name]);
            if (bad.length && bot.food <= 8) cands = bad; // desperate
          }
          if (!cands.length) throw new SkillError('No food in inventory. Hunt animals (attack cow/pig/chicken/sheep), farm crops, or fish.');
        }
        cands.sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints || foods[b.name].saturation - foods[a.name].saturation);
        // don't waste a high value food when only slightly hungry
        const pick = cands.find((c) => 20 - bot.food >= foods[c.name].foodPoints * 0.5) ?? cands[cands.length - 1];
        if (bot.autoEat?.isEating) await waitUntil(ctx, () => !bot.autoEat.isEating, 4000);
        await equipItem(ctx, pick);
        try {
          await withTimeout(ctx, bot.consume(), 8000, `Eating ${pick.name}`, () => bot.deactivateItem());
        } catch (err) {
          if (err instanceof SkillError) throw err;
          if (eaten.length) break;
          throw new SkillError(`Could not eat ${pick.name}: ${err.message}`);
        }
        eaten.push(pick.name);
        if (args.food) break;
        if (bot.food >= 18) break;
      }
      if (!eaten.length) return `Not hungry enough to eat (food ${bot.food}/20).`;
      return `Ate ${eaten.join(', ')}. Food ${startFood} -> ${bot.food}/20.`;
    },
  },
  {
    name: 'chest_deposit',
    description: 'Put items into the nearest chest/barrel (or the one at x,y,z). `items`: "auto" (default) = everything except tools, weapons, armor and food; "all" = everything; or a comma-separated list like "cobblestone,dirt,oak_log". Walks to the chest first.',
    params: {
      type: 'object',
      properties: {
        items: { type: 'string', description: 'auto | all | comma-separated names' },
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
      },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const mode = String(args.items ?? 'auto').trim().toLowerCase();
      let list;
      if (mode === 'auto' || mode === '' || /except/.test(mode)) {
        list = bot.inventory.items().filter((it) => !isToolOrArmor(it.name) && !bot.registry.foodsByName[it.name]);
      } else if (mode === 'all' || mode === 'everything') {
        list = bot.inventory.items();
      } else {
        const names = new Set();
        for (const part of mode.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)) {
          const r = resolveItem(ctx, part);
          for (const n of r.names) names.add(n);
        }
        list = bot.inventory.items().filter((it) => names.has(it.name));
      }
      if (!list.length) throw new SkillError('Nothing to deposit (no matching items in inventory).');
      const { block, win } = await openChestAt(ctx, args);
      const moved = {};
      let full = false;
      try {
        for (const it of list) {
          checkAbort(ctx);
          try {
            await withTimeout(ctx, win.deposit(it.type, null, it.count), 6000, `Depositing ${it.name}`);
            moved[it.name] = (moved[it.name] ?? 0) + it.count;
          } catch (err) {
            if (err.message === 'Aborted') throw err;
            if (/full|no space|Can't find/i.test(err.message)) { full = true; break; }
            ctx.log?.(`deposit ${it.name}: ${err.message}`);
          }
        }
      } finally {
        closeQuiet(win);
      }
      if (!Object.keys(moved).length) throw new SkillError(`Could not deposit anything into the ${block.name} at ${fmtPos(block.position)}${full ? ' (it is full)' : ''}.`);
      return `Deposited ${formatCounts(moved, 20)} into ${block.name} at ${fmtPos(block.position)}${full ? ' (chest became full; some items stayed with me)' : ''}.`;
    },
  },
  {
    name: 'chest_withdraw',
    description: 'Take items out of the nearest chest/barrel (or the one at x,y,z). count defaults to all of that item in the chest.',
    params: {
      type: 'object',
      properties: {
        item: { type: 'string' }, count: { type: 'integer', minimum: 1 },
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
      },
      required: ['item'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const r = resolveItem(ctx, args.item);
      const { block, win } = await openChestAt(ctx, args);
      try {
        const contents = contentsOf(win);
        const name = r.names.filter((n) => contents[n]).sort((a, b) => contents[b] - contents[a])[0];
        if (!name) throw new SkillError(`The ${block.name} at ${fmtPos(block.position)} has no ${args.item}. It contains: ${formatCounts(contents, 20)}.`);
        const n = Math.min(args.count ? intArg(args.count, 1) : contents[name], contents[name]);
        const id = bot.registry.itemsByName[name].id;
        let left = n;
        while (left > 0) {
          const step = Math.min(left, bot.registry.itemsByName[name].stackSize ?? 64);
          try {
            await withTimeout(ctx, win.withdraw(id, null, step), 6000, `Withdrawing ${name}`);
          } catch (err) {
            if (err instanceof SkillError) throw err;
            if (left === n) throw new SkillError(`Could not withdraw ${name}: ${err.message}`);
            break;
          }
          left -= step;
        }
        return `Took ${n - left} ${name} from the ${block.name} at ${fmtPos(block.position)}. Inventory has ${countItem(bot, name)} ${name}.`;
      } finally {
        closeQuiet(win);
      }
    },
  },
  {
    name: 'chest_list',
    description: 'Look inside the nearest chest/barrel (or the one at x,y,z) and list its contents.',
    params: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const { block, win } = await openChestAt(ctx, args);
      try {
        return `${block.name} at ${fmtPos(block.position)} contains: ${formatCounts(contentsOf(win), 50)}.`;
      } finally {
        closeQuiet(win);
      }
    },
  },
];
