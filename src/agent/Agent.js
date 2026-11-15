import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createProvider, describeLLMError, isRetryableLLMError } from '../llm/index.js';
import { isContextError } from '../llm/anthropic.js';
import { skills, getSkill, describeState } from '../skills/index.js';
import { buildSystemPrompt, SUMMARY_REQUEST } from './prompt.js';

const STOP_WORDS = /^(stop|halt|cancel|freeze|stay|wait|stop it|stop that)\b[\s!.]*$/i;
const LLM_BACKOFF_S = [2, 5, 15, 30, 60];
const CONTEXT = Symbol('context-full');
const MAX_CONTINUATIONS = 5;          // extra turns in a row when a task needs more than maxStepsPerTurn
const BOT_CHAT_BUDGET = 6;            // bot->bot replies allowed until a human speaks again
const PRIMARY_RETRY_MS = 10 * 60_000; // how long to stay on the fallback provider before re-trying the primary

/**
 * The thinking loop for one character. Receives events (chat, damage, ...), asks the LLM what to do
 * and executes the chosen skills. One Agent lives as long as its BotRunner (it survives reconnects).
 */
export class Agent extends EventEmitter {
  constructor({ runner, character, settingsManager, memory, manager, log }) {
    super();
    this.runner = runner;
    this.character = character;
    this.sm = settingsManager;
    this.memory = memory;
    this.manager = manager;
    this.log = log;

    this.history = [];          // neutral message list (see docs/ARCHITECTURE.md)
    this.system = null;         // frozen system prompt for the current conversation
    this.events = [];           // pending event lines for the next user message
    this.carrySummary = null;   // summary of the previous conversation, shown once in the next turn
    this.goal = '';             // current explicit goal ('' = default goal)
    this.autonomous = settingsManager.settings.agent?.autonomous ?? true;
    this.currentAction = null;  // { name, args, controller, interruptible, startedAt }
    this.running = false;
    this.thinking = false;
    this.lastThinkAt = 0;
    this.lastError = null;
    this.blockedUntil = 0;      // LLM back-off
    this.fatalLLMError = null;  // non-retryable (bad key, ...) until settings change
    this.failures = new Map();  // "name:args" -> count
    this.consecutiveFailures = 0;
    this.provider = null;
    this.providerFailures = 0;
    this.usingFallback = false;
    this.fallbackSince = 0;
    this.pendingReply = false;  // someone talked to us and hasn't been answered yet
    this.spokeThisTurn = false; // set by runner.say()
    this.continuePending = false;
    this.continuations = 0;
    this.idleBackoff = 1;       // multiplier on idleThinkSeconds; grows while idle check-ins find nothing to do
    this.idleUntil = 0;
    this.botChatBudget = BOT_CHAT_BUDGET;
    this._wake = null;
    this._turnAbort = null;
    this._stopTurn = false;
    this._botChatTimes = [];
    this._loopPromise = null;

    this._onSettings = () => {
      this.provider = null;
      this.fatalLLMError = null;
      this.usingFallback = false;
      this.blockedUntil = 0;
      // The system prompt holds owners/personality: a new conversation starts at the next turn if they changed.
      this.wake();
    };
    settingsManager.on('change', this._onSettings);
  }

  get settings() { return this.sm.settings; }
  get agentCfg() { return this.settings.agent || {}; }

  // ---------------------------------------------------------------- public API
  start() {
    if (this.running) return;
    this.running = true;
    this._loopPromise = this.loop().catch((e) => this.log.error('Agent loop crashed:', e));
  }

  /** Stops the loop; waits for the in-flight turn to unwind, then saves a session summary. */
  async stop({ summarize = true, summaryTimeoutMs = 15_000 } = {}) {
    this.running = false;
    this.hardStop('shutting down');
    this.wake();
    this.sm.off('change', this._onSettings);
    if (this._loopPromise) await Promise.race([this._loopPromise, sleep(10_000)]);
    if (summarize) await this.compact('session ended', { timeoutMs: summaryTimeoutMs }).catch(() => {});
  }

