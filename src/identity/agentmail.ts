import { loggedFetch, log, unlessEmpty, type LoggedFetchOptions } from '../core/log.ts';

/** AgentMail: the agent's own inbox. Plain fetch, snake_case on the wire. */

export interface Inbox {
  inbox_id: string;
  email: string;
  display_name?: string;
  created_at?: string;
}

export interface MailItem {
  inbox_id: string;
  thread_id: string;
  message_id: string;
  labels: string[];
  timestamp: string;
  from: string;
  to: string[];
  subject?: string;
  preview?: string;
  text?: string;
  html?: string;
  extracted_text?: string;
  in_reply_to?: string;
}

export class AgentMailError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`AgentMail ${status}: ${message}`);
    this.status = status;
  }
}

export class AgentMail {
  private base: string;
  private key: string;
  taskId?: string;

  constructor(opts: { apiKey: string; base?: string }) {
    this.key = opts.apiKey;
    this.base = (opts.base ?? 'https://api.agentmail.to/v0').replace(/\/$/, '');
  }

  private async req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, logIf?: LoggedFetchOptions['logIf']): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await loggedFetch(
        'agentmail',
        `${this.base}${path}`,
        {
          method,
          headers: { authorization: `Bearer ${this.key}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
          body: body ? JSON.stringify(body) : undefined,
        },
        { taskId: this.taskId, logIf },
      );
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1000 * Number(res.headers.get('retry-after') ?? 1)));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        try {
          const j = JSON.parse(text) as { message?: string; name?: string; fix?: string };
          msg = [j.name, j.message, j.fix].filter(Boolean).join(' — ');
        } catch {}
        throw new AgentMailError(res.status, msg.slice(0, 500));
      }
      return (text ? JSON.parse(text) : {}) as T;
    }
    throw new AgentMailError(429, 'rate limited');
  }

  listInboxes(limit = 20): Promise<{ count: number; inboxes: Inbox[] }> {
    return this.req('GET', `/inboxes?limit=${limit}`);
  }

  createInbox(input: { username?: string; display_name?: string; client_id?: string }): Promise<Inbox> {
    return this.req('POST', '/inboxes', input);
  }

  getInbox(inboxId: string): Promise<Inbox> {
    return this.req('GET', `/inboxes/${encodeURIComponent(inboxId)}`);
  }

  send(inboxId: string, msg: { to: string | string[]; subject: string; text: string; html?: string; cc?: string[] }, idempotencyKey?: string): Promise<{ message_id: string; thread_id: string }> {
    return this.req('POST', `/inboxes/${encodeURIComponent(inboxId)}/messages/send`, msg, idempotencyKey ? { 'idempotency-key': idempotencyKey } : {});
  }

  reply(inboxId: string, messageId: string, msg: { text: string; html?: string; reply_all?: boolean }, idempotencyKey?: string): Promise<{ message_id: string; thread_id: string }> {
    return this.req(
      'POST',
      `/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}/reply`,
      msg,
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    );
  }

  listMessages(inboxId: string, opts: { limit?: number; after?: string } = {}): Promise<{ count: number; messages: MailItem[]; next_page_token?: string }> {
    const q = new URLSearchParams({ limit: String(opts.limit ?? 20) });
    if (opts.after) q.set('after', opts.after);
    return this.req('GET', `/inboxes/${encodeURIComponent(inboxId)}/messages?${q}`, undefined, {}, unlessEmpty('messages'));
  }

  getMessage(inboxId: string, messageId: string): Promise<MailItem> {
    return this.req('GET', `/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`);
  }
}

export function mailBody(m: MailItem): string {
  return (m.extracted_text ?? m.text ?? m.preview ?? (m.html ? m.html.replace(/<[^>]+>/g, ' ') : '')).trim();
}

export function addressOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}

/**
 * Watches the inbox. Polls (simple, works everywhere, no tunnel); when
 * `realtime` is on it also listens on AgentMail's WebSocket for instant delivery.
 * Duplicates are fine: the caller dedupes on message_id.
 */
export class MailWatcher {
  private mail: AgentMail;
  private inboxId: string;
  private pollMs: number;
  private onMessage: (m: MailItem) => Promise<void>;
  private loadCursor: () => string | undefined;
  private saveCursor: (iso: string) => void;
  private timer?: NodeJS.Timeout;
  private ws?: WebSocket;
  private stopped = false;
  private wsUrl?: string;
  private apiKey: string;

  constructor(opts: {
    mail: AgentMail;
    apiKey: string;
    inboxId: string;
    pollSeconds: number;
    realtimeUrl?: string;
    onMessage: (m: MailItem) => Promise<void>;
    loadCursor: () => string | undefined;
    saveCursor: (iso: string) => void;
  }) {
    this.mail = opts.mail;
    this.apiKey = opts.apiKey;
    this.inboxId = opts.inboxId;
    this.pollMs = opts.pollSeconds * 1000;
    this.onMessage = opts.onMessage;
    this.loadCursor = opts.loadCursor;
    this.saveCursor = opts.saveCursor;
    this.wsUrl = opts.realtimeUrl;
  }

  private inflight?: Promise<void>;

  start(): void {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      this.inflight = this.poll().catch((err) => log('mail poll error', String((err as Error).message ?? err)));
      await this.inflight;
      if (!this.stopped) this.timer = setTimeout(tick, this.pollMs);
    };
    void tick();
    if (this.wsUrl) this.connectWs();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    await this.inflight;
  }

  async poll(): Promise<void> {
    const cursor = this.loadCursor();
    // AgentMail's `after` is inclusive: step 1 ms past the last message already handled,
    // or every poll fetches it again.
    const ms = cursor ? Date.parse(cursor) : NaN;
    const after = Number.isFinite(ms) ? new Date(ms + 1).toISOString() : cursor;
    const list = await this.mail.listMessages(this.inboxId, { limit: 50, after });
    const fresh = list.messages.filter((m) => !cursor || m.timestamp > cursor).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (const item of fresh) {
      if (item.labels.includes('received')) {
        const full = item.text || item.extracted_text ? item : await this.mail.getMessage(this.inboxId, item.message_id);
        await this.onMessage(full);
      }
      // Sent mail moves the cursor too, so it isn't listed again on every poll.
      this.saveCursor(item.timestamp);
    }
  }

  private connectWs(): void {
    if (this.stopped || !this.wsUrl) return;
    const ws = new WebSocket(`${this.wsUrl}?api_key=${encodeURIComponent(this.apiKey)}`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', inbox_ids: [this.inboxId], event_types: ['message.received'] }));
    });
    ws.addEventListener('message', (ev) => {
      try {
        const frame = JSON.parse(String(ev.data)) as { type: string; event_type?: string; message?: MailItem };
        if (frame.type === 'event' && frame.event_type === 'message.received' && frame.message) {
          void this.onMessage(frame.message).catch((e) => log('mail ws handler error', String(e)));
        }
      } catch {}
    });
    ws.addEventListener('close', () => {
      if (!this.stopped) setTimeout(() => this.connectWs(), 5000);
    });
    ws.addEventListener('error', () => ws.close());
  }
}
