#!/usr/bin/env node
/**
 * Minecraft server setup: Paper + ViaVersion.
 *
 *   npm run setup-server -- [options]
 *
 * Options:
 *   --version <mc>     Use this Minecraft version instead of auto-detecting.
 *   --dir <path>       Install directory (default: <repo>/server).
 *   --ram <size>       Heap for the start scripts, e.g. 4G or 6144M (default 4G).
 *   --java <path>      Use this java executable instead of auto-detecting.
 *   --install-java     Windows only: install the required Temurin JDK with winget.
 *   --accept-eula      Accept the Minecraft EULA without prompting.
 *   --update           Re-download Paper and ViaVersion even if present.
 *   --online-mode      Write online-mode=true in a new server.properties (bots cannot join).
 *   --help             Show this help.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const PAPER_API = 'https://fill.papermc.io/v3/projects/paper';
const MODRINTH_API = 'https://api.modrinth.com/v2/project/viaversion/version';
const UA = 'Minecraft-AI-server-setup/0.1 (Mineflayer test server setup script)';
const EULA_URL = 'https://aka.ms/MinecraftEULA';

// ---------------------------------------------------------------- output helpers
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const info = (s = '') => console.log(s);
const step = (s) => console.log(`\n${c('1;36', '==>')} ${c('1', s)}`);
const ok = (s) => console.log(`${c('32', '[ok]')} ${s}`);
const warn = (s) => console.log(`${c('33', '[!!]')} ${s}`);
const fail = (s) => {
  console.error(`${c('31', '[error]')} ${s}`);
  process.exit(1);
};

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const opts = {
    version: null,
    dir: path.join(REPO_ROOT, 'server'),
    ram: '4G',
    java: null,
    installJava: false,
    acceptEula: false,
    update: false,
    onlineMode: false,
  };
  const needValue = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const val = () => {
      if (inline !== null) return inline;
      const v = needValue(i, a);
      i++;
      return v;
    };
    switch (a) {
      case '--version': opts.version = val(); break;
      case '--dir': opts.dir = path.resolve(val()); break;
      case '--ram': opts.ram = val(); break;
      case '--java': opts.java = path.resolve(val()); break;
      case '--install-java': opts.installJava = true; break;
      case '--accept-eula': opts.acceptEula = true; break;
      case '--update': opts.update = true; break;
      case '--online-mode': opts.onlineMode = true; break;
      case '--help': case '-h':
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split('\n').slice(2).map((l) => l.replace(/^ ?\* ?/, '')).join('\n'));
        process.exit(0);
        break;
      default: fail(`Unknown option: ${argv[i]} (see --help)`);
    }
  }
  if (!/^\d+[MGmg]$/.test(opts.ram)) fail(`--ram must look like 4G or 6144M, got "${opts.ram}"`);
  opts.ram = opts.ram.toUpperCase();
  return opts;
}

// ---------------------------------------------------------------- http
async function getJson(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error(`GET ${url} failed: ${lastErr?.message ?? lastErr}${lastErr?.cause ? ` (${lastErr.cause.code || lastErr.cause.message})` : ''}`);
}

async function hashFile(file, algo) {
  const h = crypto.createHash(algo);
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

async function download(url, dest, algo, expected, label) {
  const tmp = `${dest}.part`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error(`Download of ${label} failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let lastPrint = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    got += chunk.length;
    const now = Date.now();
    if (process.stdout.isTTY && now - lastPrint > 200) {
      lastPrint = now;
      const pct = total ? ` ${((got / total) * 100).toFixed(0)}%` : '';
      process.stdout.write(`\r    ${label}: ${(got / 1048576).toFixed(1)} MiB${pct}   `);
    }
  });
  await pipeline(body, fs.createWriteStream(tmp));
  if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(60) + '\r');
  const actual = await hashFile(tmp, algo);
  if (actual !== expected.toLowerCase()) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`${algo} mismatch for ${label}: expected ${expected}, got ${actual}`);
  }
  await fsp.rename(tmp, dest);
}

// ---------------------------------------------------------------- versions
function cmpVer(a, b) {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
const isReleaseId = (v) => /^\d+(\.\d+)*$/.test(v); // excludes -pre / -rc

/** Newest STABLE paper build for a version, or null. */
async function stableBuild(version) {
  let builds;
  try {
    builds = await getJson(`${PAPER_API}/versions/${version}/builds`);
  } catch {
    return null;
  }
  if (!Array.isArray(builds)) return null;
  const stable = builds.filter((b) => b.channel === 'STABLE' && b.downloads?.['server:default']);
  stable.sort((a, b) => b.id - a.id);
  return stable[0] ?? null;
}

