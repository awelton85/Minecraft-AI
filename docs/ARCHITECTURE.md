# Architecture & internal contracts

Node.js (ESM, plain JavaScript, Node >= 20). No build step. Runs on Windows 10/11.

```
src/
  index.js              entry: load settings, start BotManager + web dashboard
  config.js             SettingsManager (settings.json, characters/*.json, secrets.json)
  log.js                tiny logger -> console + EventEmitter (dashboard log stream)
  bot/BotManager.js     owns one BotRunner per enabled character
  bot/BotRunner.js      mineflayer connection, plugins, reflexes, auto-reconnect, owns an Agent
  agent/Agent.js        LLM loop: events -> observation -> LLM -> tool calls -> skills
  agent/prompt.js       system prompt builder
  llm/index.js          createProvider(name, settings, secrets)
  llm/anthropic.js      Claude API (official @anthropic-ai/sdk)
  llm/openai.js         LM Studio (OpenAI-compatible /v1 endpoint) incl. JSON fallback tool mode
  memory/MemoryStore.js per-character persistent memory (data/memory/<name>.json)
  skills/index.js       registry of every tool the LLM can call
  skills/*.js           skill implementations (mineflayer)
  skills/observe.js     describeState(): compact text snapshot of the world for the LLM
  web/server.js         express + ws dashboard (settings, chat, voice, memory, logs)
  web/public/*          dashboard front-end (vanilla JS, no build)
scripts/setup-server.mjs  downloads + configures a Paper server compatible with Mineflayer
```

## Skill contract (`src/skills/`)

`src/skills/index.js` exports:

```js
export const skills = [ /* Skill objects */ ];
export function getSkill(name) { /* -> Skill | undefined */ }
export { describeState } from './observe.js';
```

A Skill:

```js
{
  name: 'collect_block',                       // snake_case, unique
  description: 'Mine N blocks of a type ...',  // written FOR the LLM: when to use it, what it returns
  params: {                                    // JSON Schema (type: object), used directly as tool input_schema
    type: 'object',
    properties: { block: { type: 'string', description: '...' }, count: { type: 'integer', minimum: 1 } },
    required: ['block'],
    additionalProperties: false
  },
  run: async (ctx, args) => 'Collected 5 oak_log. Inventory now has 7 oak_log.'
}
```

* `run` returns a short **string** describing the outcome (the LLM reads it). Keep it under ~600 chars.
* On failure `throw new SkillError('Could not find any iron_ore within 64 blocks. Try exploring or mining deeper (y < 16).')`
  (`SkillError` exported from `src/skills/util.js`). Messages should help the model choose a different approach.
* Skills MUST honour `ctx.signal` (an `AbortSignal`): when aborted, stop pathfinding/digging/combat promptly
  (`bot.pathfinder.stop()`, `bot.stopDigging()`, `bot.pvp.stop()`, clear control states) and throw `SkillError('Aborted')`.
* Skills must never hang: every await on the world is bounded by a timeout. Movement uses a stuck watchdog
  (no meaningful progress for `ctx.settings.agent.stuckSeconds` -> try to unstick once (jump/dig obstacle/step back), then fail).
* Skills must not load plugins; `BotRunner` loads: mineflayer-pathfinder, mineflayer-collectblock, mineflayer-pvp,
  mineflayer-tool, mineflayer-auto-eat, mineflayer-armor-manager.

`ctx` passed to every skill:

| field | type | meaning |
|---|---|---|
| `bot` | mineflayer Bot | the connected bot (spawned) |
| `mcData` | minecraft-data | for `bot.version` |
| `signal` | AbortSignal | aborted when the user says stop / a new urgent command arrives / timeout |
| `log(msg)` | fn | debug log line |
| `say(text)` | async fn | send in-game chat as this bot (handles splitting/length) |
| `memory` | MemoryStore | see below |
| `settings` | object | merged settings (read only) |
| `character` | object | the character profile |
| `manager` | BotManager | e.g. to find the other AI bots' usernames (`manager.botUsernames()`) |

## MemoryStore contract (`src/memory/MemoryStore.js`)

```js
const mem = new MemoryStore(characterName)   // file: data/memory/<characterName>.json
await mem.load(); await mem.save();          // save is debounced internally too
mem.addFact(text)            -> id           // long-lived facts ("owner prefers oak", "base is at ...")
mem.removeFact(idOrText)     -> boolean
mem.setPlace(name, {x,y,z,dimension,note})
mem.getPlace(name)           -> place | undefined   (case-insensitive)
mem.listPlaces()             -> [{name, x,y,z, dimension, note}]
mem.removePlace(name)        -> boolean
mem.addSessionSummary(text)
mem.recordDeath({x,y,z,dimension,cause})
mem.toPromptText()           -> string (compact memory section for the system prompt)
mem.data                     -> raw object (dashboard editor)
```

## BotManager contract (used by the web dashboard)

`BotManager` is an `EventEmitter`.

```js
manager.list()  -> [{ name, username, enabled, status }]
  status = { connection: 'stopped'|'connecting'|'connected'|'reconnecting'|'error',
             health, food, position: {x,y,z}|null, dimension, currentAction, goal,
             autonomous, provider, model, lastError, reconnectAttempts }
await manager.start(name) / stop(name) / restart(name)
await manager.startAll() / stopAll()
manager.sendMessage(target /* name | 'all' */, text, from /* 'dashboard' | 'voice' */)
manager.setAutonomous(name, bool)
manager.stopAction(name)
manager.setGoal(name, text)
manager.getMemory(name) -> object ; await manager.saveMemory(name, object) ; await manager.clearMemory(name)
await manager.testProvider(providerName) -> { ok, message }
await manager.listModels('lmstudio') -> [modelId]
manager.botUsernames() -> [username]

events:
  'log'    { ts, bot|null, level: 'debug'|'info'|'warn'|'error', msg }
  'chat'   { ts, bot /* receiving/sending character or null */, from, text, kind: 'player'|'bot'|'system' }
  'speech' { ts, bot, text, voice: {name, rate, pitch} }     // text the dashboard should speak (TTS)
  'thought'{ ts, bot, text }                                  // model's reasoning text / tool calls summary
  'status' { bot, status }
```

## SettingsManager contract (`src/config.js`)

```js
const sm = new SettingsManager(rootDir); await sm.load();
sm.settings                       // merged default + user settings
sm.characters                     // { [name]: profile }
await sm.saveSettings(patch)      // deep-merge patch, write config/settings.json, emit 'change'
await sm.saveCharacter(profile)   // write config/characters/<name>.json
await sm.deleteCharacter(name)
sm.secretsStatus()                // { anthropicApiKey: boolean }
await sm.setSecret(key, value)    // config/secrets.json (never sent back to the browser)
sm.getSecret(key)                 // falls back to env (ANTHROPIC_API_KEY)
```

## Internal LLM message format (`src/llm/`)

Provider-neutral so a conversation can continue when the user switches provider:

```js
{ role: 'user', content: 'text' }
{ role: 'assistant', text: '...', toolCalls: [{ id, name, args }], raw: { provider, model, content } }
{ role: 'tool', results: [{ id, name, content: 'string', isError: bool }] }
provider.chat({ system, messages, tools: [{name, description, params}], signal })
  -> { text, toolCalls, raw, stopReason, usage }
```
