import path from 'node:path';
import { configureLogs, loggedFetch } from '../core/log.ts';
import { PROJECT_ROOT, vfRoot } from '../core/paths.ts';
import { KeyFileStore, type SecretStore } from '../core/secrets.ts';
import { color as C, TerminalPrompter, type Prompter } from '../onboarding/prompter.ts';

/**
 * `vf keys`: the parent types keys once (hidden), each is checked live against
 * the real service, and stored in the local key file (`.env.local`, 0600, gitignored;
 * editing it by hand works too). `vf init` then offers them, so nobody pastes secrets into a chat.
 */

export interface KeyCheck {
  ok: boolean;
  detail: string;
}

interface KeySpec {
  name: string;
  label: string;
  where: string;
  check: (key: string) => Promise<KeyCheck>;
}

const OPENROUTER = process.env.VF_OPENROUTER_API ?? 'https://openrouter.ai/api/v1';

async function json(service: string, url: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await loggedFetch(service, url, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

function errMsg(body: Record<string, unknown>): string {
  const e = body.error as { message?: string } | string | undefined;
  return String((typeof e === 'object' ? e?.message : e) ?? body.message ?? body.detail ?? body.description ?? body.raw ?? 'error').split('\n')[0].slice(0, 160);
}

export async function checkOpenRouter(key: string): Promise<KeyCheck> {
  const info = await json('openrouter', `${OPENROUTER}/key`, { headers: { authorization: `Bearer ${key}` } });
  if (info.status !== 200) return { ok: false, detail: `key 无效：${errMsg(info.body)}` };
  const d = (info.body.data ?? {}) as { usage?: number; limit?: number | null; label?: string };
  const parts = [`key「${d.label ?? '?'}」已用 $${(d.usage ?? 0).toFixed(2)}${d.limit != null ? ` / 上限 $${d.limit}` : '（没设上限）'}`];
  let anyOk = false;
  for (const model of ['deepseek/deepseek-v4.1-flash', 'anthropic/claude-sonnet-5.5']) {
    const r = await json('openrouter', `${OPENROUTER}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'vibefox' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], max_tokens: 8 }),
    });
    const ok = r.status === 200 && Array.isArray(r.body.choices);
    anyOk ||= ok;
    parts.push(`${ok ? '✔' : '✘'} ${model}${ok ? '' : `：${/guardrail/i.test(errMsg(r.body)) ? '被 guardrail 挡住' : errMsg(r.body)}`}`);
  }
  return { ok: anyOk, detail: parts.join('；') };
}

export const KEY_SPECS: KeySpec[] = [
  { name: 'openrouter_api_key', label: 'OpenRouter API key', where: 'https://openrouter.ai/settings/keys', check: checkOpenRouter },
  {
    name: 'anthropic_api_key',
    label: 'Anthropic API key（可选）',
    where: 'https://console.anthropic.com/settings/keys',
    check: async (key) => {
      const r = await json('anthropic', `${process.env.VF_ANTHROPIC_API ?? 'https://api.anthropic.com'}/v1/models?limit=1`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
      return r.status === 200 ? { ok: true, detail: 'key 有效' } : { ok: false, detail: errMsg(r.body) };
    },
  },
  {
    name: 'deepseek_api_key',
    label: 'DeepSeek API key（可选）',
    where: 'https://platform.deepseek.com/api_keys',
    check: async (key) => {
      const r = await json('deepseek', `${process.env.VF_DEEPSEEK_API ?? 'https://api.deepseek.com'}/models`, { headers: { authorization: `Bearer ${key}` } });
      return r.status === 200 ? { ok: true, detail: 'key 有效' } : { ok: false, detail: errMsg(r.body) };
    },
  },
  {
    name: 'telegram_bot_token',
    label: 'Telegram bot token',
    where: 'Telegram 里找 @BotFather，发 /newbot',
    check: async (token) => {
      const r = await json('telegram', `${process.env.VF_TELEGRAM_API ?? 'https://api.telegram.org'}/bot${token}/getMe`);
      const me = r.body.result as { username?: string } | undefined;
      return r.status === 200 && me ? { ok: true, detail: `bot @${me.username}` } : { ok: false, detail: errMsg(r.body) };
    },
  },
  {
    name: 'agentmail_api_key',
    label: 'AgentMail API key',
    where: 'https://console.agentmail.to',
    check: async (key) => {
      const r = await json('agentmail', `${process.env.VF_AGENTMAIL_API ?? 'https://api.agentmail.to/v0'}/inboxes?limit=5`, { headers: { authorization: `Bearer ${key}` } });
      return r.status === 200 ? { ok: true, detail: `已有 ${Number(r.body.count ?? 0)} 个收件箱` } : { ok: false, detail: errMsg(r.body) };
    },
  },
  {
    name: 'agentphone_api_key',
    label: 'AgentPhone API key',
    where: 'https://agentphone.ai（送 $5）',
    check: async (key) => {
      const r = await json('agentphone', `${process.env.VF_AGENTPHONE_API ?? 'https://api.agentphone.ai/v1'}/numbers?limit=5&offset=0`, { headers: { authorization: `Bearer ${key}` } });
      return r.status === 200 ? { ok: true, detail: `已有 ${(r.body.data as unknown[] | undefined)?.length ?? 0} 个号码` } : { ok: false, detail: errMsg(r.body) };
    },
  },
];

/** The parent's key file: `.env.local` in the checkout unless VF_KEYS_FILE says otherwise. */
export function keysFile(): string {
  return process.env.VF_KEYS_FILE ?? path.join(PROJECT_ROOT, '.env.local');
}

/** Keys from `vf keys` or the key file, offered to every agent born on this Mac (each copies its own into its keychain). */
export function setupKeys(): SecretStore {
  return new KeyFileStore(keysFile());
}

export const tail = (s: string) => `…${s.slice(-4)}`;

export async function runKeys(opts: { only?: string[]; check?: boolean; prompter?: Prompter } = {}): Promise<void> {
  configureLogs(path.join(vfRoot(), 'setup-logs'));
  const store = setupKeys();
  const p = opts.prompter ?? new TerminalPrompter();
  const specs = KEY_SPECS.filter((s) => !opts.only?.length || opts.only.some((o) => s.name.startsWith(o)));
  p.say(C.bold('🔑 vibefox keys') + C.dim(`  —  输入时不显示；回车跳过；每个都会当场去真实服务验证，存进本地 key 文件 ${keysFile()}（0600，不进 git）`));
  for (const spec of specs) {
    let key = store.get(spec.name);
    if (!opts.check) {
      p.say('');
      p.say(`${C.bold(spec.label)}  ${C.dim(spec.where)}${key ? C.dim(`  已存：${tail(key)}，回车保留`) : ''}`);
      const typed = await p.secret(spec.name, '粘贴');
      if (typed) key = typed;
    }
    if (!key) {
      if (opts.check) p.say(`${C.dim('·')} ${spec.label}：没有`);
      continue;
    }
    let res: KeyCheck;
    try {
      res = await spec.check(key);
    } catch (err) {
      res = { ok: false, detail: `连不上：${(err as Error).message}` };
    }
    p.say(`${res.ok ? C.green('✔') : C.red('✘')} ${spec.label} ${tail(key)}  ${res.detail}`);
    if (!opts.check) store.set(spec.name, key);
  }
  p.say('');
  p.say(C.dim(`验证请求的日志（已脱敏）：${path.join(vfRoot(), 'setup-logs', 'api')}`));
  if (!opts.check) p.say(`下一步：${C.bold('./bin/vf init')} ——它会直接用这些 key。`);
  p.close();
}
