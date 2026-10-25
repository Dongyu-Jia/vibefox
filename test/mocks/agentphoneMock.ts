import http from 'node:http';

/**
 * Local stand-in for the AgentPhone REST API. Outbound calls play out on their
 * own: a few polls "in-progress", then "completed" with a transcript built from
 * the call's system prompt (so tests can see the purpose was carried through).
 */

export interface MockSms {
  id: string;
  from_: string;
  to: string;
  body: string;
  direction: 'inbound' | 'outbound';
  receivedAt: string;
}

export class AgentPhoneMock {
  url = '';
  key = 'ap_test_key_0123456789abcdef';
  agents: Record<string, unknown>[] = [];
  numbers: { id: string; phoneNumber: string; country: string; status: string; agentId: string | null; outboundSms: string; createdAt: string }[] = [];
  sms: MockSms[] = [];
  calls: { id: string; agentId: string; toNumber: string; fromNumber: string; systemPrompt?: string; initialGreeting?: string; status: string; polls: number; startedAt: string; endedAt?: string }[] = [];
  /** What the person on the other end says; override per test. */
  calleeSays = (purpose: string) => [`Hello, Golden Gate Dim Sum, how can I help?`, `Yes — for "${purpose.slice(0, 60)}": we have a private room on Saturday at 7pm for up to 8 people. I can hold it under your name.`, 'Great, see you then. Bye!'];
  private seq = 0;
  private server?: http.Server;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/v1`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  incomingSms(from: string, body: string): MockSms {
    const n = this.numbers[0];
    const s: MockSms = { id: `msg_${++this.seq}`, from_: from, to: n.phoneNumber, body, direction: 'inbound', receivedAt: new Date(Date.now() + this.seq).toISOString() };
    this.sms.push(s);
    return s;
  }

  private transcript(c: AgentPhoneMock['calls'][number]) {
    const purpose = /Purpose of this call: (.*)/.exec(c.systemPrompt ?? '')?.[1] ?? 'your request';
    const them = this.calleeSays(purpose);
    return [
      { role: 'agent', content: c.initialGreeting ?? 'Hi' },
      { role: 'user', content: them[0] },
      { role: 'agent', content: `I'm an AI agent calling on behalf of my parent. ${purpose}` },
      { role: 'user', content: them[1] },
      { role: 'agent', content: 'Perfect, please hold it. Thank you!' },
      { role: 'user', content: them[2] },
    ];
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://x');
    let raw = '';
    for await (const c of req) raw += c;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${this.key}`) return json(401, { detail: 'Invalid API key' });
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const p = u.pathname.replace(/^\/v1/, '').split('/').filter(Boolean);
    const now = () => new Date().toISOString();

    if (p[0] === 'agents' && p.length === 1 && req.method === 'POST') {
      const a = { id: `agt_${++this.seq}`, ...body, createdAt: now(), numbers: [] };
      this.agents.push(a);
      return json(200, a);
    }
    if (p[0] === 'agents' && p.length === 1) return json(200, { data: this.agents, total: this.agents.length });
    if (p[0] === 'agents' && p[2] === 'numbers' && req.method === 'POST') {
      const n = this.numbers.find((x) => x.id === body.numberId);
      if (!n) return json(404, { error: { message: 'number not found' } });
      n.agentId = p[1];
      return json(200, { agentId: p[1], number: n });
    }
    if (p[0] === 'numbers' && p.length === 1 && req.method === 'POST') {
      const area = String(body.areaCode ?? '415');
      const n = { id: `num_${++this.seq}`, phoneNumber: `+1${area}555${String(1000 + this.seq).slice(-4)}`, country: 'US', status: 'active', agentId: (body.agentId as string) ?? null, outboundSms: 'enabled', createdAt: now() };
      this.numbers.push(n);
      return json(200, n);
    }
    if (p[0] === 'numbers' && p.length === 1) return json(200, { data: this.numbers, hasMore: false, total: this.numbers.length });
    if (p[0] === 'numbers' && p.length === 2) return json(200, this.numbers.find((x) => x.id === p[1]) ?? {});
    if (p[0] === 'numbers' && p[2] === 'messages') {
      const after = u.searchParams.get('after');
      const n = this.numbers.find((x) => x.id === p[1]);
      const data = this.sms.filter((s) => (s.to === n?.phoneNumber || s.from_ === n?.phoneNumber) && (!after || s.receivedAt > after)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      return json(200, { data, hasMore: false });
    }
    if (p[0] === 'messages' && req.method === 'POST') {
      const n = this.numbers[0];
      const s: MockSms = { id: `msg_${++this.seq}`, from_: n.phoneNumber, to: String(body.to_number), body: String(body.body), direction: 'outbound', receivedAt: new Date(Date.now() + this.seq).toISOString() };
      this.sms.push(s);
      return json(200, { id: s.id, status: 'sent', channel: 'sms', from_number: n.phoneNumber, to_number: s.to, conversation_id: `conv_${s.to}` });
    }
    if (p[0] === 'calls' && p.length === 1 && req.method === 'POST') {
      const n = this.numbers.find((x) => x.id === body.fromNumberId) ?? this.numbers[0];
      const c = { id: `call_${++this.seq}`, agentId: String(body.agentId), toNumber: String(body.toNumber), fromNumber: n.phoneNumber, systemPrompt: body.systemPrompt as string | undefined, initialGreeting: body.initialGreeting as string | undefined, status: 'in-progress', polls: 0, startedAt: now() };
      this.calls.push(c);
      return json(200, { id: c.id, fromNumber: c.fromNumber, toNumber: c.toNumber, status: c.status });
    }
    if (p[0] === 'calls' && p.length === 1) {
      const dir = u.searchParams.get('direction');
      return json(200, { data: dir === 'inbound' ? [] : this.calls.map((c) => ({ id: c.id, status: c.status, toNumber: c.toNumber, fromNumber: c.fromNumber, direction: 'outbound' })), hasMore: false, total: this.calls.length });
    }
    if (p[0] === 'calls' && p.length === 2) {
      const c = this.calls.find((x) => x.id === p[1]);
      if (!c) return json(404, { error: { message: 'call not found' } });
      c.polls++;
      if (c.polls >= 2 && c.status === 'in-progress') {
        c.status = 'completed';
        c.endedAt = now();
      }
      return json(200, { id: c.id, status: c.status, fromNumber: c.fromNumber, toNumber: c.toNumber, direction: 'outbound', startedAt: c.startedAt, endedAt: c.endedAt, durationSeconds: c.endedAt ? 74 : undefined, summary: c.endedAt ? 'Private room available Saturday 7pm for up to 8; held under the parent name.' : undefined });
    }
    if (p[0] === 'calls' && p[2] === 'transcript') {
      const c = this.calls.find((x) => x.id === p[1]);
      return json(200, { transcript: c ? this.transcript(c) : [] });
    }
    return json(404, { error: { message: `no route ${req.method} ${u.pathname}` } });
  }
}