  wake() {
    const w = this._wake;
    this._wake = null;
    w?.();
  }

  /**
   * Queue an event for the model. `urgent` aborts an interruptible action (follow, explore, wait);
   * `abortAny` aborts whatever is running (owner talking, danger).
   */
  notify(text, { urgent = false, abortAny = false } = {}) {
    this.events.push(`[${clock()}] ${text}`);
    if (this.events.length > 40) this.events.splice(0, this.events.length - 40);
    if (abortAny || (urgent && this.currentAction?.interruptible)) this.abortAction('interrupted: ' + text.slice(0, 80), { interrupted: true });
    this.idleBackoff = 1;
    this.wake();
  }

  /** A chat line addressed (possibly) to this bot. */
  onChat(from, text, { isBot = false, direct = false, source = 'game' } = {}) {
    const me = this.character.username;
    const meRe = new RegExp(`\\b${escapeRe(me)}\\b`, 'i');
    const mentioned = meRe.test(text) || /\b(everyone|all bots|everybody)\b/i.test(text);
    if (isBot) {
      const policy = this.agentCfg.botsTalkToBots || 'when-addressed';
      if (policy === 'never') return;
      if (policy === 'when-addressed' && !mentioned && !direct) return;
      // Bots can't keep each other talking forever: a small budget that only a human refills,
      // plus a per-minute rate limit.
      const now = Date.now();
      this._botChatTimes = this._botChatTimes.filter((t) => now - t < 60_000);
      if (this._botChatTimes.length >= 4 || this.botChatBudget <= 0) return;
      this._botChatTimes.push(now);
      this.botChatBudget--;
    } else {
      this.botChatBudget = BOT_CHAT_BUDGET;
    }

    // "stop", "Steve_AI stop", "Steve, stop!" -> hard stop, no LLM round-trip needed.
    const bare = text.replace(meRe, '').replace(/\b(everyone|all bots|everybody)\b/ig, '').replace(/^[\s,:;!.-]+/, '').trim();
    const others = this.manager.botUsernames().filter((u) => u !== me);
    const addressedElsewhere = !mentioned && !direct && others.some((u) => new RegExp(`\\b${escapeRe(u)}\\b`, 'i').test(text));
    if (!isBot && STOP_WORDS.test(bare) && !addressedElsewhere) {
      this.hardStop(`${from} said stop`);
      this.goal = '';
      this.continuePending = false;
      this.notify(`${from} told you to stop. You stopped everything and dropped your goal. Wait for new instructions.`);
      this.idleUntil = Date.now() + 120_000; // don't wander off on your own right after being told to stop
      return;
    }
    if (addressedElsewhere) return; // clearly for another bot
    const via = source === 'voice' ? ' (spoken)' : source === 'dashboard' ? ' (via dashboard)' : direct ? ' (whispered to you)' : '';
    // A human talking to us takes priority over whatever we're doing.
    this.notify(`${from}${via} says: "${text}"`, { urgent: !isBot, abortAny: !isBot });
  }

  setGoal(text) {
    this.goal = String(text || '').trim();
    this.notify(this.goal ? `Your owner set a new goal: ${this.goal}` : 'Your owner cleared your goal.', { abortAny: true });
  }

  setAutonomous(on) {
    this.autonomous = Boolean(on);
    this.idleBackoff = 1;
    this.notify(on ? 'Autonomous mode ON: keep working on your goal on your own.' : 'Autonomous mode OFF: only act when someone asks you something.');
    this.runner.emitStatus();
  }

  abortAction(reason = 'aborted', { interrupted = false } = {}) {
    if (this.currentAction) {
      this.log.info(`Aborting ${this.currentAction.name}: ${reason}`);
      this.currentAction.interrupted = interrupted;
      this.currentAction.controller.abort(new Error(reason));
    }
  }

