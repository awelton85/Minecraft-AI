// Gathering skills: mining, finding blocks, farming.
// collect_block uses its own loop (pathfinder via moveTo + mineflayer-tool + bot.dig) instead of bot.collectBlock.collect,
// because collect() replaces the pathfinder Movements, has no stuck watchdog and cannot be bounded/aborted reliably.
import {
  SkillError, goals, Vec3, moveTo, checkAbort, sleep, fmtPos, vecFrom, intArg, resolveBlock, blockIdsFor, countItem,
  digBlock, collectDrops, blockAtSafe, isAir, isLiquid, FACES, goNear, findItem, placeItemAt, inventoryCounts,
  formatCounts, waitUntil, withTimeout, freeSlots,
} from './util.js';

function dropNamesOf(bot, blockName) {
  const b = bot.registry.blocksByName[blockName];
  if (!b?.drops) return [];
  return b.drops.map((d) => bot.registry.items[typeof d === 'object' ? d.drop ?? d.id : d]?.name).filter(Boolean);
}

function hasLiquidNeighbor(bot, pos) {
  for (const d of FACES) {
    if (d.y < 0) continue;
    if (isLiquid(blockAtSafe(bot, pos.plus(d)))) return true;
  }
  return false;
}

function toolNamesFor(bot, block) {
  const ids = Object.keys(block.harvestTools ?? {});
  return ids.map((id) => bot.registry.items[id]?.name).filter(Boolean);
}

/** After equipForBlock, check the held tool can actually harvest the block. */
function canHarvestNow(bot, block) {
  if (!block.harvestTools) return true;
  const held = bot.heldItem;
  return !!held && block.canHarvest(held.type);
}