async function chooseVersion(opts) {
  let tested = [];
  try {
    tested = require(path.join(REPO_ROOT, 'node_modules', 'mineflayer')).testedVersions ?? [];
  } catch {
    warn('Could not load mineflayer (run `npm install` first) - cannot read its supported versions.');
  }
  const proj = await getJson(PAPER_API);
  const allPaper = Object.values(proj.versions).flat();

  if (opts.version) {
    if (!allPaper.includes(opts.version)) fail(`Paper has no version "${opts.version}".`);
    const build = await stableBuild(opts.version);
    if (!build) fail(`Paper has no STABLE build for ${opts.version}.`);
    const covered = tested.some((t) => t === opts.version || (cmpVer(t, '26') >= 0 && opts.version.startsWith(t + '.')));
    info(`Using --version ${opts.version} (user override).`);
    if (!covered) warn(`Mineflayer ${tested.length ? 'does not list' : 'support unknown for'} ${opts.version} as tested; bots may fail to connect.`);
    return { version: opts.version, build, reason: 'user override' };
  }
  if (!tested.length) fail('Mineflayer testedVersions unavailable; pass --version <mc>.');

  const sorted = [...tested].sort((a, b) => cmpVer(b, a));
  info(`Mineflayer tested versions (newest first): ${sorted.slice(0, 6).join(', ')} ...`);
  for (const t of sorted) {
    // "26.1" covers 26.1.x patch releases (same protocol); older tested entries are exact.
    const cands = allPaper
      .filter(isReleaseId)
      .filter((v) => v === t || (cmpVer(t, '26') >= 0 && v.startsWith(t + '.')))
      .sort((a, b) => cmpVer(b, a));
    for (const v of cands) {
      const build = await stableBuild(v);
      if (build) {
        const skipped = sorted.slice(0, sorted.indexOf(t));
        const reason = `newest Minecraft version Mineflayer supports (${t}) that Paper has a STABLE build for` +
          (v !== t ? `; ${v} is the latest ${t}.x patch (same protocol)` : '');
        info(`Target: ${c('1', v)} - ${reason}.`);
        if (skipped.length) info(`(No stable Paper build for: ${skipped.join(', ')})`);
        return { version: v, build, reason };
      }
    }
  }
  fail('No Mineflayer-supported version has a STABLE Paper build.');
}

// ---------------------------------------------------------------- java
function probeJava(exe) {
  const r = spawnSync(exe, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.error || r.status === null) return null;
  const text = `${r.stderr || ''}\n${r.stdout || ''}`;
  const m = text.match(/version "([^"]+)"/);
  if (!m) return null;
  const raw = m[1];
  // "1.8.0_392" -> 8 ; "21.0.2" -> 21 ; "25" -> 25
  const major = raw.startsWith('1.') ? parseInt(raw.split('.')[1], 10) : parseInt(raw, 10);
  if (!Number.isFinite(major)) return null;
  return { path: exe, version: raw, major };
}

function windowsJavaCandidates() {
  const roots = new Set();
  for (const env of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'LOCALAPPDATA']) {
    if (process.env[env]) roots.add(process.env[env]);
  }
  roots.add('C:\\Program Files');
  const vendorDirs = ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'Eclipse Foundation'];
  const out = [];
  for (const root of roots) {
    for (const vendor of vendorDirs) {
      const base = path.join(root, vendor);
      let entries;
      try { entries = fs.readdirSync(base); } catch { continue; }
      for (const e of entries) {
        for (const sub of [path.join(base, e, 'bin', 'java.exe'), path.join(base, e, 'jre', 'bin', 'java.exe')]) {
          if (fs.existsSync(sub)) out.push(sub);
        }
      }
    }
  }
  return out;
}

function findJava(opts, minimum) {
  const tried = [];
  const consider = (exe, source) => {
    const p = probeJava(exe);
    if (p) tried.push({ ...p, source });
  };
  if (opts.java) {
    if (!fs.existsSync(opts.java)) fail(`--java path does not exist: ${opts.java}`);
    consider(opts.java, '--java');
  } else {
    const exeName = IS_WIN ? 'java.exe' : 'java';
    if (process.env.JAVA_HOME) consider(path.join(process.env.JAVA_HOME, 'bin', exeName), 'JAVA_HOME');
    consider('java', 'PATH');
    if (IS_WIN) for (const p of windowsJavaCandidates()) consider(p, 'common install location');
  }
  // Earliest-found suitable one wins (--java, JAVA_HOME, PATH, then common locations).
  const pick = tried.find((t) => t.major >= minimum) ?? null;
  return { pick, tried };
}

