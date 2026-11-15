// Combat skills (mineflayer-pvp does the fighting; we pick the weapon, bound the fight and handle aborts).
import {
  SkillError, goals, moveTo, checkAbort, sleep, fmtPos, intArg, numArg, isHostile, findPlayerEntity, stopEverything, getMovements,
  withTimeout, HOSTILE_NAMES,
} from './util.js';

const WEAPONS = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe',
];

async function equipBestWeapon(ctx) {
  const bot = ctx.bot;
  const items = bot.inventory.items();
  for (const w of WEAPONS) {
    const it = items.find((i) => i.name === w);
    if (it) {
      if (bot.heldItem?.type !== it.type) await bot.equip(it, 'hand').catch(() => {});
      return it.name;
    }
  }
  return null;
}

function findTarget(ctx, spec, maxDist) {
  const bot = ctx.bot;
  const me = bot.entity.position;
  const s = String(spec ?? 'hostile').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const p = findPlayerEntity(bot, spec);
  if (p) return p;
  const wantHostile = ['hostile', 'nearest', 'any', 'monster', 'mob', 'nearest_hostile', 'enemy', ''].includes(s);
  const cands = Object.values(bot.entities).filter((e) => {
    if (e === bot.entity || !e.position || e.isValid === false) return false;
    if (e.position.distanceTo(me) > maxDist) return false;
    if (wantHostile) return isHostile(e);
    if (e.type === 'player') return false;
    return (e.name ?? '').toLowerCase() === s || (e.displayName ?? '').toLowerCase().replace(/\s+/g, '_') === s || (e.name ?? '').toLowerCase() === s.replace(/s$/, '');
  });
  cands.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  return cands[0] ?? null;
}

export const combatSkills = [
  {
    name: 'attack',
    description: 'Fight a target until it is dead, out of range, you are in danger (health <= 6) or timeout. `target`: a mob type ("zombie", "cow", "skeleton"), a player name, or "hostile"/"nearest" for the closest hostile mob. Equips your best sword/axe automatically. Only attack players if explicitly instructed. Also use this to hunt animals for food.',
    params: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'mob type, player name, or "hostile" (default)' },
        maxDistance: { type: 'number', minimum: 3, maximum: 64, description: 'search radius, default 24' },
        timeoutSeconds: { type: 'number', minimum: 3, maximum: 120, description: 'default 30' },
      },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      if (!bot.pvp) throw new SkillError('PVP plugin is not loaded.');
      const maxDist = numArg(args.maxDistance, 24);
      const target = findTarget(ctx, args.target, maxDist);
      if (!target) throw new SkillError(`No ${args.target ?? 'hostile mob'} found within ${maxDist} blocks.`);
      const tname = target.type === 'player' ? target.username : target.name ?? 'mob';
      const timeout = Math.min(120, numArg(args.timeoutSeconds, 30)) * 1000;
      const weapon = await equipBestWeapon(ctx);
      bot.pvp.movements = getMovements(ctx);
      const hp0 = bot.health;
      const t0 = Date.now();
      let dead = false;
      const onDead = (e) => { if (e === target) dead = true; };
      const onGone = (e) => { if (e === target) dead = true; };
      bot.on('entityDead', onDead);
      bot.on('entityGone', onGone);
      let reason = 'timeout';
      try {
        bot.pvp.attack(target).catch(() => {});
        for (;;) {
          await sleep(ctx, 250);
          if (dead || target.isValid === false) { reason = 'dead'; break; }
          if (bot.health <= 6 && bot.health < hp0) { reason = 'low-health'; break; }
          if (!bot.pvp.target) { reason = 'lost'; break; }
          if (Date.now() - t0 > timeout) break;
        }
      } finally {
        bot.removeListener('entityDead', onDead);
        bot.removeListener('entityGone', onGone);
        try { await bot.pvp.stop(); } catch { /* ignore */ }
        try { bot.pvp.forceStop?.(); } catch { /* ignore */ }
        bot.clearControlStates();
      }
      const secs = Math.round((Date.now() - t0) / 1000);
      const hp = `HP ${Math.round(hp0)} -> ${Math.round(bot.health)}`;
      if (reason === 'dead') return `Killed ${tname} in ${secs}s using ${weapon ?? 'bare hands'}. ${hp}. Any drops: pick them up with collect/walk over them.`;
      if (reason === 'low-health') throw new SkillError(`Stopped fighting ${tname} because health is low (${Math.round(bot.health)}). Use flee, eat, or build_shelter.`);
      if (reason === 'lost') return `Lost ${tname} (out of range or escaped) after ${secs}s. ${hp}.`;
      return `Timed out after ${secs}s; ${tname} is still alive${target.position ? ' at ' + fmtPos(target.position) : ''}. ${hp}.`;
    },
  },
  {
    name: 'flee',
    description: 'Run away from the nearest hostile mobs, `distance` blocks (default 20). Use when health is low or outnumbered. Follow up with build_shelter, eat or sleep.',
    params: {
      type: 'object',
      properties: { distance: { type: 'integer', minimum: 5, maximum: 80 } },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      const dist = intArg(args.distance, 20, 5, 80);
      const me = bot.entity.position;
      const hostiles = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && isHostile(e) && e.position.distanceTo(me) < 32);
      if (!hostiles.length) return 'No hostile mobs nearby; nothing to flee from.';
      let dx = 0, dz = 0;
      for (const h of hostiles) {
        const d = Math.max(1, h.position.distanceTo(me));
        dx += (me.x - h.position.x) / d / d;
        dz += (me.z - h.position.z) / d / d;
      }
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const base = Math.atan2(dz, dx);
      let lastErr;
      for (const rot of [0, 0.7, -0.7, 1.4, -1.4]) {
        checkAbort(ctx);
        const a = base + rot;
        const tx = me.x + Math.cos(a) * dist, tz = me.z + Math.sin(a) * dist;
        try {
          bot.setControlState('sprint', true);
          await moveTo(ctx, new goals.GoalNearXZ(tx, tz, 3), { label: 'safe spot', timeoutMs: 25000 });
          break;
        } catch (err) {
          if (err.message === 'Aborted') throw err;
          lastErr = err;
        } finally {
          bot.setControlState('sprint', false);
        }
      }
      const moved = Math.round(bot.entity.position.distanceTo(me));
      const still = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && isHostile(e) && e.position.distanceTo(bot.entity.position) < 12);
      if (moved < 4 && lastErr) throw new SkillError(`Could not flee: ${lastErr.message}`);
      return `Ran ${moved} blocks away to ${fmtPos(bot.entity.position)}. ${still.length ? `${still.length} hostile(s) still within 12 blocks (${still.slice(0, 3).map((e) => e.name).join(', ')}); consider build_shelter or fighting.` : 'No hostiles within 12 blocks now.'}`;
    },
  },
];
