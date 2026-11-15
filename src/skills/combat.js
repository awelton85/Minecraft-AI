// Combat skills (mineflayer-pvp does the fighting; we pick the weapon, bound the fight and handle aborts).
import {
  SkillError, goals, moveTo, checkAbort, sleep, fmtPos, intArg, numArg, isHostile, stopEverything, getMovements,
  withTimeout, haltPathfinder, collectDrops, formatCounts, timeLeft, PROTECTED_MOBS,
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
      if (bot.heldItem?.type !== it.type) {
        try { await withTimeout(ctx, bot.equip(it, 'hand'), 5000, 'Equipping weapon'); } catch (e) { if (e.message === 'Aborted') throw e; }
      }
      return it.name;
    }
  }
  return null;
}

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

function nearbyMobTypes(bot, maxDist) {
  const me = bot.entity.position;
  const c = {};
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position || e.type === 'player' || e.name === 'item' || e.position.distanceTo(me) > maxDist) continue;
    c[e.name ?? 'mob'] = (c[e.name ?? 'mob'] ?? 0) + 1;
  }
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, k]) => `${n}x${k}`).join(', ');
}

/** Returns { entity } or throws a SkillError explaining why not. */
function findTarget(ctx, spec, maxDist, args) {
  const bot = ctx.bot;
  const me = bot.entity.position;
  const s = norm(spec);
  const wantHostile = ['hostile', 'nearest', 'any', 'monster', 'mob', 'nearest_hostile', 'enemy', ''].includes(s);
  if (!wantHostile) {
    // player?
    const pname = Object.keys(bot.players).find((u) => u.toLowerCase() === String(spec).toLowerCase());
    if (pname) {
      const owners = (ctx.settings?.owners ?? []).map((o) => String(o).toLowerCase());
      const bots = (ctx.manager?.botUsernames?.() ?? []).map((o) => String(o).toLowerCase());
      if (owners.includes(pname.toLowerCase())) throw new SkillError(`${pname} is my owner: I will not attack them.`);
      if (bots.includes(pname.toLowerCase())) throw new SkillError(`${pname} is another AI bot (a teammate): I will not attack them.`);
      if (args.allowPlayer !== true) throw new SkillError(`${pname} is a player. I only attack players when allowPlayer:true is given explicitly (and never owners/teammates).`);
      const e = bot.players[pname].entity;
      if (!e) throw new SkillError(`${pname} is not close enough to attack.`);
      return e;
    }
  }
  const cands = Object.values(bot.entities).filter((e) => {
    if (e === bot.entity || !e.position || e.isValid === false || e.name === 'item') return false;
    if (e.position.distanceTo(me) > maxDist) return false;
    if (wantHostile) return isHostile(e, bot);
    if (e.type === 'player') return false;
    const n = (e.name ?? '').toLowerCase();
    return n === s || n === s.replace(/s$/, '') || (e.displayName ?? '').toLowerCase().replace(/\s+/g, '_') === s;
  });
  cands.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  const e = cands[0];
  if (!e) {
    const types = nearbyMobTypes(bot, maxDist);
    throw new SkillError(`No ${wantHostile ? 'hostile mob' : spec} found within ${maxDist} blocks.${types ? ` Mobs nearby: ${types}.` : ' No mobs nearby at all.'}`);
  }
  if (PROTECTED_MOBS.has(e.name) && args.force !== true) {
    throw new SkillError(`${e.name} is a protected mob (villager / golem / pet): pass force:true only if you are sure.`);
  }
  if (e.metadata?.some?.((m) => m && m.key === 'owner')) { /* tamed check is best effort; PROTECTED_MOBS covers wolves/cats */ }
  return e;
}