function javaInstructions(minimum) {
  const lines = [
    `Paper needs Java ${minimum} or newer for this Minecraft version.`,
    '',
    'Install it (pick one):',
    `  * winget (Windows 10/11, in a normal terminal):`,
    `      winget install --id EclipseAdoptium.Temurin.${minimum}.JDK -e`,
    `  * or run: npm run setup-server -- --install-java   (does the winget command above)`,
    `  * or download the Temurin ${minimum} JDK .msi (x64) from:`,
    `      https://adoptium.net/temurin/releases/?version=${minimum}&os=windows&arch=x64&package=jdk`,
    `    In the installer enable "Add to PATH" (and "Set JAVA_HOME").`,
    '',
    'Then open a NEW terminal window (so PATH refreshes) and re-run: npm run setup-server',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------- misc writers
function writeIfChanged(file, content, mode) {
  fs.writeFileSync(file, content);
  if (mode && !IS_WIN) fs.chmodSync(file, mode);
}

function batEscape(s) {
  return s.replace(/%/g, '%%');
}

function buildStartScripts(dir, { jarName, javaPath, ram, flags, version }) {
  const javaIsAbs = javaPath && path.isAbsolute(javaPath);
  const flagLine = flags.join(' ');
  const bat = [
    '@echo off',
    'setlocal',
    `title Paper ${version} server`,
    'cd /d "%~dp0"',
    '',
    `rem Generated by scripts/setup-server.mjs - re-run it (or edit this file) to change RAM/flags.`,
    `"${batEscape(javaIsAbs ? javaPath : 'java')}" -Xms${ram} -Xmx${ram} ${flagLine} -jar "${batEscape(jarName)}" --nogui`,
    'set "SERVER_EXIT=%ERRORLEVEL%"',
    '',
    'echo.',
    'echo Server stopped (exit code %SERVER_EXIT%).',
    'pause',
    'exit /b %SERVER_EXIT%',
    '',
  ].join('\r\n');
  const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const sh = [
    '#!/usr/bin/env bash',
    '# Generated by scripts/setup-server.mjs',
    'cd "$(dirname "$0")" || exit 1',
    `JAVA=${shQuote(javaIsAbs ? javaPath : 'java')}`,
    `exec "$JAVA" -Xms${ram} -Xmx${ram} ${flagLine} -jar ${shQuote(jarName)} --nogui`,
    '',
  ].join('\n');
  writeIfChanged(path.join(dir, 'start-server.bat'), bat);
  writeIfChanged(path.join(dir, 'start-server.sh'), sh, 0o755);
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (v4 && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  return out;
}

function readProp(file, key, fallback) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
    return m ? m[1] : fallback;
  } catch {
    return fallback;
  }
}

async function confirmEula(opts, dir) {
  const eulaFile = path.join(dir, 'eula.txt');
  if (fs.existsSync(eulaFile) && /^\s*eula\s*=\s*true/im.test(fs.readFileSync(eulaFile, 'utf8'))) {
    ok('eula.txt already accepted.');
    return true;
  }
  let accepted = opts.acceptEula;
  if (!accepted) {
    info(`Running a Minecraft server requires accepting the Minecraft EULA: ${EULA_URL}`);
    if (!process.stdin.isTTY) {
      warn('Not an interactive terminal and --accept-eula not given; eula.txt NOT written.');
      return false;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Do you accept the Minecraft EULA? [y/N] ')).trim().toLowerCase();
    rl.close();
    accepted = answer === 'y' || answer === 'yes';
  } else {
    info(`--accept-eula given: you are agreeing to the Minecraft EULA (${EULA_URL}).`);
  }
  if (!accepted) {
    warn('EULA not accepted; eula.txt NOT written. The server will not start until you accept it.');
    return false;
  }
  fs.writeFileSync(
    eulaFile,
    `#By changing the setting below to TRUE you are indicating your agreement to our EULA (${EULA_URL}).\n` +
      `#Written by scripts/setup-server.mjs on ${new Date().toString()}\neula=true\n`,
  );
  ok('eula.txt written (eula=true).');
  return true;
}

function writeServerProperties(opts, dir) {
  const file = path.join(dir, 'server.properties');
  if (fs.existsSync(file)) {
    ok('server.properties already exists - left untouched.');
    return false;
  }
  const online = opts.onlineMode;
  const body = [
    '# Written by scripts/setup-server.mjs (only created if missing; Paper adds the rest on first start).',
    `# online-mode=false is REQUIRED for the Mineflayer bots: they log in with offline (unauthenticated) names.`,
    `# Real players still join normally. Do NOT port-forward this server to the internet.`,
    `online-mode=${online}`,
    'enforce-secure-profile=false',
    'server-port=25565',
    'motd=Minecraft-AI test server',
    'difficulty=normal',
    'spawn-protection=0',
    'view-distance=10',
    'simulation-distance=8',
    'enable-command-block=false',
    'white-list=false',
    '',
  ].join('\n');
  fs.writeFileSync(file, body);
  ok(`server.properties written (online-mode=${online}).`);
  if (!online) {
    warn('online-mode=false: anyone who can reach the port can log in as ANY username (including an op).');
    info('    This is needed for AI bots (offline-mode logins) and is fine on a home LAN.');
    info('    Do NOT port-forward 25565 on your router / expose it to the internet.');
    info('    (Whitelisting is not reliable in offline mode because UUIDs derive from names.)');
  } else {
    warn('online-mode=true: Mineflayer bots without a Microsoft account will be rejected. Set online-mode=false for bots.');
  }
  return true;
}

// ---------------------------------------------------------------- main
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = opts.dir;
  const pluginsDir = path.join(dir, 'plugins');

  step('Choosing Minecraft version');
  const chosen = await chooseVersion(opts);
  const { version, build } = chosen;
  const dl = build.downloads['server:default'];
  const verInfo = await getJson(`${PAPER_API}/versions/${version}`);
  const minJava = verInfo.version?.java?.version?.minimum ?? 21;
  const flags = verInfo.version?.java?.flags?.recommended ?? [];
  info(`Paper ${version} build ${build.id} (${build.channel}), requires Java >= ${minJava}.`);

  step('Checking Java');
  const { pick, tried } = findJava(opts, minJava);
  let java = pick;
  if (!java && opts.installJava) {
    if (!IS_WIN) {
      warn('--install-java only works on Windows (winget). Install a JDK with your package manager.');
    } else {
      info(`Running: winget install --id EclipseAdoptium.Temurin.${minJava}.JDK -e ...`);
      const r = spawnSync('winget', ['install', '--id', `EclipseAdoptium.Temurin.${minJava}.JDK`, '-e', '--accept-package-agreements', '--accept-source-agreements'], { stdio: 'inherit' });
      if (r.status !== 0) warn(`winget exited with code ${r.status}.`);
      java = findJava({ ...opts, java: null }, minJava).pick;
    }
  }
  if (java) {
    ok(`Java ${java.version} (major ${java.major}) at ${java.path} [${java.source}]`);
  } else {
    if (tried.length) {
      for (const t of tried) warn(`Found Java ${t.version} at ${t.path} [${t.source}] - too old (need ${minJava}+).`);
    } else {
      warn('No Java found on PATH' + (IS_WIN ? ' or in common install locations.' : '.'));
    }
    info('\n' + javaInstructions(minJava).split('\n').map((l) => '    ' + l).join('\n') + '\n');
    warn('Continuing setup (downloads and scripts) - you must install Java before starting the server.');
    if (!IS_WIN) info(`    (Linux: e.g. apt install openjdk-${minJava}-jdk, or use https://adoptium.net/ )`);
  }

  step(`Preparing ${dir}`);
  await fsp.mkdir(pluginsDir, { recursive: true });

  step('Paper server jar');
  const jarName = dl.name;
  const jarPath = path.join(dir, jarName);
  const sha = dl.checksums.sha256;
  let have = false;
  if (fs.existsSync(jarPath) && !opts.update) {
    have = (await hashFile(jarPath, 'sha256')) === sha;
    if (!have) warn(`${jarName} exists but its sha256 does not match; re-downloading.`);
  }
  if (have) {
    ok(`${jarName} already present and verified (sha256 ${sha.slice(0, 12)}...).`);
  } else {
    info(`Downloading ${jarName} (${(dl.size / 1048576).toFixed(1)} MiB) ...`);
    await download(dl.url, jarPath, 'sha256', sha, jarName);
    ok(`${jarName} downloaded, sha256 verified.`);
  }
  for (const f of fs.readdirSync(dir)) {
    if (/^paper-.*\.jar$/.test(f) && f !== jarName) {
      fs.rmSync(path.join(dir, f), { force: true });
      info(`    removed old ${f}`);
    }
  }

  step('ViaVersion plugin');
  const q = new URLSearchParams({ loaders: JSON.stringify(['paper']), game_versions: JSON.stringify([version]) });
  const vv = await getJson(`${MODRINTH_API}?${q}`);
  if (!Array.isArray(vv) || !vv.length) fail(`No ViaVersion build on Modrinth for paper + ${version}.`);
  vv.sort((a, b) => b.date_published.localeCompare(a.date_published));
  let pickVv;
  for (const type of ['release', 'beta', 'alpha']) {
    pickVv = vv.find((v) => v.version_type === type);
    if (pickVv) {
      if (type !== 'release') warn(`No ViaVersion "release" for ${version}; using newest ${type}: ${pickVv.version_number}`);
      break;
    }
  }
  const vvFile = pickVv.files.find((f) => f.primary) ?? pickVv.files[0];
  const vvPath = path.join(pluginsDir, vvFile.filename);
  info(`ViaVersion ${pickVv.version_number} (${pickVv.version_type}), supports ${pickVv.game_versions.slice(-4).join(', ')}.`);
  let haveVv = false;
  if (fs.existsSync(vvPath) && !opts.update) {
    haveVv = (await hashFile(vvPath, 'sha512')) === vvFile.hashes.sha512;
    if (!haveVv) warn(`${vvFile.filename} exists but hash differs; re-downloading.`);
  }
  if (haveVv) {
    ok(`${vvFile.filename} already present and verified.`);
  } else {
    await download(vvFile.url, vvPath, 'sha512', vvFile.hashes.sha512, vvFile.filename);
    ok(`${vvFile.filename} downloaded, sha512 verified.`);
  }
  for (const f of fs.readdirSync(pluginsDir)) {
    if (/^ViaVersion-.*\.jar$/i.test(f) && f !== vvFile.filename) {
      fs.rmSync(path.join(pluginsDir, f), { force: true });
      info(`    removed old ${f}`);
    }
  }

  step('EULA, server.properties, start scripts');
  const eulaOk = await confirmEula(opts, dir);
  writeServerProperties(opts, dir);
  buildStartScripts(dir, { jarName, javaPath: java?.path ?? null, ram: opts.ram, flags, version });
  ok(`start-server.bat and start-server.sh written (-Xms${opts.ram} -Xmx${opts.ram}, Paper recommended flags).`);

  // ---- summary
  const propsFile = path.join(dir, 'server.properties');
  const port = readProp(propsFile, 'server-port', '25565');
  info('\n' + c('1;32', '================  Setup complete  ================'));
  info(`Minecraft version : ${version} (Paper build ${build.id}) + ViaVersion ${pickVv.version_number}`);
  info(`Install directory : ${dir}`);
  if (!java) info(c('33', `Java              : NOT READY - install Java ${minJava}+ first (see above).`));
  if (!eulaOk) info(c('33', 'EULA              : NOT accepted - re-run with --accept-eula (or answer "y").'));
  info('\nStart the server:');
  info(IS_WIN ? `  ${path.join(dir, 'start-server.bat')}   (double-click it)` : `  ${path.join(dir, 'start-server.sh')}`);
  info('  Type "stop" in the server console to shut down cleanly.');
  info('\nBots: point them at host "localhost" (the default; this PC), port ' + port + ', and set the bot version to "' +
    (version.split('.').slice(0, 2).join('.')) + '" if auto-detect has trouble.');

  info('\nJoining from another PC on your network (Minecraft Java, latest version is fine):');
  const addrs = lanAddresses();
  if (addrs.length) {
    for (const a of addrs) info(`  ${a.address}${port === '25565' ? '' : ':' + port}   (${a.name})`);
  } else {
    warn('  No LAN IPv4 address found - run `ipconfig` on this PC and use its IPv4 Address.');
  }
  info(`  ViaVersion lets a newer client (like 26.3) join this ${version} server - just use the normal "latest release".`);
  info(`  Without ViaVersion you would have to pick an installation with exactly ${version} in the launcher`);
  info(`  (Installations > New installation > Version: release ${version}).`);

  info('\nWindows Firewall (on this PC, only needed for players on other PCs; run PowerShell as Administrator):');
  info(`  New-NetFirewallRule -DisplayName "Minecraft Server (TCP ${port})" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private`);
  info('  Also make sure the home network is set to "Private", and allow Java if Windows asks on first start.');
  warn('Security: the server is in offline mode for the bots - keep it LAN-only, never port-forward ' + port + '.');
}

main().catch((e) => fail(e?.stack || String(e)));