  /** Stop everything in this turn: the running skill, the remaining tool calls and any in-flight LLM call. */
  hardStop(reason) {
    this._stopTurn = true;
    this.abortAction(reason, { interrupted: true });
    this._turnAbort?.abort(new Error(reason));
    try { this.runner.bot?.pathfinder?.setGoal(null); this.runner.bot?.pvp?.stop(); this.runner.bot?.clearControlStates(); } catch { /* ignore */ }
  }

  /** Dashboard "Reset conversation": forget the current conversation (long-term memory is kept). */
  resetConversation() {
    this.hardStop('conversation reset');
    this.history = [];
    this.system = null;
    this.carrySummary = null;
    this.continuePending = false;
    this.pendingReply = false;
    this.failures.clear();
    this.consecutiveFailures = 0;
    this.fatalLLMError = null;
    this.blockedUntil = 0;
    this.log.info('Conversation reset from dashboard');
    this.runner.emitStatus();
  }

  status() {
    return {
      currentAction: this.currentAction ? `${this.currentAction.name} ${shortArgs(this.currentAction.args)}` : this.thinking ? '(thinking)' : null,
      goal: this.goal || null,
      autonomous: this.autonomous,
      provider: this.provider?.name || this.providerName(),
      model: this.provider?.model || null,
      lastError: this.fatalLLMError || this.lastError,
    };
  }

  // ---------------------------------------------------------------- main loop
  idleIntervalMs() {
    const base = Math.max(5, this.agentCfg.idleThinkSeconds ?? 45) * 1000;
    return Math.min(base * this.idleBackoff, 10 * 60_000);
  }

  /** With pauseWhenOwnerAway, idle check-ins (not replies) only happen while an owner is online. */
  ownerOnline() {
    if (this.agentCfg.pauseWhenOwnerAway === false) return true;
    const owners = (this.settings.owners || []).map((o) => o.toLowerCase());
    const players = Object.keys(this.runner.bot?.players || {}).map((p) => p.toLowerCase());
    return owners.some((o) => players.includes(o));
  }

  async loop() {
    while (this.running) {
      const now = Date.now();
      if (this.usingFallback && now - this.fallbackSince > PRIMARY_RETRY_MS) {
        this.log.info('Re-trying the primary LLM provider');
        this.usingFallback = false;
        this.provider = null;
      }
      const idleDue = this.autonomous && now - this.lastThinkAt >= this.idleIntervalMs() && now >= this.idleUntil && this.ownerOnline();
      const shouldThink = this.runner.isReady() && now >= this.blockedUntil && !this.fatalLLMError
        && (this.events.length > 0 || this.continuePending || idleDue);
      if (!shouldThink) {
        await new Promise((resolve) => {
          this._wake = resolve;
          setTimeout(resolve, 2000);
        });
        continue;
      }
      try {
        await this.turn();
      } catch (e) {
        this.log.error('Turn failed:', e);
        await sleep(3000);
      }
    }
  }

  providerName() {
    const fb = this.settings.llm?.fallbackProvider;
    if (this.usingFallback && fb && fb !== 'none') return fb;
    return this.character.llm?.provider || this.settings.llm?.provider || 'anthropic';
  }

  getProvider() {
    if (!this.provider) {
      const name = this.providerName();
      const ov = this.character.llm || {};
      // A character's model override applies only to the provider it was chosen for.
      const ownProvider = ov.provider || this.settings.llm?.provider;
      const useModel = ov.model && ownProvider === name && !this.usingFallback;
      this.provider = createProvider(name, this.settings, this.sm, useModel ? { model: ov.model } : {});
      this.log.info(`Using LLM provider ${name}${this.provider.model ? ` (${this.provider.model})` : ''}`);
    }
    return this.provider;
  }

