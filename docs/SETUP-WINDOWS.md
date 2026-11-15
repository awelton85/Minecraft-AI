# Setup guide: Windows 11 desktop (server + bots) and Windows 10 laptop (you)

The **desktop** runs three things:
- the Minecraft server
- the bot program, including the web dashboard
- optionally, LM Studio

The **laptop** runs Minecraft (you playing) and a browser for the dashboard and voice.

## 1. Desktop: install prerequisites

1. **Node.js 20 or newer**: install the LTS version from https://nodejs.org/ and keep the defaults.
2. **Java 25**: the Paper 26.1.2 server needs it. Open *Terminal* or *PowerShell* and run:
   ```powershell
   winget install EclipseAdoptium.Temurin.25.JDK
   ```
   You can also download the MSI from https://adoptium.net/ instead.
3. **Get this project**:
   - With git: `git clone https://github.com/awelton85/Minecraft-AI.git`
   - Without git: on GitHub use *Code → Download ZIP* and extract it, e.g. to `C:\Minecraft-AI`.

## 2. Desktop: create the Minecraft server

Double-click **`setup.bat`** in the project folder. It will:

1. run `npm install`, which downloads the bot libraries;
2. pick the newest Minecraft version the bots support (currently **26.1.2**), then download **Paper** and the **ViaVersion** plugin into `server\`;
3. ask you to accept the Minecraft EULA;
4. write `server\server.properties` and `server\start-server.bat`.

Optional flags: `setup.bat --ram 6G` (memory for the server) or `setup.bat --install-java` (installs Java via winget).

Start the server by double-clicking **`server\start-server.bat`**. Wait for `Done (…)! For help, type "help"`. The first start takes a minute while the world generates.

**Firewall**: the first time Java starts, Windows asks whether to allow it. Tick **Private networks**. If you missed the prompt, run this in an *Administrator* PowerShell:
```powershell
New-NetFirewallRule -DisplayName "Minecraft Server" -Direction Inbound -Protocol TCP -LocalPort 25565 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "Minecraft AI Dashboard" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```
Make sure your home network is set to **Private** (Settings → Network & Internet → your connection → *Private network*).

Find the desktop's IP address with `ipconfig` and look for "IPv4 Address", e.g. `192.168.1.20`. Setting a DHCP reservation for the desktop in your router keeps this address from changing.

## 3. Desktop: start the bots

Double-click **`start-bots.bat`**. The console prints lines such as:
```
Dashboard: https://192.168.1.20:3000
Connecting to 127.0.0.1:25565 as Steve_AI...
Spawned in world (Minecraft 26.1) at ...
```
The window restarts the program automatically if it ever crashes. To stop it cleanly, press **Ctrl+C**; the bots save their memories first.

`server.host` in Settings stays `127.0.0.1`, because the bots run on the same PC as the server.

## 4. Configure from the dashboard

On the laptop (or the desktop), open `https://<desktop-ip>:3000`.

The browser warns that the certificate isn't trusted. It's a self-signed certificate made for your PC, so click **Advanced → Continue/Proceed**. HTTPS is what allows the browser to use your microphone.

Under **Settings → General**:
- **Owners**: your Minecraft username (exactly as in game). The bots only obey owners.
- **LLM provider**:
  - *Claude API*: paste your API key from https://console.anthropic.com/ and click **Save key**, then **Test connection**.
  - *LM Studio*: see section 6.
- Click **Save settings**.

Under **Settings → Characters** you can edit `Steve_AI`'s personality and voice, or add more bots. Each bot needs a unique Minecraft username of 3–16 characters (letters, digits, `_`).

## 5. Laptop: join the game

Open the Minecraft Launcher and play your normal latest version (26.3), then go to **Multiplayer → Add Server** with address `<desktop-ip>`. ViaVersion translates between your 26.3 client and the 26.1.2 server.

If you ever see block or item glitches, you can instead create a launcher installation for exactly **26.1.2** and join with that.

Talk to the bot in chat: `Steve_AI follow me`, `Steve_AI get 10 oak logs and make a crafting table`, or `stop`.

## 6. Using LM Studio (local models)

1. Install LM Studio on the desktop (or another PC) and download a model that's good at **tool / function calling**. Recent Qwen instruct models in the 7B–32B range work well, as do Llama 3.1+ instruct and Mistral Small. Larger models plan better.
2. Load the model with a context length of at least **16384**.
3. Go to the **Developer** tab and click **Start Server**. The default address is `http://127.0.0.1:1234`.
   - If LM Studio runs on a *different* PC from the bots, enable **Serve on Local Network** and use that PC's IP in the dashboard, e.g. `http://192.168.1.30:1234/v1`.
4. On the dashboard, open **Settings → LLM provider → LM Studio**, click **Refresh models**, pick the model (leave it blank to use whatever is loaded), then **Test connection** and **Save**.
5. Set **Tool mode** to *auto*. If the model often "talks about" actions instead of doing them, set it to *json*.
6. Set *Context tokens* to match what you loaded the model with.

**Fallback provider**: choose LM Studio as the fallback while using Claude (or the other way around). The bots then switch over automatically if the primary provider keeps failing, for example when the internet is down.

## 7. Voice

On the dashboard **Chat & Voice** tab (Chrome or Edge):
- **Mic**: hold it to talk, or click once to toggle. The text is sent to the selected bot.
- **Hands-free**: listens continuously and only sends sentences that start with a wake word, i.e. a bot name (`Steve, come here`) or `everyone …`. You can add extra wake words.
- **Speak bot replies**: the bots' chat is read aloud. Each character can have its own voice, rate and pitch (Settings → Characters → Voice → *Preview*). Windows' built-in voices appear in the list. More can be added under Windows *Settings → Time & language → Speech*.

Speech recognition in Chrome and Edge is done by Google or Microsoft online services, so it needs internet access.

## 8. Multiple bots

Add characters in **Settings → Characters**. They appear in game when started (Bots tab → Start, or Start all). Each has its own memory file.

Address them by name in chat. `everyone …` goes to all of them. Bot-to-bot chat only happens when one names the other, and it is rate-limited.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot status *reconnecting*, "refused the connection" | Server not running, or wrong host/port in Settings. |
| "Kicked: You are not white-listed" / "outdated" | Turn off the whitelist, or check `server.properties`. Leave the Game version setting on `auto`. |
| Bot ignores me | Your exact username must be in **Owners**, or enable *Listen to everyone*. |
| "Claude API key is invalid" | Re-enter the key in Settings and click Test connection. |
| "Cannot reach LM Studio" | LM Studio's server is not started, or it's on another PC without *Serve on Local Network*. |
| Mic button says it needs a secure page | Open the dashboard with `https://`, not `http://`. |
| Laptop can't open the dashboard or server | Windows Firewall (section 2) or the network is set to *Public*. |
| Bot keeps failing at something | It will ask for help after repeated failures. Give it a simpler goal, or check the Logs tab. |

Logs are in the `logs\` folder and on the dashboard's **Logs** tab.
