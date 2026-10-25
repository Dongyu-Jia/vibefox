import type { AgentConfig } from '../core/body.ts';
import type { SecretStore } from '../core/secrets.ts';
import { AnthropicModel } from './anthropic.ts';
import { OpenAICompatModel } from './openaiCompat.ts';
import type { ChatMessage, ChatModel, ChatRequest } from './types.ts';

export * from './types.ts';

export type Provider = 'openrouter' | 'anthropic' | 'deepseek';

export function parseModelSpec(spec: string): { provider: Provider; model: string } {
  const idx = spec.indexOf(':');
  if (idx < 0) return { provider: 'openrouter', model: spec };
  return { provider: spec.slice(0, idx) as Provider, model: spec.slice(idx + 1) };
}

export function providerKeyName(p: Provider): string {
  return `${p}_api_key`;
}

export function hasProvider(p: Provider, secrets: SecretStore): boolean {
  return Boolean(secrets.get(providerKeyName(p)));
}

export function resolveModel(spec: string, config: AgentConfig, secrets: SecretStore): ChatModel {
  const { provider, model } = parseModelSpec(spec);
  const key = secrets.get(providerKeyName(provider));
  if (!key) throw new Error(`No ${provider} key. Add one with \`vf init --step brain\`.`);
  if (provider === 'anthropic') return new AnthropicModel({ id: spec, base: config.services.anthropic, apiKey: key, model });
  const base = provider === 'deepseek' ? config.services.deepseek : config.services.openrouter;
  return new OpenAICompatModel({ id: spec, base, apiKey: key, model, service: provider });
}

/** Equivalent models across providers, so the agent still thinks when only one key exists. */
const TIER_MODELS: Record<'cheap' | 'mid' | 'strong', Record<Provider, string>> = {
  cheap: { openrouter: 'deepseek/deepseek-v4.1-flash', deepseek: 'deepseek-v4-flash', anthropic: 'claude-haiku-5-5' },
  mid: { openrouter: 'anthropic/claude-sonnet-5.5', deepseek: 'deepseek-v4-pro', anthropic: 'claude-sonnet-5-5' },
  strong: { openrouter: 'anthropic/claude-opus-5.5', deepseek: 'deepseek-v4-pro', anthropic: 'claude-opus-5-5' },
};

export function modelForTier(tier: 'cheap' | 'mid' | 'strong', secrets: SecretStore): string | undefined {
  for (const p of ['openrouter', 'anthropic', 'deepseek'] as Provider[]) {
    if (hasProvider(p, secrets)) return `${p}:${TIER_MODELS[tier][p]}`;
  }
  return undefined;
}

/** Use the configured model if its key exists, else the same tier from whatever provider we have. */
export function usableModel(spec: string, tier: 'cheap' | 'mid' | 'strong', secrets: SecretStore): string | undefined {
  const { provider } = parseModelSpec(spec);
  if (hasProvider(provider, secrets)) return spec;
  return modelForTier(tier, secrets);
}

export function extractJson<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
    throw new Error(`model did not return JSON: ${text.slice(0, 200)}`);
  }
}

export async function chatJson<T>(model: ChatModel, messages: ChatMessage[], req: Omit<ChatRequest, 'messages'> = {}): Promise<T> {
  const hint = 'Respond with one JSON object only — no prose, no code fences.';
  const withHint = messages.map((m, idx) => (idx === 0 && m.role === 'system' ? { ...m, content: `${m.content}\n\n${hint}` } : m));
  const res = await model.chat({ ...req, messages: withHint, json: true });
  try {
    return extractJson<T>(res.content);
  } catch {
    // One retry with the bad output quoted back.
    const again = await model.chat({ ...req, json: true, messages: [...withHint, { role: 'assistant', content: res.content }, { role: 'user', content: `That was not valid JSON. ${hint}` }] });
    return extractJson<T>(again.content);
  }
}
