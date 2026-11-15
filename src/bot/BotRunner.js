import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import collectBlockPkg from 'mineflayer-collectblock';
import pvpPkg from 'mineflayer-pvp';
import toolPkg from 'mineflayer-tool';
import { loader as autoEat } from 'mineflayer-auto-eat';
import armorManager from 'mineflayer-armor-manager';
import minecraftData from 'minecraft-data';
import { Agent } from '../agent/Agent.js';

const { pathfinder, Movements } = pathfinderPkg;

// Kick reasons where reconnecting quickly is pointless.
const SLOW_RETRY_KICKS = /banned|whitelist|white-listed|outdated|incompatible|unsupported|version/i;
const DUPLICATE_LOGIN = /logged in from another location|duplicate|already (online|connected)/i;

/**
 * Owns the Minecraft connection for one character: connects, loads plugins, wires reflexes and
 * chat into the Agent, and reconnects with exponential back-off whenever the connection drops.
 */
export class BotRunner {
  constructor({ character, settingsManager, manager, memory, log }) {
    this.character = character;
    this.sm = settingsManager;
    this.manager = manager;
    this.memory = memory;
    this.log = log;
    this.bot = null;
    this.mcData = null;
    this.state = 'stopped';     // stopped | connecting | connected | reconnecting | error
    this.wantRunning = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.lastError = null;
    this.chatQueue = Promise.resolve();
    this.lastStatusEmit = 0;
    this.agent = new Agent({ runner: this, character, settingsManager, memory, manager, log });
    this.agent.on('thought', (text) => manager.emit('thought', { ts: Date.now(), bot: character.name, text }));
  }

  get settings() { return this.sm.settings; }

  isReady() {
    return this.state === 'connected' && Boolean(this.bot?.entity);
  }

  async start() {
    if (this.wantRunning) return;
    this.wantRunning = true;
    this.reconnectAttempts = 0;
    this.memory.markSessionStart();
    this.agent.start();
    this.connect();
  }

  async stop() {
    this.wantRunning = false;
    clearTimeout(this.reconnectTimer);
    this.agent.abortAction('bot stopping');
    this.disconnect('Stopped from dashboard');
    this.setState('stopped');
  }

  async shutdown() {
    await this.stop();
    await this.agent.stop({ summarize: true });
    await this.memory.save().catch(() => {});
  }

  // ------------------------------------------------------------------ connection
  connect() {
    clearTimeout(this.reconnectTimer);
    if (!this.wantRunning) return;
    const s = this.settings.server || {};
    this.setState(this.reconnectAttempts ? 'reconnecting' : 'connecting');
    this.log.info(`Connecting to ${s.host}:${s.port} as ${this.character.username}...`);

    let bot;
    try {
      bot = mineflayer.createBot({
        host: s.host || '127.0.0.1',
        port: Number(s.port) || 25565,
        username: this.character.username,
        auth: s.auth || 'offline',
        version: !s.version || s.version === 'auto' ? false : s.version,
        hideErrors: true,
        checkTimeoutInterval: 60_000,
        respawn: this.settings.reflexes?.autoRespawn !== false,
      });
    } catch (e) {
      this.onDisconnected(`createBot failed: ${e.message}`);
      return;
    }
    this.bot = bot;
    let ended = false;

    const spawnTimeout = setTimeout(() => {
      if (!bot.entity) {
        this.log.warn('No spawn within 60s, retrying');
        bot.end('spawn timeout');
      }
    }, 60_000);

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlockPkg.plugin);
    bot.loadPlugin(pvpPkg.plugin);
    bot.loadPlugin(toolPkg.plugin);
    bot.loadPlugin(autoEat);
    bot.loadPlugin(armorManager);

