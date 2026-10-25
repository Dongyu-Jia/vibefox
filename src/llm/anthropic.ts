import { loggedFetch } from '../core/log.ts';
import { ModelError, type ChatMessage, type ChatModel, type ChatRequest, type ChatResult, type ToolCall } from './types.ts';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/** Anthropic Messages API, adapted to the shared OpenAI-style message format. */
export class AnthropicModel implements ChatModel {
  readonly id: string;
  private base: string;
  private apiKey: string;
  private model: string;

  constructor(opts: { id: string; base: string; apiKey: string; model: string }) {
    this.id = opts.id;
    this.base = opts.base.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
  }

  private convert(messages: ChatMessage[]): { system: string; messages: { role: 'user' | 'assistant'; content: Block[] }[] } {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n\n');
    const out: { role: 'user' | 'assistant'; content: Block[] }[] = [];
    const push = (role: 'user' | 'assistant', block: Block) => {
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(block);
      else out.push({ role, content: [block] });
    };
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        push('user', { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content ?? '' });
      } else if (m.role === 'assistant') {
        if (m.content) push('assistant', { type: 'text', text: m.content });
        for (const tc of m.tool_calls ?? []) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.function.arguments || '{}');
          } catch {
            input = { raw: tc.function.arguments };
          }
          push('assistant', { type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
      } else {
        push('user', { type: 'text', text: m.content ?? '' });
      }
    }
    return { system, messages: out };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const { system, messages } = this.convert(req.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? 2000,
      temperature: req.temperature ?? 0.3,
      system: req.json ? `${system}\n\nRespond with a single JSON object and nothing else.` : system,
      messages,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (req.tag && process.env.VF_LLM_TAG_HEADER) headers['x-vf-tag'] = req.tag;
    const res = await loggedFetch('anthropic', `${this.base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) }, { taskId: req.taskId });
    const text = await res.text();
    if (!res.ok) throw new ModelError(res.status, text.slice(0, 1000));
    const json = JSON.parse(text) as {
      content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
      usage?: { input_tokens: number; output_tokens: number };
      stop_reason?: string;
      model?: string;
    };
    const toolCalls: ToolCall[] = [];
    let content = '';
    for (const blk of json.content) {
      if (blk.type === 'text') content += blk.text ?? '';
      if (blk.type === 'tool_use') toolCalls.push({ id: blk.id ?? '', type: 'function', function: { name: blk.name ?? '', arguments: JSON.stringify(blk.input ?? {}) } });
    }
    return {
      content,
      toolCalls,
      usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
      model: json.model ?? this.model,
      finishReason: json.stop_reason,
    };
  }
}
