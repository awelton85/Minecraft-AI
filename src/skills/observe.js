// describeState(bot, { detail }) -> compact text snapshot of the world for the LLM. Never throws.
import { HOSTILE_NAMES, isNeutral, scanGroups, listDrops } from './util.js';

const groupCache = new WeakMap(); // registry -> Map<blockId, group>
const scanCache = new WeakMap(); // bot -> { t, pos, maxD, res }

function groupMap(bot) {
  let g = groupCache.get(bot.registry);
  if (g) return g;
  g = new Map();
  const add = (re, name) => {
    for (const b of Object.values(bot.registry.blocksByName)) if (re.test(b.name)) g.set(b.id, name);
  };
  add(/_log$|^crimson_stem$|^warped_stem$/, 'log');
  add(/_ore$|^ancient_debris$/, 'ore');
  add(/^crafting_table$/, 'crafting_table');
  add(/^(furnace|blast_furnace|smoker)$/, 'furnace');
  add(/^(chest|trapped_chest|barrel)$/, 'chest');
  add(/_bed$/, 'bed');
  add(/^water$/, 'water');
  add(/^lava$/, 'lava');
  add(/^(wheat|carrots|potatoes|beetroots|melon|pumpkin|sweet_berry_bush|nether_wart|sugar_cane)$/, 'crops');
  groupCache.set(bot.registry, g);
  return g;
}

const r = (n) => Math.round(n);
const posStr = (p) => `${r(p.x)},${r(p.y)},${r(p.z)}`;

function timeOfDay(bot) {
  const t = bot.time?.timeOfDay;
  if (typeof t !== 'number') return 'time unknown';
  let label;
  if (t < 12000) label = 'day';
  else if (t < 13000) label = 'dusk';
  else if (t < 23000) label = 'night';
  else label = 'dawn';
  return `${label} (${t})`;
}

function weather(bot) {
  if (bot.thunderState > 0) return 'thunderstorm';
  if (bot.isRaining) return 'rain';
  return 'clear';
}

function itemStr(it) {
  return it ? `${it.name}${it.count > 1 ? 'x' + it.count : ''}` : 'nothing';
}

function armorStr(bot) {
  const out = [];
  for (const dest of ['head', 'torso', 'legs', 'feet']) {
    try {
      const slot = bot.getEquipmentDestSlot(dest);
      const it = bot.inventory.slots[slot];
      if (it) out.push(it.name);
    } catch { /* ignore */ }
  }
  return out.length ? out.join(', ') : 'none';
}

function inventoryStr(bot, max) {
  const counts = {};
  for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] ?? 0) + it.count;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return 'empty';
  const shown = entries.slice(0, max).map(([n, c]) => `${n}x${c}`);
  if (entries.length > max) shown.push(`+${entries.length - max} more`);
  return shown.join(' ');
}

/** One world pass for all groups, cached for a few seconds while the bot stays put. */
function scanNotable(bot, maxD) {
  const now = Date.now();
  const c = scanCache.get(bot);
  const pos = bot.entity.position;
  if (c && now - c.t < 4000 && c.maxD >= maxD && c.pos.distanceTo(pos) < 3) return c.res;
  const res = scanGroups(bot, groupMap(bot), { maxDistance: maxD, perGroup: 4 });
  scanCache.set(bot, { t: now, pos: pos.clone(), maxD, res });
  return res;
}

function describeNotable(bot, brief) {
  const res = scanNotable(bot, brief ? 20 : 32);
  const me = bot.entity.position;
  const parts = [];
  const label = { crafting_table: 'crafting_table', furnace: 'furnace', chest: 'chest', bed: 'bed', water: 'water', lava: 'LAVA' };
  for (const key of ['lava', 'log', 'ore', 'crafting_table', 'furnace', 'chest', 'bed', 'crops', 'water']) {
    const hits = (res[key] ?? []).map((h) => ({ ...h, d: h.pos.distanceTo(me) })).sort((a, b) => a.d - b.d);
    if (!hits.length) continue;
    if ((key === 'ore' || key === 'log') && !brief) {
      const kinds = new Map();
      for (const h of hits) {
        const n = bot.registry.blocks[h.id]?.name ?? key;
        if (!kinds.has(n)) kinds.set(n, h);
      }
      parts.push([...kinds.entries()].slice(0, 3).map(([n, h]) => `${n} @${posStr(h.pos)} (${r(h.d)}m)`).join('; '));
      continue;
    }
    const h = hits[0];
    const name = key === 'ore' || key === 'log' || key === 'crops' ? (bot.registry.blocks[h.id]?.name ?? key) : label[key] ?? key;
    parts.push(`${name} @${posStr(h.pos)} (${r(h.d)}m)`);
  }
  return parts;
}

