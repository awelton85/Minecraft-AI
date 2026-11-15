// Shared fakes implementing the BotManager / SettingsManager contracts (used by the web smoke test + manual runs).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const clone = (o) => JSON.parse(JSON.stringify(o));
function merge(t, p) {
  for (const [k, v] of Object.entries(p)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) { t[k] = merge(t[k] && typeof t[k] === 'object' ? t[k] : {}, v); } else t[k] = v;
  }
  return t;
}

export class FakeSettings extends EventEmitter {
  constructor(rootDir) {
    super();
    this.settings = JSON.parse(fs.readFileSync(path.join(rootDir, 'config/settings.default.json'), 'utf8'));
    this.characters = { Steve_AI: JSON.parse(fs.readFileSync(path.join(rootDir, 'config/characters/Steve_AI.json'), 'utf8')) };
    this.secrets = {};
    this.saved = [];
  }
  async saveSettings(patch) { this.saved.push(clone(patch)); merge(this.settings, patch); this.emit('change'); }
  async saveCharacter(p) { this.characters[p.name] = clone(p); if (!this.settings.characters.includes(p.name)) this.settings.characters.push(p.name); }
  async deleteCharacter(n) { delete this.characters[n]; this.settings.characters = this.settings.characters.filter((x) => x !== n); }
  secretsStatus() { return { anthropicApiKey: !!this.secrets.anthropicApiKey }; }
  async setSecret(k, v) { this.secrets[k] = v; }
  getSecret(k) { return this.secrets[k]; }
}

export class FakeManager extends EventEmitter {
  constructor(settings) {
    super();
    this.sm = settings;
    this.calls = [];
    this.state = {};
    this.memory = {};
    for (const n of Object.keys(settings.characters)) this.#init(n);
  }
  #init(n) {
    this.state[n] = { connection: 'stopped', health: 20, food: 20, position: null, dimension: null, currentAction: null, goal: null, autonomous: true, provider: 'anthropic', model: 'claude-opus-5-5', lastError: null, reconnectAttempts: 0 };
    this.memory[n] ??= { version: 1, facts: [{ id: 1, text: 'Owner likes oak', ts: 1700000000000 }], places: { home: { name: 'home', x: 1, y: 64, z: 2, dimension: 'overworld', note: 'base', ts: 1700000000000 } }, sessionSummaries: [{ ts: 1700000000000, text: 'Built a hut' }], deaths: [{ ts: 1700000100000, x: 5, y: 12, z: 5, dimension: 'overworld', cause: 'lava' }], stats: { sessions: 3, firstSeen: 1700000000000, lastSeen: 1700000100000 } };
  }
  list() {
    for (const n of Object.keys(this.sm.characters)) if (!this.state[n]) this.#init(n);
    return Object.keys(this.state).filter((n) => this.sm.characters[n]).map((n) => ({ name: n, username: this.sm.characters[n].username, enabled: this.sm.characters[n].enabled, status: clone(this.state[n]) }));
  }
  #set(n, patch) { Object.assign(this.state[n], patch); this.emit('status', { bot: n, status: clone(this.state[n]) }); }
  async start(n) { this.calls.push(['start', n]); this.#set(n, { connection: 'connected', position: { x: 10.4, y: 64, z: -3 }, dimension: 'overworld', health: 17, food: 14, currentAction: 'idle' }); }
  async stop(n) { this.calls.push(['stop', n]); this.#set(n, { connection: 'stopped' }); }
  async restart(n) { this.calls.push(['restart', n]); await this.start(n); }
  async startAll() { for (const n of Object.keys(this.state)) await this.start(n); }
  async stopAll() { for (const n of Object.keys(this.state)) await this.stop(n); }
  sendMessage(t, text, from) {
    this.calls.push(['sendMessage', t, text, from]);
    this.emit('chat', { ts: Date.now(), bot: t === 'all' ? null : t, from: 'dashboard', text, kind: 'player' });
    const bot = t === 'all' ? Object.keys(this.state)[0] : t;
    setTimeout(() => {
      this.emit('thought', { ts: Date.now(), bot, text: 'The owner wants something; let me check my inventory.' });
      this.emit('chat', { ts: Date.now(), bot, from: bot, text: `Sure! ${text}`, kind: 'bot' });
      this.emit('speech', { ts: Date.now(), bot, text: `Sure! ${text}`, voice: { name: '', rate: 1, pitch: 1 } });
    }, 20);
  }
  setAutonomous(n, v) { this.calls.push(['setAutonomous', n, v]); this.#set(n, { autonomous: v }); }
  stopAction(n) { this.calls.push(['stopAction', n]); }
  setGoal(n, t) { this.calls.push(['setGoal', n, t]); this.#set(n, { goal: t }); }
  resetConversation(n) { this.calls.push(['resetConversation', n]); }
  async deleteMemoryEntry(n, section, key) {
    this.calls.push(['deleteMemoryEntry', n, section, key]);
    const m = this.memory[n]; const v = m?.[section];
    if (Array.isArray(v)) {
      const i = section === 'facts' ? v.findIndex((x) => String(x.id) === String(key)) : Number(key);
      if (i < 0 || i >= v.length) return false; v.splice(i, 1); return true;
    }
    if (v && key in v) { delete v[key]; return true; }
    return false;
  }
  getMemory(n) { return clone(this.memory[n] ?? {}); }
  async saveMemory(n, o) { this.memory[n] = clone(o); }
  async clearMemory(n) { this.memory[n] = {}; }
  async testProvider(p) { this.calls.push(['testProvider', p]); return { ok: p === 'anthropic', message: p === 'anthropic' ? 'Connected (fake)' : 'Connection refused (fake)' }; }
  async listModels() { return ['qwen3-14b', 'llama-3.1-8b']; }
  botUsernames() { return Object.values(this.sm.characters).map((c) => c.username); }
}
