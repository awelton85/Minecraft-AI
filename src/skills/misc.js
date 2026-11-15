// Misc skills: sleep, use_block, wait, look_around, chat.
import {
  SkillError, goals, moveTo, checkAbort, sleep as sleepMs, fmtPos, vecFrom, intArg, numArg, findNearestBlock, withTimeout,
  blockAtSafe, isHostile, waitUntil,
} from './util.js';
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
      const near = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && isHostile(e) && e.position.distanceTo(me) < 8);
      if (near.length) throw new SkillError(`Cannot sleep: hostile mob(s) nearby (${near.slice(0, 3).map((e) => e.name).join(', ')}). Kill them or flee first.`);
      const beds = bot.findBlocks({ matching: (b) => bot.isABed(b), maxDistance: 32, count: 6 }).sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
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
          const woke = await waitUntil(ctx, () => !bot.isSleeping, 90000, 500).catch(async (e) => {
            if (bot.isSleeping) await bot.wake().catch(() => {});
            throw e;
          });
          if (!woke) {
            await bot.wake().catch(() => {});
            return `Slept ${Math.round((Date.now() - start) / 1000)}s but it is still night (other players may not be in bed); woke up. Time now ${bot.time.timeOfDay}.`;
          }
          return `Slept and woke up at ${fmtPos(bot.entity.position)}; time now ${bot.time.timeOfDay}. Respawn point set.`;
        } catch (err) {
          if (err.message === 'Aborted') { if (bot.isSleeping) await bot.wake().catch(() => {}); throw err; }
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
        await moveTo(ctx, new goals.GoalGetToBlock(pos.x, pos.y, pos.z), { label: block.name, timeoutMs: 40000 });
      }
      try {
        await withTimeout(ctx, bot.lookAt(pos.offset(0.5, 0.5, 0.5), true), 2000, 'Looking');
        await withTimeout(ctx, bot.activateBlock(block), 6000, `Using ${block.name}`);
      } catch (err) {
        if (err instanceof SkillError) throw err;
        throw new SkillError(`Could not use ${block.name} at ${fmtPos(pos)}: ${err.message}`);
      }
      await sleepMs(ctx, 250);
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
      const s = Math.min(300, Math.max(1, numArg(args.seconds, 5)));
      await sleepMs(ctx, s * 1000);
      return `Waited ${s}s.`;
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
];
