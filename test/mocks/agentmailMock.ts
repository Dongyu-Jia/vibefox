import http from 'node:http';

/** Local stand-in for the AgentMail REST API (snake_case, same shapes as the real one). */

export interface MockMail {
  inbox_id: string;
  thread_id: string;
  message_id: string;
  labels: string[];
  timestamp: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  extracted_text: string;
  preview: string;
}

export class AgentMailMock {
  url = '';
  key = 'am_test_key_0123456789abcdef';
  inboxes: { inbox_id: string; email: string; display_name?: string; created_at: string }[] = [];
  messages: MockMail[] = [];
  private seq = 0;
  private server?: http.Server;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/v0`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  private ts(): string {
    return new Date(Date.now() + this.seq).toISOString();
  }

  /** Someone emails the agent. Pass threadId to reply inside a thread the agent started. */
  deliver(input: { from: string; subject: string; text: string; threadId?: string; to?: string }): MockMail {
    const inbox = this.inboxes[0];
    const m: MockMail = {
      inbox_id: inbox.inbox_id,
      thread_id: input.threadId ?? `thd_${++this.seq}`,
      message_id: `<in${++this.seq}@example.com>`,
      labels: ['received', 'unread'],
      timestamp: this.ts(),
      from: input.from,
      to: [input.to ?? inbox.email],
      subject: input.subject,
      text: input.text,
      extracted_text: input.text,
      preview: input.text.slice(0, 80),
    };
    this.messages.push(m);
    return m;
  }

  sent(): MockMail[] {
    return this.messages.filter((m) => m.labels.includes('sent'));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://x');
    let raw = '';
    for await (const c of req) raw += c;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${this.key}`) return json(403, { name: 'ForbiddenError', message: 'Invalid API key' });
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const p = u.pathname.replace(/^\/v0/, '').split('/').filter(Boolean).map(decodeURIComponent);

    if (p[0] === 'inboxes' && p.length === 1 && req.method === 'GET') return json(200, { count: this.inboxes.length, inboxes: this.inboxes });
    if (p[0] === 'inboxes' && p.length === 1 && req.method === 'POST') {
      const username = String(body.username ?? `agent${++this.seq}`);
      const email = `${username}@agentmail.to`;
      const existing = this.inboxes.find((i) => i.inbox_id === email);
      if (existing) return json(200, existing);
      const inbox = { pod_id: 'pod_test', inbox_id: email, email, display_name: body.display_name as string | undefined, client_id: body.client_id, created_at: this.ts(), updated_at: this.ts() };
      this.inboxes.push(inbox);
      return json(200, inbox);
    }
    const inbox = this.inboxes.find((i) => i.inbox_id === p[1]);
    if (p[0] === 'inboxes' && !inbox) return json(404, { name: 'NotFoundError', message: 'inbox not found' });
    if (p[0] === 'inboxes' && p.length === 2) return json(200, inbox);
    if (p[2] === 'messages' && p[3] === 'send' && req.method === 'POST') {
      const to = Array.isArray(body.to) ? (body.to as string[]) : [String(body.to)];
      const m: MockMail = {
        inbox_id: inbox!.inbox_id,
        thread_id: `thd_${++this.seq}`,
        message_id: `<out${++this.seq}@agentmail.to>`,
        labels: ['sent'],
        timestamp: this.ts(),
        from: `${inbox!.display_name ?? ''} <${inbox!.email}>`,
        to,
        subject: String(body.subject ?? ''),
        text: String(body.text ?? ''),
        extracted_text: String(body.text ?? ''),
        preview: String(body.text ?? '').slice(0, 80),
      };
      this.messages.push(m);
      return json(200, { message_id: m.message_id, thread_id: m.thread_id });
    }
    if (p[2] === 'messages' && p[4] === 'reply' && req.method === 'POST') {
      const orig = this.messages.find((m) => m.message_id === p[3]);
      if (!orig) return json(404, { name: 'NotFoundError', message: 'message not found' });
      const m: MockMail = {
        ...orig,
        message_id: `<out${++this.seq}@agentmail.to>`,
        labels: ['sent'],
        timestamp: this.ts(),
        from: inbox!.email,
        to: [orig.from],
        subject: 'Re: ' + orig.subject,
        text: String(body.text),
        extracted_text: String(body.text),
        preview: String(body.text).slice(0, 80),
      };
      this.messages.push(m);
      return json(200, { message_id: m.message_id, thread_id: m.thread_id });
    }
    if (p[2] === 'messages' && p.length === 3 && req.method === 'GET') {
      const after = u.searchParams.get('after');
      const list = this.messages
        .filter((m) => m.inbox_id === inbox!.inbox_id && (!after || m.timestamp > after))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, Number(u.searchParams.get('limit') ?? 20))
        .map(({ text: _t, extracted_text: _e, ...item }) => item);
      return json(200, { count: list.length, messages: list });
    }
    if (p[2] === 'messages' && p.length === 4 && req.method === 'GET') {
      const m = this.messages.find((x) => x.message_id === p[3]);
      return m ? json(200, m) : json(404, { name: 'NotFoundError', message: 'message not found' });
    }
    return json(404, { name: 'NotFoundError', message: `no route ${req.method} ${u.pathname}` });
  }
}
