// Movement skills.
import {
  SkillError, goals, Vec3, moveTo, goNear, checkAbort, sleep, fmtPos, vecFrom, numArg, intArg, findPlayerEntity,
  playerExists, stopEverything, isSolid, isAir, isLiquid, blockAtSafe, feetPos, towerUp, inHole, digBlock, findPlaceableJunk, getMovements,
} from './util.js';

const visited = new WeakMap(); // bot -> Set of 32x32 cells already explored

const DIRS = {
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  northeast: [1, -1], northwest: [-1, -1], southeast: [1, 1], southwest: [-1, 1],
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1],
};

const cellOf = (x, z) => `${Math.floor(x / 32)},${Math.floor(z / 32)}`;

export const movementSkills = [
  {
    name: 'go_to',
    description: 'Walk (pathfind) to coordinates. Digs/places blocks when needed. Use `range` to stop within N blocks of the point (default 1). If y is omitted only x/z are targeted (ends at ground level). Fails with a clear message if unreachable or stuck.',
    params: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number', description: 'optional height' }, z: { type: 'number' },
        range: { type: 'number', minimum: 0, description: 'stop when within this many blocks (default 1)' },
      },
      required: ['x', 'z'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const x = numArg(args.x), z = numArg(args.z);
      const range = numArg(args.range, 1);
      if (x === undefined || z === undefined) throw new SkillError('x and z are required.');
      let goal;
      if (args.y === undefined || args.y === null) goal = new goals.GoalNearXZ(x, z, Math.max(range, 1));
      else if (range <= 0.5) goal = new goals.GoalBlock(Math.floor(x), Math.floor(numArg(args.y)), Math.floor(z));
      else goal = new goals.GoalNear(x, numArg(args.y), z, range);
      await moveTo(ctx, goal, { label: `${Math.round(x)}, ${args.y ?? '~'}, ${Math.round(z)}` });
      return `Arrived at ${fmtPos(ctx.bot.entity.position)}.`;
    },
  },
  {
    name: 'go_to_player',
    description: 'Walk to a player who is currently visible/loaded nearby (not just online) and stop `distance` blocks from them.',
    params: {
      type: 'object',
      properties: { name: { type: 'string' }, distance: { type: 'number', minimum: 1, description: 'default 3' } },
      required: ['name'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const e = findPlayerEntity(ctx.bot, args.name);
      if (!e) {
        if (playerExists(ctx.bot, args.name)) throw new SkillError(`${args.name} is online but too far away for me to see. Ask them for their coordinates and use go_to.`);
        throw new SkillError(`Player "${args.name}" is not online.`);
      }
      const d = numArg(args.distance, 3);
      await moveTo(ctx, new goals.GoalNear(e.position.x, e.position.y, e.position.z, d), { label: args.name });
      const e2 = findPlayerEntity(ctx.bot, args.name) ?? e;
      return `Now ${Math.round(e2.position.distanceTo(ctx.bot.entity.position))} blocks from ${args.name} at ${fmtPos(ctx.bot.entity.position)}.`;
    },
  },
  {
    name: 'follow_player',
    description: 'Keep following a player (staying ~`distance` blocks away) until interrupted or `seconds` elapse (default 60, max 600). Good for "follow me". Ends early if the player leaves or gets lost for 10s.',
    interruptible: true,
    params: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        distance: { type: 'number', minimum: 1, description: 'default 3' },
        seconds: { type: 'number', minimum: 1, maximum: 600, description: 'default 60' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const dist = numArg(args.distance, 3);
      const seconds = Math.min(600, numArg(args.seconds, 60));
      let e = findPlayerEntity(bot, args.name);
      if (!e) throw new SkillError(`I can't see ${args.name} nearby${playerExists(bot, args.name) ? ' (online but far away; ask for coordinates and use go_to)' : ' (not online)'}.`);
      bot.pathfinder.setMovements(getMovements(ctx));
      bot.pathfinder.setGoal(new goals.GoalFollow(e, dist), true);
      const end = Date.now() + seconds * 1000;
      let lostSince = 0;
      try {
        while (Date.now() < end) {
          await sleep(ctx, 500);
          e = findPlayerEntity(bot, args.name);
          if (!e) {
            lostSince ||= Date.now();
            if (Date.now() - lostSince > 10000) return `Lost sight of ${args.name}; stopped following at ${fmtPos(bot.entity.position)}.`;
          } else if (lostSince) {
            lostSince = 0;
            bot.pathfinder.setGoal(new goals.GoalFollow(e, dist), true);
          }
        }
      } finally {
        try { bot.pathfinder.setGoal(null); bot.pathfinder.stop(); } catch { /* ignore */ }
        bot.clearControlStates();
      }
      return `Followed ${args.name} for ${seconds}s; now at ${fmtPos(bot.entity.position)}.`;
    },
  },
  {
    name: 'explore',
    description: 'Walk to an unexplored area to discover new terrain/resources. Optional `direction` (north/south/east/west/northeast/...; default: automatic, prefers unvisited areas) and `distance` in blocks (default 40, max 200). Reports where it ended up and what is nearby.',
    interruptible: true,
    params: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: 'north|south|east|west|northeast|northwest|southeast|southwest|random' },
        distance: { type: 'integer', minimum: 8, maximum: 200 },
      },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const total = intArg(args.distance, 40, 8, 200);
      let seen = visited.get(bot);
      if (!seen) visited.set(bot, (seen = new Set()));
      const start = bot.entity.position.clone();
      seen.add(cellOf(start.x, start.z));
      let dirKey = String(args.direction ?? '').toLowerCase().replace(/[\s_-]/g, '');
      let vec;
      if (DIRS[dirKey]) vec = DIRS[dirKey];
      else {
        // pick the direction whose target cell is unvisited, with some randomness
        const opts = Object.values({ n: DIRS.north, e: DIRS.east, s: DIRS.south, w: DIRS.west, ne: DIRS.ne, nw: DIRS.nw, se: DIRS.se, sw: DIRS.sw });
        const scored = opts.map((v) => {
          const n = Math.hypot(v[0], v[1]);
          const tx = start.x + (v[0] / n) * total, tz = start.z + (v[1] / n) * total;
          return { v, score: (seen.has(cellOf(tx, tz)) ? 0 : 1) + Math.random() * 0.9 };
        }).sort((a, b) => b.score - a.score);
        vec = scored[0].v;
      }
      let dx = vec[0], dz = vec[1];
      const n0 = Math.hypot(dx, dz);
      dx /= n0; dz /= n0;
      let moved = 0;
      let fails = 0;
      let rot = 0;
      while (moved < total - 4 && fails < 4) {
        checkAbort(ctx);
        const step = Math.min(32, total - moved);
        const cur = bot.entity.position;
        const a = Math.atan2(dz, dx) + rot;
        const tx = cur.x + Math.cos(a) * step, tz = cur.z + Math.sin(a) * step;
        try {
          await moveTo(ctx, new goals.GoalNearXZ(tx, tz, 4), { label: `exploration point ${Math.round(tx)}, ${Math.round(tz)}`, timeoutMs: 40000 });
          seen.add(cellOf(bot.entity.position.x, bot.entity.position.z));
          moved = Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z);
          rot = 0;
        } catch (err) {
          if (err.message === 'Aborted') throw err;
          fails++;
          rot = (fails % 2 ? 1 : -1) * (Math.PI / 4) * Math.ceil(fails / 2);
        }
      }
      const end = bot.entity.position;
      const dist = Math.round(Math.hypot(end.x - start.x, end.z - start.z));
      if (dist < 8) throw new SkillError(`Could not make progress exploring (moved ${dist} blocks, now at ${fmtPos(end)}). The area may be enclosed or water/cliffs block the way; try another direction.`);
      let biome = '';
      try { biome = blockAtSafe(bot, feetPos(bot))?.biome?.name ?? ''; } catch { /* ignore */ }
      return `Explored ${dist} blocks, now at ${fmtPos(end)}${biome ? ` (biome ${biome})` : ''}. Use look_around to see what is nearby.`;
    },
  },
  {
    name: 'save_place',
    description: 'Remember the current position (or given x,y,z) under a name such as "home" or "iron mine" so you can return later with go_to_place. Overwrites an existing place with the same name.',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string' }, note: { type: 'string', description: 'optional short note' },
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      if (!args.name?.trim()) throw new SkillError('A place name is required.');
      const p = args.x !== undefined && args.z !== undefined ? { x: Math.floor(args.x), y: Math.floor(args.y ?? ctx.bot.entity.position.y), z: Math.floor(args.z) } : ctx.bot.entity.position.floored();
      const dimension = (ctx.bot.game?.dimension ?? 'overworld').replace('minecraft:', '');
      ctx.memory.setPlace(args.name.trim(), { x: p.x, y: p.y, z: p.z, dimension, note: args.note ?? '' });
      return `Saved place "${args.name.trim()}" at ${p.x}, ${p.y}, ${p.z} (${dimension}).`;
    },
  },
  {
    name: 'list_places',
    description: 'List all saved places (name, coordinates, dimension, note).',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const list = ctx.memory.listPlaces();
      if (!list.length) return 'No saved places yet. Use save_place.';
      const me = ctx.bot.entity.position;
      return list.map((p) => `${p.name}: ${p.x}, ${p.y}, ${p.z} (${p.dimension ?? '?'}, ${Math.round(Math.hypot(p.x - me.x, p.z - me.z))}m away)${p.note ? ' - ' + p.note : ''}`).join('\n');
    },
  },
  {
    name: 'go_to_place',
    description: 'Walk to a place previously saved with save_place.',
    params: {
      type: 'object',
      properties: { name: { type: 'string' }, range: { type: 'number', minimum: 0, description: 'default 2' } },
      required: ['name'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const p = ctx.memory.getPlace(args.name);
      if (!p) {
        const names = ctx.memory.listPlaces().map((x) => x.name);
        throw new SkillError(`No saved place called "${args.name}".${names.length ? ' Known places: ' + names.join(', ') + '.' : ' No places saved yet.'}`);
      }
      const dim = (ctx.bot.game?.dimension ?? 'overworld').replace('minecraft:', '');
      if (p.dimension && p.dimension.replace('minecraft:', '') !== dim) {
        throw new SkillError(`"${p.name ?? args.name}" is in the ${p.dimension}, but I am in the ${dim}.`);
      }
      await goNear(ctx, new Vec3(p.x, p.y, p.z), numArg(args.range, 2), { label: p.name ?? args.name });
      return `Arrived at ${p.name ?? args.name} (${fmtPos(ctx.bot.entity.position)}).`;
    },
  },
  {
    name: 'come_up_to_surface',
    description: 'Escape from a hole, deep water or a cave: swim up / tower up / dig out toward open sky and stand on the surface. Use when trapped, drowning, or lost underground.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const bot = ctx.bot;
      const openAbove = (p) => {
        for (let dy = 1; dy <= 30; dy++) {
          const b = blockAtSafe(bot, p.offset(0, dy, 0));
          if (isSolid(b) && !/leaves/.test(b.name)) return false;
        }
        return true;
      };
      const sky = (b) => b && ((typeof b.skyLight === 'number' && b.skyLight >= 12) || openAbove(b.position));
      const standable = (p) => {
        const below = blockAtSafe(bot, p.offset(0, -1, 0));
        const here = blockAtSafe(bot, p);
        const up = blockAtSafe(bot, p.offset(0, 1, 0));
        return isSolid(below) && !isLiquid(below) && isAir(here) && isAir(up) && sky(here) && !inHole(bot, p);
      };
      const atSurface = () => !inHole(bot) && (standable(feetPos(bot)) || (sky(blockAtSafe(bot, feetPos(bot))) && !isLiquid(blockAtSafe(bot, feetPos(bot))) && isSolid(blockAtSafe(bot, feetPos(bot).offset(0, -1, 0)))));
      if (atSurface()) return `Already on the surface at ${fmtPos(bot.entity.position)}.`;
      const startY = bot.entity.position.y;
      const air = new Set(['air', 'cave_air']);
      const ids = Object.values(bot.registry.blocksByName).filter((b) => air.has(b.name)).map((b) => b.id);
      const tried = [];
      for (let round = 0; round < 3; round++) {
        checkAbort(ctx);
        const cands = bot.findBlocks({ matching: ids, maxDistance: 32, count: 400, useExtraInfo: (b) => standable(b.position) })
          .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
          .filter((p) => !tried.some((t) => t.equals(p)));
        if (cands.length) {
          const c = cands[0];
          tried.push(c);
          try {
            await moveTo(ctx, new goals.GoalBlock(c.x, c.y, c.z), { label: 'the surface', timeoutMs: 60000 });
            return `Back on the surface at ${fmtPos(bot.entity.position)} (was y=${Math.round(startY)}).`;
          } catch (err) {
            if (err.message === 'Aborted') throw err;
            ctx.log?.(`surface path failed: ${err.message}`);
          }
        }
        // no reachable surface spot: climb/dig upward
        const water = isLiquid(blockAtSafe(bot, feetPos(bot)));
        if (water) {
          bot.setControlState('jump', true);
          await sleep(ctx, 1500);
          bot.setControlState('jump', false);
        }
        const target = Math.floor(startY) + 12 * (round + 1);
        try {
          await moveTo(ctx, new goals.GoalY(target), { label: `height y=${target}`, timeoutMs: 45000 });
        } catch (err) {
          if (err.message === 'Aborted') throw err;
          // last resort: pillar up manually
          const n = await towerUp(ctx, 6).catch(() => 0);
          if (!n && !findPlaceableJunk(bot) && round === 2) {
            throw new SkillError(`Could not get to the surface from ${fmtPos(bot.entity.position)}: no path and no blocks to build with. Try digging upward with dig_block_at or collect cobblestone/dirt first.`);
          }
        }
        if (atSurface()) return `Back on the surface at ${fmtPos(bot.entity.position)} (was y=${Math.round(startY)}).`;
      }
      throw new SkillError(`Could not reach the surface; now at ${fmtPos(bot.entity.position)}. Try explore, or dig upward with dig_block_at.`);
    },
  },
];
