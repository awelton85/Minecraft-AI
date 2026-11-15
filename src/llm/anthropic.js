import Anthropic from '@anthropic-ai/sdk';

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5']);
// Older models that reject output_config.effort.
const NO_EFFORT_MODELS = new Set(['claude-haiku-4-5', 'claude-sonnet-4-5']);
// Models with adaptive thinking (we ask for summarised thinking so the dashboard can show reasoning).
const ADAPTIVE_RE = /^claude-(opus|sonnet|haiku|fable|mythos)-(5|4-[6-9])/;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const DROP_BEFORE_FALLBACK = new Set(['thinking', 'redacted_thinking', 'connector_text', 'tool_use']);

/**
 * Claude API provider using the official SDK.
 *
 * History rules that keep Claude's thinking blocks valid and the prompt cache warm:
 *  - the system prompt and tool list are frozen for a conversation (the Agent guarantees this),
 *  - the history is append-only; when it grows too long the Agent replaces the WHOLE history
 *    with a summary (never trims from the middle/front),
 *  - assistant turns are replayed with their raw content blocks, unchanged.
 */
export class AnthropicProvider {
  constructor({ apiKey, model, effort, maxTokens, refusalFallback }) {
    if (!apiKey) throw new Error('No Anthropic API key set. Add it on the dashboard Settings page (or set ANTHROPIC_API_KEY).');
    this.name = 'anthropic';
    this.model = model || 'claude-opus-5-5';
    this.effort = effort || 'medium';
    this.maxTokens = maxTokens || 16000;
    this.useFallback = refusalFallback !== false && FALLBACK_MODELS.has(this.model);
    // Streaming requests: no HTTP timeout pressure even at high effort. Few SDK retries because
    // the Agent has its own retry/back-off and every retry may be billed.
    this.client = new Anthropic({ apiKey, maxRetries: 1, timeout: 600_000 });
    // Rough budget (in characters) before the Agent compacts the conversation.
    this.maxContextChars = 300_000;
  }

