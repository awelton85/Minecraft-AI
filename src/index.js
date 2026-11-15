import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsManager } from './config.js';
import { BotManager } from './bot/BotManager.js';
import { startWebServer } from './web/server.js';
import { log } from './log.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  log.enableFile(path.join(rootDir, 'logs'));
  const settingsManager = await new SettingsManager(rootDir).load();
  const manager = new BotManager({ settingsManager, log, rootDir });
  log.on('log', (entry) => manager.emit('log', entry));

  let web = null;
  if (settingsManager.settings.web?.enabled !== false) {
    try {
      web = await startWebServer({ settingsManager, manager, log, rootDir });
    } catch (e) {
      log.error(`Dashboard failed to start: ${e.message}`);
    }
  }

  const s = settingsManager.settings;
  log.info(`Minecraft server: ${s.server.host}:${s.server.port} | LLM: ${s.llm.provider} | characters: ${(s.characters || []).join(', ') || '(none)'}`);
  if (s.llm.provider === 'anthropic' && !settingsManager.getSecret('anthropicApiKey')) {
    log.warn('No Claude API key configured yet - add it on the dashboard Settings page, or switch the provider to LM Studio.');
  }
  if ((s.owners || []).includes('YourMinecraftName')) {
    log.warn('Set your Minecraft username under "owners" in Settings so the bots follow your commands.');
  }

  await manager.startAll();

  let shuttingDown = false;
  const shutdown = async (sig) => {
    // Exit code 0 tells start-bots.bat/.sh that this was intentional (no auto-restart).
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    log.info(`${sig}: saving memories and disconnecting (press Ctrl+C again to force)...`);
    const force = setTimeout(() => process.exit(0), 30_000);
    await manager.shutdown();
    await web?.close?.();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Closing the console window on Windows sends SIGHUP; Ctrl+Break sends SIGBREAK.
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  // A bug in one bot must never take the whole program down.
  process.on('uncaughtException', (e) => log.error('Uncaught exception:', e));
  process.on('unhandledRejection', (e) => log.error('Unhandled rejection:', e));
}

main().catch((e) => {
  log.error('Fatal:', e);
  process.exit(1);
});