export const gatherSkills = [
  {
    name: 'collect_block',
    description: 'Mine/harvest `count` blocks of a type and pick up the drops. Uses the best tool in inventory automatically. Accepts exact names (oak_log, cobblestone, iron_ore, sand) or generic ones: "log"/"wood" (any tree), "coal"/"iron"/"diamond" (the ore). Fails with the tool you need if you lack one (e.g. stone needs a wooden pickaxe). Returns how many were collected.',
    params: {
      type: 'object',
      properties: {
        block: { type: 'string', description: 'e.g. "oak_log", "log", "cobblestone", "iron_ore", "sand"' },
        count: { type: 'integer', minimum: 1, maximum: 128, description: 'how many to collect (default 1)' },
        maxDistance: { type: 'integer', minimum: 4, maximum: 128, description: 'search radius, default 48' },
      },
      required: ['block'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const want = intArg(args.count, 1, 1, 128);
      const maxDistance = intArg(args.maxDistance, 48, 4, 128);
      const res = resolveBlock(ctx, args.block);
      const ids = blockIdsFor(ctx, res.names);
      const dropSet = new Set();
      for (const n of res.names) for (const d of dropNamesOf(bot, n)) dropSet.add(d);
      const dropNames = [...dropSet];
      const snap = () => Object.fromEntries(dropNames.map((n) => [n, countItem(bot, n)]));
      const beforeSnap = snap();
      const itemCount = () => Object.values(snap()).reduce((a, b) => a + b, 0);
      const before = Object.values(beforeSnap).reduce((a, b) => a + b, 0);
      let broken = 0;
      const bad = new Set(); // positions we failed on
      let consecutiveFails = 0;
      let lastError = '';
      const deadline = Date.now() + Math.min(600000, 45000 * want + 30000);

      const gained = () => (dropNames.length ? itemCount() - before : broken);
      while (gained() < want) {
        checkAbort(ctx);
        if (Date.now() > deadline) { lastError = 'time budget used up'; break; }
        if (freeSlots(bot) === 0) { lastError = 'inventory is full'; break; }
        const me = bot.entity.position;
        const found = bot.findBlocks({ matching: ids, maxDistance, count: 40 })
          .filter((p) => !bad.has(p.toString()))
          .map((p) => ({ p, score: p.distanceTo(me) + Math.abs(p.y - me.y) * 0.5 }))
          .sort((a, b) => a.score - b.score);
        if (!found.length) { lastError = `no more ${res.generic ? args.block : res.names[0]} within ${maxDistance} blocks`; break; }
        const target = found[0].p;
        const block = blockAtSafe(bot, target);
        if (!block || !ids.includes(block.type)) { bad.add(target.toString()); continue; }
        if (hasLiquidNeighbor(bot, target)) { bad.add(target.toString()); continue; }
        try {
          // tool check before walking
          try { await bot.tool.equipForBlock(block, { requireHarvest: true }); } catch { /* maybe no suitable tool */ }
          if (!canHarvestNow(bot, block)) {
            const need = toolNamesFor(bot, block);
            throw new SkillError(`Cannot harvest ${block.name}: it needs ${need.length ? need.join(' or ') : 'a better tool'} (holding ${bot.heldItem?.name ?? 'nothing'}). Craft that tool first.`);
          }
          await moveTo(ctx, new goals.GoalLookAtBlock(target, bot.world, { reach: 4 }), { label: `${block.name} at ${fmtPos(target)}`, timeoutMs: 45000 });
          const fresh = blockAtSafe(bot, target);
          if (!fresh || !ids.includes(fresh.type)) continue;
          await digBlock(ctx, fresh);
          broken++;
          consecutiveFails = 0;
          await collectDrops(ctx, target.offset(0.5, 0.5, 0.5), { radius: 5, maxMs: 4000 });
        } catch (err) {
          if (err.message === 'Aborted') throw err;
          if (/Cannot harvest/.test(err.message)) throw err;
          bad.add(target.toString());
          consecutiveFails++;
          lastError = err.message;
          ctx.log?.(`collect_block: ${err.message}`);
          if (consecutiveFails >= 4) break;
        }
      }
      const g = gained();
      const nowSnap = snap();
      const parts = dropNames.map((n) => [n, nowSnap[n] - beforeSnap[n], nowSnap[n]]).filter(([, d]) => d > 0);
      const label = parts.length ? parts.map(([n, d]) => `${d} ${n}`).join(' + ') : `${broken} ${res.names[0]}`;
      const inv = parts.map(([n, , t]) => `${t} ${n}`).join(', ');
      if (g >= want) return `Collected ${label} (mined ${broken}). Inventory now has ${inv || 'them'}.`;
      if (g === 0) throw new SkillError(`Could not collect any ${res.generic ? args.block : res.names[0]}: ${lastError || 'nothing found'}. Try explore to find more, or increase maxDistance.`);
      return `Only collected ${label} of ${want} wanted: ${lastError}. Inventory has ${inv}.`;
    },
  },
  {
    name: 'dig_block_at',
    description: 'Walk within reach of the block at x,y,z, mine it with the best tool and pick up the drop. Use for precise digging (tunnels, clearing a spot). Will not dig bedrock.',
    params: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const pos = vecFrom(args);
      const block = blockAtSafe(bot, pos);
      if (!block) throw new SkillError(`Position ${fmtPos(pos)} is not in a loaded chunk.`);
      if (isAir(block)) return `Nothing to dig at ${fmtPos(pos)} (already air).`;
      if (isLiquid(block)) throw new SkillError(`${block.name} at ${fmtPos(pos)} is a liquid; place a block there instead.`);
      if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.3) {
        await moveTo(ctx, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), { label: `${block.name} at ${fmtPos(pos)}`, timeoutMs: 45000 });
      }
      try { await bot.tool.equipForBlock(block, { requireHarvest: false }); } catch { /* ignore */ }
      const harvestable = canHarvestNow(bot, block);
      await digBlock(ctx, block);
      await collectDrops(ctx, pos.offset(0.5, 0.5, 0.5), { radius: 5, maxMs: 3000 });
      return `Dug ${block.name} at ${fmtPos(pos)}${harvestable ? '' : ' (wrong tool: no drop)'}.`;
    },
  },
  {
    name: 'find_blocks',
    description: 'Search loaded terrain for blocks of a type and return their coordinates (nearest first). Use before go_to / collect_block to know where resources are. Accepts generic names like "log", "iron", "diamond". Searches only chunks near the bot.',
    params: {
      type: 'object',
      properties: {
        block: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 20, description: 'default 5' },
        maxDistance: { type: 'integer', minimum: 4, maximum: 128, description: 'default 48' },
      },
      required: ['block'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const res = resolveBlock(ctx, args.block);
      const ids = blockIdsFor(ctx, res.names);
      const count = intArg(args.count, 5, 1, 20);
      const maxDistance = intArg(args.maxDistance, 48, 4, 128);
      const me = bot.entity.position;
      const pts = bot.findBlocks({ matching: ids, maxDistance, count })
        .map((p) => ({ p, d: p.distanceTo(me) }))
        .sort((a, b) => a.d - b.d);
      if (!pts.length) return `No ${res.generic ? args.block : res.names[0]} found within ${maxDistance} blocks (only loaded chunks are searched). Try explore or move and search again.`;
      const label = res.generic ? args.block : res.names[0];
      return `Found ${pts.length} ${label}: ` + pts.map(({ p, d }) => `${blockAtSafe(bot, p)?.name ?? label} at ${p.x},${p.y},${p.z} (${Math.round(d)}m)`).join('; ');
    },
  },
  {
    name: 'farm',
    description: 'Harvest fully grown crops (wheat, carrots, potatoes, beetroots, nether wart) within ~16 blocks and replant them with seeds/produce from your inventory. Returns what was harvested and replanted.',
    params: {
      type: 'object',
      properties: { radius: { type: 'integer', minimum: 3, maximum: 32, description: 'default 16' } },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const radius = intArg(args.radius, 16, 3, 32);
      const CROPS = {
        wheat: { age: 7, seed: 'wheat_seeds' },
        carrots: { age: 7, seed: 'carrot' },
        potatoes: { age: 7, seed: 'potato' },
        beetroots: { age: 3, seed: 'beetroot_seeds' },
        nether_wart: { age: 3, seed: 'nether_wart' },
      };
      const ids = blockIdsFor(ctx, Object.keys(CROPS));
      const all = bot.findBlocks({ matching: ids, maxDistance: radius, count: 200 });
      const mature = [];
      let growing = 0;
      for (const p of all) {
        const b = blockAtSafe(bot, p);
        if (!b) continue;
        const def = CROPS[b.name];
        const age = b.getProperties?.().age ?? b.metadata;
        if (def && Number(age) >= def.age) mature.push({ p, b, def });
        else growing++;
      }
      if (!mature.length) return all.length ? `No mature crops yet (${growing} still growing within ${radius} blocks).` : `No crops found within ${radius} blocks.`;
      mature.sort((a, b) => a.p.distanceTo(bot.entity.position) - b.p.distanceTo(bot.entity.position));
      const harvested = {};
      let replanted = 0;
      const deadline = Date.now() + 120000;
      for (const { p, b, def } of mature.slice(0, 40)) {
        checkAbort(ctx);
        if (Date.now() > deadline) break;
        try {
          await moveTo(ctx, new goals.GoalLookAtBlock(p, bot.world, { reach: 4 }), { label: 'crop', timeoutMs: 20000, noUnstick: true });
          const cur = blockAtSafe(bot, p);
          if (!cur || cur.name !== b.name) continue;
          await digBlock(ctx, cur, { timeoutMs: 5000 });
          harvested[b.name] = (harvested[b.name] ?? 0) + 1;
          await collectDrops(ctx, p.offset(0.5, 0.5, 0.5), { radius: 4, maxMs: 2500 });
          const seed = findItem(bot, def.seed);
          if (seed) {
            const below = blockAtSafe(bot, p.offset(0, -1, 0));
            if (below && (below.name === 'farmland' || below.name === 'soul_sand')) {
              await placeItemAt(ctx, seed, p, { stand: bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) < 4.3 });
              replanted++;
            }
          }
        } catch (err) {
          if (err.message === 'Aborted') throw err;
          ctx.log?.(`farm: ${err.message}`);
        }
      }
      const hs = Object.entries(harvested).map(([n, c]) => `${c} ${n}`).join(', ');
      return hs ? `Harvested ${hs}; replanted ${replanted}. ${growing} crops still growing.` : `Could not harvest any of ${mature.length} mature crops (unreachable?).`;
    },
  },
];
