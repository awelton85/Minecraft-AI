// Building skills.
import {
  SkillError, Vec3, checkAbort, fmtPos, vecFrom, pickInventoryItem, placeItemAt, blockAtSafe, isAir, isLiquid, isSolid,
  findPlacementRef, findPlaceableJunk, countItem, inventoryCounts, formatCounts, findItem, intArg,
} from './util.js';

const MAX_BLOCKS = 400;

function isFree(b) {
  return !b || isAir(b) || isLiquid(b) || b.boundingBox === 'empty';
}

function shapePositions(shape, a, b, hollow) {
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
  const z1 = Math.min(a.z, b.z), z2 = Math.max(a.z, b.z);
  const out = [];
  switch (shape) {
    case 'floor':
      for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) out.push(new Vec3(x, a.y, z));
      break;
    case 'wall': {
      const alongX = x2 - x1 >= z2 - z1;
      if (alongX) for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) out.push(new Vec3(x, y, a.z));
      else for (let z = z1; z <= z2; z++) for (let y = y1; y <= y2; y++) out.push(new Vec3(a.x, y, z));
      break;
    }
    case 'box':
      for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) {
        const edge = x === x1 || x === x2 || y === y1 || y === y2 || z === z1 || z === z2;
        if (!hollow || edge) out.push(new Vec3(x, y, z));
      }
      break;
    case 'pillar':
      for (let y = y1; y <= y2; y++) out.push(new Vec3(a.x, y, a.z));
      break;
    case 'stairs': {
      // diagonal staircase from a (low) to b (high): one block per step, climbing along the longer horizontal axis
      const dx = b.x - a.x, dz = b.z - a.z;
      const steps = Math.max(Math.abs(b.y - a.y), 1);
      const horiz = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
      const dir = horiz === 'x' ? Math.sign(dx) || 1 : Math.sign(dz) || 1;
      const up = Math.sign(b.y - a.y) || 1;
      for (let i = 0; i <= steps; i++) {
        const p = new Vec3(a.x, a.y + i * up, a.z);
        if (horiz === 'x') p.x += i * dir; else p.z += i * dir;
        out.push(p);
      }
      break;
    }
    default:
      throw new SkillError(`Unknown shape "${shape}". Use wall, floor, box, pillar or stairs.`);
  }
  return out;
}

