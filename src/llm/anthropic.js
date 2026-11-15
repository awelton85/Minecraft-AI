import Anthropic from '@anthropic-ai/sdk';

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5']);
// Older models that reject output_config.effort.
const NO_EFFORT_MODELS = new Set(['claude-haiku-4-5', 'claude-sonnet-4-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

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
    this.client = new Anthropic({ apiKey, maxRetries: 3, timeout: 180_000 });
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
            type: 'tool_result', tool_use_id: r.id, content: String(r.content ?? ''), is_error: Boolean(r.isError),
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
        if (!content.length) content = [{ type: 'text', text: '(no reply)' }];
        out.push({ role: 'assistant', content });
      }
    }
    // Tool-result ids must match the (possibly sanitised) tool_use ids.
    for (const m of out) {
      if (m.role === 'user') for (const b of m.content) if (b.type === 'tool_result') b.tool_use_id = sanitizeId(b.tool_use_id);
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
      if (err instanceof Anthropic.BadRequestError && JSON.stringify(params.messages).includes('"thinking')) {
        params.messages = this.toApiMessages(messages, { stripThinking: true });
        res = await this.send(params, signal);
      } else {
        throw err;
      }
    }

    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const toolCalls = res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
    let stopReason = res.stop_reason;
    if (stopReason === 'refusal') stopReason = `refusal (${res.stop_details?.category || 'unspecified'})`;
    return {
      text,
      toolCalls,
      stopReason,
      raw: { provider: 'anthropic', model: this.model, content: res.content },
      usage: res.usage,
    };
  }

  send(params, signal) {
    const opts = { signal };
    return params.betas ? this.client.beta.messages.create(params, opts) : this.client.messages.create(params, opts);
  }

  async test() {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
    });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return `Connected to ${this.model}: "${text.slice(0, 40)}"`;
  }

  static describeError(err) {
    if (err instanceof Anthropic.AuthenticationError) return 'Claude API key is invalid (401). Check it on the Settings page.';
    if (err instanceof Anthropic.PermissionDeniedError) return 'Claude API key lacks permission for this model (403).';
    if (err instanceof Anthropic.NotFoundError) return 'Claude model not found (404). Check the model name in Settings.';
    if (err instanceof Anthropic.RateLimitError) return 'Claude API rate limit hit (429).';
    if (err instanceof Anthropic.BadRequestError) return `Claude API rejected the request (400): ${err.message}`;
    if (err instanceof Anthropic.APIConnectionError) return 'Cannot reach the Claude API (network problem).';
    if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ''}: ${err.message}`;
    return null;
  }

  static isRetryable(err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
      || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.BadRequestError) return false;
    return true;
  }
}

function sanitizeId(id) {
  const clean = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean || `call_${Math.random().toString(36).slice(2, 10)}`;
}
