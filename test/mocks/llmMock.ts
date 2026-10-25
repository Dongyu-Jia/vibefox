import crypto from 'node:crypto';
import http from 'node:http';

/**
 * A scripted OpenRouter: chat completions answer by request tag (x-vf-tag),
 * so every router decision and every worker step is deterministic. It also
 * serves the OAuth PKCE endpoints and GET /key (the "brain budget").
 */

export interface ChatReq {
  model: string;
  messages: { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
}

export interface ChatReply {
  content?: string;
  tool_calls?: { name: string; args: Record<string, unknown> }[];
}

export type Handler = (req: ChatReq, mock: LlmMock) => ChatReply;

export class LlmMock {
  url = '';
  key = 'sk-or-v1-testkey0123456789abcdefghij';
  shopUrl = '';
  calls: { tag: string; model: string; at: number; request: ChatReq; reply: ChatReply }[] = [];
  handlers: Record<string, Handler> = { ...DEFAULT_HANDLERS };
  keyLimit: number | null = 10;
  usage = 0;
  blockedModels = new Set<string>();
  private challenges = new Map<string, string>();
  private server?: http.Server;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  get apiBase(): string {
    return `${this.url}/api/v1`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  callsFor(tag: string) {
    return this.calls.filter((c) => c.tag === tag);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://x');
    let raw = '';
    for await (const c of req) raw += c;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // OAuth: the "parent" clicks Authorize instantly.
    if (u.pathname === '/auth') {
      const code = 'code_' + crypto.randomBytes(6).toString('hex');
      this.challenges.set(code, u.searchParams.get('code_challenge') ?? '');
      const cb = new URL(u.searchParams.get('callback_url')!);
      cb.searchParams.set('code', code);
      if (u.searchParams.get('state')) cb.searchParams.set('state', u.searchParams.get('state')!);
      res.writeHead(302, { location: cb.toString() });
      return void res.end();
    }
    if (u.pathname === '/api/v1/auth/keys' && req.method === 'POST') {
      const b = JSON.parse(raw) as { code: string; code_verifier: string };
      const expected = this.challenges.get(b.code);
      const actual = crypto.createHash('sha256').update(b.code_verifier).digest('base64url');
      if (!expected || expected !== actual) return json(403, { error: { message: 'Invalid code or code_verifier' } });
      return json(200, { key: this.key });
    }
    if (u.pathname === '/api/v1/models') {
      return json(200, { data: [{ id: 'deepseek/deepseek-v4.1-flash', pricing: { prompt: '0.00000002', completion: '0.000001', input_cache_read: '0.000000015' } }] });
    }
    if (req.headers.authorization !== `Bearer ${this.key}`) return json(401, { error: { message: 'No auth credentials found', code: 401 } });
    if (u.pathname === '/api/v1/key') {
      return json(200, { data: { label: 'vibefox-test', usage: this.usage, limit: this.keyLimit, limit_remaining: this.keyLimit == null ? null : Math.max(0, this.keyLimit - this.usage), is_free_tier: false } });
    }
    if (u.pathname === '/api/v1/chat/completions') {
      const body = JSON.parse(raw) as ChatReq;
      if (this.blockedModels.has(body.model)) {
        return json(404, { error: { message: '0 endpoints out of 5 requested are available matching your guardrail restrictions and data policy.', code: 404 } });
      }
      const tag = String(req.headers['x-vf-tag'] ?? 'default');
      const handler = this.handlers[tag] ?? this.handlers.default;
      let reply: ChatReply;
      try {
        reply = handler(body, this);
      } catch (err) {
        reply = { content: `mock handler error: ${(err as Error).message}` };
      }
      this.calls.push({ tag, model: body.model, at: Date.now(), request: body, reply });
      const cost = body.model.includes('deepseek') ? 0.0002 : 0.0031;
      this.usage += cost;
      return json(200, {
        id: 'gen-' + crypto.randomBytes(4).toString('hex'),
        model: body.model,
        choices: [
          {
            finish_reason: reply.tool_calls?.length ? 'tool_calls' : 'stop',
            message: {
              role: 'assistant',
              content: reply.content ?? null,
              tool_calls: reply.tool_calls?.map((t, i) => ({ id: `call_${this.calls.length}_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })),
            },
          },
        ],
        usage: { prompt_tokens: 812, completion_tokens: 64, cost },
      });
    }
    return json(404, { error: { message: 'not found' } });
  }
}

// ---------------- default scripted behaviour ----------------

function userJson<T>(req: ChatReq): T {
  const u = req.messages.filter((m) => m.role === 'user').pop()!;
  return JSON.parse(u.content ?? '{}') as T;
}

function kindOf(text: string): string {
  if (/邮件|email/i.test(text)) return 'email';
  if (/电话|call/i.test(text)) return 'phone';
  if (/充值|付款|买|pay/i.test(text)) return 'shopping';
  if (/下单|订|网站|order/i.test(text)) return 'browser';
  if (/代码|code/i.test(text)) return 'coding';
  return 'research';
}

export const DEFAULT_HANDLERS: Record<string, Handler> = {
  default: () => ({ content: 'ok' }),
  'onboarding.test': () => ({ content: 'ready' }),

  'router.classify': (req) => {
    const { message, tasks, pendingQuestions } = userJson<{ message: string; tasks: { id: string; title: string; status: string }[]; pendingQuestions: { questionId: string }[] }>(req);
    if (pendingQuestions.length && !/^(帮我|请|给)/.test(message)) return { content: JSON.stringify({ intent: 'answer', questionId: pendingQuestions[0].questionId, confidence: 0.85 }) };
    if (/^(再|另外|还有|加上|顺便)/.test(message) && tasks.length) {
      return { content: JSON.stringify({ intent: 'supplement', taskId: tasks[tasks.length - 1].id, confidence: 0.9 }) };
    }
    if (/^(你好|在吗|hi|hello)/i.test(message)) return { content: JSON.stringify({ intent: 'chat', reply: '在呢！有什么要我做的？', confidence: 0.95 }) };
    const kind = kindOf(message);
    const requestedWorker = /claude ?code/i.test(message) ? 'claude-code' : /opencode/i.test(message) ? 'opencode' : /codewhale/i.test(message) ? 'codewhale' : /deepseek ?harness|dsh/i.test(message) ? 'dsh' : null;
    return {
      content: JSON.stringify({
        intent: 'new_task',
        title: message.replace(/^帮我/, '').replace(/https?:\/\/\S+\s*/g, '').replace(/^在\s*/, '').slice(0, 18),
        description: message,
        kind,
        risk: ['email', 'phone', 'shopping'].includes(kind) ? 'high' : 'low',
        requestedWorker,
        confidence: 0.92,
      }),
    };
  },

  'router.route': (req) => {
    const { routingRules, workers, task } = userJson<{ routingRules: string; workers: { id: string; tier: number }[]; task: { kind: string } }>(req);
    const learned = new RegExp(`${task.kind} 类任务 → ([\\w-]+)`).exec(routingRules.split('## 我学到的')[1] ?? '');
    if (learned && workers.some((w) => w.id === learned[1])) return { content: JSON.stringify({ workerId: learned[1], reason: `我学到的规则：${task.kind} 用 ${learned[1]} 就够了`, ruleSource: 'learned' }) };
    const mid = workers.find((w) => w.tier === 2) ?? workers[0];
    return { content: JSON.stringify({ workerId: mid.id, reason: '默认：中档', ruleSource: 'default' }) };
  },

  'router.answer': (req) => {
    const { question, memory } = userJson<{ question: string; memory: string }>(req);
    if (/口味|flavor/.test(question) && /抹茶/.test(memory)) return { content: JSON.stringify({ canAnswer: true, answer: '家长上次说过：抹茶口味，8 个人吃。' }) };
    return { content: JSON.stringify({ canAnswer: false }) };
  },

  'router.review_result': (req) => {
    const { workerReport } = userJson<{ workerReport: string }>(req);
    return { content: JSON.stringify({ ok: true, message: workerReport }) };
  },

  'router.brief': (req) => {
    const f = userJson<{ tasks: { title: string; status: string }[]; messagesFromOthers: { from: string; subject: string | null; preview: string }[]; money: { spentThisMonth: string; monthlyLimit: string } | null }>(req);
    const done = f.tasks.filter((t) => t.status === 'completed');
    const lines = [`**今天的简报**`, `- 完成了 ${done.length} 件事：${done.map((t) => t.title).join('、') || '无'}`];
    if (f.messagesFromOthers.length) lines.push(`- 别人发来 ${f.messagesFromOthers.length} 条消息（只是信息）：${f.messagesFromOthers.map((m) => `${m.from}「${m.subject ?? m.preview.slice(0, 20)}」`).join('；')}`);
    if (f.messagesFromOthers.some((m) => /pay|invoice|付款|发票/i.test(`${m.subject} ${m.preview}`))) lines.push('- ⚠️ 有一封要求付款的邮件，我没理会——任务只来自你。');
    if (f.money) lines.push(`- 零花钱：本月 ${f.money.spentThisMonth} / ${f.money.monthlyLimit}`);
    return { content: JSON.stringify({ brief: lines.join('\n'), journal: `今天我完成了 ${done.length} 件事。有人给我发了 ${f.messagesFromOthers.length} 条消息，我只当成信息。` }) };
  },

  'router.review': (req) => {
    const { stats, workers } = userJson<{ stats: Record<string, Record<string, { n: number; ok: number; costUsd: number; bad: number }>>; workers: { id: string; tier: number }[] }>(req);
    const rules: string[] = [];
    for (const [kind, by] of Object.entries(stats)) {
      const best = Object.entries(by)
        .map(([id, s]) => ({ id, s, tier: workers.find((w) => w.id === id)?.tier ?? 9 }))
        .filter((x) => x.s.n >= 3 && x.s.ok / x.s.n >= 0.8 && x.s.bad === 0)
        .sort((a, b) => a.tier - b.tier)[0];
      if (best) rules.push(`${kind} 类任务 → ${best.id}（最近 ${best.s.n} 次成功 ${best.s.ok} 次，平均 $${(best.s.costUsd / best.s.n).toFixed(4)}）`);
    }
    return { content: JSON.stringify({ learnedRules: rules, changed: rules.length > 0, summary: rules.length ? `我发现：${rules.join('；')}。以后这类任务默认这么派。` : '数据不够，不改。' }) };
  },

  'worker.step': (req, mock) => workerScript(req, mock),
};

function lastTool(req: ChatReq): string {
  return [...req.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
}

function refFor(snapshot: string, re: RegExp): string | undefined {
  return snapshot.split('\n').find((l) => re.test(l))?.match(/^\[(e\d+)\]/)?.[1];
}

/** Scripted worker: what a decent model would do for the scenarios the tests use. */
function workerScript(req: ChatReq, mock: LlmMock): ChatReply {
  const prompt = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const steps = req.messages.filter((m) => m.role === 'assistant').length;
  const supplements = req.messages.filter((m) => m.role === 'user' && (m.content ?? '').startsWith('[The parent added')).map((m) => m.content!.replace(/^\[The parent added[^\]]*\]\s*/, ''));
  const addedSection = /## The parent added later\n((?:- .*\n?)+)/.exec(prompt)?.[1] ?? '';
  const extraFromPrompt = [...addedSection.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
  const added = [...new Set([...supplements, ...extraFromPrompt])];
  const report = (summary: string, status: 'done' | 'failed' = 'done'): ChatReply => ({ tool_calls: [{ name: 'report', args: { status, summary: added.length && status === 'done' ? `${summary}\n\n（已按补充处理：${added.join('；')}）` : summary } }] });
  const isCheap = req.model.includes('deepseek');

  if (/很难|太难|hard/.test(prompt) && isCheap) return report('这个任务太难了，便宜档搞不定：需要多步推理。', 'failed');

  if (/活动|events/i.test(prompt)) {
    if (steps === 0) return { tool_calls: [{ name: 'browser_open', args: { url: `${mock.shopUrl}/events` } }] };
    const rows = lastTool(req).split('\n').filter((l) => /\tYes$|Yes$/.test(l) && /Sat|Sun/.test(l));
    const list = rows.map((r) => '- ' + r.replace(/\t/g, ' · ').replace(/ · Yes$/, '')).join('\n');
    const budget = added.some((a) => /预算|budget/.test(a)) ? '\n\n预算：全部免费或每个孩子 $12 以内，两天总共不超过 $24。' : '';
    return report(`这周末适合带小孩的活动：\n${list}${budget}`);
  }

  if (/邮件|email/i.test(prompt) && /餐厅|restaurant/.test(prompt)) {
    if (steps === 0) return { tool_calls: [{ name: 'mail_send', args: { to: 'reservations@goldengate-dimsum.example', subject: 'Private room for 6 on Saturday?', text: 'Hello! I am Fox, an AI agent writing on behalf of Dongyu. Do you have a private room for 6 people this Saturday around 7pm? Thank you.' } }] };
    return report('已经用我的邮箱给 Golden Gate Dim Sum 发了邮件，问周六晚上 7 点 6 人包间。等他们回信我会告诉你。');
  }

  if (/电话|call/i.test(prompt)) {
    if (steps === 0) return { tool_calls: [{ name: 'call', args: { to: '+14155550199', purpose: 'Ask if a private room for 6 is available this Saturday at 7pm and hold it under Dongyu.' } }] };
    let call: { summary?: string; transcript?: string; status?: string } = {};
    try {
      call = JSON.parse(lastTool(req));
    } catch {}
    return report(`打完电话了（${call.status ?? '?'}）。\n${call.summary ?? ''}\n\n通话记录：\n${call.transcript ?? ''}`);
  }

  if (/充值|top up/i.test(prompt)) {
    if (steps === 0) return { tool_calls: [{ name: 'pay', args: { merchant_name: 'OpenRouter', merchant_url: 'https://openrouter.ai/settings/credits', amount_cents: 500, context: 'Top up my own OpenRouter credits ($5) so I can keep thinking this month.', test: true } }] };
    const t = lastTool(req);
    const status = /"status":\s*"(\w+)"/.exec(t)?.[1];
    const last4 = /"last4":\s*"(\d+)"/.exec(t)?.[1];
    return report(status === 'approved' ? `Link 批准了 $5.00 的一次性卡（尾号 ${last4}）。测试模式，没有真的扣钱。` : `付款没成：${t.slice(0, 200)}`, status === 'approved' ? 'done' : 'failed');
  }

  if (/蛋糕|cake|下单|order/i.test(prompt)) {
    const needsFlavor = /生日蛋糕/.test(prompt) && !/抹茶|matcha/i.test(prompt + added.join(''));
    const asked = req.messages.some((m) => m.tool_calls?.some((t) => t.function.name === 'ask'));
    if (needsFlavor && !asked) return { tool_calls: [{ name: 'ask', args: { question: '蛋糕要什么口味？几个人吃？' } }] };
    const opened = req.messages.some((m) => m.tool_calls?.some((t) => t.function.name === 'browser_open'));
    if (!opened) return { tool_calls: [{ name: 'browser_open', args: { url: `${mock.shopUrl}/order` } }] };
    const filled = req.messages.some((m) => m.tool_calls?.some((t) => t.function.name === 'browser_click'));
    const snap = lastTool(req);
    if (!filled) {
      return {
        tool_calls: [
          { name: 'browser_type', args: { ref: refFor(snap, /name=name/), text: 'Fox (for Dongyu)' } },
          { name: 'browser_type', args: { ref: refFor(snap, /name=email/), text: 'fox@example.com' } },
          { name: 'browser_select', args: { ref: refFor(snap, /name=item/), value: 'matcha-cake' } },
          { name: 'browser_type', args: { ref: refFor(snap, /name=note/), text: 'Happy birthday! Pickup Saturday 5pm' } },
          { name: 'browser_click', args: { ref: refFor(snap, /button "Place order"/) } },
        ],
      };
    }
    const order = /Order number\s*\n?\s*(FB-\d+)/.exec(snap)?.[1] ?? /(FB-\d+)/.exec(snap)?.[1];
    return report(order ? `蛋糕订好了：抹茶生日蛋糕（8 人份）$42.00，订单号 ${order}，周六 5 点取，到店付款。` : `没找到订单号：${snap.slice(0, 300)}`, order ? 'done' : 'failed');
  }

  return report(`完成：${(/^# Task \w+: (.*)$/m.exec(prompt)?.[1] ?? '任务')}。`);
}
