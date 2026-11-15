import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createProvider, describeLLMError, isRetryableLLMError } from '../llm/index.js';
import { skills, getSkill, describeState } from '../skills/index.js';
import { buildSystemPrompt, SUMMARY_REQUEST } from './prompt.js';

const STOP_WORDS = /^\s*(stop|halt|cancel|freeze|stay|wait)\b[\s!.]*$/i;
const LLM_BACKOFF_S = [2, 5, 15, 30, 60];

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
    this._wake = null;
    this._turnAbort = null;
    this._botChatTimes = [];

    this._onSettings = () => { this.provider = null; this.fatalLLMError = null; this.wake(); };
    settingsManager.on('change', this._onSettings);
  }

  get settings() { return this.sm.settings; }

  // ---------------------------------------------------------------- public API
  start() {
    if (this.running) return;
    this.running = true;
    this.loop().catch((e) => this.log.error('Agent loop crashed:', e));
  }

  async stop({ summarize = true } = {}) {
    this.running = false;
    this.abortAction('shutting down');
    this._turnAbort?.abort();
    this.wake();
    this.sm.off('change', this._onSettings);
    if (summarize) await this.compact('session ended').catch(() => {});
  }

  wake() {
    const w = this._wake;
    this._wake = null;
    w?.();
  }

  notify(text, { urgent = false } = {}) {
    this.events.push(`[${clock()}] ${text}`);
    if (this.events.length > 40) this.events.splice(0, this.events.length - 40);
    if (urgent && this.currentAction?.interruptible) this.abortAction('interrupted by: ' + text);
    this.wake();
  }

  /** A chat line addressed (possibly) to this bot. */
  onChat(from, text, { isBot = false, direct = false, source = 'game' } = {}) {
    const me = this.character.username;
    const mentioned = new RegExp(`\\b${escapeRe(me)}\\b`, 'i').test(text) || /\b(everyone|all bots|everybody)\b/i.test(text);
    if (isBot) {
      const policy = this.settings.agent?.botsTalkToBots || 'when-addressed';
      if (policy === 'never') return;
      if (policy === 'when-addressed' && !mentioned && !direct) return;
      // Rate-limit bot<->bot conversations so two bots can't chat forever.
      const now = Date.now();
      this._botChatTimes = this._botChatTimes.filter((t) => now - t < 60_000);
      if (this._botChatTimes.length >= 4) return;
      this._botChatTimes.push(now);
    }
    if (STOP_WORDS.test(text) && (mentioned || direct || this.manager.botUsernames().length <= 1 || /^\s*\w+\s*$/.test(text))) {
      this.abortAction(`${from} said stop`);
      this.goal = '';
      this.notify(`${from} told you to stop. You stopped your current action and dropped your goal. Wait for new instructions.`);
      this.idleUntil = Date.now() + 120_000; // don't wander off on your own right after being told to stop
      return;
    }
    const via = source === 'voice' ? ' (spoken)' : source === 'dashboard' ? ' (via dashboard)' : direct ? ' (whispered to you)' : '';
    const others = this.manager.botUsernames().filter((u) => u !== me);
    const addressedElsewhere = !mentioned && !direct && others.some((u) => new RegExp(`\\b${escapeRe(u)}\\b`, 'i').test(text));
    if (addressedElsewhere) return; // clearly for another bot
    this.notify(`${from}${via} says: "${text}"`, { urgent: !isBot });
  }

  setGoal(text) {
    this.goal = String(text || '').trim();
    this.notify(this.goal ? `Your owner set a new goal: ${this.goal}` : 'Your owner cleared your goal.', { urgent: true });
  }

  setAutonomous(on) {
    this.autonomous = Boolean(on);
    this.notify(on ? 'Autonomous mode ON: keep working on your goal on your own.' : 'Autonomous mode OFF: only act when someone asks you something.');
    this.runner.emitStatus();
  }

  abortAction(reason = 'aborted') {
    if (this.currentAction) {
      this.log.info(`Aborting ${this.currentAction.name}: ${reason}`);
      this.currentAction.controller.abort(new Error(reason));
    }
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
  async loop() {
    while (this.running) {
      const shouldThink = this.runner.isReady() && Date.now() >= this.blockedUntil && !this.fatalLLMError && (
        this.events.length > 0
        || (this.autonomous && Date.now() - this.lastThinkAt >= (this.settings.agent?.idleThinkSeconds ?? 45) * 1000
          && Date.now() >= (this.idleUntil || 0))
      );
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
    const ov = this.character.llm || {};
    if (this.usingFallback && this.settings.llm?.fallbackProvider && this.settings.llm.fallbackProvider !== 'none') {
      return this.settings.llm.fallbackProvider;
    }
    return ov.provider || this.settings.llm?.provider || 'anthropic';
  }

  getProvider() {
    if (!this.provider) {
      const name = this.providerName();
      const ov = this.character.llm || {};
      this.provider = createProvider(name, this.settings, this.sm, ov.provider && ov.provider !== name ? {} : ov);
      this.log.info(`Using LLM provider ${name}${this.provider.model ? ` (${this.provider.model})` : ''}`);
    }
    return this.provider;
  }

  /** One think-act cycle: observe -> LLM -> tools -> ... until the model stops calling tools. */
  async turn() {
    this.thinking = true;
    this.lastThinkAt = Date.now();
    this.runner.emitStatus();
    const turnAbort = new AbortController();
    this._turnAbort = turnAbort;
    try {
      if (!this.system) this.startConversation();
      this.history.push({ role: 'user', content: this.composeObservation(true) });

      const maxSteps = this.settings.agent?.maxStepsPerTurn ?? 12;
      for (let step = 0; step < maxSteps && this.running && this.runner.isReady(); step++) {
        const reply = await this.callLLM(turnAbort.signal);
        if (!reply) return; // LLM unavailable; events stay queued for later
        if (reply.text) this.emit('thought', reply.text);
        if (reply.thoughts) this.emit('thought', reply.thoughts.slice(0, 600));

        if (!reply.toolCalls.length) {
          // Final answer without tools. If someone just talked to us, say it out loud.
          if (reply.text && this._turnHadChat && !/^\(.*\)$/.test(reply.text)) await this.runner.say(reply.text);
          if (reply.stopReason?.startsWith?.('refusal')) this.log.warn(`Model refused: ${reply.stopReason}`);
          break;
        }

        const results = [];
        for (const call of reply.toolCalls) {
          if (!this.running) break;
          results.push(await this.runTool(call));
        }
        // Calls skipped because we stopped still need a result.
        for (const call of reply.toolCalls.slice(results.length)) {
          results.push({ id: call.id, name: call.name, content: 'Not executed (agent stopping).', isError: true });
        }
        this.history.push({ role: 'tool', results });
        const extra = this.composeFollowUp();
        if (extra) this.history.push({ role: 'user', content: extra });
      }
    } finally {
      this.thinking = false;
      this._turnAbort = null;
      this.lastThinkAt = Date.now();
      this.runner.emitStatus();
    }
    await this.maybeCompact();
  }

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
        this.history.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
        this.lastError = null;
        this.providerFailures = 0;
        return reply;
      } catch (err) {
        if (signal.aborted || !this.running) return null;
        const msg = describeLLMError(err);
        this.lastError = msg;
        this.log.warn(`LLM call failed (${provider.name}): ${msg}`);
        this.runner.emitStatus();
        this.providerFailures++;
        const fb = this.settings.llm?.fallbackProvider;
        if (!this.usingFallback && fb && fb !== 'none' && fb !== provider.name && this.providerFailures >= 2) {
          this.log.warn(`Switching to fallback provider ${fb}`);
          this.usingFallback = true;
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
        await sleep(LLM_BACKOFF_S[attempt] * 1000);
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
    const key = `${call.name}:${JSON.stringify(call.args || {})}`;
    const controller = new AbortController();
    const timeoutS = this.settings.agent?.actionTimeoutSeconds ?? 180;
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutS}s`)), timeoutS * 1000);
    this.currentAction = { name: call.name, args: call.args, controller, interruptible: Boolean(skill.interruptible), startedAt: Date.now() };
    this.runner.emitStatus();
    this.emit('thought', `→ ${call.name} ${shortArgs(call.args)}`);

    let content;
    let isError = false;
    try {
      const out = await skill.run(this.skillContext(controller.signal), call.args || {});
      content = String(out ?? 'Done.');
      this.failures.delete(key);
      this.consecutiveFailures = 0;
    } catch (err) {
      isError = true;
      const reason = controller.signal.aborted ? controller.signal.reason?.message || 'aborted' : null;
      content = reason ? `Stopped: ${reason}. ${err?.message && err.message !== 'Aborted' ? err.message : ''}`.trim() : `Failed: ${err?.message || err}`;
      if (!(err && err.name === 'SkillError') && !reason) this.log.warn(`Skill ${call.name} threw:`, err);
      const n = (this.failures.get(key) || 0) + 1;
      this.failures.set(key, n);
      this.consecutiveFailures++;
      if (n >= 2) content += `\nThis exact call has now failed ${n} times. Do NOT repeat it; try a different approach.`;
      if (this.consecutiveFailures >= 5) {
        content += '\nMany actions in a row have failed. Step back: look_around, rethink the plan, try something else, or ask your owner for help.';
      }
    } finally {
      clearTimeout(timer);
      this.currentAction = null;
      this.runner.emitStatus();
    }
    if (content.length > 1500) content = content.slice(0, 1500) + '…';
    this.emit('thought', `${isError ? '✗' : '✓'} ${call.name}: ${content.slice(0, 200)}`);
    if (this.consecutiveFailures >= 10) {
      // Truly stuck: pause autonomy for a while so we don't burn tokens, and ask for help.
      this.consecutiveFailures = 0;
      this.idleUntil = Date.now() + 5 * 60_000;
      this.runner.say("I'm stuck and keep failing at this. Could you help me out or give me a different task?").catch(() => {});
    }
    return { id: call.id, name: call.name, content, isError };
  }

  skillContext(signal) {
    return {
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
  startConversation(summary) {
    const otherBots = this.manager.botUsernames().filter((u) => u !== this.character.username);
    this.system = buildSystemPrompt({
      character: this.character,
      settings: this.settings,
      memoryText: this.memory.toPromptText(),
      otherBots,
      toolNames: skills.map((s) => s.name),
    });
    this.history = [];
    if (summary) this.events.unshift(`(Context: your memory was just refreshed. Summary of the conversation so far: ${summary})`);
    this.failures.clear();
  }

  composeObservation() {
    const lines = [];
    this._turnHadChat = this.events.some((e) => /says: "/.test(e));
    if (this.events.length) lines.push('EVENTS:\n' + this.events.join('\n'));
    this.events = [];
    lines.push('CURRENT GOAL: ' + (this.goal || `(none set) default: ${this.character.defaultGoal}`));
    if (!this.autonomous) lines.push('Autonomous mode is OFF: only respond to requests; do not start new projects on your own.');
    lines.push('SURROUNDINGS:\n' + safeDescribe(this.runner.bot, 'brief'));
    if (!this._turnHadChat && this.autonomous) lines.push('(Periodic check-in: continue your goal, or stop calling tools if there is nothing useful to do.)');
    return lines.join('\n\n');
  }

  /** Appended after tool results: new chat/events that arrived while acting, plus a tiny status line. */
  composeFollowUp() {
    const bot = this.runner.bot;
    const status = bot?.entity
      ? `[status] health ${Math.round(bot.health)}/20, food ${bot.food}/20, at ${fmtPos(bot.entity.position)}, ${isNight(bot) ? 'night' : 'day'}`
      : '[status] not connected';
    if (!this.events.length) return status;
    if (this.events.some((e) => /says: "/.test(e))) this._turnHadChat = true;
    const text = 'NEW EVENTS:\n' + this.events.join('\n') + '\n' + status;
    this.events = [];
    return text;
  }

  historyChars() {
    let n = this.system?.length || 0;
    for (const m of this.history) {
      n += (m.content?.length || 0) + (m.text?.length || 0);
      for (const c of m.toolCalls || []) n += JSON.stringify(c.args || {}).length + 40;
      for (const r of m.results || []) n += String(r.content).length + 40;
    }
    return n;
  }

  async maybeCompact() {
    const limit = this.settings.agent?.historyCompactAt ?? 60;
    const chars = this.provider?.maxContextChars ?? 200_000;
    if (this.history.length >= limit || this.historyChars() >= chars) await this.compact('context full');
  }

  /**
   * Replaces the whole conversation with a summary (stored in long-term memory). This is the only
   * way history is ever shortened: it is never trimmed in place.
   */
  async compact(reason) {
    if (reason === 'session ended' && this.history.length < 4) return;
    let summary = '';
    if (this.history.length >= 4 && this.provider) {
      try {
        const msgs = [...this.history, { role: 'user', content: SUMMARY_REQUEST }];
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 90_000);
        const res = await this.provider.chat({ system: this.system, messages: msgs, tools: this.toolDefs(), signal: ac.signal, toolChoice: 'none' });
        clearTimeout(t);
        summary = (res.text || '').trim();
      } catch (e) {
        this.log.warn('Could not summarise conversation:', describeLLMError(e));
      }
    }
    if (summary) {
      this.memory.addSessionSummary(summary);
      this.emit('thought', `(memory) ${summary.slice(0, 300)}`);
    }
    this.log.info(`Conversation compacted (${reason}); ${this.history.length} messages -> summary`);
    if (reason !== 'session ended') this.startConversation(summary || 'Earlier conversation was cleared.');
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