  /** One think-act cycle: observe -> LLM -> tools -> ... until the model stops calling tools. */
  async turn() {
    this.thinking = true;
    this.lastThinkAt = Date.now();
    this._stopTurn = false;
    this.spokeThisTurn = false;
    const wasIdleCheck = this.events.length === 0 && !this.continuePending;
    const continuing = this.continuePending;
    this.continuePending = false;
    this.runner.emitStatus();
    const turnAbort = new AbortController();
    this._turnAbort = turnAbort;
    let usedTools = false;
    let hitStepCap = false;
    let refused = false;
    try {
      if (this.system && this.promptKey() !== this._promptKey) {
        // Owners / personality / other bots changed. Changing the system prompt means a new
        // conversation (that keeps Claude's thinking blocks and prompt cache valid).
        await this.compact('settings/profile changed');
      }
      if (!this.system) this.startConversation();

      const savedEvents = this.events;
      const observation = this.composeObservation(continuing);
      this.history.push({ role: 'user', content: observation });
      const turnStart = this.history.length;

      const maxSteps = Math.max(1, this.agentCfg.maxStepsPerTurn ?? 12);
      let step = 0;
      for (; step < maxSteps && this.running && this.runner.isReady() && !this._stopTurn; step++) {
        const reply = await this.callLLM(turnAbort.signal);
        if (reply === CONTEXT) {
          // The conversation no longer fits: summarise it and start over right away.
          if (this.history.length === turnStart) {
            this.history.pop();
            this.events = [...savedEvents, ...this.events];
          }
          await this.compact('context window full', { force: true });
          this.continuePending = true;
          return;
        }
        if (!reply) {
          if (this.history.length === turnStart) {
            // Nothing happened yet: put the observation's events back so the command isn't lost.
            this.history.pop();
            this.events = [...savedEvents, ...this.events];
          }
          return;
        }
        if (reply.thoughts) this.emit('thought', reply.thoughts.slice(0, 800));
        if (reply.text) this.emit('thought', reply.text);

        if (!reply.toolCalls.length) {
          if (reply.stopReason?.startsWith?.('refusal')) {
            this.log.warn(`Model refused: ${reply.stopReason}`);
            refused = true;
          }
          // Final text without tools: if someone is waiting for an answer and we haven't
          // talked this turn, say it out loud.
          if (reply.text && this.pendingReply && !this.spokeThisTurn && !/^\(.*\)$/s.test(reply.text)) {
            await this.runner.say(reply.text);
          }
          break;
        }

        usedTools = true;
        const results = [];
        for (const call of reply.toolCalls) {
          if (!this.running || this._stopTurn) {
            results.push({ id: call.id, name: call.name, content: 'Not executed: you were told to stop.', isError: true });
            continue;
          }
          results.push(await this.runTool(call));
        }
        this.history.push({ role: 'tool', results });
        const extra = this.composeFollowUp();
        if (extra) this.history.push({ role: 'user', content: extra });

        if (this.overBudget()) {
          await this.compact('context full', { force: true });
          this.continuePending = true;
          return;
        }
      }
      hitStepCap = step >= maxSteps;
    } finally {
      if (this.spokeThisTurn) this.pendingReply = false;
      this.thinking = false;
      this._turnAbort = null;
      this.lastThinkAt = Date.now();
      this.runner.emitStatus();
    }

    if (refused) {
      // A conversation that triggered a refusal tends to keep triggering it: start fresh.
      this.startConversation();
      this.carrySummary = 'The previous conversation was reset after the model declined a request.';
    }
    // Keep going on long tasks instead of going silent after maxStepsPerTurn.
    if (hitStepCap && !this._stopTurn && (this.goal || this.pendingReply || this.autonomous) && this.continuations < MAX_CONTINUATIONS) {
      this.continuations++;
      this.continuePending = true;
    } else if (!hitStepCap) {
      this.continuations = 0;
    }
    // Idle check-ins that find nothing to do get gradually rarer (up to 10 min); any work resets it.
    if (usedTools) this.idleBackoff = 1;
    else if (wasIdleCheck) this.idleBackoff = Math.min(this.idleBackoff * 2, 16);
    await this.maybeCompact();
  }