function nearbyEntities(bot, brief) {
  const me = bot.entity.position;
  const players = [];
  const hostiles = [];
  const neutrals = [];
  const passive = {};
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue;
    const d = e.position.distanceTo(me);
    if (e.type === 'player') {
      if (e.username) players.push({ name: e.username, d });
    } else if (isNeutral(e, bot)) {
      if (d <= 24) neutrals.push({ name: e.name ?? 'mob', d });
    } else if (e.type === 'hostile' || HOSTILE_NAMES.has(e.name)) {
      if (d <= (brief ? 24 : 32)) hostiles.push({ name: e.name ?? 'mob', d });
    } else if (e.type === 'animal' || e.type === 'passive') {
      if (d <= 24) passive[e.name ?? 'animal'] = (passive[e.name ?? 'animal'] ?? 0) + 1;
    }
  }
  players.sort((a, b) => a.d - b.d);
  hostiles.sort((a, b) => a.d - b.d);
  neutrals.sort((a, b) => a.d - b.d);
  return { players, hostiles, neutrals, passive };
}

// Lines are produced as { text, prio }: when over the limit the lowest-priority (highest number) lines are dropped first.
function build(bot, brief) {
  const lines = [];
  const L = (text, prio) => lines.push({ text, prio });
  const me = bot.entity.position;
  const feet = me.floored();
  let biome = '';
  try {
    const b = bot.blockAt(feet);
    if (b?.biome?.name) biome = `, biome ${b.biome.name}`;
  } catch { /* ignore */ }
  const dim = (bot.game?.dimension ?? '').replace('minecraft:', '') || 'unknown';
  L(`Pos ${posStr(me)} ${dim}${biome}. ${timeOfDay(bot)}, ${weather(bot)}.`, 0);

  let under = '?';
  try { under = bot.blockAt(feet.offset(0, -1, 0))?.name ?? '?'; } catch { /* ignore */ }
  let inWater = false;
  try { inWater = !!bot.entity.isInWater || bot.blockAt(feet)?.name === 'water'; } catch { /* ignore */ }
  const oxy = typeof bot.oxygenLevel === 'number' && bot.oxygenLevel < 20 ? ` air ${bot.oxygenLevel}/20` : '';
  L(`HP ${r(bot.health ?? 0)}/20 food ${r(bot.food ?? 0)}/20 sat ${r(bot.foodSaturation ?? 0)}${oxy}. Underfoot ${under}${inWater ? ' IN WATER' : ''}.`, 0);

  const { players, hostiles, neutrals, passive } = nearbyEntities(bot, brief);
  if (hostiles.length) L(`HOSTILES: ${hostiles.slice(0, brief ? 4 : 8).map((h) => `${h.name} ${r(h.d)}m`).join(', ')}.`, 0);
  const pl = players.slice(0, brief ? 3 : 8).map((p) => `${p.name} ${r(p.d)}m`);
  const online = Object.keys(bot.players ?? {}).filter((n) => n !== bot.username && !players.some((p) => p.name === n));
  L(`Players near: ${pl.length ? pl.join(', ') : 'none'}${!brief && online.length ? `; online elsewhere: ${online.slice(0, 8).join(', ')}` : ''}.`, 1);
  L(`Holding ${itemStr(bot.heldItem)}. Armor: ${armorStr(bot)}.`, 1);
  const notable = describeNotable(bot, brief);
  if (notable.length) L(`Nearby: ${notable.join('; ')}.`, 2);
  if (neutrals.length) L(`Neutral mobs (do not attack unless needed): ${neutrals.slice(0, 4).map((h) => `${h.name} ${r(h.d)}m`).join(', ')}.`, 3);
  const drops = listDrops(bot, me, 12);
  if (drops.length) {
    const agg = {};
    for (const d of drops) agg[d.name] = (agg[d.name] ?? 0) + d.count;
    L(`Dropped items near (pickup_items): ${Object.entries(agg).slice(0, 5).map(([n, c]) => `${n}x${c}`).join(', ')}.`, 3);
  }
  if (!brief) {
    const pa = Object.entries(passive).map(([n, c]) => `${n}x${c}`);
    if (pa.length) L(`Animals: ${pa.slice(0, 8).join(', ')}.`, 4);
  }
  L(`Inventory: ${inventoryStr(bot, brief ? 12 : 30)}.`, 1.5);
  return lines;
}

export function describeState(bot, { detail = 'brief' } = {}) {
  const brief = detail !== 'full';
  try {
    if (!bot?.entity) return 'Not spawned yet.';
    const lines = build(bot, brief);
    const limit = brief ? 900 : 2000;
    const join = (ls) => ls.map((l) => l.text).join('\n');
    let keep = [...lines];
    while (join(keep).length > limit && keep.length > 3) {
      // drop the lowest-priority (highest prio number, latest) line
      let worst = 0;
      keep.forEach((l, i) => { if (l.prio >= keep[worst].prio) worst = i; });
      keep.splice(worst, 1);
    }
    let text = join(keep);
    if (text.length > limit) text = text.slice(0, limit - 3) + '...';
    return text;
  } catch (err) {
    try {
      return `State unavailable (${err.message}). Pos ${bot?.entity ? posStr(bot.entity.position) : '?'}, HP ${bot?.health}.`;
    } catch {
      return 'State unavailable.';
    }
  }
}
