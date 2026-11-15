# Minecraft AI

AI-controlled players for Minecraft Java Edition. Each bot is a real player on your server (built on [Mineflayer](https://github.com/PrismarineJS/mineflayer)). An LLM decides what it does, using either the **Claude API** or a **local model in LM Studio**. You talk to the bots in game chat, from a web dashboard, or by voice. Each bot keeps its own memory between sessions.

## Features

- **Two LLM backends, switchable at runtime**: Claude API (Opus / Sonnet / Haiku) or LM Studio (any OpenAI-compatible server). You can set them globally or per character, and pick an automatic fallback provider if the main one goes down.
- **Web dashboard**: bot status, chat, settings, memory editor and live logs. It's served from the PC that runs the bots, so you can open it from any device on your network.
- **Voice**: push-to-talk or hands-free with a wake word (the bot's name). The bots answer out loud with text-to-speech, each with its own voice. This uses the browser's built-in speech features, so there's nothing extra to install.
- **Robustness**:
  - Reconnects automatically with back-off after disconnects, server restarts and kicks.
  - A watchdog catches frozen connections.
  - Every action has a timeout, and movement has a stuck detector that tries to get unstuck before giving up.
  - Failed actions are tracked. The model is told to change approach after repeated failures, and a bot that is truly stuck asks you for help instead of burning tokens.
  - LLM errors are retried with back-off. One crashing bot never takes down the others.
- **Survival reflexes**: auto-eat, auto-equip armour, fights back when attacked, auto-respawn. Deaths are remembered.
- **Persistent memory per character**: facts, named places, summaries of past sessions and death history. It's stored as JSON in `data/memory/` and can be edited from the dashboard.
- **Multiple bots at once**: each has its own personality, voice, model and memory. They know about each other, and bot-to-bot chat is rate-limited so they can't loop forever.
- **About 40 skills**: mining, crafting (auto-crafts planks and sticks), smelting, building shapes and shelters, farming (tilling and planting), chests, item pickup, combat and fleeing, following, exploring, sleeping, returning to where you died, and saved places. Player builds, chests and beds are protected from digging.

## How it fits together

```
 Host PC                                             Player PC (can be the same machine)
 ┌──────────────────────────────────────┐            ┌────────────────────────────┐
 │ Paper server 26.1.2 + ViaVersion      │◀──────────│ Minecraft (latest, you play)│
 │        ▲ (bots join as players)       │           │                             │
 │ node src/index.js                     │           │ Browser: dashboard + voice  │
 │   BotRunner ─ Agent ─ skills          │◀──https───│  https://<host-ip>:3000     │
 │   web dashboard :3000                 │           └────────────────────────────┘
 │        │                              │
 │        ├──▶ Claude API (internet)     │
 │        └──▶ LM Studio :1234 (local)   │
 └──────────────────────────────────────┘
```

**Why server version 26.1.2?** Mineflayer currently supports Minecraft up to 26.1. The server runs the newest version the bots can handle, and the ViaVersion plugin lets newer clients (e.g. 26.3) join it anyway. Players keep using the latest launcher version.

## Quick start (Windows)

The *host PC* runs the server and the bots; the *player PC* is where you play. They can be the same computer.

Full step-by-step guide: **[docs/SETUP-WINDOWS.md](docs/SETUP-WINDOWS.md)**. Short version:

1. **On the host PC**, install [Node.js LTS](https://nodejs.org/) (20+) and Java 25 (`winget install EclipseAdoptium.Temurin.25.JDK`).
2. Download this repository to the host PC, then double-click **`setup.bat`**. It installs dependencies, then downloads Paper and ViaVersion into `server\`, after you accept the Minecraft EULA.
3. Start the server: **`server\start-server.bat`**.
4. Start the bots: **`start-bots.bat`**. On first run it creates `config\settings.json` and prints the dashboard address.
5. Open the dashboard (`https://<host-ip>:3000`, or `https://localhost:3000` on the host itself) and accept the self-signed certificate warning. In **Settings**:
   - Put **your Minecraft username** in *Owners*. The bots only take orders from owners.
   - Choose **Claude API** and paste your API key, or choose **LM Studio** and pick a model.
6. **On the player PC**, open Minecraft and go to Multiplayer → Add Server → `<host-ip>` (or `localhost`).
7. Say hi in chat: `Steve_AI, come here and help me build a house`.

## Talking to the bots

| Where | How |
|---|---|
| Game chat | Just talk. With several bots, start with a name (`Alex_AI get wood`) or `everyone ...`. |
| Whisper | `/msg Steve_AI ...` |
| Dashboard | Chat box, sent to one bot or to all. |
| Voice | Dashboard → hold the mic button, or enable hands-free and start with the bot's name. |
| Stop | Say `stop` (or press **Stop action** on the dashboard). The current action is aborted at once. |

The bots answer in game chat, and the dashboard reads their replies aloud if TTS is on.

## Choosing a model

- **Claude API**: `claude-opus-5-5` is the default and the most capable. `claude-sonnet-5-5` and `claude-haiku-5-5` are cheaper and faster. *Effort* trades depth of thinking for speed and cost: `low` or `medium` is fine for a game bot.
  - Autonomous mode makes calls continuously while a bot is working, and every ~45 s when idle. Watch your API usage, turn autonomous off when you're away, or use LM Studio for idle play.
- **LM Studio**: use a model with good tool calling (for example a recent Qwen, Llama 3.x or Mistral instruct model of 7B+; bigger plans better). In LM Studio, load the model, then Developer → *Start Server*.
  - If LM Studio runs on a different PC from the bots, enable *Serve on Local Network* and put that PC's IP in Settings.
  - *Tool mode*: `auto` starts with native function calling and falls back to a JSON prompt format if the model can't do it.
  - Give the model a context length of at least 16k, and set the same value in Settings.

## Files

| Path | What |
|---|---|
| `config/settings.json` | Your settings (created on first run; the dashboard edits it). Defaults are in `settings.default.json`. |
| `config/characters/*.json` | One file per bot: username, personality, default goal, model override and voice. |
| `config/secrets.json` | API keys (never sent to the browser). `ANTHROPIC_API_KEY` env var also works. |
| `data/memory/<name>.json` | Each bot's long-term memory. |
| `logs/` | Daily log files. |
| `server/` | The Minecraft server created by `setup.bat`. |

## Security notes

- The bots log in without Mojang authentication, so the server runs with `online-mode=false`. That's fine on a home LAN, but **do not port-forward it to the internet**: anyone could join under any name, including yours, and command the bots.
- The dashboard can change settings and holds your API key. Set a password in Settings → Web if other people use your network.
- The bots cannot run slash-commands. Chat starting with `/` is stripped.

## Development

```
npm test                       # unit tests
node test/skills.smoke.mjs     # skill smoke test against a local server
node test/web.smoke.mjs        # dashboard API smoke test
```
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the internals.