export const buildSkills = [
  {
    name: 'place_block',
    description: 'Place one block from inventory at the given x,y,z (the position must be empty and touch at least one solid block). Walks within reach first. Generic names like "planks" or "log" use whichever type you have most of.',
    params: {
      type: 'object',
      properties: { block: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['block', 'x', 'y', 'z'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const pos = vecFrom(args);
      const { item, name } = pickInventoryItem(ctx, args.block);
      if (!ctx.bot.registry.blocksByName[name]) throw new SkillError(`${name} is not a placeable block.`);
      await placeItemAt(ctx, item, pos);
      const b = blockAtSafe(ctx.bot, pos);
      return `Placed ${name} at ${fmtPos(pos)}${b ? ` (now ${b.name})` : ''}. ${countItem(ctx.bot, name)} ${name} left.`;
    },
  },
  {
    name: 'build_shape',
    description: 'Build a structure from inventory blocks between two corners (from/to, inclusive). Shapes: wall (vertical, along x or z; height from y range), floor (flat at from.y covering the x/z range), box (cuboid; hollow=true default builds only the shell, leaving the inside open), pillar (vertical column at from.x/z between y values), stairs (climbing staircase from `from` up to `to`). Skips blocks already present; fails up front if you lack enough blocks. Max 400 blocks. Reports placed/failed counts.',
    params: {
      type: 'object',
      properties: {
        shape: { type: 'string', enum: ['wall', 'floor', 'box', 'pillar', 'stairs'] },
        block: { type: 'string', description: 'block to use, e.g. "cobblestone" or "planks"' },
        from: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
        to: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
        hollow: { type: 'boolean', description: 'box only: shell only (default true)' },
      },
      required: ['shape', 'block', 'from', 'to'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const a = vecFrom(args.from ?? {});
      const b = vecFrom(args.to ?? {});
      const hollow = args.hollow !== false;
      let positions = shapePositions(args.shape, a, b, hollow);
      if (positions.length > MAX_BLOCKS) throw new SkillError(`That shape needs ${positions.length} blocks; the maximum per call is ${MAX_BLOCKS}. Build it in parts.`);
      const todo = positions.filter((p) => isFree(blockAtSafe(bot, p)));
      const already = positions.length - todo.length;
      if (!todo.length) return `Nothing to build: all ${positions.length} positions are already filled.`;
      const picked = pickInventoryItem(ctx, args.block);
      const name = picked.name;
      if (!bot.registry.blocksByName[name]) throw new SkillError(`${name} is not a placeable block.`);
      if (picked.total < todo.length) {
        throw new SkillError(`Need ${todo.length} ${name} but only have ${picked.total}. Collect ${todo.length - picked.total} more (or build a smaller shape).`);
      }
      // bottom-up, then nearest first within a layer
      todo.sort((p, q) => p.y - q.y || p.distanceTo(bot.entity.position) - q.distanceTo(bot.entity.position));
      let placed = 0;
      const failed = [];
      let pending = todo;
      const deadline = Date.now() + 170000;
      for (let pass = 0; pass < 3 && pending.length; pass++) {
        const next = [];
        for (const p of pending) {
          checkAbort(ctx);
          if (Date.now() > deadline) { next.push(p); continue; }
          if (!isFree(blockAtSafe(bot, p))) { continue; }
          if (!findPlacementRef(bot, p)) { next.push(p); continue; } // floating for now; retry after neighbours exist
          try {
            const item = findItem(bot, name);
            if (!item) throw new SkillError(`Ran out of ${name}`);
            await placeItemAt(ctx, item, p);
            placed++;
          } catch (err) {
            if (err.message === 'Aborted') throw err;
            ctx.log?.(`build_shape: ${err.message}`);
            next.push(p);
            if (/Ran out/.test(err.message)) { pass = 99; break; }
          }
        }
        pending = next;
      }
      for (const p of pending) failed.push(fmtPos(p));
      const rem = countItem(bot, name);
      let msg = `Built ${args.shape}: placed ${placed} ${name}, ${already} already present, ${failed.length} failed. ${rem} ${name} left.`;
      if (failed.length) msg += ` Failed at: ${failed.slice(0, 6).join(' | ')}${failed.length > 6 ? ' ...' : ''} (unreachable, floating, or blocked).`;
      if (placed === 0 && failed.length) throw new SkillError(msg);
      return msg;
    },
  },
  {
    name: 'build_shelter',
    description: 'Emergency 1x1 enclosed hut around yourself (walls 3 high plus a roof) using spare cheap blocks (cobblestone, dirt, planks...). Needs ~10 blocks. Use to survive a night or hide from monsters when no house is nearby. Break out afterwards with dig_block_at.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const bot = ctx.bot;
      const f = bot.entity.position.floored();
      const first = findPlaceableJunk(bot);
      if (!first) throw new SkillError('I have no spare solid blocks (cobblestone/dirt/planks) to build a shelter. Collect some first.');
      const want = [];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) want.push(f.offset(dx, dy, dz));
      // roof: first a side block at y+2 (it touches the wall below), then the block above the head
      const roofSide = f.offset(1, 2, 0);
      const roofSide2 = f.offset(-1, 2, 0);
      const roof = f.offset(0, 2, 0);
      const all = [...want, roofSide, roofSide2, roof];
      const todo = all.filter((p) => isFree(blockAtSafe(bot, p)));
      // pick the block type with the most items
      const counts = inventoryCounts(bot);
      let name = first.name;
      for (const n of ['cobblestone', 'dirt', 'netherrack', 'cobbled_deepslate', 'stone']) if ((counts[n] ?? 0) > (counts[name] ?? 0) && (counts[n] ?? 0) >= todo.length) name = n;
      if ((counts[name] ?? 0) < todo.length) {
        // maybe combine: just check total of the chosen type
        throw new SkillError(`A shelter needs ${todo.length} blocks but my largest stack of building blocks is ${counts[name] ?? 0} ${name}. Collect more (cobblestone/dirt).`);
      }
      let placed = 0;
      const failed = [];
      const order = [...todo].sort((p, q) => p.y - q.y);
      for (const p of order) {
        checkAbort(ctx);
        try {
          const item = findItem(bot, name);
          if (!item) throw new SkillError('ran out');
          await placeItemAt(ctx, item, p, { stand: true });
          placed++;
        } catch (err) {
          if (err.message === 'Aborted') throw err;
          failed.push(fmtPos(p));
        }
      }
      const enclosed = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => isSolid(blockAtSafe(bot, f.offset(dx, 0, dz))) && isSolid(blockAtSafe(bot, f.offset(dx, 1, dz)))) && isSolid(blockAtSafe(bot, f.offset(0, 2, 0)));
      if (!enclosed) throw new SkillError(`Shelter incomplete: placed ${placed}, failed ${failed.length} (${failed.slice(0, 4).join(' | ')}). Not fully enclosed.`);
      return `Shelter built around ${fmtPos(f)} with ${placed} ${name} (${failed.length} failed but enclosed). Stay inside until morning (sleep/wait), then dig out with dig_block_at.`;
    },
  },
];
