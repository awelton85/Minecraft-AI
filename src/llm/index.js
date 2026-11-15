import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai.js';

export const PROVIDERS = ['anthropic', 'lmstudio'];

/**
 * Creates a provider from settings. `override` = character-level { provider, model }.
 * Providers are cheap to construct, so the Agent builds a fresh one whenever settings change.
 */
export function createProvider(name, settings, settingsManager, override = {}) {
  const llm = settings.llm || {};
  if (name === 'anthropic') {
    const cfg = llm.anthropic || {};
    return new AnthropicProvider({
      apiKey: settingsManager.getSecret('anthropicApiKey'),
      model: override.model || cfg.model,
      effort: cfg.effort,
      maxTokens: cfg.maxTokens,
      refusalFallback: cfg.refusalFallback,
    });
  }
  if (name === 'lmstudio') {
    const cfg = llm.lmstudio || {};
    return new OpenAICompatProvider({
      baseUrl: cfg.baseUrl,
      apiKey: settingsManager.getSecret('lmstudioApiKey'),
      model: override.model || cfg.model,
      toolMode: cfg.toolMode,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      contextTokens: cfg.contextTokens,
    });
  }
  throw new Error(`Unknown LLM provider "${name}" (use one of: ${PROVIDERS.join(', ')})`);
}

export function describeLLMError(err) {
  return AnthropicProvider.describeError(err) || OpenAICompatProvider.describeError(err) || err?.message || String(err);
}

export function isRetryableLLMError(provider, err) {
  if (err?.name === 'AbortError') return false;
  if (provider?.name === 'anthropic') return AnthropicProvider.isRetryable(err);
  return true;
}