    bot.once('spawn', () => {
      clearTimeout(spawnTimeout);
      this.onSpawned(bot);
    });
    bot.on('kicked', (reason) => {
      const text = flattenReason(reason);
      this.lastError = `Kicked: ${text}`;
      this.log.warn(this.lastError);
      this._kickReason = text;
    });
    bot.on('error', (err) => {
      this.lastError = describeConnError(err, s);
      this.log.warn(`Connection error: ${this.lastError}`);
    });
    bot.on('end', (reason) => {
      if (ended) return;
      ended = true;
      clearTimeout(spawnTimeout);
      this.onDisconnected(reason);
    });
  }

  disconnect(reason) {
    const bot = this.bot;
    if (!bot) return;
    try { bot.pathfinder?.stop(); } catch { /* ignore */ }
    try { bot.quit(reason); } catch { /* ignore */ }
    try { bot.end(reason); } catch { /* ignore */ }
  }

  onDisconnected(reason) {
    const wasConnected = this.state === 'connected';
    clearInterval(this._statusTimer);
    clearInterval(this._watchdog);
    this.agent.abortAction('disconnected');
    if (this.bot) this.bot.removeAllListeners('chat');
    this.bot = null;
    if (!this.wantRunning) { this.setState('stopped'); return; }

    const kick = this._kickReason || '';
    this._kickReason = null;
    const rc = this.settings.reconnect || {};
    if (rc.enabled === false) {
      this.setState('error');
      this.log.warn(`Disconnected (${reason}); auto-reconnect is disabled.`);
      return;
    }
    this.reconnectAttempts++;
    const base = (rc.initialDelaySeconds ?? 3) * 1000;
    const max = (rc.maxDelaySeconds ?? 60) * 1000;
    let delay = Math.min(max, base * 2 ** Math.min(this.reconnectAttempts - 1, 6));
    if (SLOW_RETRY_KICKS.test(kick) || DUPLICATE_LOGIN.test(kick)) delay = Math.max(delay, max);
    delay += Math.floor(Math.random() * 1000);
    this.log.info(`Disconnected (${kick || reason || 'connection lost'}). Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}).`);
    if (wasConnected) this.agent.notify('You were disconnected from the server and are reconnecting.');
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  onSpawned(bot) {
    this.mcData = minecraftData(bot.version);
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.setState('connected');
    this.log.info(`Spawned in world (Minecraft ${bot.version}) at ${fmtPos(bot.entity.position)}`);

    const moves = new Movements(bot);
    moves.allowParkour = true;
    moves.allowSprinting = true;
    moves.canDig = true;
    // Don't use valuable blocks for scaffolding.
    const scaffold = ['dirt', 'cobblestone', 'netherrack', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff'];
    moves.scafoldingBlocks = scaffold.map((n) => this.mcData.itemsByName[n]?.id).filter((id) => id !== undefined);
    bot.pathfinder.setMovements(moves);
    bot.pathfinder.thinkTimeout = 10_000;
    bot.pathfinder.tickTimeout = 20;

    this.setupReflexes(bot);
    this.setupChat(bot);

    let lastPos = null;
    bot.on('death', () => {
      const pos = lastPos || bot.entity?.position;
      const dimension = dimName(bot);
      if (pos) this.memory.recordDeath({ x: pos.x, y: pos.y, z: pos.z, dimension, cause: this._lastDamage || 'unknown' });
      this.agent.abortAction('you died');
      this.agent.notify(`You DIED${pos ? ` at ${fmtPos(pos)} (${dimension})` : ''}${this._lastDamage ? ` (${this._lastDamage})` : ''}. Your items dropped there and despawn after ~5 minutes. You respawned.`, { urgent: true });
    });
    bot.on('respawn', () => this.emitStatus(true));
    bot.on('health', () => this.emitStatus());
    bot.on('move', () => { if (bot.entity) lastPos = bot.entity.position.clone(); });

    this._statusTimer = setInterval(() => this.emitStatus(true), 3000);
    // Watchdog: a connection that stops ticking without 'end' would leave us frozen.
    let lastTick = Date.now();
    bot.on('physicsTick', () => { lastTick = Date.now(); });
    this._watchdog = setInterval(() => {
      if (Date.now() - lastTick > 45_000 && this.bot === bot) {
        this.log.warn('No game ticks for 45s - forcing reconnect');
        try { bot.end('watchdog'); } catch { /* ignore */ }
      }
    }, 15_000);

    const welcome = this.memory.data.stats.sessions > 1 ? 'You reconnected to the world.' : 'You just joined the world for the first time.';
    this.agent.notify(welcome);
    this.emitStatus(true);
  }

  setupReflexes(bot) {
    const r = this.settings.reflexes || {};
    try {
      if (r.autoEat !== false) {
        bot.autoEat.setOpts({ minHunger: 14, strictErrors: false, bannedFood: ['rotten_flesh', 'pufferfish', 'chorus_fruit', 'poisonous_potato', 'spider_eye'] });
        bot.autoEat.enableAuto();
      }
    } catch (e) { this.log.warn('auto-eat setup failed:', e.message); }
    try {
      if (r.autoArmor !== false && bot.armorManager) bot.armorManager.equipAll?.();
    } catch (e) { this.log.debug('armor setup:', e.message); }

    // Self defence: when hurt by a hostile and not busy, fight back; when weak, tell the agent.
    let lastDefense = 0;
    bot.on('entityHurt', (entity) => {
      if (entity !== bot.entity) return;
      const attacker = nearestHostile(bot, 6);
      this._lastDamage = attacker ? `attacked by ${attacker.name}` : 'took damage';
      const now = Date.now();
      if (now - lastDefense < 4000) return;
      lastDefense = now;
      if (!attacker) return;
      if (bot.health <= 6) {
        this.agent.notify(`DANGER: health ${Math.round(bot.health)}/20 and a ${attacker.name} is attacking you. Flee or heal now!`, { urgent: true });
        return;
      }
      if (r.selfDefense !== false && !this.agent.currentAction && bot.pvp && !bot.pvp.target) {
        this.log.info(`Defending against ${attacker.name}`);
        bot.pvp.attack(attacker);
        setTimeout(() => { if (bot.pvp?.target === attacker && !attacker.isValid) bot.pvp.stop(); }, 15_000);
      }
      this.agent.notify(`You are being attacked by a ${attacker.name} (health ${Math.round(bot.health)}/20).`, { urgent: true });
    });
  }

  setupChat(bot) {
    const me = this.character.username;
    const owners = (this.settings.owners || []).map((o) => o.toLowerCase());
    const accept = (username) => this.settings.listenToEveryone || owners.includes(username.toLowerCase()) || this.manager.isBotUsername(username);

    bot.on('chat', (username, message) => {
      if (!username || username === me) return;
      const isBot = this.manager.isBotUsername(username);
      // Every bot hears the chat, but only the first one forwards it to the dashboard feed.
      if (this.manager.isChatReporter(this.character.name)) {
        this.manager.emit('chat', { ts: Date.now(), bot: isBot ? username : null, from: username, text: message, kind: isBot ? 'bot' : 'player' });
      }
      if (isBot) return this.agent.onChat(username, message, { isBot: true });
      if (!accept(username)) return;
      this.agent.onChat(username, message);
    });
    bot.on('whisper', (username, message) => {
      if (!username || username === me || !accept(username)) return;
      this.manager.emit('chat', { ts: Date.now(), bot: this.character.name, from: username, text: `(whisper) ${message}`, kind: 'player' });
      this.agent.onChat(username, message, { direct: true, isBot: this.manager.isBotUsername(username) });
    });
  }

  /** Sends chat as this bot. Splits long text, strips commands, paces messages to avoid spam kicks. */
  say(text) {
    const max = Math.min(250, this.settings.agent?.chatMaxLength || 240);
    let clean = String(text || '').replace(/\s+/g, ' ').trim().replace(/^\/+/, '');
    if (!clean) return Promise.resolve();
    const voice = this.character.voice || {};
    this.manager.emit('speech', { ts: Date.now(), bot: this.character.name, text: clean, voice });
    this.manager.emit('chat', { ts: Date.now(), bot: this.character.name, from: this.character.username, text: clean, kind: 'bot' });
    const parts = [];
    while (clean.length > max) {
      let cut = clean.lastIndexOf(' ', max);
      if (cut < max / 2) cut = max;
      parts.push(clean.slice(0, cut));
      clean = clean.slice(cut).trim();
    }
    if (clean) parts.push(clean);
    this.chatQueue = this.chatQueue.then(async () => {
      for (const p of parts.slice(0, 4)) {
        if (!this.isReady()) return;
        try { this.bot.chat(p); } catch (e) { this.log.warn('chat failed:', e.message); }
        await new Promise((r) => setTimeout(r, 1100));
      }
    }).catch(() => {});
    return this.chatQueue;
  }

  // ------------------------------------------------------------------ status
  setState(state) {
    this.state = state;
    this.emitStatus(true);
  }

  status() {
    const bot = this.bot;
    const ready = this.isReady();
    return {
      connection: this.state,
      health: ready ? Math.round(bot.health) : null,
      food: ready ? bot.food : null,
      position: ready ? { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) } : null,
      dimension: ready ? dimName(bot) : null,
      reconnectAttempts: this.reconnectAttempts,
      ...this.agent.status(),
      lastError: this.agent.status().lastError || this.lastError,
    };
  }

  emitStatus(force = false) {
    const now = Date.now();
    if (!force && now - this.lastStatusEmit < 500) return;
    this.lastStatusEmit = now;
    this.manager.emit('status', { bot: this.character.name, status: this.status() });
  }
}