  /** Returns the reply, null (unavailable - try later) or CONTEXT (conversation too long). */
  async callLLM(signal) {
    let provider;
    try {
      provider = this.getProvider();
    } catch (e) {
      this.fatalLLMError = e.message;
      this.log.error(e.message);
      this.runner.emitStatus();
      return null;
    }
    const tools = this.toolDefs();
    for (let attempt = 0; ; attempt++) {
      try {
        const reply = await provider.chat({ system: this.system, messages: this.history, tools, signal });
        if (signal.aborted) return null;
        this.history.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
        this.lastError = null;
        this.providerFailures = 0;
        return reply;
      } catch (err) {
        if (signal.aborted || !this.running) return null;
        if (isContextError(err)) {
          this.log.warn('Conversation too long for the model - compacting.');
          return CONTEXT;
        }
        const msg = describeLLMError(err);
        this.lastError = msg;
        this.log.warn(`LLM call failed (${provider.name}): ${msg}`);
        this.runner.emitStatus();
        this.providerFailures++;
        const fb = this.settings.llm?.fallbackProvider;
        if (!this.usingFallback && fb && fb !== 'none' && fb !== provider.name && (this.providerFailures >= 2 || !isRetryableLLMError(provider, err))) {
          this.log.warn(`Switching to fallback provider ${fb} for a while`);
          this.usingFallback = true;
          this.fallbackSince = Date.now();
          this.provider = null;
          return this.callLLM(signal);
        }
        if (!isRetryableLLMError(provider, err)) {
          this.fatalLLMError = msg;
          this.runner.emitStatus();
          return null;
        }
        if (attempt >= 2) {
          // Give up for now; back off before the next turn.
          const wait = LLM_BACKOFF_S[Math.min(this.providerFailures, LLM_BACKOFF_S.length - 1)];
          this.blockedUntil = Date.now() + wait * 1000;
          return null;
        }
        await sleep(LLM_BACKOFF_S[attempt] * 1000, null, { signal }).catch(() => {});
        if (signal.aborted) return null;
      }
    }
  }

  toolDefs() {
    return skills.map((s) => ({ name: s.name, description: s.description, params: s.params }));
  }

