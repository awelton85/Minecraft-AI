# Setup guide (Windows)

This guide uses two roles:

| Role | Runs |
|---|---|
| **Host PC** | the Minecraft server, the bot program and its web dashboard, and optionally LM Studio |
| **Player PC** | Minecraft (you playing) and a browser for the dashboard and voice |

They can be **the same computer**. If so, skip the networking steps and use `localhost` wherever this guide says `<host-ip>`. Any recent Windows 10 or 11 works for either role. The bot program also runs on Linux and macOS: use `start-bots.sh` and `server/start-server.sh` instead of the `.bat` files.

The host PC needs enough memory for the server (4 GB by default) plus a little for the bots. If you also run LM Studio on it, add whatever your model needs.

## 1. Host PC: install prerequisites

1. **Node.js 20 or newer**: install the LTS version from https://nodejs.org/ and keep the defaults.
2. **Java 25**: the Paper 26.1.2 server needs it. Open *Terminal* or *PowerShell* and run:
   ```powershell
   winget install EclipseAdoptium.Temurin.25.JDK
   ```
   You can also download the MSI from https://adoptium.net/ instead.

   Windows asks for admin permission (a UAC prompt) during the install: click *Yes*. An older Java can stay installed, because the setup script finds and uses Java 25 automatically.
3. **Get this project** into a simple folder such as `C:\Minecraft-AI`. Either:
   - **With git.** If `git` isn't installed, run `winget install Git.Git` (another admin prompt), then open a *new* terminal. Then run:
     ```powershell
     cd C:\
     git clone https://github.com/awelton85/Minecraft-AI.git
     ```
     This creates `C:\Minecraft-AI`.
   - **Without git.** On the GitHub page use *Code → Download ZIP* and extract it to `C:\Minecraft-AI`.

## 2. Host PC: create the Minecraft server

Double-click **`setup.bat`** in the project folder. It will:

1. run `npm install`, which downloads the bot libraries;
2. pick the newest Minecraft version the bots support (currently **26.1.2**), then download **Paper** and the **ViaVersion** plugin into `server\`;
3. ask you to accept the Minecraft EULA;
4. write `server\server.properties` and `server\start-server.bat`.

Optional flags:
- `--ram 6G`: memory for the server.
- `--install-java`: installs Java via winget.
- `--accept-eula`: skips the EULA question.

For example, `setup.bat --ram 6G`.

`npm install` may print deprecation warnings, a "vulnerabilities" count and an npm update notice. These are normal. **Don't run `npm audit fix --force`**, because it can break the bot libraries.

**Already have a server?** You can point the bots at it instead. In Settings, set *Server connection* to its address and port. The server needs `online-mode=false` (see Security in the README) and a version the bots support, 26.1.x or older. A newer server should also work with the ViaVersion and ViaBackwards plugins installed (untested).

Start the server by double-clicking **`server\start-server.bat`**. Wait for `Done (…)! For help, type "help"`. The first start can take up to a minute while the world generates.

> **Ignore Paper's "update" warning.** Paper prints that you are several releases behind and should update as soon as possible. **Don't update the server**: the bots only support Minecraft up to 26.1, and newer players can already join through ViaVersion.

The first time Java starts, Windows may ask whether to allow it through the firewall, even if you only play on this PC. Choose **Allow** with **Private networks** ticked if you'll ever join from another PC; for a same-PC setup either choice works.

## 3. Host PC: allow network access

*Skip this section if you play on the host PC itself.*

If you missed or declined the firewall prompt from section 2, run this in an *Administrator* PowerShell. It allows the Minecraft server (port 25565) and the dashboard (port 3000):
```powershell
New-NetFirewallRule -DisplayName "Minecraft Server" -Direction Inbound -Protocol TCP -LocalPort 25565 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "Minecraft AI Dashboard" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```
Make sure your home network is set to **Private** (Settings → Network & Internet → your connection → *Private network*).

Find the host PC's IP address with `ipconfig` and look for "IPv4 Address", e.g. `192.168.1.20`. This guide calls it `<host-ip>`. Setting a DHCP reservation in your router keeps this address from changing.

## 4. Host PC: start the bots

Double-click **`start-bots.bat`**. The console prints lines such as:
```
Dashboard: https://localhost:3000
Dashboard: https://192.168.1.20:3000
Browser will warn about the self-signed certificate: choose Advanced -> Proceed.
WARN  Dashboard has no password and is reachable on the LAN. Set one in Settings -> Web.
Minecraft server: 127.0.0.1:25565 | LLM: anthropic | characters: Steve_AI
WARN  No Claude API key configured yet - add it on the dashboard Settings page, or switch the provider to LM Studio.
WARN  Set your Minecraft username under "owners" in Settings so the bots follow your commands.
INFO  [Steve_AI] Connecting to 127.0.0.1:25565 as Steve_AI...
INFO  [Steve_AI] Spawned in world (Minecraft 26.1) at ...
ERROR [Steve_AI] No Anthropic API key set. Add it on the dashboard Settings page (or set ANTHROPIC_API_KEY).
```
On the first run, the two warnings and the red **ERROR** about the API key are expected until you finish section 5. A line about a "deprecated event (physicTick)" comes from a library and is harmless.

The window restarts the program automatically if it ever crashes. To stop it cleanly, press **Ctrl+C**; the bots save their memories first. When Windows then asks `Terminate batch job (Y/N)?`, type **Y**.

Leave *Server connection → host* at `127.0.0.1` when the bots run on the same PC as the server.

## 5. Configure from the dashboard

On any device on your network, open `https://<host-ip>:3000` (or `https://localhost:3000` on the host PC).

