import OpenAI from 'openai';

/**
 * LM Studio (or any OpenAI-compatible server) provider.
 *
 * Local models vary a lot in how well they call tools, so three modes are supported:
 *   native - send `tools`; the server parses tool calls (works with Qwen, Llama 3.1+, Mistral, ... in LM Studio)
 *   json   - describe the tools in the prompt and ask for a JSON block (works with almost any instruct model)
 *   auto   - start native, permanently switch to json if the server/model can't do native tools
 * In every mode, tool calls that the model writes as text (<tool_call>{...}</tool_call>, ```json blocks)
 * are recovered.
 */
export class OpenAICompatProvider {
  constructor({ baseUrl, apiKey, model, toolMode, temperature, maxTokens, contextTokens }) {
    this.name = 'lmstudio';
    this.baseUrl = baseUrl || 'http://127.0.0.1:1234/v1';
    this.model = model || '';
    this.toolMode = toolMode || 'auto';
    this.temperature = temperature ?? 0.4;
    this.maxTokens = maxTokens || 4096;
    this.client = new OpenAI({ baseURL: this.baseUrl, apiKey: apiKey || 'lm-studio', maxRetries: 2, timeout: 300_000 });
    // Leave room for the reply: compact when the prompt approaches ~70% of the context window.
    this.maxContextChars = Math.floor((contextTokens || 16384) * 0.7 * 3.2);
  }

  get effectiveMode() {
    return OpenAICompatProvider.jsonModeModels.has(this.model) ? 'json' : this.toolMode === 'auto' ? 'native' : this.toolMode;
  }

  async resolveModel() {
    if (this.model) return this.model;
    // Prefer the model that is actually loaded (LM Studio REST API); /v1/models may list every
    // downloaded model when just-in-time loading is on.
    try {
      const root = this.baseUrl.replace(/\/v1\/?$/, '');
      const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = (await res.json()).data || [];
        const loaded = data.find((m) => m.state === 'loaded' && m.type !== 'embeddings');
        if (loaded) return (this.model = loaded.id);
      }
    } catch { /* not LM Studio, or older version */ }
    const models = await this.listModels();
    const chat = models.filter((m) => !/embed/i.test(m));
    if (!chat.length) throw new Error(`LM Studio at ${this.baseUrl} has no model loaded. Load a model in LM Studio (Developer tab) first.`);
    this.model = chat[0];
    return this.model;
  }

  async listModels() {
    const list = await this.client.models.list();
    const out = [];
    for await (const m of list) out.push(m.id);
    return out;
  }

  toApiMessages(system, messages, mode, tools) {
    const sys = mode === 'json' ? `${system}\n\n${jsonToolInstructions(tools)}` : system;
    const out = [{ role: 'system', content: sys }];
    for (const m of messages) {
      if (m.role === 'user') out.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        if (mode === 'json') {
          const calls = (m.toolCalls || []).map((c) => ({ name: c.name, args: c.args }));
          const body = calls.length ? `${m.text ? m.text + '\n' : ''}\`\`\`json\n${JSON.stringify({ tool_calls: calls })}\n\`\`\`` : m.text || '(no reply)';
          out.push({ role: 'assistant', content: body });
        } else {
          const msg = { role: 'assistant', content: m.text || (m.toolCalls?.length ? '' : '(no reply)') };
          if (m.toolCalls?.length) {
            msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
          }
          out.push(msg);
        }
      } else if (m.role === 'tool') {
        if (mode === 'json') {
          out.push({ role: 'user', content: 'Tool results:\n' + m.results.map((r) => `- ${r.name}: ${r.isError ? 'FAILED: ' : ''}${r.content}`).join('\n') });
        } else {
          for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: `${r.isError ? 'FAILED: ' : ''}${r.content}` });
        }
      }
    }
    return mergeAdjacentUserMessages(out);
  }

  async chat({ system, messages, tools, signal, toolChoice }) {
    await this.resolveModel();
    let mode = this.effectiveMode;
    let res;
    try {
      res = await this.request(system, messages, tools, mode, signal, toolChoice);
    } catch (err) {
      // Some servers/models reject the `tools` parameter outright (but a 400 can also mean
      // "context too long", which must not flip the mode).
      const text = `${err?.message || ''} ${JSON.stringify(err?.error || '')}`;
      if (mode === 'native' && this.toolMode === 'auto' && err?.status === 400 && /tool|function|template|jinja/i.test(text)
        && !/context|too long|n_ctx|tokens/i.test(text)) {
        OpenAICompatProvider.jsonModeModels.add(this.model);
        mode = 'json';
        res = await this.request(system, messages, tools, mode, signal, toolChoice);
      } else throw err;
    }

    const choice = res.choices?.[0];
    const msg = choice?.message || {};
    let { text, thoughts } = splitThinking(msg.content || '');
    if (msg.reasoning_content) thoughts = [msg.reasoning_content, thoughts].filter(Boolean).join('\n');
    const known = new Set(tools.map((t) => t.name));
    let toolCalls = (msg.tool_calls || []).map((c, i) => ({
      id: c.id || `call_${Date.now()}_${i}`,
      name: c.function?.name,
      args: parseArgs(c.function?.arguments),
    })).filter((c) => c.name);

    if (!toolCalls.length) {
      const recovered = extractTextToolCalls(text, known);
      if (recovered.calls.length) {
        toolCalls = recovered.calls;
        text = recovered.rest;
        // The model writes tool calls as text: json mode will be more reliable from now on.
        if (mode === 'native' && this.toolMode === 'auto') OpenAICompatProvider.jsonModeModels.add(this.model);
      }
    }
    return {
      text: text.trim(),
      thoughts,
      toolCalls,
      stopReason: choice?.finish_reason || 'stop',
      raw: { provider: 'lmstudio', model: this.model },
      usage: res.usage,
    };
  }

  request(system, messages, tools, mode, signal, toolChoice) {
    const body = {
      model: this.model,
      messages: this.toApiMessages(system, messages, mode, tools),
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };
    if (mode === 'native') {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.params } }));
      body.tool_choice = toolChoice === 'none' ? 'none' : 'auto';
    }
    return this.client.chat.completions.create(body, { signal });
  }

  async test() {
    const model = await this.resolveModel();
    const res = await this.client.chat.completions.create({
      model, max_tokens: 400, messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
    });
    const { text } = splitThinking(res.choices?.[0]?.message?.content || '');
    return `Connected to LM Studio model ${model}: "${text.trim().slice(0, 40)}"`;
  }

  static describeError(err) {
    const code = err?.cause?.code || err?.code;
    if (code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed|Connection error/i.test(String(err?.message))) {
      return 'Cannot reach LM Studio. Start LM Studio, load a model, and start the server (Developer tab > Start Server). If LM Studio runs on another PC, enable "Serve on Local Network" and use that PC\'s IP.';
    }
    if (err?.status) return `LM Studio error ${err.status}: ${err.message}`;
    return null;
  }

  static isRetryable() {
    return true;
  }
}

