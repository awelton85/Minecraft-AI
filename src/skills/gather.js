// Gathering skills: mining, finding blocks, farming.
// collect_block uses its own loop (pathfinder via moveTo + mineflayer-tool + bot.dig) instead of bot.collectBlock.collect,
// because collect() replaces the pathfinder Movements, has no stuck watchdog and cannot be bounded/aborted reliably.
import {
  SkillError, goals, moveTo, checkAbort, fmtPos, vecFrom, intArg, resolveBlock, blockIdsFor, countItem, digBlock, collectDrops,
  blockAtSafe, isAir, isLiquid, FACES, findItem, placeItemAt, inventoryCounts, formatCounts, freeSlots, goalForBlock,
  scanBlocks, equipTool, isProtectedBlockName, timeLeft, outOfTime,
} from './util.js';

const CROPS = {
  wheat: { age: 7, seed: 'wheat_seeds' },
  carrots: { age: 7, seed: 'carrot' },
  potatoes: { age: 7, seed: 'potato' },
  beetroots: { age: 3, seed: 'beetroot_seeds' },
  nether_wart: { age: 3, seed: 'nether_wart' },
};
const CROP_RE = /^(wheat|carrots|potatoes|beetroots|nether_wart|sweet_berry_bush|torchflower_crops|pitcher_crop)$/;
// protected for pathing, but legitimately harvested by collect_block
const HARVESTABLE_RE = /^(melon|pumpkin|sugar_cane|bamboo)$/;
const EXTRA_REFUSE_RE = /(chest|barrel|furnace|smoker|crafting_table|_bed$|spawner|shulker_box|_door$|trapdoor|bookshelf|enchanting|anvil|beacon|lectern|loom|_sign$)/;

function dropNamesOf(bot, blockName) {
  const b = bot.registry.blocksByName[blockName];
  if (!b?.drops) return [];
  return b.drops.map((d) => bot.registry.items[typeof d === 'object' ? d.drop ?? d.id : d]?.name).filter((n) => n && n !== 'air');
}

function hasLiquidNeighbor(bot, pos) {
  for (const d of FACES) {
    if (d.y < 0) continue;
    if (isLiquid(blockAtSafe(bot, pos.plus(d)))) return true;
  }
  return false;
}

function toolNamesFor(bot, block) {
  return Object.keys(block.harvestTools ?? {}).map((id) => bot.registry.items[id]?.name).filter(Boolean);
}

function canHarvestNow(bot, block) {
  if (!block.harvestTools) return true;
  const held = bot.heldItem;
  return !!held && block.canHarvest(held.type);
}

/** Throws for blocks the model should not break by accident (builds, containers, crops). */
function refuseIfProtected(names, force, argBlock) {
  if (force) return;
  for (const n of names) {
    if (CROP_RE.test(n)) throw new SkillError(`${n} is a crop: use the farm skill (it harvests only mature crops and replants). Pass force:true to break it anyway.`);
    if (EXTRA_REFUSE_RE.test(n) || (isProtectedBlockName(n) && !HARVESTABLE_RE.test(n))) {
      throw new SkillError(`${n} is usually part of someone's build or a functional block, so I will not mine it by default. If you really mean it, call again with force:true.`);
    }
  }
}