export const combatSkills = [
  {
    name: 'attack',
    description: 'Fight a target until dead, lost, health <= 6 or timeout, then pick up its drops. target: mob type ("zombie", "cow"), or "hostile"/"nearest" for the closest hostile (neutral mobs are never auto-targeted). Equips your best weapon. Players only with allowPlayer:true (never owners or teammate bots); villagers/golems/pets need force:true.',
    params: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'mob type, player name, or "hostile" (default)' },
        maxDistance: { type: 'number', minimum: 3, maximum: 64, description: 'default 24' },
        timeoutSeconds: { type: 'number', minimum: 3, maximum: 120, description: 'default 30' },
        allowPlayer: { type: 'boolean' },
        force: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const bot = ctx.bot;
      if (!bot.pvp) throw new SkillError('PVP plugin is not loaded.');
      const maxDist = numArg(args.maxDistance, 24);
      const target = findTarget(ctx, args.target, maxDist, args);
      const tname = target.type === 'player' ? target.username : target.name ?? 'mob';
      const timeout = Math.max(3000, Math.min(Math.min(120, numArg(args.timeoutSeconds, 30)) * 1000, timeLeft(ctx) - 6000));
      // a self-defence reflex may already be fighting something else: stop it synchronously first
      try { bot.pvp.forceStop?.(); } catch { /* ignore */ }
      haltPathfinder(bot);
      const weapon = await equipBestWeapon(ctx);
      bot.pvp.movements = getMovements(ctx);
      const hp0 = bot.health;
      const t0 = Date.now();
      let dead = false;
      let started = false;
      let lastPos = target.position.clone();
      const onDead = (e) => { if (e === target) dead = true; };
      bot.on('entityDead', onDead);
      bot.on('entityGone', onDead);
      let reason = 'timeout';
      try {
        bot.pvp.attack(target).catch(() => {});
        for (;;) {
          await sleep(ctx, 250);
          if (target.position) lastPos = target.position.clone();
          if (bot.pvp.target === target) started = true;
          if (dead || target.isValid === false) { reason = 'dead'; break; }
          if (bot.health <= 6 && bot.health < hp0) { reason = 'low-health'; break; }
          if (started && !bot.pvp.target) { reason = 'lost'; break; }
          if (!started && Date.now() - t0 > 3000) { reason = 'notstarted'; break; }
          if (Date.now() - t0 > timeout) break;
        }
      } catch (err) {
        if (err.message === 'Aborted') throw new SkillError(`Aborted while fighting ${tname} (HP ${Math.round(hp0)} -> ${Math.round(bot.health)}${dead ? ', target already dead' : ''}).`);
        throw err;
      } finally {
        bot.removeListener('entityDead', onDead);
        bot.removeListener('entityGone', onDead);
        try { bot.pvp.forceStop?.(); } catch { /* ignore */ }
        haltPathfinder(bot);
        bot.clearControlStates();
      }
      const secs = Math.round((Date.now() - t0) / 1000);
      const hp = `HP ${Math.round(hp0)} -> ${Math.round(bot.health)}`;
      if (reason === 'dead') {
        let drops = '';
        try {
          const got = await collectDrops(ctx, lastPos, { radius: 7, maxMs: 6000 });
          drops = Object.keys(got).length ? ` Picked up ${formatCounts(got, 6)}.` : ' No drops picked up.';
        } catch (e) { if (e.message === 'Aborted') throw e; }
        return `Killed ${tname} in ${secs}s using ${weapon ?? 'bare hands'}. ${hp}.${drops}`;
      }
      if (reason === 'low-health') throw new SkillError(`Stopped fighting ${tname} because health is low (${Math.round(bot.health)}). Use flee, eat, or build_shelter.`);
      if (reason === 'notstarted') throw new SkillError(`Could not engage ${tname} (pvp did not start; it may be unreachable).`);
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
      const hostiles = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && isHostile(e, bot) && e.position.distanceTo(me) < 32);
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
      const still = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && isHostile(e, bot) && e.position.distanceTo(bot.entity.position) < 12);
      if (moved < 4 && lastErr) throw new SkillError(`Could not flee: ${lastErr.message}`);
      return `Ran ${moved} blocks away to ${fmtPos(bot.entity.position)}. ${still.length ? `${still.length} hostile(s) still within 12 blocks (${still.slice(0, 3).map((e) => e.name).join(', ')}); consider build_shelter or fighting.` : 'No hostiles within 12 blocks now.'}`;
    },
  },
];
