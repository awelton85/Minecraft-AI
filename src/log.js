import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

/** Central logger. Emits 'log' events ({ts, bot, level, msg}) for the dashboard. */
class Logger extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.consoleLevel = process.env.LOG_LEVEL || 'info';
    this.fileStream = null;
  }

  enableFile(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      this.fileStream = fs.createWriteStream(path.join(dir, `minecraft-ai-${day}.log`), { flags: 'a' });
    } catch (e) {
      console.error('Could not open log file:', e.message);
    }
  }

  write(level, bot, ...parts) {
    const msg = parts
      .map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : safeJson(p)))
      .join(' ');
    const entry = { ts: Date.now(), bot: bot || null, level, msg };
    const time = new Date(entry.ts).toTimeString().slice(0, 8);
    const line = `${time} ${level.toUpperCase().padEnd(5)} ${bot ? `[${bot}] ` : ''}${msg}`;
    if (LEVELS[level] >= (LEVELS[this.consoleLevel] ?? 20)) {
      console.log(`${COLORS[level]}${line}\x1b[0m`);
    }
    if (this.fileStream) this.fileStream.write(line + '\n');
    this.emit('log', entry);
  }

  /** Returns a logger bound to a bot name: log.for('Steve').info('hi') */
  for(bot) {
    return {
      debug: (...a) => this.write('debug', bot, ...a),
      info: (...a) => this.write('info', bot, ...a),
      warn: (...a) => this.write('warn', bot, ...a),
      error: (...a) => this.write('error', bot, ...a),
    };
  }

  debug(...a) { this.write('debug', null, ...a); }
  info(...a) { this.write('info', null, ...a); }
  warn(...a) { this.write('warn', null, ...a); }
  error(...a) { this.write('error', null, ...a); }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const log = new Logger();
