import { EventEmitter } from 'node:events';
import path from 'node:path';
import { BotRunner } from './BotRunner.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { createProvider, describeLLMError } from '../llm/index.js';

/** Owns one BotRunner per character. This is the object the web dashboard talks to. */
export class BotManager extends EventEmitter {
  constructor({ settingsManager, log, rootDir }) {
    super();
    this.setMaxListeners(100);
    this.sm = settingsManager;
    this.logger = log;
    this.dataDir = path.join(rootDir, 'data');
    this.runners = new Map(); // name -> BotRunner

    // Character edits: rebuild runners whose profile changed, add/remove characters.
    settingsManager.on('change', () => this.syncCharacters().catch((e) => log.error('sync failed:', e)));
  }

  async getRunner(name, create = false) {
    let r = this.runners.get(name);
    if (!r && create) {
      const character = this.sm.characters[name];
      if (!character) throw new Error(`Unknown character ${name}`);
      const memory = await new MemoryStore(name, this.dataDir).load();
      r = new BotRunner({ character, settingsManager: this.sm, manager: this, memory, log: this.logger.for(name) });
      r._profileJson = JSON.stringify(character);
      this.runners.set(name, r);
    }
    return r;
  }

  async syncCharacters() {
    const active = new Set(this.sm.settings.characters || []);
    for (const [name, r] of this.runners) {
      const profile = this.sm.characters[name];
      if (!active.has(name) || !profile) {
        await r.shutdown();
        this.runners.delete(name);
        this.emit('status', { bot: name, status: { connection: 'stopped', removed: true } });
      } else if (JSON.stringify(profile) !== r._profileJson) {
        // Profile edited: restart with the new profile if it was running.
        const wasRunning = r.wantRunning;
        await r.shutdown();
        this.runners.delete(name);
        const nr = await this.getRunner(name, true);
        if (wasRunning && profile.enabled !== false) await nr.start();
      }
    }
    for (const name of active) {
      if (!this.runners.has(name) && this.sm.characters[name]) await this.getRunner(name, true);
    }
  }

  async startAll() {
    await this.syncCharacters();
    for (const c of this.sm.activeCharacters()) {
      if (c.enabled === false) continue;
      await this.start(c.name);
      await new Promise((r) => setTimeout(r, 1500)); // stagger logins
    }
  }

  async stopAll() {
    await Promise.all([...this.runners.values()].map((r) => r.stop()));
  }

  async shutdown() {
    await Promise.all([...this.runners.values()].map((r) => r.shutdown().catch(() => {})));
  }

  async start(name) { (await this.need(name)).start(); }
  async stop(name) { await (await this.need(name)).stop(); }
  async restart(name) {
    const r = await this.need(name);
    await r.stop();
    await new Promise((res) => setTimeout(res, 1000));
    await r.start();
  }

  async need(name) {
    const r = await this.getRunner(name, true);
    if (!r) throw new Error(`Unknown character ${name}`);
    return r;
  }

  list() {
    return this.sm.activeCharacters().map((c) => {
      const r = this.runners.get(c.name);
      return {
        name: c.name,
        username: c.username,
        enabled: c.enabled !== false,
        status: r ? r.status() : { connection: 'stopped' },
      };
    });
  }

  sendMessage(target, text, from = 'dashboard') {
    text = String(text || '').trim();
    if (!text) throw new Error('empty message');
    const speaker = (this.sm.settings.owners || [])[0] || 'Owner';
    const targets = target === 'all' ? [...this.runners.values()] : [this.runners.get(target)].filter(Boolean);
    if (!targets.length) throw new Error(`No running bot named ${target}`);
    this.emit('chat', { ts: Date.now(), bot: target === 'all' ? null : target, from: `${speaker} (${from})`, text, kind: 'player' });
    for (const r of targets) r.agent.onChat(speaker, text, { direct: true, source: from });
  }

  setAutonomous(name, on) { this.runners.get(name)?.agent.setAutonomous(on); }
  stopAction(name) { this.runners.get(name)?.agent.abortAction('stopped from dashboard'); }
  setGoal(name, text) { this.runners.get(name)?.agent.setGoal(text); }

  getMemory(name) {
    const r = this.runners.get(name);
    if (!r) throw new Error(`Unknown character ${name}`);
    return r.memory.data;
  }

  async saveMemory(name, obj) { await (await this.need(name)).memory.replace(obj); }
  async clearMemory(name) { await (await this.need(name)).memory.clear(); }

  async testProvider(providerName) {
    try {
      const p = createProvider(providerName, this.sm.settings, this.sm);
      return { ok: true, message: await p.test() };
    } catch (e) {
      return { ok: false, message: describeLLMError(e) };
    }
  }

  async listModels(providerName = 'lmstudio') {
    if (providerName === 'anthropic') {
      return ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];
    }
    const p = createProvider(providerName, this.sm.settings, this.sm);
    return p.listModels();
  }

  botUsernames() {
    return this.sm.activeCharacters().map((c) => c.username);
  }

  isBotUsername(username) {
    const u = String(username || '').toLowerCase();
    return this.botUsernames().some((b) => b.toLowerCase() === u);
  }

  /** The first connected bot forwards public chat to the dashboard, so lines aren't duplicated. */
  isChatReporter(name) {
    for (const [n, r] of this.runners) if (r.isReady()) return n === name;
    return false;
  }
}