The browser warns that the certificate isn't trusted. It's a self-signed certificate made for your PC, so click **Advanced → Continue/Proceed**. HTTPS is what allows the browser to use your microphone.

Under **Settings → General**, in this order:
- **Owners**: replace the placeholder `YourMinecraftName` with your Minecraft username (exactly as in game). The bots only obey owners, and they only work on their own while an owner is online (see section 10).
- **LLM provider**:
  - *Claude API*: paste your API key from https://console.anthropic.com/ and click **Save key**, then **Test connection**.
  - *LM Studio*: see section 7.
- **Web → password**: set one if other people use your network.
- Click **Save settings**.

Under **Settings → Characters** you can edit `Steve_AI`'s personality and voice, or add more bots. Each bot needs a unique Minecraft username of 3–16 characters (letters, digits, `_`).

## 6. Player PC: join the game

Open the Minecraft Launcher and play your normal (latest) Java version, then go to **Multiplayer → Add Server** with address `<host-ip>` (or `localhost` on the host PC). ViaVersion translates between newer clients and the 26.1.2 server.

If you ever see block or item glitches, you can instead create a launcher installation for exactly **26.1.2** and join with that.

Talk to the bot in chat: `Steve_AI follow me`, `Steve_AI get 10 oak logs and make a crafting table`, or `stop`.

## 7. Using LM Studio (local models)

1. Install LM Studio and download a model that's good at **tool / function calling**. Recent Qwen instruct models in the 7B–32B range work well, as do Llama 3.1+ instruct and Mistral Small. Larger models plan better.
2. Load the model with a context length of at least **16384**.
3. Start LM Studio's local server. The default address is `http://127.0.0.1:1234`. Depending on your LM Studio version this is in the **Developer** tab (*Start Server*) or the **Model Server** page in the sidebar.
   - If LM Studio runs on a *different* PC from the bots, enable **Serve on Local Network** and use that PC's IP in the dashboard, e.g. `http://192.168.1.30:1234/v1`.
4. On the dashboard, open **Settings → LLM provider → LM Studio**, click **Refresh models**, pick the model (leave it blank to use whatever is loaded), then click **Test connection**. The first test can take up to a minute while LM Studio loads the model; it shows "testing…" until then. Finally click **Save settings** at the bottom of the page.
5. Set **Tool mode** to *auto*. If the model often "talks about" actions instead of doing them, set it to *json*.
6. Set *Context tokens* to match what you loaded the model with. **16k is the practical minimum**: the bot's tool list and instructions alone take about 6k tokens. With less, the bot stops and the dashboard says the context is too small.

**Fallback provider**: choose LM Studio as the fallback while using Claude (or the other way around). The bots then switch over automatically if the primary provider keeps failing, for example when the internet is down. They retry the primary every 10 minutes.

