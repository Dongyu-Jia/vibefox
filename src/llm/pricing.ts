import { loggedFetch } from '../core/log.ts';

/**
 * Prices for harnesses that report tokens but not dollars (dsh). OpenRouter's
 * public model list gives USD per token; it is fetched once and kept for 6 hours.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface TokenPrice {
  prompt: number;
  completion: number;
  cacheRead: number;
}

let cache: { at: number; prices: Map<string, TokenPrice> } | undefined;

export async function openrouterPrice(model: string): Promise<TokenPrice | undefined> {
  if (!cache || Date.now() - cache.at > 6 * 3600_000) {
    const base = (process.env.VF_OPENROUTER_API ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    // The list is ~1 MB of every model; only a failure is worth an audit entry.
    const res = await loggedFetch('openrouter', `${base}/models`, {}, { logIf: (status) => status !== 200 });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: { id: string; pricing?: Record<string, string> }[] };
    const prices = new Map<string, TokenPrice>();
    for (const m of json.data ?? []) {
      const p = m.pricing ?? {};
      const prompt = Number(p.prompt);
      if (!Number.isFinite(prompt)) continue;
      prices.set(m.id, { prompt, completion: Number(p.completion) || 0, cacheRead: Number(p.input_cache_read ?? p.prompt) || 0 });
    }
    cache = { at: Date.now(), prices };
  }
  return cache.prices.get(model);
}

export function usageCost(u: TokenUsage, p: TokenPrice): number {
  return u.inputTokens * p.prompt + u.outputTokens * p.completion + u.cacheReadTokens * p.cacheRead;
}
