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
    name: 'resources',
    description: 'Your resources: accounts, tokens, cloud projects, the wallet… with origin (given by the parent / made by you), access and status. Read-only for you.',
    parameters: obj({}),
    async run(c) {
      const { resources } = await c.get<{ resources: { id: string; label: string; handle?: string; origin: string; access: string; status: string; method: string; secretFields: string[] }[] }>('/v1/resources');
      if (!resources.length) return 'No resources yet.';
      return resources
        .map((r) => `${r.id}: ${r.label}${r.handle ? ` (${r.handle})` : ''} · ${r.origin === 'self' ? 'made by you' : 'given by the parent'} · ${r.access} · ${r.status}${r.secretFields.length ? ` · fields: ${r.secretFields.join(', ')}` : ''}${r.method === 'browser' ? ' · signed in in your browser' : ''}`)
        .join('\n');
    },
  },
  {
    name: 'resource_get',
    description: 'Read one credential field of a resource (e.g. token, password, login) when a task needs it. Every read is audited.',
    parameters: obj({ id: str('Resource id from `resources`'), field: str('Field, e.g. token or password (default: the first secret field)') }, ['id']),
    run: async (c, a) => (await c.post<{ value: string }>(`/v1/resources/${encodeURIComponent(String(a.id))}/secret`, { field: a.field, runId: c.runId, taskId: c.taskId })).value,
  },
  {
    name: 'resource_otp',
    description: 'The current two-step (TOTP) code for a resource the parent gave you with a two-step key.',
    parameters: obj({ id: str('Resource id') }, ['id']),
    run: async (c, a) => (await c.post<{ code: string }>(`/v1/resources/${encodeURIComponent(String(a.id))}/otp`, { runId: c.runId })).code,
  },
  {
    name: 'resource_add',
    description: 'Record a resource you created yourself (a repo, a deployment, a database, a domain…), ideally with the resource it was built on as parent. You cannot change or remove existing resources.',
    parameters: obj({ kind: str('Catalog kind, e.g. github, supabase, domain, custom'), label: str('What it is'), handle: str('Its name/URL/id'), parent: str('Id of the resource it was built on'), note: str('Anything worth knowing') }, ['kind', 'label']),
    run: async (c, a) => text((await c.post<{ resource: unknown }>('/v1/resources', { kind: a.kind, label: a.label, handle: a.handle, parent: a.parent, note: a.note, taskId: c.taskId })).resource),
  },
  {
    name: 'resource_request',
    description: 'Ask the parent for a root only a human can give: a signup on a human-only platform, money, or legal identity. They get a Telegram message pointing to the control plane.',
    parameters: obj({ kind: str('Catalog kind, e.g. cloudflare, github, stripe'), why: str('What you need it for, in the parent’s language') }, ['kind', 'why']),
    async run(c, a) {
      await c.post('/v1/resources/request', { kind: a.kind, why: a.why, taskId: c.taskId });
      return 'asked the parent';
    },
  },
  {
    name: 'parent_legal',
    description: "The parent's registrant details (name, address, email, phone) — only for registrations that legally need a registrant, such as a domain. Audited.",
    parameters: obj({}),
    run: async (c) => text((await c.post<{ legal: unknown }>('/v1/parent/legal', { runId: c.runId, taskId: c.taskId })).legal ?? 'The parent has not given registrant details yet; use resource_request with kind "legal".'),
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
