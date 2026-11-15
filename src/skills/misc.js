// Misc skills: sleep, use_block, wait, look_around, chat.
import {
  SkillError, goals, moveTo, checkAbort, sleep as sleepMs, fmtPos, vecFrom, intArg, numArg, withTimeout,
  blockAtSafe, isHostile, waitUntil, closeOpenWindow, goalForBlock, pickInventoryItem, equipItem, timeLeft, budgetMs, Vec3,
  isLiquid, isAir, isSolid, digBlock, equipTool, placeItemAt, findItem, FACES, outOfTime, formatCounts, inventoryCounts, scanBlocks,
  isProtectedBlockName, haltPathfinder,
} from './util.js';

/** bot.wake() can hang when the server never confirms: bound it (plain timer, usable during abort cleanup). */
async function wakeSafe(bot) {
  await Promise.race([bot.wake().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}
import { describeState } from './observe.js';

export const miscSkills = [
  {
    name: 'sleep',
    description: 'Go to the nearest bed (within 32 blocks) and sleep through the night. Only works at night (or in thunderstorms) and when no hostile mobs are within 8 blocks. Sleeping also sets your respawn point. Explains why if it cannot sleep.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const bot = ctx.bot;
      const t = bot.time?.timeOfDay ?? 0;
      const thunder = bot.isRaining && bot.thunderState > 0;
      if (!thunder && !(t >= 12541 && t <= 23458)) {
        throw new SkillError(`It is not night (time ${t}; beds work from 12541 to 23458) and there is no thunderstorm, so sleeping is impossible right now. Try again at dusk/night.`);
      }
      const me = bot.entity.position;
      const near = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && isHostile(e, bot) && e.position.distanceTo(me) < 8);
      if (near.length) throw new SkillError(`Cannot sleep: hostile mob(s) nearby (${near.slice(0, 3).map((e) => e.name).join(', ')}). Kill them or flee first.`);
      const bedIds = new Set(Object.values(bot.registry.blocksByName).filter((b) => /_bed$/.test(b.name)).map((b) => b.id));
      const beds = scanBlocks(bot, bedIds, { maxDistance: 32, count: 6 }).sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
      if (!beds.length) throw new SkillError('No bed within 32 blocks. Craft one (3 wool + 3 planks) and place it with place_block, or explore.');
      let lastErr;
      for (const p of beds) {
        const bed = blockAtSafe(bot, p);
        if (!bed) continue;
        try {
          if (bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) > 2.5) {
            await moveTo(ctx, new goals.GoalNear(p.x, p.y, p.z, 2), { label: 'bed', timeoutMs: 45000 });
          }
          await withTimeout(ctx, bot.sleep(bed), 8000, 'Going to bed');
          const start = Date.now();
          const woke = await waitUntil(ctx, () => !bot.isSleeping, Math.min(90000, Math.max(5000, timeLeft(ctx) - 6000)), 500).catch(async (e) => {
            if (bot.isSleeping) await wakeSafe(bot);
            throw e;
          });
          if (!woke) {
            await wakeSafe(bot);
            return `Slept ${Math.round((Date.now() - start) / 1000)}s but it is still night (other players may not be in bed); woke up. Time now ${bot.time.timeOfDay}.`;
          }
          return `Slept and woke up at ${fmtPos(bot.entity.position)}; time now ${bot.time.timeOfDay}. Respawn point set.`;
        } catch (err) {
          if (err.message === 'Aborted') { if (bot.isSleeping) await wakeSafe(bot); throw err; }
          lastErr = err;
        }
      }
      throw new SkillError(`Could not sleep: ${lastErr?.message ?? 'unknown reason'}.`);
    },
  },
  {
    name: 'use_block',
    description: 'Walk next to the block at x,y,z and right-click it: open/close doors, trapdoors and gates, press buttons, flip levers, etc. Returns the block state afterwards if it has one (e.g. open=true).',
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
      if (!block || block.name === 'air') throw new SkillError(`There is no block at ${fmtPos(pos)} to use.`);
      if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 3.8) {
        await moveTo(ctx, new goals.GoalGetToBlock(pos.x, pos.y, pos.z), { label: block.name, timeoutMs: 40000, dig: false });
      }
      try {
        await withTimeout(ctx, bot.lookAt(pos.offset(0.5, 0.5, 0.5), true), 2000, 'Looking');
        await withTimeout(ctx, bot.activateBlock(block), 6000, `Using ${block.name}`, () => closeOpenWindow(bot));
      } catch (err) {
        if (err instanceof SkillError) throw err;
        throw new SkillError(`Could not use ${block.name} at ${fmtPos(pos)}: ${err.message}`);
      }
      await sleepMs(ctx, 350).catch((e) => { closeOpenWindow(bot); throw e; });
      if (bot.currentWindow) {
        closeOpenWindow(bot);
        throw new SkillError(`${block.name} at ${fmtPos(pos)} is a container/workstation (a window opened and I closed it). Use chest_list / chest_withdraw / chest_deposit for chests, smelt_item / furnace_collect for furnaces, craft_item for crafting.`);
      }
      const after = blockAtSafe(bot, pos);
      const props = after?.getProperties?.() ?? {};
      const interesting = ['open', 'powered', 'lit'].filter((k) => k in props).map((k) => `${k}=${props[k]}`);
      return `Used ${block.name} at ${fmtPos(pos)}${interesting.length ? ` (${interesting.join(', ')})` : ''}.`;
    },
  },
  {
    name: 'wait',
    description: 'Do nothing for a number of seconds (default 5, max 300), e.g. while waiting for crops, a furnace, daylight or another player. Can be interrupted.',
    interruptible: true,
    params: {
      type: 'object',
      properties: { seconds: { type: 'number', minimum: 1, maximum: 300 } },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const wanted = Math.min(300, Math.max(1, numArg(args.seconds, 5)));
      const s = Math.max(1, Math.min(wanted, (timeLeft(ctx) - 1500) / 1000));
      const t0 = Date.now();
      try {
        await sleepMs(ctx, s * 1000);
      } catch (e) {
        if (e.message === 'Aborted') throw new SkillError(`Aborted after waiting ${Math.round((Date.now() - t0) / 1000)}s.`);
        throw e;
      }
      return `Waited ${Math.round(s)}s${s < wanted ? ` (cut short from ${wanted}s by the action time limit)` : ''}.`;
    },
  },
  {
    name: 'look_around',
    description: 'Get a detailed snapshot of the surroundings: position, time, weather, health, inventory, nearby players, hostile mobs and notable blocks (logs, ores, water, lava, chests, beds...) with coordinates.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      return describeState(ctx.bot, { detail: 'full' });
    },
  },
  {
    name: 'chat',
    description: 'Say something in the in-game chat (visible to all players). Keep it short.',
    params: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const text = String(args.text ?? '').trim();
      if (!text) throw new SkillError('Nothing to say.');
      await ctx.say(text);
      return `Said: ${text.slice(0, 120)}`;
    },
  },
  {
    name: 'use_item',
    description: 'Use an inventory item, optionally on the block at x,y,z (add x2,z2 for a rectangle at the same y). Hoe on grass/dirt = till (needs water nearby for farmland); seeds/carrot/potato on farmland = plant; bone_meal on crops; flint_and_steel; bucket on water/lava = fill; bucket on a block = pour. Without x,y,z uses the item in the air (e.g. bucket on the water you face).',
    params: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'item to use (default: held item)' },
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
        x2: { type: 'number' }, z2: { type: 'number' },
        face: { type: 'string', enum: ['up', 'down', 'north', 'south', 'east', 'west'], description: 'face of the target block to click (default up)' },
      },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      let name = bot.heldItem?.name;
      if (args.item) {
        const p = pickInventoryItem(ctx, args.item);
        await equipItem(ctx, p.item);
        name = p.name;
      }
      if (!name) throw new SkillError('Nothing held: name an item to use.');
      const faces = { up: new Vec3(0, 1, 0), down: new Vec3(0, -1, 0), north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0) };
      const face = faces[args.face ?? 'up'];
      if (args.x === undefined) {
        await withTimeout(ctx, Promise.resolve(bot.activateItem()), 3000, `Using ${name}`);
        await sleepMs(ctx, 400);
        return `Used ${name} (held, no target).`;
      }
      const a = vecFrom(args);
      const b = args.x2 !== undefined && args.z2 !== undefined ? new Vec3(Math.floor(args.x2), a.y, Math.floor(args.z2)) : a;
      const cells = [];
      for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++) cells.push(new Vec3(x, a.y, z));
      if (cells.length > 40) throw new SkillError('Area too large (max 40 blocks).');
      cells.sort((p, q) => p.distanceTo(bot.entity.position) - q.distanceTo(bot.entity.position));
      const before = inventoryCounts(bot);
      let ok = 0;
      const notes = [];
      for (const pos of cells) {
        checkAbort(ctx);
        if (outOfTime(ctx, 3000)) { notes.push('out of time'); break; }
        const block = blockAtSafe(bot, pos);
        if (!block) { notes.push(`${fmtPos(pos)} not loaded`); continue; }
        try {
          if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4) {
            await moveTo(ctx, goalForBlock(bot, pos, block), { label: block.name, timeoutMs: 20000, dig: false, noUnstick: true });
          }
          if (!bot.heldItem || bot.heldItem.name !== name) { const it = findItem(bot, name); if (it) await equipItem(ctx, it); }
          const center = pos.offset(0.5, 0.5, 0.5);
          await withTimeout(ctx, bot.lookAt(center.offset(face.x * 0.5, face.y * 0.5, face.z * 0.5), true), 2000, 'Looking');
          if (isLiquid(block)) await withTimeout(ctx, Promise.resolve(bot.activateItem()), 3000, `Using ${name}`);
          else await withTimeout(ctx, bot.activateBlock(block, face), 5000, `Using ${name}`);
          await sleepMs(ctx, 250);
          ok++;
        } catch (e) {
          if (e.message === 'Aborted') throw e;
          notes.push(`${fmtPos(pos)}: ${e.message}`);
        }
      }
      await sleepMs(ctx, 200);
      const after = inventoryCounts(bot);
      const diff = {};
      for (const n of new Set([...Object.keys(before), ...Object.keys(after)])) if ((after[n] ?? 0) !== (before[n] ?? 0)) diff[n] = (after[n] ?? 0) - (before[n] ?? 0);
      const first = blockAtSafe(bot, cells[0]);
      const changed = Object.entries(diff).map(([n, d]) => `${d > 0 ? '+' : ''}${d} ${n}`).join(', ');
      if (!ok) throw new SkillError(`Could not use ${name}: ${notes[0] ?? 'unknown error'}.`);
      return `Used ${name} on ${ok}/${cells.length} block(s); first is now ${first?.name ?? '?'}${changed ? `; inventory ${changed}` : ''}${notes.length ? `; problems: ${notes.slice(0, 2).join(' | ')}` : ''}.`;
    },
  },
  {
    name: 'mine_to',
    description: 'Dig a safe 1x2 staircase tunnel up or down to height y, heading in `direction` (default: where you face). Stops at lava/water or a gravel/sand ceiling, places torches if you have them, returns progress (call again to continue). Needs a pickaxe.',
    params: {
      type: 'object',
      properties: {
        y: { type: 'integer', description: 'target height' },
        direction: { type: 'string', enum: ['north', 'south', 'east', 'west'] },
      },
      required: ['y'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const targetY = Math.floor(Number(args.y));
      if (!Number.isFinite(targetY)) throw new SkillError('y must be a number.');
      const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
      let [dx, dz] = dirs[args.direction] ?? (() => {
        const yaw = bot.entity.yaw;
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        return Math.abs(fx) > Math.abs(fz) ? [Math.sign(fx), 0] : [0, Math.sign(fz)];
      })();
      const startY = Math.floor(bot.entity.position.y);
      if (startY === targetY) return `Already at y=${targetY}.`;
      const dy = Math.sign(targetY - startY);
      const danger = (p) => {
        for (const d of [...FACES, new Vec3(0, 0, 0)]) {
          const b = blockAtSafe(bot, p.plus(d));
          if (b && (b.name === 'lava' || b.name === 'water')) return b.name;
        }
        return null;
      };
      const falling = (b) => b && /^(gravel|sand|red_sand|suspicious_)/.test(b.name);
      let steps = 0;
      let torchIn = 0;
      let stop = '';
      try {
        while (Math.floor(bot.entity.position.y) !== targetY) {
          checkAbort(ctx);
          if (outOfTime(ctx, 4000)) { stop = 'out of time'; break; }
          const f = bot.entity.position.floored();
          const next = new Vec3(f.x + dx, f.y + dy, f.z + dz); // cell we will stand in (feet)
          // cells to clear: the next feet cell, the head cell above it, and for descending the cell above current to keep headroom
          const cells = dy < 0 ? [new Vec3(f.x + dx, f.y + 1, f.z + dz), new Vec3(f.x + dx, f.y, f.z + dz), next] : [new Vec3(f.x, f.y + 2, f.z), next, next.offset(0, 1, 0)];
          for (const c of cells) {
            const dg = danger(c);
            if (dg) { stop = `${dg} next to ${fmtPos(c)}`; break; }
          }
          if (stop) break;
          const ceil = blockAtSafe(bot, next.offset(0, 2, 0));
          if (falling(ceil)) { stop = `${ceil.name} above the tunnel`; break; }
          for (const c of cells) {
            const b = blockAtSafe(bot, c);
            if (!b || isAir(b) || b.boundingBox === 'empty') continue;
            if (b.hardness === -1 || b.name === 'bedrock') { stop = `unbreakable ${b.name}`; break; }
            if (isProtectedBlockName(b.name) || /(chest|spawner|_bed$)/.test(b.name)) { stop = `reached a built structure (${b.name} at ${fmtPos(c)})`; break; }
            if (bot.entity.position.distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.3) break;
            try { await digBlock(ctx, b, { timeoutMs: 15000 }); } catch (e) { if (e.message === 'Aborted') throw e; stop = e.message; break; }
          }
          if (stop) break;
          // floor under the next cell for ascending / gaps
          const floor = blockAtSafe(bot, next.offset(0, -1, 0));
          if (!floor || (!isSolid(floor) && !isLiquid(floor))) {
            const junk = bot.inventory.items().find((i) => /^(cobblestone|dirt|netherrack|cobbled_deepslate|stone)$/.test(i.name));
            if (junk) { try { await placeItemAt(ctx, junk, next.offset(0, -1, 0), { stand: true }); } catch { /* ignore */ } }
          }
          await moveTo(ctx, new goals.GoalBlock(next.x, next.y, next.z), { label: 'tunnel', timeoutMs: 20000, noUnstick: false });
          steps++;
          if (++torchIn >= 7) {
            const torch = findItem(bot, 'torch');
            if (torch) { try { await placeItemAt(ctx, torch, f, { stand: true }); } catch { /* ignore */ } }
            torchIn = 0;
          }
        }
      } catch (err) {
        if (err.message === 'Aborted') throw new SkillError(`Aborted after ${steps} tunnel steps; now at ${fmtPos(bot.entity.position)}.`);
        if (steps > 0) stop = stop || err.message;
        else throw err;
      }
      const y = Math.floor(bot.entity.position.y);
      return y === targetY
        ? `Reached y=${y} at ${fmtPos(bot.entity.position)} after ${steps} steps (tunnel heading ${args.direction ?? 'forward'}).`
        : `Dug ${steps} steps; now at ${fmtPos(bot.entity.position)} (y=${y}, target ${targetY}). Stopped: ${stop || 'unknown'}. Call again to continue${stop && /lava|water|unbreakable|structure/.test(stop) ? ' (try another direction)' : ''}.`;
    },
  },
];
