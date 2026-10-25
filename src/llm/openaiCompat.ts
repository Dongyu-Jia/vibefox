import { loggedFetch } from '../core/log.ts';
import { ModelError, type ChatModel, type ChatRequest, type ChatResult } from './types.ts';

/** OpenRouter, DeepSeek and any other OpenAI-compatible chat completions endpoint. */
export class OpenAICompatModel implements ChatModel {
  readonly id: string;
  private base: string;
  private apiKey: string;
  private model: string;
  private service: string;

  constructor(opts: { id: string; base: string; apiKey: string; model: string; service: string }) {
    this.id = opts.id;
    this.base = opts.base.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.service = opts.service;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens ?? 2000,
    };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }
    // No response_format: several OpenRouter providers (e.g. Anthropic) reject it. chatJson asks in the prompt instead.
    if (this.service === 'openrouter') body.usage = { include: true };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    };
    if (this.service === 'openrouter') {
      headers['http-referer'] = 'https://github.com/Dongyu-Jia/vibefox';
      headers['x-title'] = 'vibefox';
    }
    if (req.tag && process.env.VF_LLM_TAG_HEADER) headers['x-vf-tag'] = req.tag;

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await loggedFetch(this.service, `${this.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, { taskId: req.taskId });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new ModelError(res.status, text.slice(0, 500));
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1) ** 2));
        continue;
      }
      if (!res.ok) throw new ModelError(res.status, text.slice(0, 1000));
      const json = JSON.parse(text) as {
        model?: string;
        choices?: { message: { content: string | null; tool_calls?: ChatResult['toolCalls'] }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        error?: { message: string };
      };
      if (json.error) throw new ModelError(502, json.error.message);
      const choice = json.choices?.[0];
      if (!choice) throw new ModelError(502, 'no choices in response');
      return {
        content: choice.message.content ?? '',
        toolCalls: (choice.message.tool_calls ?? []).map((tc, i) => ({ ...tc, id: tc.id || `call_${i}`, type: 'function' })),
        usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0, costUsd: json.usage?.cost },
        model: json.model ?? this.model,
        finishReason: choice.finish_reason,
      };
    }
    throw lastErr;
  }
}
