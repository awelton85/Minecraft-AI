import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY = () => ({
  version: 1,
  facts: [],            // [{ id, text, ts }]
  places: {},           // { lowerName: { name, x, y, z, dimension, note, ts } }
  sessionSummaries: [], // [{ ts, text }]
  deaths: [],           // [{ ts, x, y, z, dimension, cause }]
  stats: { sessions: 0, firstSeen: null, lastSeen: null },
});

const LIMITS = { facts: 200, sessionSummaries: 30, deaths: 20 };

/**
 * Persistent per-character memory stored as JSON in data/memory/<name>.json.
 * Writes are debounced and atomic so a crash never corrupts the file.
 */
export class MemoryStore {
  constructor(characterName, dataDir) {
    this.name = characterName;
    this.file = path.join(dataDir, 'memory', `${characterName}.json`);
    this.data = EMPTY();
    this._saveTimer = null;
    this._nextId = 1;
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = { ...EMPTY(), ...raw, stats: { ...EMPTY().stats, ...(raw.stats || {}) } };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Keep the unreadable file for the user instead of overwriting it.
        await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {});
      }
      this.data = EMPTY();
    }
    this._nextId = 1 + Math.max(0, ...this.data.facts.map((f) => f.id || 0));
    return this;
  }

  /** Replace the whole memory (dashboard raw editor). */
  async replace(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('memory must be an object');
    this.data = { ...EMPTY(), ...obj };
    this._nextId = 1 + Math.max(0, ...this.data.facts.map((f) => f.id || 0));
    await this.save();
  }

  async clear() {
    this.data = EMPTY();
    this._nextId = 1;
    await this.save();
  }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save().catch(() => {}), 1000);
  }

  async save() {
    clearTimeout(this._saveTimer);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }

  // ---- facts -------------------------------------------------------------
  addFact(text) {
    text = String(text || '').trim().slice(0, 500);
    if (!text) throw new Error('empty fact');
    const dup = this.data.facts.find((f) => f.text.toLowerCase() === text.toLowerCase());
    if (dup) return dup.id;
    const id = this._nextId++;
    this.data.facts.push({ id, text, ts: Date.now() });
    if (this.data.facts.length > LIMITS.facts) this.data.facts.shift();
    this.scheduleSave();
    return id;
  }

  removeFact(idOrText) {
    const n = Number(idOrText);
    const needle = String(idOrText).toLowerCase();
    const before = this.data.facts.length;
    this.data.facts = this.data.facts.filter((f) =>
      Number.isFinite(n) && String(idOrText).trim() !== '' ? f.id !== n : !f.text.toLowerCase().includes(needle),
    );
    const removed = this.data.facts.length !== before;
    if (removed) this.scheduleSave();
    return removed;
  }

  // ---- places ------------------------------------------------------------
  setPlace(name, { x, y, z, dimension = 'overworld', note = '' }) {
    name = String(name || '').trim().slice(0, 60);
    if (!name) throw new Error('place needs a name');
    this.data.places[name.toLowerCase()] = {
      name, x: Math.round(x), y: Math.round(y), z: Math.round(z), dimension, note: String(note || '').slice(0, 200), ts: Date.now(),
    };
    this.scheduleSave();
  }

  getPlace(name) {
    return this.data.places[String(name || '').trim().toLowerCase()];
  }

  listPlaces() {
    return Object.values(this.data.places);
  }

  removePlace(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!this.data.places[key]) return false;
    delete this.data.places[key];
    this.scheduleSave();
    return true;
  }

  // ---- history -----------------------------------------------------------
  addSessionSummary(text) {
    text = String(text || '').trim();
    if (!text) return;
    this.data.sessionSummaries.push({ ts: Date.now(), text: text.slice(0, 4000) });
    if (this.data.sessionSummaries.length > LIMITS.sessionSummaries) this.data.sessionSummaries.shift();
    this.scheduleSave();
  }

  recordDeath({ x, y, z, dimension, cause }) {
    this.data.deaths.push({ ts: Date.now(), x: Math.round(x), y: Math.round(y), z: Math.round(z), dimension, cause: cause || 'unknown' });
    if (this.data.deaths.length > LIMITS.deaths) this.data.deaths.shift();
    this.scheduleSave();
  }

  markSessionStart() {
    const now = Date.now();
    this.data.stats.sessions += 1;
    this.data.stats.firstSeen ??= now;
    this.data.stats.lastSeen = now;
    this.scheduleSave();
  }

  /** Compact text for the system prompt. */
  toPromptText() {
    const parts = [];
    const s = this.data.stats;
    if (s.sessions > 1 && s.lastSeen) parts.push(`You have played ${s.sessions} sessions in this world.`);
    if (this.data.facts.length) {
      parts.push('Things you remember:\n' + this.data.facts.slice(-60).map((f) => `- [${f.id}] ${f.text}`).join('\n'));
    }
    const places = this.listPlaces();
    if (places.length) {
      parts.push('Saved places:\n' + places.slice(-40)
        .map((p) => `- ${p.name}: ${p.x} ${p.y} ${p.z} (${p.dimension})${p.note ? ` - ${p.note}` : ''}`).join('\n'));
    }
    const sums = this.data.sessionSummaries.slice(-4);
    if (sums.length) {
      parts.push('Summaries of your recent play (oldest first):\n' + sums
        .map((x) => `- ${new Date(x.ts).toISOString().slice(0, 16).replace('T', ' ')}: ${x.text}`).join('\n'));
    }
    const lastDeath = this.data.deaths.at(-1);
    if (lastDeath) {
      parts.push(`Your last death: ${lastDeath.cause} at ${lastDeath.x} ${lastDeath.y} ${lastDeath.z} (${lastDeath.dimension}).`);
    }
    return parts.join('\n\n') || 'You have no memories yet - this is your first session.';
  }
}
