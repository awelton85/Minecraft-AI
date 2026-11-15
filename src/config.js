import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

const CHARACTER_DEFAULTS = {
  name: '',
  username: '',
  enabled: true,
  personality: 'A helpful, practical Minecraft companion. Speaks briefly.',
  defaultGoal: 'Help the owner. When idle, gather useful resources and stay safe.',
  llm: { provider: '', model: '' },
  voice: { name: '', rate: 1.0, pitch: 1.0 },
};

const SECRET_KEYS = ['anthropicApiKey', 'lmstudioApiKey'];
const SECRET_ENV = { anthropicApiKey: 'ANTHROPIC_API_KEY', lmstudioApiKey: 'LMSTUDIO_API_KEY' };

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge: objects merge recursively, arrays and scalars replace. */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Characters must have filesystem- and Minecraft-safe names. */
export function validCharacterName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(name);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`Could not parse ${file}: ${e.message}`);
  }
}

async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Loads/saves config/settings.json (user overrides on top of settings.default.json),
 * config/characters/*.json and config/secrets.json. Emits 'change' ({ settings, characters }).
 */
export class SettingsManager extends EventEmitter {
  constructor(rootDir) {
    super();
    this.rootDir = rootDir;
    this.configDir = path.join(rootDir, 'config');
    this.charDir = path.join(this.configDir, 'characters');
    this.defaults = {};
    this.user = {};
    this.settings = {};
    this.characters = {};
    this.secrets = {};
  }

  async load() {
    this.defaults = await readJson(path.join(this.configDir, 'settings.default.json'), {});
    this.user = await readJson(path.join(this.configDir, 'settings.json'), null);
    if (this.user === null) {
      // First run: create an editable copy so users can find and edit it.
      this.user = structuredClone(this.defaults);
      await writeJsonAtomic(path.join(this.configDir, 'settings.json'), this.user);
    }
    this.settings = deepMerge(this.defaults, this.user);
    this.secrets = await readJson(path.join(this.configDir, 'secrets.json'), {});

    this.characters = {};
    await fs.mkdir(this.charDir, { recursive: true });
    for (const f of await fs.readdir(this.charDir)) {
      if (!f.endsWith('.json')) continue;
      const profile = deepMerge(CHARACTER_DEFAULTS, await readJson(path.join(this.charDir, f), {}));
      if (!profile.name) profile.name = path.basename(f, '.json');
      if (!profile.username) profile.username = profile.name;
      this.characters[profile.name] = profile;
    }
    // Make sure every name listed in settings.characters has a profile.
    for (const name of this.settings.characters || []) {
      if (!this.characters[name] && validCharacterName(name)) {
        await this.saveCharacter({ name, username: name }, { silent: true });
      }
    }
    return this;
  }

  async saveSettings(patch) {
    if (!isPlainObject(patch)) throw new Error('settings patch must be an object');
    this.user = deepMerge(this.user, patch);
    this.settings = deepMerge(this.defaults, this.user);
    await writeJsonAtomic(path.join(this.configDir, 'settings.json'), this.user);
    this.emit('change', { settings: this.settings, characters: this.characters });
    return this.settings;
  }

  async saveCharacter(profile, { silent = false } = {}) {
    if (!profile || !validCharacterName(profile.name)) {
      throw new Error('Character name must be 3-16 characters: letters, digits or underscore');
    }
    const merged = deepMerge(deepMerge(CHARACTER_DEFAULTS, this.characters[profile.name] || {}), profile);
    if (!merged.username) merged.username = merged.name;
    if (!validCharacterName(merged.username)) {
      throw new Error('Minecraft username must be 3-16 characters: letters, digits or underscore');
    }
    this.characters[merged.name] = merged;
    await writeJsonAtomic(path.join(this.charDir, `${merged.name}.json`), merged);
    const list = this.settings.characters || [];
    if (!list.includes(merged.name)) await this.saveSettings({ characters: [...list, merged.name] });
    else if (!silent) this.emit('change', { settings: this.settings, characters: this.characters });
    return merged;
  }

  async deleteCharacter(name) {
    if (!validCharacterName(name)) throw new Error('invalid character name');
    delete this.characters[name];
    await fs.rm(path.join(this.charDir, `${name}.json`), { force: true });
    await this.saveSettings({ characters: (this.settings.characters || []).filter((n) => n !== name) });
  }

  /** Characters listed in settings.characters, in order. */
  activeCharacters() {
    return (this.settings.characters || []).map((n) => this.characters[n]).filter(Boolean);
  }

  getSecret(key) {
    return this.secrets[key] || process.env[SECRET_ENV[key]] || '';
  }

  secretsStatus() {
    return Object.fromEntries(SECRET_KEYS.map((k) => [k, Boolean(this.getSecret(k))]));
  }

  async setSecret(key, value) {
    if (!SECRET_KEYS.includes(key)) throw new Error(`unknown secret ${key}`);
    if (value) this.secrets[key] = String(value).trim();
    else delete this.secrets[key];
    await writeJsonAtomic(path.join(this.configDir, 'secrets.json'), this.secrets);
    this.emit('change', { settings: this.settings, characters: this.characters });
  }
}