  toApiMessages(messages, { stripThinking = false } = {}) {
    const out = [];
    for (const m of messages) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: [{ type: 'text', text: m.content || '(no message)' }] });
      } else if (m.role === 'tool') {
        out.push({
          role: 'user',
          content: m.results.map((r) => ({
            type: 'tool_result', tool_use_id: sanitizeId(r.id), content: String(r.content ?? ''), is_error: Boolean(r.isError),
          })),
        });
      } else if (m.role === 'assistant') {
        let content;
        if (m.raw?.provider === 'anthropic' && m.raw.model === this.model && Array.isArray(m.raw.content)) {
          content = m.raw.content.filter((b) => {
            if (stripThinking && (b.type === 'thinking' || b.type === 'redacted_thinking')) return false;
            if (!this.useFallback && b.type === 'fallback') return false;
            return true;
          });
        } else {
          // Written by another provider/model: rebuild from the neutral form.
          content = [];
          if (m.text) content.push({ type: 'text', text: m.text });
          for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: sanitizeId(c.id), name: c.name, input: c.args || {} });
        }
        if (!content.some((b) => b.type !== 'fallback' && b.type !== 'thinking' && b.type !== 'redacted_thinking')) {
          content = [...content, { type: 'text', text: '(no reply)' }];
        }
        out.push({ role: 'assistant', content });
      }
    }
    return out;
  }

  async chat({ system, messages, tools, signal, toolChoice }) {
    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.params })),
      messages: this.toApiMessages(messages),
      cache_control: { type: 'ephemeral' },
    };
    if (toolChoice === 'none') params.tool_choice = { type: 'none' };
    if (ADAPTIVE_RE.test(this.model)) params.thinking = { type: 'adaptive', display: 'summarized' };
    if (!NO_EFFORT_MODELS.has(this.model)) params.output_config = { effort: this.effort };
    if (this.useFallback) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = 'default';
    }

    let res;
    try {
      res = await this.send(params, signal);
    } catch (err) {
      // A 400 on a replayed history is usually a thinking-block binding problem (e.g. the model
      // was changed mid-conversation). Removing every thinking block is always allowed.
      if (err instanceof Anthropic.BadRequestError && !isContextError(err) && JSON.stringify(params.messages).includes('"thinking')) {
        params.messages = this.toApiMessages(messages, { stripThinking: true });
        res = await this.send(params, signal);
      } else {
        throw err;
      }
    }

    // Server-side refusal fallback: content produced before the final `fallback` block came from a
    // model that declined. Its client tool calls and thinking are dropped (and never executed);
    // the fallback block itself stays in place for replay.
    let content = res.content;
    const lastFb = content.map((b) => b.type).lastIndexOf('fallback');
    if (lastFb >= 0) content = content.filter((b, i) => i >= lastFb || !DROP_BEFORE_FALLBACK.has(b.type));
    const after = content.slice(content.map((b) => b.type).lastIndexOf('fallback') + 1);

    const text = after.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const thoughts = after.filter((b) => b.type === 'thinking' && b.thinking).map((b) => b.thinking).join('\n').trim();
    const toolCalls = after.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
    let stopReason = res.stop_reason;
    if (stopReason === 'refusal') {
      stopReason = `refusal (${res.stop_details?.category || 'unspecified'})`;
      // Partial output from a refusal is incomplete; discard it.
      return { text: '', thoughts: '', toolCalls: [], stopReason, raw: { provider: 'anthropic', model: this.model, content: [] }, usage: res.usage };
    }
    return {
      text,
      thoughts,
      toolCalls,
      stopReason,
      raw: { provider: 'anthropic', model: this.model, content },
      usage: res.usage,
    };
  }

  /** Streams the response (no timeout issues at high effort) and returns the final message. */
  send(params, signal) {
    const opts = { signal };
    const stream = params.betas ? this.client.beta.messages.stream(params, opts) : this.client.messages.stream(params, opts);
    return stream.finalMessage();
  }

  async test() {
    const params = { model: this.model, max_tokens: 2048, messages: [{ role: 'user', content: 'Reply with just the word OK.' }] };
    if (!NO_EFFORT_MODELS.has(this.model)) params.output_config = { effort: 'low' };
    const res = await this.client.messages.create(params);
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return `Connected to ${this.model}: "${text.slice(0, 40) || '(empty reply)'}"`;
  }

  static describeError(err) {
    if (!(err instanceof Anthropic.APIError)) return null;
    const detail = err.error?.error?.message || err.message;
    if (err instanceof Anthropic.AuthenticationError) return 'Claude API key is invalid (401). Check it on the Settings page.';
    if (err instanceof Anthropic.PermissionDeniedError) return `Claude API key lacks permission for this model (403): ${detail}`;
    if (err instanceof Anthropic.NotFoundError) return `Claude model not found (404). Check the model name in Settings. ${detail}`;
    if (err instanceof Anthropic.RateLimitError) return 'Claude API rate limit hit (429).';
    if (err instanceof Anthropic.BadRequestError) return `Claude API rejected the request (400): ${detail}`;
    if (err instanceof Anthropic.APIConnectionError) return 'Cannot reach the Claude API (network problem).';
    return `Claude API error ${err.status ?? ''}: ${detail}`;
  }

  static isRetryable(err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
      || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.BadRequestError) return false;
    return true;
  }
}

/** True when the request failed because the conversation is too long for the model. */
export function isContextError(err) {
  const msg = `${err?.error?.error?.message || ''} ${err?.message || ''}`;
  return /prompt is too long|context length|context window|maximum context|too many tokens|n_ctx|exceeds the (available )?context|context size/i.test(msg);
}

function sanitizeId(id) {
  const clean = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean || 'call_missing_id';
}
