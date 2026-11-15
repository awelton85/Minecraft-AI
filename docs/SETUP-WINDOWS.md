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
3. **Get this project**:
   - With git: `git clone https://github.com/awelton85/Minecraft-AI.git`
   - Without git: on GitHub use *Code → Download ZIP* and extract it, e.g. to `C:\Minecraft-AI`.

## 2. Host PC: create the Minecraft server

Double-click **`setup.bat`** in the project folder. It will:

1. run `npm install`, which downloads the bot libraries;
2. pick the newest Minecraft version the bots support (currently **26.1.2**), then download **Paper** and the **ViaVersion** plugin into `server\`;
3. ask you to accept the Minecraft EULA;
4. write `server\server.properties` and `server\start-server.bat`.

Optional flags: `setup.bat --ram 6G` (memory for the server) or `setup.bat --install-java` (installs Java via winget).

**Already have a server?** You can point the bots at it instead. In Settings, set *Server connection* to its address and port. The server needs `online-mode=false` (see Security in the README) and a version the bots support, 26.1.x or older. A newer server should also work with the ViaVersion and ViaBackwards plugins installed (untested).

Start the server by double-clicking **`server\start-server.bat`**. Wait for `Done (…)! For help, type "help"`. The first start takes a minute while the world generates.

## 3. Host PC: allow network access

*Skip this section if you play on the host PC itself.*

The first time Java starts, Windows asks whether to allow it. Tick **Private networks**. If you missed the prompt, run this in an *Administrator* PowerShell:
```powershell
New-NetFirewallRule -DisplayName "Minecraft Server" -Direction Inbound -Protocol TCP -LocalPort 25565 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "Minecraft AI Dashboard" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```
Make sure your home network is set to **Private** (Settings → Network & Internet → your connection → *Private network*).

Find the host PC's IP address with `ipconfig` and look for "IPv4 Address", e.g. `192.168.1.20`. This guide calls it `<host-ip>`. Setting a DHCP reservation in your router keeps this address from changing.

## 4. Host PC: start the bots

Double-click **`start-bots.bat`**. The console prints lines such as:
```
Dashboard: https://192.168.1.20:3000
Connecting to 127.0.0.1:25565 as Steve_AI...
Spawned in world (Minecraft 26.1) at ...
```
The window restarts the program automatically if it ever crashes. To stop it cleanly, press **Ctrl+C**; the bots save their memories first.

Leave *Server connection → host* at `127.0.0.1` when the bots run on the same PC as the server.

## 5. Configure from the dashboard

On any device on your network, open `https://<host-ip>:3000` (or `https://localhost:3000` on the host PC).

The browser warns that the certificate isn't trusted. It's a self-signed certificate made for your PC, so click **Advanced → Continue/Proceed**. HTTPS is what allows the browser to use your microphone.

Under **Settings → General**:
- **Owners**: your Minecraft username (exactly as in game). The bots only obey owners.
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
3. Go to the **Developer** tab and click **Start Server**. The default address is `http://127.0.0.1:1234`.
   - If LM Studio runs on a *different* PC from the bots, enable **Serve on Local Network** and use that PC's IP in the dashboard, e.g. `http://192.168.1.30:1234/v1`.
4. On the dashboard, open **Settings → LLM provider → LM Studio**, click **Refresh models**, pick the model (leave it blank to use whatever is loaded), then **Test connection** and **Save**.
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

- **Pause idle check-ins while no owner is online** (on by default): bots only think on their own while you're in the game.
- Idle check-ins that find nothing to do back off gradually, up to once every 10 minutes.
- A lower *effort* setting, or a smaller model (`claude-sonnet-5-5`, `claude-haiku-5-5`), is cheaper. You can turn *Autonomous* off per bot so it only acts when asked.

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
| Bot acting confused or looping | Dashboard → Bots → **Reset conversation** (long-term memory is kept). |
| Bot keeps failing at something | It will ask for help after repeated failures. Give it a simpler goal, or check the Logs tab. |

Logs are in the `logs\` folder (one file per day) and on the dashboard's **Logs** tab.
