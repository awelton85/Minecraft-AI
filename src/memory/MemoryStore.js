import fs from 'node:fs/promises';
import path from 'node:path';

/** fs.rename can fail transiently on Windows (antivirus/indexer holding the file). */
export async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return await fs.rename(from, to); } catch (e) {
      if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

const EMPTY = () => ({
  version: 1,
  facts: [],            // [{ id, text, ts }]
  places: {},           // { lowerName: { name, x, y, z, dimension, note, ts } }
  sessionSummaries: [], // [{ ts, text }]
  deaths: [],           // [{ ts, x, y, z, dimension, cause }]
  stats: { sessions: 0, firstSeen: null, lastSeen: null },
});

const LIMITS = { facts: 200, sessionSummaries: 30, deaths: 20 };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v, max = 4000) => String(v ?? '').slice(0, max);

/** Coerces anything (hand-edited file, dashboard JSON editor) into the expected shape. */
export function normalizeMemory(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('memory must be a JSON object');
  const out = EMPTY();
  const arr = (v, name) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`"${name}" must be an array`);
    return v;
  };
  let id = 1;
  out.facts = arr(raw.facts, 'facts')
    .map((f) => (typeof f === 'string' ? { text: f } : f))
    .filter((f) => f && typeof f === 'object' && String(f.text ?? '').trim())
    .map((f) => ({ id: Number.isInteger(f.id) && f.id > 0 ? f.id : 0, text: str(f.text, 500).trim(), ts: num(f.ts) || Date.now() }));
  const seen = new Set();
  const taken = new Set(out.facts.map((f) => f.id).filter(Boolean));
  for (const f of out.facts) {
    if (!f.id || seen.has(f.id)) { while (taken.has(id)) id++; f.id = id; taken.add(id); }
    seen.add(f.id);
  }
  if (raw.places !== undefined && raw.places !== null) {
    if (typeof raw.places !== 'object' || Array.isArray(raw.places)) throw new Error('"places" must be an object');
    for (const [k, p] of Object.entries(raw.places)) {
      if (!p || typeof p !== 'object') continue;
      const name = str(p.name || k, 60).trim();
      if (!name) continue;
      out.places[name.toLowerCase()] = { name, x: Math.round(num(p.x)), y: Math.round(num(p.y)), z: Math.round(num(p.z)),
        dimension: str(p.dimension || 'overworld', 40), note: str(p.note, 200), ts: num(p.ts) || Date.now() };
    }
  }
  out.sessionSummaries = arr(raw.sessionSummaries, 'sessionSummaries')
    .map((x) => (typeof x === 'string' ? { text: x } : x))
    .filter((x) => x && String(x.text ?? '').trim())
    .map((x) => ({ ts: num(x.ts) || Date.now(), text: str(x.text) }));
  out.deaths = arr(raw.deaths, 'deaths').filter((d) => d && typeof d === 'object')
    .map((d) => ({ ts: num(d.ts) || Date.now(), x: Math.round(num(d.x)), y: Math.round(num(d.y)), z: Math.round(num(d.z)),
      dimension: str(d.dimension || 'overworld', 40), cause: str(d.cause || 'unknown', 200) }));
  const st = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  out.stats = { sessions: Math.max(0, Math.round(num(st.sessions))), firstSeen: st.firstSeen ? num(st.firstSeen) : null, lastSeen: st.lastSeen ? num(st.lastSeen) : null };
  return out;
}

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
      const raw = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, ''));
      this.data = normalizeMemory(raw);
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
    this.data = normalizeMemory(obj); // throws on a bad shape before anything is replaced
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

  /** Atomic write; saves are serialised so overlapping calls can't interleave. */
  save() {
    clearTimeout(this._saveTimer);
    this._saving = (this._saving || Promise.resolve()).catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      await renameRetry(tmp, this.file);
    });
    return this._saving;
  }

  /** Dashboard: delete a single entry without replacing the whole memory. */
  deleteEntry(section, key) {
    let ok = false;
    if (section === 'facts') {
      if (!/^\d+$/.test(String(key))) throw Object.assign(new Error('fact id must be a number'), { status: 400 });
      ok = this.removeFact(String(key));
    }
    else if (section === 'places') ok = this.removePlace(key);
    else if (section === 'sessionSummaries' || section === 'deaths') {
      const i = Number(key);
      if (Number.isInteger(i) && i >= 0 && i < this.data[section].length) { this.data[section].splice(i, 1); ok = true; this.scheduleSave(); }
    } else throw new Error(`unknown memory section ${section}`);
    return ok;
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

  /** Removes one fact by id, by exact text, or by a substring that matches exactly one fact. */
  removeFact(idOrText) {
    const raw = String(idOrText ?? '').trim();
    if (!raw) return false;
    let idx = -1;
    if (/^\d+$/.test(raw)) idx = this.data.facts.findIndex((f) => f.id === Number(raw));
    if (idx < 0) idx = this.data.facts.findIndex((f) => f.text.toLowerCase() === raw.toLowerCase());
    if (idx < 0) {
      const hits = this.data.facts.map((f, i) => (f.text.toLowerCase().includes(raw.toLowerCase()) ? i : -1)).filter((i) => i >= 0);
      if (hits.length === 1) idx = hits[0];
    }
    if (idx < 0) return false;
    this.data.facts.splice(idx, 1);
    this.scheduleSave();
    return true;
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
