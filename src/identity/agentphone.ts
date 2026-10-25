import crypto from 'node:crypto';
import { loggedFetch, unlessEmpty, type LoggedFetchOptions } from '../core/log.ts';

/**
 * AgentPhone: the agent's own phone number. Outbound calls are run by
 * AgentPhone's hosted voice model with a system prompt we write for the task,
 * and SMS + call history are polled — so the agent needs no public webhook.
 */

export interface PhoneNumber {
  id: string;
  phoneNumber: string;
  country: string;
  status: string;
  agentId?: string | null;
  outboundSms?: 'enabled' | 'activating' | 'registration_required';
}

export interface PhoneAgent {
  id: string;
  name: string;
  voiceMode: string;
  numbers?: { id: string; phoneNumber: string }[];
}

export interface SmsItem {
  id: string;
  from_: string;
  to: string;
  body: string;
  direction: 'inbound' | 'outbound';
  receivedAt: string;
}

export interface CallInfo {
  id: string;
  status: string;
  fromNumber?: string;
  toNumber?: string;
  direction?: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  summary?: string;
}

export class AgentPhoneError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`AgentPhone ${status}: ${message}`);
    this.status = status;
  }
}

export class AgentPhone {
  private base: string;
  private key: string;
  taskId?: string;

  constructor(opts: { apiKey: string; base?: string }) {
    this.key = opts.apiKey;
    this.base = (opts.base ?? 'https://api.agentphone.ai/v1').replace(/\/$/, '');
  }

  private async req<T>(method: string, path: string, body?: unknown, logIf?: LoggedFetchOptions['logIf']): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await loggedFetch(
        'agentphone',
        `${this.base}${path}`,
        { method, headers: { authorization: `Bearer ${this.key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined },
        { taskId: this.taskId, logIf },
      );
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1000 * Number(res.headers.get('retry-after') ?? 2)));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        try {
          const j = JSON.parse(text) as { error?: { message?: string }; detail?: unknown };
          msg = j.error?.message ?? (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j));
        } catch {}
        throw new AgentPhoneError(res.status, String(msg).slice(0, 500));
      }
      return (text ? JSON.parse(text) : {}) as T;
    }
    throw new AgentPhoneError(429, 'rate limited');
  }

  createAgent(input: { name: string; description?: string; voiceMode?: 'webhook' | 'hosted'; systemPrompt?: string; beginMessage?: string; voice?: string }): Promise<PhoneAgent> {
    return this.req('POST', '/agents', input);
  }

  listAgents(): Promise<{ data: PhoneAgent[] }> {
    return this.req('GET', '/agents?limit=20&offset=0');
  }

  createNumber(input: { country?: string; areaCode?: string; agentId?: string }): Promise<PhoneNumber> {
    return this.req('POST', '/numbers', { country: input.country ?? 'US', areaCode: input.areaCode, agentId: input.agentId });
  }

  listNumbers(): Promise<{ data: PhoneNumber[] }> {
    return this.req('GET', '/numbers?limit=20&offset=0');
  }

  getNumber(id: string): Promise<PhoneNumber> {
    return this.req('GET', `/numbers/${encodeURIComponent(id)}`);
  }

  attachNumber(agentId: string, numberId: string): Promise<unknown> {
    return this.req('POST', `/agents/${encodeURIComponent(agentId)}/numbers`, { numberId });
  }

  sendSms(input: { agentId?: string; numberId?: string; to: string; body: string }): Promise<{ id: string; status: string; conversation_id?: string }> {
    return this.req('POST', '/messages', { agent_id: input.agentId, number_id: input.numberId, to_number: input.to, body: input.body });
  }

  listNumberMessages(numberId: string, opts: { limit?: number; after?: string } = {}): Promise<{ data: SmsItem[]; hasMore: boolean }> {
    const q = new URLSearchParams({ limit: String(opts.limit ?? 50) });
    if (opts.after) q.set('after', opts.after);
    return this.req('GET', `/numbers/${encodeURIComponent(numberId)}/messages?${q}`, undefined, unlessEmpty('data'));
  }

  createCall(input: { agentId: string; toNumber: string; fromNumberId?: string; initialGreeting?: string; systemPrompt?: string; voice?: string }): Promise<CallInfo> {
    return this.req('POST', '/calls', input);
  }

  getCall(id: string): Promise<CallInfo> {
    return this.req('GET', `/calls/${encodeURIComponent(id)}`);
  }

  getTranscript(id: string): Promise<{ transcript: { role: string; content: string }[] }> {
    return this.req('GET', `/calls/${encodeURIComponent(id)}/transcript`);
  }

  listCalls(opts: { direction?: 'inbound' | 'outbound'; limit?: number } = {}): Promise<{ data: CallInfo[] }> {
    const q = new URLSearchParams({ limit: String(opts.limit ?? 20), offset: '0' });
    if (opts.direction) q.set('direction', opts.direction);
    return this.req('GET', `/calls?${q}`, undefined, unlessEmpty('data'));
  }

  /** Poll a call until it ends; returns the call and its transcript. */
  async waitForCall(id: string, timeoutSec = 900, pollSec = 4): Promise<{ call: CallInfo; transcript: { role: string; content: string }[] }> {
    const deadline = Date.now() + timeoutSec * 1000;
    let call = await this.getCall(id);
    while (!['completed', 'failed', 'ended', 'no-answer', 'busy', 'canceled'].includes(call.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollSec * 1000));
      call = await this.getCall(id);
    }
    const t = await this.getTranscript(id).catch(() => ({ transcript: [] }));
    return { call, transcript: t.transcript ?? [] };
  }
}

/** Verify an AgentPhone webhook delivery (HMAC-SHA256 over `${timestamp}.${rawBody}`, secret used as-is). */
export function verifyAgentPhoneSignature(rawBody: string, signature: string | undefined, timestamp: string | undefined, secret: string): boolean {
  if (!signature || !timestamp) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Pull a one-time code out of an SMS or email. */
export function extractCode(text: string): string | undefined {
  if (!/(code|verif|otp|passcode|pin|验证码|校验码|动态码|确认码)/i.test(text)) return undefined;
  const m = /(?<![\d-])(\d{4,8})(?![\d-])/.exec(text);
  return m?.[1];
}

export function callSystemPrompt(input: { agentName: string; parentName: string; purpose: string; soul: string }): string {
  return `You are ${input.agentName}, an independent AI agent, placing a phone call on behalf of ${input.parentName}.
Always say early in the call that you are an AI agent calling for ${input.parentName}. Never claim to be human.
Purpose of this call: ${input.purpose}
Be polite, brief and concrete. Get the information or confirmation needed for the purpose, confirm details back, then thank them and end the call.
Do not agree to pay, share card numbers, passwords or personal data, or commit ${input.parentName} to anything beyond the purpose. If asked, say ${input.parentName} will follow up.
Personality: ${input.soul.slice(0, 600)}`;
}