  async runTool(call) {
    const skill = getSkill(call.name);
    if (!skill) {
      return { id: call.id, name: call.name, content: `Unknown tool "${call.name}". Available: ${skills.map((s) => s.name).join(', ')}`, isError: true };
    }
    const bot = this.runner.bot;
    // A reflex fight must not tug against a new non-combat action.
    if (call.name !== 'attack' && bot?.pvp?.target) { try { bot.pvp.stop(); } catch { /* ignore */ } }

    const key = `${call.name}:${JSON.stringify(call.args || {})}`;
    const controller = new AbortController();
    const timeoutS = Math.max(10, this.agentCfg.actionTimeoutSeconds ?? 180);
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutS}s`)), timeoutS * 1000);
    const action = { name: call.name, args: call.args, controller, interruptible: Boolean(skill.interruptible), startedAt: Date.now() };
    this.currentAction = action;
    this.runner.emitStatus();
    this.emit('thought', `→ ${call.name} ${shortArgs(call.args)}`);

    let content;
    let isError = false;
    let hang;
    try {
      // A skill that ignores its abort signal must not wedge the agent forever.
      const guard = new Promise((_, reject) => {
        hang = setTimeout(() => reject(new Error(`did not finish within ${timeoutS + 15}s`)), (timeoutS + 15) * 1000);
      });
      // Skills get a deadline a little before the hard timeout so they can stop cleanly and report progress.
      const deadline = Date.now() + Math.max(5, timeoutS - 10) * 1000;
      const out = await Promise.race([skill.run(this.skillContext(controller.signal, deadline), call.args || {}), guard]);
      content = String(out ?? 'Done.');
      this.failures.delete(key);
      this.consecutiveFailures = 0;
    } catch (err) {
      isError = true;
      const reason = controller.signal.aborted ? controller.signal.reason?.message || 'aborted' : null;
      content = reason ? `Stopped: ${reason}. ${err?.message && err.message !== 'Aborted' ? err.message : ''}`.trim() : `Failed: ${err?.message || err}`;
      if (!(err && err.name === 'SkillError') && !reason) this.log.warn(`Skill ${call.name} threw:`, err);
      if (!action.interrupted) {
        // Interruptions (someone talked, "stop") are not failures of the approach.
        const n = (this.failures.get(key) || 0) + 1;
        this.failures.set(key, n);
        this.consecutiveFailures++;
        if (n >= 2) content += `\nThis exact call has now failed ${n} times. Do NOT repeat it; try a different approach.`;
        if (this.consecutiveFailures >= 5) {
          content += '\nMany actions in a row have failed. Step back: look_around, rethink the plan, try something else, or ask your owner for help.';
        }
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(hang);
      if (this.currentAction === action) this.currentAction = null;
      this.runner.emitStatus();
    }
    if (content.length > 3000) content = content.slice(0, 3000) + '…';
    this.emit('thought', `${isError ? '✗' : '✓'} ${call.name}: ${content.slice(0, 200)}`);
    if (this.consecutiveFailures >= 10) {
      // Truly stuck: stop this turn, pause autonomy for a while so we don't burn tokens, and ask for help.
      this.consecutiveFailures = 0;
      this.idleUntil = Date.now() + 5 * 60_000;
      this._stopTurn = true;
      this.runner.say("I'm stuck and keep failing at this. Could you help me out or give me a different task?").catch(() => {});
    }
    return { id: call.id, name: call.name, content, isError };
  }

  skillContext(signal, deadline = Date.now() + 170_000) {
    return {
      deadline,
      timeLeftMs: () => Math.max(0, deadline - Date.now()),
      bot: this.runner.bot,
      mcData: this.runner.mcData,
      signal,
      log: (m) => this.log.debug(m),
      say: (t) => this.runner.say(t),
      memory: this.memory,
      settings: this.settings,
      character: this.character,
      manager: this.manager,
    };
  }

  // ---------------------------------------------------------------- context
  /** Everything the system prompt depends on except memory (memory refreshes at compaction). */
  promptKey() {
    const s = this.settings;
    return JSON.stringify([s.owners, s.listenToEveryone, this.character.username, this.character.personality,
      this.character.defaultGoal, this.manager.botUsernames()]);
  }

  startConversation() {
    this._promptKey = this.promptKey();
    const otherBots = this.manager.botUsernames().filter((u) => u !== this.character.username);
    this.system = buildSystemPrompt({
      character: this.character,
      settings: this.settings,
      memoryText: this.memory.toPromptText(),
      otherBots,
      toolNames: skills.map((s) => s.name),
    });
    this.history = [];
    this.failures.clear();
  }

  composeObservation(continuing = false) {
    const lines = [];
    if (this.carrySummary) {
      lines.push(`(Your conversation was just condensed to save memory. Summary of it: ${this.carrySummary})`);
      this.carrySummary = null;
    }
    if (this.events.some((e) => /says: "/.test(e))) this.pendingReply = true;
    if (this.events.length) lines.push('EVENTS:\n' + this.events.join('\n'));
    this.events = [];
    lines.push('CURRENT GOAL: ' + (this.goal || `(none set) default: ${this.character.defaultGoal}`));
    if (!this.autonomous) lines.push('Autonomous mode is OFF: only respond to requests; do not start new projects on your own.');
    lines.push('SURROUNDINGS:\n' + safeDescribe(this.runner.bot, 'brief'));
    if (continuing) lines.push('(Continue the task you were working on.)');
    else if (!this.pendingReply && this.autonomous) lines.push('(Periodic check-in: continue your goal, or stop calling tools if there is nothing useful to do.)');
    if (this.pendingReply) lines.push('(Someone is waiting for your reply - answer them with the chat tool.)');
    return lines.join('\n\n');
  }

  /** Appended after tool results: new chat/events that arrived while acting, plus a tiny status line. */
  composeFollowUp() {
    const bot = this.runner.bot;
    const status = bot?.entity
      ? `[status] health ${Math.round(bot.health)}/20, food ${bot.food}/20, at ${fmtPos(bot.entity.position)}, ${isNight(bot) ? 'night' : 'day'}`
      : '[status] not connected';
    if (!this.events.length) return status;
    if (this.events.some((e) => /says: "/.test(e))) this.pendingReply = true;
    const text = 'NEW EVENTS:\n' + this.events.join('\n') + '\n' + status;
    this.events = [];
    return text;
  }

  /** Approximate prompt size in characters, including the system prompt and tool definitions. */
  historyChars() {
    let n = (this.system?.length || 0) + JSON.stringify(this.toolDefs()).length;
    for (const m of this.history) {
      n += (m.content?.length || 0) + (m.text?.length || 0);
      for (const c of m.toolCalls || []) n += JSON.stringify(c.args || {}).length + 40;
      for (const r of m.results || []) n += String(r.content).length + 40;
    }
    return n;
  }

  overBudget() {
    const chars = this.provider?.maxContextChars ?? 200_000;
    return this.historyChars() >= chars;
  }

  async maybeCompact() {
    const limit = Math.max(10, this.agentCfg.historyCompactAt ?? 60);
    if (this.history.length >= limit || this.overBudget()) await this.compact('context full');
  }

  /**
   * Replaces the whole conversation with a summary (stored in long-term memory). This is the only
   * way history is ever shortened: it is never trimmed in place.
   */
  async compact(reason, { timeoutMs = 60_000 } = {}) {
    const ended = reason === 'session ended';
    if (ended && this.history.length < 4) return;
    let summary = '';
    if (this.history.length >= 4) {
      try {
        const provider = this.getProvider();
        // The history must end in a consistent state (every tool call answered).
        const msgs = [...this.history];
        const last = msgs.at(-1);
        if (last?.role === 'assistant' && last.toolCalls?.length) {
          msgs.push({ role: 'tool', results: last.toolCalls.map((c) => ({ id: c.id, name: c.name, content: 'Not executed.', isError: true })) });
        }
        msgs.push({ role: 'user', content: SUMMARY_REQUEST });
        const res = await provider.chat({ system: this.system, messages: msgs, tools: this.toolDefs(), signal: AbortSignal.timeout(timeoutMs), toolChoice: 'none' });
        summary = (res.text || '').trim();
      } catch (e) {
        this.log.warn('Could not summarise conversation:', isContextError(e) ? 'conversation too long' : describeLLMError(e));
      }
    }
    if (!summary && !ended) {
      // Last resort (e.g. the conversation is already too long to summarise): keep the essentials.
      summary = `Goal: ${this.goal || this.character.defaultGoal}. ${this.pendingReply ? 'Someone was waiting for your reply.' : ''}`.trim();
    }
    if (summary) {
      this.memory.addSessionSummary(summary);
      this.emit('thought', `(memory) ${summary.slice(0, 300)}`);
    }
    this.log.info(`Conversation compacted (${reason}); ${this.history.length} messages -> summary`);
    if (!ended) {
      this.startConversation();
      this.carrySummary = summary;
    }
    await this.memory.save().catch(() => {});
  }
}

function safeDescribe(bot, detail) {
  try {
    return bot?.entity ? describeState(bot, { detail }) : 'Not connected to the server.';
  } catch (e) {
    return `(could not describe surroundings: ${e.message})`;
  }
}

function isNight(bot) {
  const t = bot.time?.timeOfDay ?? 0;
  return t > 12_500 && t < 23_500;
}

function fmtPos(p) {
  return `${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`;
}

function clock() {
  return new Date().toTimeString().slice(0, 8);
}

function shortArgs(args) {
  const s = JSON.stringify(args || {});
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
