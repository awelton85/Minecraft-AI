// describeState(bot, { detail }) -> compact text snapshot of the world for the LLM. Never throws.
import { HOSTILE_NAMES } from './util.js';

const groupCache = new WeakMap(); // registry -> { group -> ids[] }

function groupIds(bot) {
  let g = groupCache.get(bot.registry);
  if (g) return g;
  const byName = bot.registry.blocksByName;
  const ids = (re) => Object.values(byName).filter((b) => re.test(b.name)).map((b) => b.id);
  g = {
    log: ids(/_log$|^crimson_stem$|^warped_stem$/),
    ore: ids(/_ore$|^ancient_debris$/),
    crafting_table: ids(/^crafting_table$/),
    furnace: ids(/^(furnace|blast_furnace|smoker)$/),
    chest: ids(/^(chest|trapped_chest|barrel)$/),
    bed: ids(/_bed$/),
    water: ids(/^water$/),
    lava: ids(/^lava$/),
    crops: ids(/^(wheat|carrots|potatoes|beetroots|melon|pumpkin|sweet_berry_bush|nether_wart)$/),
  };
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

function nearestBlocks(bot, ids, maxDistance, count) {
  if (!ids.length) return [];
  let pts;
  try {
    pts = bot.findBlocks({ matching: ids, maxDistance, count });
  } catch {
    return [];
  }
  const me = bot.entity.position;
  return pts.map((p) => ({ p, d: p.distanceTo(me) })).sort((a, b) => a.d - b.d);
}

function describeNotable(bot, brief) {
  const g = groupIds(bot);
  const maxD = brief ? 20 : 32;
  const parts = [];
  const names = {
    log: 'log', ore: 'ore', crafting_table: 'crafting_table', furnace: 'furnace', chest: 'chest',
    bed: 'bed', water: 'water', lava: 'LAVA', crops: 'crops',
  };
  for (const key of Object.keys(names)) {
    const cnt = key === 'water' || key === 'lava' ? 4 : 16;
    const found = nearestBlocks(bot, g[key], maxD, cnt);
    if (!found.length) continue;
    const near = found[0];
    let label = names[key];
    if (key === 'ore' || key === 'log' || key === 'crops') {
      const b = bot.blockAt(near.p);
      if (b) label = b.name;
    }
    let s = `${label} @${posStr(near.p)} (${r(near.d)}m)`;
    if (!brief && found.length > 1) {
      // list distinct other kinds for ores/logs
      if (key === 'ore' || key === 'log') {
        const kinds = new Map();
        for (const f of found) {
          const b = bot.blockAt(f.p);
          if (b && !kinds.has(b.name)) kinds.set(b.name, f);
        }
        s = [...kinds.entries()].slice(0, 4).map(([n, f]) => `${n} @${posStr(f.p)} (${r(f.d)}m)`).join('; ');
      } else {
        s += ` [+${found.length - 1} more nearby]`;
      }
    }
    parts.push(s);
  }
  return parts;
}

function nearbyEntities(bot, brief) {
  const me = bot.entity.position;
  const players = [];
  const hostiles = [];
  const passive = {};
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue;
    const d = e.position.distanceTo(me);
    if (e.type === 'player') {
      if (e.username) players.push({ name: e.username, d });
    } else if (e.type === 'hostile' || HOSTILE_NAMES.has(e.name)) {
      if (d <= (brief ? 24 : 32)) hostiles.push({ name: e.name ?? 'mob', d });
    } else if (e.type === 'animal' || e.type === 'passive') {
      if (d <= 24) passive[e.name ?? 'animal'] = (passive[e.name ?? 'animal'] ?? 0) + 1;
    }
  }
  players.sort((a, b) => a.d - b.d);
  hostiles.sort((a, b) => a.d - b.d);
  return { players, hostiles, passive };
}

function build(bot, brief) {
  const lines = [];
  const me = bot.entity.position;
  const feet = me.floored();
  let biome = '';
  try {
    const b = bot.blockAt(feet);
    if (b?.biome?.name) biome = `, biome ${b.biome.name}`;
  } catch { /* ignore */ }
  const dim = (bot.game?.dimension ?? '').replace('minecraft:', '') || 'unknown';
  lines.push(`Pos ${posStr(me)} ${dim}${biome}. ${timeOfDay(bot)}, ${weather(bot)}.`);

  let under = '?';
  try { under = bot.blockAt(feet.offset(0, -1, 0))?.name ?? '?'; } catch { /* ignore */ }
  let inWater = false;
  try { inWater = !!bot.entity.isInWater || bot.blockAt(feet)?.name === 'water'; } catch { /* ignore */ }
  const oxy = typeof bot.oxygenLevel === 'number' ? ` air ${bot.oxygenLevel}/20` : '';
  lines.push(`HP ${r(bot.health ?? 0)}/20 food ${r(bot.food ?? 0)}/20 sat ${r(bot.foodSaturation ?? 0)}${oxy}. Underfoot ${under}${inWater ? ' IN WATER' : ''}.`);
  lines.push(`Holding ${itemStr(bot.heldItem)}. Armor: ${armorStr(bot)}.`);
  lines.push(`Inventory: ${inventoryStr(bot, brief ? 12 : 40)}.`);

  const { players, hostiles, passive } = nearbyEntities(bot, brief);
  const pl = players.slice(0, brief ? 3 : 8).map((p) => `${p.name} ${r(p.d)}m`);
  const online = Object.keys(bot.players ?? {}).filter((n) => n !== bot.username && !players.some((p) => p.name === n));
  lines.push(`Players near: ${pl.length ? pl.join(', ') : 'none'}${!brief && online.length ? `; online elsewhere: ${online.slice(0, 8).join(', ')}` : ''}.`);
  if (hostiles.length) {
    lines.push(`HOSTILES: ${hostiles.slice(0, brief ? 4 : 10).map((h) => `${h.name} ${r(h.d)}m`).join(', ')}.`);
  }
  if (!brief) {
    const pa = Object.entries(passive).map(([n, c]) => `${n}x${c}`);
    if (pa.length) lines.push(`Animals: ${pa.slice(0, 8).join(', ')}.`);
  }
  const notable = describeNotable(bot, brief);
  if (notable.length) lines.push(`Nearby: ${notable.join('; ')}.`);
  return lines;
}

export function describeState(bot, { detail = 'brief' } = {}) {
  const brief = detail !== 'full';
  try {
    if (!bot?.entity) return 'Not spawned yet.';
    const lines = build(bot, brief);
    let text = lines.join('\n');
    const limit = brief ? 900 : 2500;
    if (text.length > limit) {
      // drop low-priority lines from the bottom, then hard-trim
      const keep = [...lines];
      while (keep.join('\n').length > limit && keep.length > 4) keep.splice(keep.length - 1 - (keep[keep.length - 1].startsWith('HOSTILES') ? 1 : 0), 1);
      text = keep.join('\n');
      if (text.length > limit) text = text.slice(0, limit - 3) + '...';
    }
    return text;
  } catch (err) {
    try {
      return `State unavailable (${err.message}). Pos ${bot?.entity ? posStr(bot.entity.position) : '?'}, HP ${bot?.health}.`;
    } catch {
      return 'State unavailable.';
    }
  }
}