Any other OpenAI-compatible server (llama.cpp server, vLLM, Ollama's `/v1` endpoint, …) also works through the LM Studio provider: set its URL in the same field. If that server needs an API key, put it in the `LMSTUDIO_API_KEY` environment variable or in `config/secrets.json` as `{"lmstudioApiKey": "..."}`.

## 8. Voice

On the dashboard **Chat & Voice** tab (Chrome or Edge):
- **Mic**: hold it to talk, or click once to toggle. The text is sent to the selected bot.
- **Hands-free**: listens continuously and only sends sentences that start with a wake word, i.e. a bot name (`Steve, come here`) or `everyone …`. You can add extra wake words.
- **Speak bot replies**: the bots' chat is read aloud. Each character can have its own voice, rate and pitch (Settings → Characters → Voice → *Preview*). Windows' built-in voices appear in the list. More can be added under Windows *Settings → Time & language → Speech*.
- **Test microphone / Test voice** buttons check that everything works.

Speech recognition in Chrome and Edge is done by Google or Microsoft online services, so it needs internet access.

## 9. Multiple bots

Add characters in **Settings → Characters**. They appear in game when started (Bots tab → Start, or Start all). Each has its own memory file.

Address them by name in chat. `everyone …` goes to all of them. Bot-to-bot chat only happens when one names the other, and it is limited.

## 10. Keeping API costs down (Claude)

- **Pause idle check-ins while no owner is online** (on by default). While none of the **Owners** is in the game, the bots make no model calls on their own: no idle work, and no reaction to being attacked, low health or dying. Built-in reflexes (fighting back, eating, respawning) still run without the model, and the bot hears about what happened when it next thinks. The bots still answer anyone who talks to them in game or from the dashboard, and that conversation does use the model.
- When the bot program shuts down, each bot makes one model call to save a summary of its conversation to memory, if there was a conversation.
- Idle check-ins that find nothing to do back off gradually, up to once every 10 minutes.
- A lower *effort* setting, or a smaller model (`claude-sonnet-5-5`, `claude-haiku-5-5`), is cheaper. You can turn *Autonomous* off per bot so it only acts when asked.

## Updating

1. Stop the bots (**Ctrl+C**, then **Y**) and the server (type `stop`).
2. In the project folder, run `git pull`. If you downloaded a ZIP, download the new ZIP instead and copy your `config\settings.json`, `config\secrets.json`, `config\characters\`, `data\` and `server\` folders into it.
3. Run **`setup.bat`** again. It installs any new dependencies and skips downloads you already have.
   - Or, in a terminal, run `npm install`.
   - In PowerShell, type `npm.cmd install` instead (see Troubleshooting).
4. Start the server and the bots as usual.

Your world, settings, API key and the bots' memories are kept.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot status *reconnecting*, "refused the connection" | Server not running, or wrong host/port in Settings. |
| "Kicked: You are not white-listed" / "outdated" | Turn off the whitelist, or check `server.properties`. Leave the Game version setting on `auto`. |
| "Kicked: … logged in from another location" | Two copies of the bot program are running, or a player uses the bot's name. |
| Bot ignores me | Your exact username must be in **Owners**, or enable *Listen to everyone*. |
| "Claude API key is invalid" | Re-enter the key in Settings and click Test connection. |
| "Cannot reach LM Studio" | LM Studio's server is not started, or it's on another PC without *Serve on Local Network*. |
| Mic button says it needs a secure page | Open the dashboard with `https://`, not `http://`. |
| Can't open the dashboard or join from another PC | Windows Firewall (section 3) or the network is set to *Public*. |
| PowerShell: `npm.ps1 cannot be loaded because running scripts is disabled` | Type `npm.cmd` instead of `npm` (e.g. `npm.cmd install`), or just run `setup.bat` / `start-bots.bat`, which don't need it. No system setting needs changing. |
| Bot acting confused or looping | Dashboard → Bots → **Reset conversation** (long-term memory is kept). |
| Bot keeps failing at something | It will ask for help after repeated failures. Give it a simpler goal, or check the Logs tab. |

Logs are in the `logs\` folder (one file per day) and on the dashboard's **Logs** tab.
