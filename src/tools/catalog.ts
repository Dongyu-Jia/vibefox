import type { DaemonClient } from '../cli/client.ts';
import type { ToolDef } from '../llm/types.ts';

/**
 * The one tool catalog. The builtin harness exposes it as function tools, the
 * MCP server as MCP tools, and the `vf` CLI as subcommands — so every harness
 * really does get the same capabilities.
 */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(client: DaemonClient, args: Record<string, unknown>): Promise<string>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });

const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export const TOOLS: ToolSpec[] = [
  {
    name: 'ask',
    description: 'Ask the router (the agent itself) a question you cannot answer yourself. Blocks until answered; the router may ask the parent.',
    parameters: obj({ question: str('The question') }, ['question']),
    async run(c, a) {
      const { questionId } = await c.post<{ questionId: string }>(c.runPath('ask'), { question: a.question });
      for (;;) {
        const q = await c.get<{ status: string; answer?: string }>(`/v1/questions/${questionId}?wait=45`);
        if (q.status === 'answered') return q.answer ?? '';
      }
    },
  },
  {
    name: 'progress',
    description: 'Post a short progress note that the parent can see.',
    parameters: obj({ text: str('One short line') }, ['text']),
    async run(c, a) {
      await c.post(c.runPath('progress'), { text: a.text });
      return 'ok';
    },
  },
  {
    name: 'report',
    description: 'Finish the task. The summary is what the parent will read, so make it complete. Use status "failed" with the reason if you could not do it.',
    parameters: obj({ status: { type: 'string', enum: ['done', 'failed'] }, summary: str('Full result or failure reason') }, ['status', 'summary']),
    async run(c, a) {
      await c.post(c.runPath('report'), { status: a.status, summary: a.summary, costUsd: a.costUsd });
      return 'Reported. Stop now.';
    },
  },
  {
    name: 'browser_open',
    description: 'Open a URL in your own browser. Returns a snapshot listing interactive elements as [refs] plus visible text.',
    parameters: obj({ url: str('Absolute URL') }, ['url']),
    run: async (c, a) => (await c.post<{ snapshot: string }>('/v1/browser/open', { url: a.url })).snapshot,
  },
  {
    name: 'browser_snapshot',
    description: 'Re-read the current page (refs + visible text).',
    parameters: obj({}),
    run: async (c) => (await c.post<{ snapshot: string }>('/v1/browser/snapshot', {})).snapshot,
  },
  {
    name: 'browser_click',
    description: 'Click an element by its ref from the latest snapshot, e.g. "e12".',
    parameters: obj({ ref: str('Element ref') }, ['ref']),
    run: async (c, a) => (await c.post<{ snapshot: string }>('/v1/browser/click', { ref: a.ref })).snapshot,
  },
  {
    name: 'browser_type',
    description: 'Fill an input or textarea by ref. Set submit=true to press Enter afterwards.',
    parameters: obj({ ref: str('Element ref'), text: str('Text to type'), submit: { type: 'boolean' } }, ['ref', 'text']),
    run: async (c, a) => (await c.post<{ snapshot: string }>('/v1/browser/type', { ref: a.ref, text: a.text, submit: a.submit })).snapshot,
  },
  {
    name: 'browser_select',
    description: 'Choose an option in a <select> by ref.',
    parameters: obj({ ref: str('Element ref'), value: str('Option value or label') }, ['ref', 'value']),
    run: async (c, a) => (await c.post<{ snapshot: string }>('/v1/browser/select', { ref: a.ref, value: a.value })).snapshot,
  },
  {
    name: 'browser_press',
    description: 'Press a keyboard key, e.g. Enter, Escape, PageDown.',
    parameters: obj({ key: str('Key name') }, ['key']),
    run: async (c, a) => (await c.post<{ snapshot: string }>('/v1/browser/press', { key: a.key })).snapshot,
  },
  {
    name: 'browser_wait',
    description: 'Wait for a page that renders late: until the given text shows up (or just N seconds), then return a fresh snapshot. Use it instead of snapshotting again and again.',
    parameters: obj({ text: str('Text to wait for (optional)'), seconds: { type: 'number', description: 'Max seconds to wait, default 15, at most 60' } }),
    run: async (c, a) => (await c.post<{ snapshot: string }>('/v1/browser/wait', { text: a.text, seconds: a.seconds })).snapshot,
  },
  {
    name: 'browser_back',
    description: 'Go back one page.',
    parameters: obj({}),
    run: async (c) => (await c.post<{ snapshot: string }>('/v1/browser/back', {})).snapshot,
  },
  {
    name: 'browser_screenshot',
    description: 'Save a screenshot of the current page; returns the file path.',
    parameters: obj({ path: str('Optional output path') }),
    run: async (c, a) => (await c.post<{ path: string }>('/v1/browser/screenshot', { path: a.path, runId: c.runId })).path,
  },
  {
    name: 'mail_send',
    description: 'Send an email from your own address. Say you are an AI agent and on whose behalf you write.',
    parameters: obj({ to: str('Recipient address'), subject: str('Subject'), text: str('Plain-text body') }, ['to', 'subject', 'text']),
    run: async (c, a) => text(await c.post('/v1/mail/send', { ...a, taskId: c.taskId })),
  },
  {
    name: 'mail_list',
    description: 'List recent emails in your inbox.',
    parameters: obj({ limit: { type: 'number' } }),
    run: async (c, a) => text(await c.get(`/v1/mail/messages?limit=${Number(a.limit ?? 10)}`)),
  },
  {
    name: 'mail_read',
    description: 'Read one email by id.',
    parameters: obj({ id: str('Message id') }, ['id']),
    run: async (c, a) => text(await c.get(`/v1/mail/messages/${encodeURIComponent(String(a.id))}`)),
  },
  {
    name: 'mail_reply',
    description: 'Reply to an email in its thread.',
    parameters: obj({ id: str('Message id'), text: str('Reply body') }, ['id', 'text']),
    run: async (c, a) => text(await c.post('/v1/mail/reply', { messageId: a.id, text: a.text, taskId: c.taskId })),
  },
  {
    name: 'sms_send',
    description: 'Send an SMS from your own phone number.',
    parameters: obj({ to: str('E.164 number, e.g. +15551234567'), text: str('Message') }, ['to', 'text']),
    run: async (c, a) => text(await c.post('/v1/sms/send', { ...a, taskId: c.taskId })),
  },
  {
    name: 'sms_list',
    description: 'List recent SMS messages on your number.',
    parameters: obj({}),
    run: async (c) => text(await c.get('/v1/sms/messages')),
  },
  {
    name: 'sms_codes',
    description: 'Recent verification codes received by SMS or email.',
    parameters: obj({}),
    run: async (c) => text(await c.get('/v1/codes')),
  },
  {
    name: 'call',
    description: 'Place a phone call as yourself. You state the purpose; your voice says you are an AI agent. Waits until the call ends and returns the transcript.',
    parameters: obj({ to: str('E.164 number'), purpose: str('What to find out or arrange, with any details needed') }, ['to', 'purpose']),
    run: async (c, a) => text(await c.op('/v1/calls', { ...a, taskId: c.taskId })),
  },
  {
    name: 'pay',
    description: 'Spend money within your mandate via your Stripe Link wallet. Returns a one-time card (file path + last4) once approved. amount_cents is an integer.',
    parameters: obj(
      {
        merchant_name: str('Merchant name'),
        merchant_url: str('Merchant URL'),
        amount_cents: { type: 'number', description: 'Amount in cents' },
        context: str('What you buy and why (for the parent)'),
        test: { type: 'boolean', description: 'Test mode: no real money' },
      },
      ['merchant_name', 'merchant_url', 'amount_cents', 'context'],
    ),
    run: async (c, a) =>
      text(
        await c.op('/v1/pay', {
          merchantName: a.merchant_name,
          merchantUrl: a.merchant_url,
          amountCents: Number(a.amount_cents),
          context: a.context,
          test: Boolean(a.test),
          taskId: c.taskId,
        }),
      ),
  },
  {
    name: 'identity',
    description: 'Your identities (email, phone, wallet, keys…) and their status.',
    parameters: obj({}),
    run: async (c) => text(await c.get('/v1/identity/summary')),
  },
  {
    name: 'remember',
    description: 'Save a fact to your long-term memory.',
    parameters: obj({ fact: str('The fact') }, ['fact']),
    async run(c, a) {
      await c.post('/v1/memory', { fact: a.fact });
      return 'remembered';
    },
  },
  {
    name: 'journal',
    description: "Add a note to today's journal.",
    parameters: obj({ text: str('Note') }, ['text']),
    async run(c, a) {
      await c.post('/v1/journal', { text: a.text });
      return 'noted';
    },
  },
];

export function toolDefs(specs: ToolSpec[] = TOOLS): ToolDef[] {
  return specs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function toolByName(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}