OpenAICompatProvider.jsonModeModels = new Set();

function jsonToolInstructions(tools) {
  const lines = tools.map((t) => {
    const props = Object.entries(t.params?.properties || {})
      .map(([k, v]) => `${k}${(t.params.required || []).includes(k) ? '' : '?'}: ${v.type || 'any'}${v.enum ? ` (${v.enum.join('|')})` : ''}`)
      .join(', ');
    return `- ${t.name}(${props}): ${t.description}`;
  });
  return [
    'TOOLS - you act in the world ONLY by calling these tools:',
    ...lines,
    '',
    'To call tools, end your reply with exactly one fenced JSON block like:',
    '```json',
    '{"tool_calls": [{"name": "collect_block", "args": {"block": "oak_log", "count": 4}}]}',
    '```',
    'You may put one short sentence of reasoning before the block. Call one or two tools at a time.',
    'If you have nothing to do right now, reply without a JSON block.',
  ].join('\n');
}

function mergeAdjacentUserMessages(msgs) {
  const out = [];
  for (const m of msgs) {
    const prev = out.at(-1);
    if (prev && prev.role === 'user' && m.role === 'user') prev.content += '\n\n' + m.content;
    else out.push({ ...m });
  }
  return out;
}

function parseArgs(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return {}; }
}

/** Separates <think>...</think> reasoning (Qwen, DeepSeek, ...) from the visible reply. */
export function splitThinking(content) {
  let thoughts = '';
  let text = String(content).replace(/<think>([\s\S]*?)<\/think>/gi, (_, t) => { thoughts += t.trim() + '\n'; return ''; });
  // Unclosed <think> (reply cut off while thinking)
  const open = text.search(/<think>/i);
  if (open >= 0) { thoughts += text.slice(open + 7); text = text.slice(0, open); }
  return { text, thoughts: thoughts.trim() };
}

/** Recovers tool calls written as text by models that don't use native tool calling. */
export function extractTextToolCalls(text, known) {
  const calls = [];
  let rest = String(text || '');
  const push = (obj) => {
    const list = Array.isArray(obj?.tool_calls) ? obj.tool_calls : Array.isArray(obj) ? obj : [obj];
    for (const c of list) {
      const name = c?.name || c?.tool || c?.function?.name;
      const args = c?.args ?? c?.arguments ?? c?.parameters ?? c?.function?.arguments ?? {};
      if (known.has(name)) calls.push({ id: `call_${Date.now()}_${calls.length}`, name, args: parseArgs(args) });
    }
  };
  const patterns = [/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, /```(?:json)?\s*([\s\S]*?)```/gi];
  for (const re of patterns) {
    rest = rest.replace(re, (whole, inner) => {
      try { const before = calls.length; push(JSON.parse(inner)); return calls.length > before ? '' : whole; } catch { return whole; }
    });
  }
  if (!calls.length) {
    // Bare JSON object as the whole reply.
    const t = rest.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      try { push(JSON.parse(t)); if (calls.length) rest = ''; } catch { /* not JSON */ }
    }
  }
  return { calls, rest };
}