const HOSTILE = new Set(['zombie', 'skeleton', 'spider', 'cave_spider', 'creeper', 'witch', 'slime', 'husk', 'stray', 'drowned',
  'zombie_villager', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'blaze', 'magma_cube', 'hoglin', 'zoglin',
  'piglin_brute', 'silverfish', 'endermite', 'guardian', 'wither_skeleton', 'bogged', 'breeze', 'vex', 'ghast']);

function nearestHostile(bot, maxDist) {
  let best = null;
  let bestD = maxDist;
  for (const e of Object.values(bot.entities)) {
    if (!e?.position || e === bot.entity || !HOSTILE.has(e.name)) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}

function dimName(bot) {
  return String(bot.game?.dimension || 'overworld').replace('minecraft:', '').replace('the_', '');
}

function fmtPos(p) {
  return `${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`;
}

function flattenReason(reason) {
  if (typeof reason === 'string') {
    try { return flattenReason(JSON.parse(reason)); } catch { return reason; }
  }
  if (!reason || typeof reason !== 'object') return String(reason ?? '');
  let out = reason.text ?? reason.translate ?? '';
  if (Array.isArray(reason.extra)) out += reason.extra.map(flattenReason).join('');
  if (Array.isArray(reason.with)) out += ' ' + reason.with.map(flattenReason).join(' ');
  if (reason.value !== undefined) out += flattenReason(reason.value);
  return out || JSON.stringify(reason);
}

function describeConnError(err, s) {
  if (err?.code === 'ECONNREFUSED') return `Server ${s.host}:${s.port} refused the connection (is the Minecraft server running?)`;
  if (err?.code === 'ETIMEDOUT' || err?.code === 'EHOSTUNREACH') return `Cannot reach ${s.host}:${s.port} (wrong IP, or firewall?)`;
  if (err?.code === 'ENOTFOUND') return `Unknown host ${s.host}`;
  return err?.message || String(err);
}