export const gatherSkills = [
  {
    name: 'collect_block',
    description: 'Mine `count` blocks of a type and pick up the drops with the best tool. Names: exact (oak_log, cobblestone, iron_ore, sand) or generic ("log", "coal", "iron", "diamond"). Needs the right tool tier (error tells which). Refuses builds/containers/crops unless force:true. May return partial progress: call again for the rest.',
    params: {
      type: 'object',
      properties: {
        block: { type: 'string', description: 'e.g. oak_log, log, cobblestone, iron_ore' },
        count: { type: 'integer', minimum: 1, maximum: 128 },
        maxDistance: { type: 'integer', minimum: 4, maximum: 64, description: 'default 48' },
        force: { type: 'boolean', description: 'allow breaking protected/man-made blocks' },
      },
      required: ['block'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const want = intArg(args.count, 1, 1, 128);
      const maxDistance = intArg(args.maxDistance, 48, 4, 64);
      const res = resolveBlock(ctx, args.block);
      refuseIfProtected(res.names, args.force === true, args.block);
      const ids = new Set(blockIdsFor(ctx, res.names));
      const dropSet = new Set();
      for (const n of res.names) for (const d of dropNamesOf(bot, n)) dropSet.add(d);
      const dropNames = [...dropSet];
      const snap = () => Object.fromEntries(dropNames.map((n) => [n, countItem(bot, n)]));
      const beforeSnap = snap();
      const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
      const before = sum(beforeSnap);
      let broken = 0;
      const bad = new Set();
      let consecutiveFails = 0;
      let lastError = '';
      let cands = [];
      let sinceScan = 0;
      const maxBroken = Math.max(want * 3, 6);
      const gained = () => (dropNames.length ? sum(snap()) - before : broken);
      const label = res.generic ? args.block : res.names[0];

      const summary = () => {
        const now = snap();
        const parts = dropNames.map((n) => [n, now[n] - beforeSnap[n], now[n]]).filter(([, d]) => d > 0);
        const g = gained();
        const what = parts.length ? parts.map(([n, d]) => `${d} ${n}`).join(' + ') : `${g} ${res.names[0]}`;
        return { g, what, inv: parts.map(([n, , t]) => `${t} ${n}`).join(', ') };
      };

      try {
        while (gained() < want) {
          checkAbort(ctx);
          if (outOfTime(ctx, 2500)) { lastError = 'out of time for this action'; break; }
          if (freeSlots(bot) === 0) { lastError = 'inventory is full'; break; }
          if (broken >= maxBroken && gained() === 0) { lastError = `broke ${broken} blocks but no drops arrived (drops lost, or this block drops nothing)`; break; }
          const me = bot.entity.position;
          cands = cands.filter((p) => !bad.has(p.toString()));
          if (!cands.length || sinceScan++ > 24) {
            sinceScan = 0;
            cands = scanBlocks(bot, ids, { maxDistance, count: 64 })
              .filter((p) => !bad.has(p.toString()))
              .filter((p) => !(p.y < me.y - 0.5 && Math.abs(p.x + 0.5 - me.x) < 0.8 && Math.abs(p.z + 0.5 - me.z) < 0.8)) // not the floor we stand on
              .map((p) => ({ p, score: p.distanceTo(me) + Math.abs(p.y - me.y) * 0.5 }))
              .sort((a, b) => a.score - b.score)
              .map((x) => x.p);
          }
          if (!cands.length) { lastError = `no more ${label} within ${maxDistance} blocks`; break; }
          // nearest remaining candidate
          cands.sort((a, b) => (a.distanceTo(me) + Math.abs(a.y - me.y) * 0.5) - (b.distanceTo(me) + Math.abs(b.y - me.y) * 0.5));
          const target = cands.shift();
          const block = blockAtSafe(bot, target);
          if (!block || !ids.has(block.type)) { bad.add(target.toString()); continue; }
          if (hasLiquidNeighbor(bot, target)) { bad.add(target.toString()); continue; }
          try {
            await equipTool(ctx, block, { requireHarvest: true });
            if (!canHarvestNow(bot, block)) {
              const need = toolNamesFor(bot, block);
              throw new SkillError(`Cannot harvest ${block.name}: it needs ${need.length ? need.slice(0, 4).join(' or ') : 'a better tool'} (holding ${bot.heldItem?.name ?? 'nothing'}). Craft that tool first.`);
            }
            await moveTo(ctx, goalForBlock(bot, target, block), { label: `${block.name} at ${fmtPos(target)}`, timeoutMs: 45000 });
            const fresh = blockAtSafe(bot, target);
            if (!fresh || !ids.has(fresh.type)) continue;
            await digBlock(ctx, fresh);
            broken++;
            consecutiveFails = 0;
            await collectDrops(ctx, target.offset(0.5, 0.5, 0.5), { radius: 5, maxMs: 4000 });
          } catch (err) {
            if (err.message === 'Aborted') throw err;
            if (/Cannot harvest/.test(err.message)) {
              if (gained() > 0) { lastError = err.message; break; }
              throw err;
            }
            bad.add(target.toString());
            consecutiveFails++;
            lastError = err.message;
            ctx.log?.(`collect_block: ${err.message}`);
            if (consecutiveFails >= 4) break;
          }
        }
      } catch (err) {
        if (err.message === 'Aborted' && (broken > 0 || gained() > 0)) {
          const { g, what } = summary();
          throw new SkillError(`Aborted after mining ${broken} ${label} (gained ${what || g}).`);
        }
        throw err;
      }
      const { g, what, inv } = summary();
      if (g >= want) return `Collected ${what} (mined ${broken}). Inventory now has ${inv || 'them'}.`;
      if (g > 0) return `Collected ${what} of ${want} wanted (${lastError}). Inventory has ${inv}. Call again for the rest.`;
      if (broken > 0) return `Broke ${broken} ${label} but picked up none (${lastError || 'drops not collected'}). Check pickup_items or the inventory.`;
      throw new SkillError(`Could not collect any ${label}: ${lastError || 'nothing found'}. Try explore to find more, or increase maxDistance.`);
    },
  },
  {
    name: 'dig_block_at',
    description: 'Walk within reach of the block at x,y,z, mine it with the best tool and pick up the drop. For precise digging (tunnels, clearing a spot). Refuses bedrock and protected/man-made blocks unless force:true.',
    params: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, force: { type: 'boolean' } },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const pos = vecFrom(args);
      const block = blockAtSafe(bot, pos);
      if (!block) throw new SkillError(`Position ${fmtPos(pos)} is not in a loaded chunk.`);
      if (isAir(block)) return `Nothing to dig at ${fmtPos(pos)} (already air).`;
      if (block.name === 'bedrock' || block.hardness === -1) throw new SkillError(`${block.name} at ${fmtPos(pos)} is unbreakable.`);
      if (isLiquid(block)) throw new SkillError(`${block.name} at ${fmtPos(pos)} is a liquid; place a block there instead.`);
      if (!args.force && (EXTRA_REFUSE_RE.test(block.name) || CROP_RE.test(block.name))) {
        throw new SkillError(`${block.name} at ${fmtPos(pos)} is a functional/crop block; pass force:true if you really want to break it.`);
      }
      if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.3) {
        await moveTo(ctx, goalForBlock(bot, pos, block), { label: `${block.name} at ${fmtPos(pos)}`, timeoutMs: 45000 });
      }
      await equipTool(ctx, block);
      const harvestable = canHarvestNow(bot, block);
      await digBlock(ctx, block);
      const got = await collectDrops(ctx, pos.offset(0.5, 0.5, 0.5), { radius: 5, maxMs: 3000 });
      return `Dug ${block.name} at ${fmtPos(pos)}${harvestable ? '' : ' (wrong tool: no drop)'}${Object.keys(got).length ? `; picked up ${formatCounts(got, 5)}` : ''}.`;
    },
  },
  {
    name: 'find_blocks',
    description: 'Search loaded terrain for a block type and return coordinates, nearest first. Generic names work ("log", "iron", "diamond"). Only chunks near the bot are searched.',
    params: {
      type: 'object',
      properties: {
        block: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 20 },
        maxDistance: { type: 'integer', minimum: 4, maximum: 96 },
      },
      required: ['block'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const res = resolveBlock(ctx, args.block);
      const ids = new Set(blockIdsFor(ctx, res.names));
      const count = intArg(args.count, 5, 1, 20);
      const maxDistance = intArg(args.maxDistance, 48, 4, 96);
      const me = bot.entity.position;
      const pts = scanBlocks(bot, ids, { maxDistance, count });
      const label = res.generic ? args.block : res.names[0];
      if (!pts.length) return `No ${label} found within ${maxDistance} blocks (only loaded chunks are searched). Try explore or move and search again.`;
      return `Found ${pts.length} ${label}: ` + pts.map((p) => `${blockAtSafe(bot, p)?.name ?? label} at ${p.x},${p.y},${p.z} (${Math.round(p.distanceTo(me))}m)`).join('; ');
    },
  },
  {
    name: 'farm',
    description: 'Harvest fully grown crops (wheat, carrots, potatoes, beetroots, nether wart) within ~16 blocks and replant them from your inventory. Immature crops are left alone. To start a farm use use_item (hoe on grass/dirt next to water, then seeds on the farmland).',
    params: {
      type: 'object',
      properties: { radius: { type: 'integer', minimum: 3, maximum: 32 } },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const radius = intArg(args.radius, 16, 3, 32);
      const ids = new Set(blockIdsFor(ctx, Object.keys(CROPS)));
      const all = scanBlocks(bot, ids, { maxDistance: radius, count: 200 });
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
      let done = 0;
      for (const { p, b, def } of mature.slice(0, 40)) {
        checkAbort(ctx);
        if (outOfTime(ctx, 4000)) break;
        done++;
        try {
          await moveTo(ctx, goalForBlock(bot, p, b), { label: 'crop', timeoutMs: 20000, noUnstick: true, dig: false });
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
      const rest = mature.length - done > 0 ? ` ${mature.length - done} mature crops left (call again).` : '';
      return hs ? `Harvested ${hs}; replanted ${replanted}. ${growing} crops still growing.${rest}` : `Could not harvest any of ${mature.length} mature crops (unreachable?).`;
    },
  },
];
