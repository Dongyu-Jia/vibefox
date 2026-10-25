/** One message format (OpenAI chat style) for every model provider. */

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
  finishReason?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object back. */
  json?: boolean;
  /** What this call is for, e.g. `router.classify` — shows up in logs and lets the test LLM script replies. */
  tag?: string;
  taskId?: string;
}

export interface ChatModel {
  /** `<provider>:<model>` */
  readonly id: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

export class ModelError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
