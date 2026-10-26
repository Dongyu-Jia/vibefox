import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramChannel, TelegramError } from '../channels/telegram.ts';
import { Body, defaultConfig, defaultRouting, defaultSoul, type AgentConfig, type IdentityRecord, type LegalProfile, type Mandate, type WorkerSpec } from '../core/body.ts';
import { detectHarnesses, type HarnessDetection } from './detect.ts';
import { configureLogs, loggedFetch } from '../core/log.ts';
import { agentsDir, setCurrentAgent, slugify } from '../core/paths.ts';
import type { SecretStore } from '../core/secrets.ts';
import { AgentMail, AgentMailError, type Inbox } from '../identity/agentmail.ts';
import { AgentPhone, AgentPhoneError, type PhoneNumber } from '../identity/agentphone.ts';
import { openSelfIdentities, openSigningKey } from '../identity/selfmade.ts';
import { resolveModel, type Provider } from '../llm/index.ts';
import { LinkWallet } from '../wallet/link.ts';
import { archiveMandate, BLOCKED_CATEGORIES, createMandate, fmtCents, mandateRevision, SPEND_CATEGORIES } from '../wallet/mandate.ts';

export type { LegalProfile } from '../core/body.ts';

/**
 * Every onboarding step as a plain function with explicit input: the terminal
 * wizard asks the questions and calls these, the local UI posts a form and
 * calls the same ones — so both write exactly the same identity records,
 * secrets, levels and config.
 */

/** Something the parent typed is wrong or missing. `message` is shown to them as is (HTTP 400). */
export class StepError extends Error {
  status = 400;
}

const now = () => new Date().toISOString();

/** A 4xx from a service the parent's key talks to is the parent's to fix, not a crash. */
function asStepError(err: unknown, what: string): unknown {
  if ((err instanceof AgentMailError || err instanceof AgentPhoneError) && err.status >= 400 && err.status < 500) return new StepError(`${what}：${err.message}`);
  return err;
}

function required(value: string | undefined, label: string): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new StepError(`需要${label}`);
  return v;
}

// ---------------- Lv0 birth ----------------

export interface BirthInput {
  name: string;
  parentName: string;
  /** A SOUL_PRESETS key or a few sentences of its own. Default: curious. */
  soul?: string;
  /** Merged into config.json at birth (tests point services at local mocks). */
  configOverrides?: Partial<AgentConfig>;
}

export async function bornAgent(input: BirthInput): Promise<Body> {
  return (await birthAgent(input)).body;
}

/** bornAgent, plus the identities it opened entirely by itself (the wizard lists them). */
export async function birthAgent(input: BirthInput): Promise<{ body: Body; opened: string[] }> {
  const name = required(input.name, '一个名字');
  const parentName = (typeof input.parentName === 'string' ? input.parentName.trim() : '') || os.userInfo().username;
  const slug = slugify(name);
  const body = Body.create(path.join(agentsDir(), slug));
  configureLogs(body.paths.logs);
  if (!body.exists()) {
    body.saveIdentity({ name, slug, bornAt: now(), parent: { name: parentName }, identities: {} });
  } else {
    body.updateIdentity((id) => {
      id.name = name;
      id.parent.name = parentName;
    });
  }
  body.saveSoul(defaultSoul(name, input.soul?.trim() || 'curious'));
  if (!fs.existsSync(body.paths.routing)) body.saveRouting(defaultRouting(), 'born');
  const overrides = input.configOverrides;
  const cfg = { ...defaultConfig(), ...(overrides ?? {}) } as AgentConfig;
  if (overrides) {
    for (const k of Object.keys(overrides) as (keyof AgentConfig)[]) {
      const v = overrides[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) (cfg as unknown as Record<string, unknown>)[k] = { ...(defaultConfig()[k] as object), ...(v as object) };
    }
  }
  body.saveConfig(cfg);
  setCurrentAgent(slug);
  const opened = openSelfIdentities(body);
  body.markLevel('birth');
  return { body, opened };
}

// ---------------- Lv1 brain ----------------

export const BRAIN_PROVIDERS: Provider[] = ['openrouter', 'anthropic', 'deepseek'];

export const TIER_CANDIDATES: Record<Provider, { cheap: string; mid: string; strong: string }> = {
  openrouter: { cheap: 'openrouter:deepseek/deepseek-v4.1-flash', mid: 'openrouter:anthropic/claude-sonnet-5.5', strong: 'openrouter:anthropic/claude-opus-5.5' },
  anthropic: { cheap: 'anthropic:claude-haiku-5-5', mid: 'anthropic:claude-sonnet-5-5', strong: 'anthropic:claude-opus-5-5' },
  deepseek: { cheap: 'deepseek:deepseek-v4-flash', mid: 'deepseek:deepseek-v4-pro', strong: 'deepseek:deepseek-v4-pro' },
};

export async function testModel(spec: string, cfg: AgentConfig, secrets: SecretStore): Promise<{ ok: boolean; detail: string }> {
  try {
    const m = resolveModel(spec, cfg, secrets);
    const r = await m.chat({ messages: [{ role: 'user', content: 'Reply with the single word: ready' }], maxTokens: 8, tag: 'onboarding.test' });
    return { ok: true, detail: r.content.trim().slice(0, 40) || 'ok' };
  } catch (err) {
    const msg = String((err as Error).message);
    if (/guardrail/i.test(msg)) return { ok: false, detail: 'OpenRouter 的防护规则（guardrail）屏蔽了这个模型或供应商，可以在 https://openrouter.ai/settings/privacy 或工作区 guardrails 里放开' };
    return { ok: false, detail: msg.slice(0, 200) };
  }
}

/** An OpenRouter key's spend so far and its limit (the agent's "brain budget"). */
export async function keyInfo(cfg: AgentConfig, key: string): Promise<{ usage: number; limit: number | null } | undefined> {
  try {
    const res = await loggedFetch('openrouter', `${cfg.services.openrouter.replace(/\/$/, '')}/key`, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { data: { usage: number; limit: number | null } };
    return { usage: j.data.usage ?? 0, limit: j.data.limit ?? null };
  } catch {
    return undefined;
  }
}

export interface BrainResult {
  ok: boolean;
  detail: string;
  /** The router model after this step (unchanged when no model answered). */
  routerModel: string;
  routerChanged: boolean;
  models: Record<string, { ok: boolean; detail: string }>;
  keyInfo?: { usage: number; limit: number | null };
}

/**
 * Stores `<provider>_api_key`, tests the provider's mid and cheap models and
 * records `brain_<provider>`. The router talks on every message, so it (and the
 * voice) use the cheap model (DeepSeek v4.1 flash on OpenRouter) when it answers.
 */
export async function connectBrain(body: Body, secrets: SecretStore, input: { provider: Provider; key: string }): Promise<BrainResult> {
  const provider = input.provider;
  if (!BRAIN_PROVIDERS.includes(provider)) throw new StepError(`不认识的模型供应商：${String(provider)}`);
  const key = required(input.key, ` ${provider} API key`);
  const cfg = body.config();
  const name = `${provider}_api_key`;
  const previous = secrets.get(name);
  // Test the new key before it replaces anything: a typo must not knock out a working brain.
  const trial: SecretStore = { kind: secrets.kind, get: (n) => (n === name ? key : secrets.get(n)), set: (n, v) => secrets.set(n, v), delete: (n) => secrets.delete(n) };
  const cand = TIER_CANDIDATES[provider];
  const specs = [...new Set([cand.mid, cand.cheap])];
  const tested = await Promise.all(specs.map((spec) => testModel(spec, cfg, trial)));
  const results: Record<string, { ok: boolean; detail: string }> = {};
  specs.forEach((spec, i) => (results[spec] = tested[i]));
  const anyOk = tested.some((r) => r.ok);
  if (!anyOk && previous && previous !== key) {
    const why = specs.map((spec) => `✘ ${spec}：${results[spec].detail}`).join('；');
    return { ok: false, detail: `新 key 没通过，还在用原来的（…${previous.slice(-4)}）。${why}`, routerModel: cfg.router.model, routerChanged: false, models: results };
  }
  secrets.set(name, key);
  body.setIdentityRecord(`brain_${provider}`, {
    status: anyOk ? 'open' : 'failed',
    value: `${provider} key …${key.slice(-4)}`,
    provider,
    openedBy: 'parent',
    openedAt: now(),
    note: anyOk ? undefined : Object.values(results)[0]?.detail,
    details: { models: results },
  });
  const info = provider === 'openrouter' ? await keyInfo(cfg, key) : undefined;
  const routerSpec = results[cand.cheap]?.ok ? cand.cheap : results[cand.mid]?.ok ? cand.mid : undefined;
  if (routerSpec) {
    body.updateConfig((c) => {
      c.router.model = routerSpec;
      c.voiceModel = results[cand.cheap]?.ok ? cand.cheap : routerSpec;
    });
    body.markLevel('brain');
    addWorkers(body, secrets, NO_HARNESSES);
  }
  const lines = specs.map((spec) => `${results[spec].ok ? '✔' : '✘'} ${spec}${results[spec].ok ? '' : `：${results[spec].detail}`}`);
  if (info) lines.push(`key 已用 $${info.usage.toFixed(2)}${info.limit != null ? ` / 上限 $${info.limit}` : '（没设上限）'}`);
  return { ok: anyOk, detail: lines.join('；'), routerModel: body.config().router.model, routerChanged: Boolean(routerSpec), models: results, keyInfo: info };
}


// ---------------- Lv1 workers ----------------

export type WorkerCandidate = WorkerSpec & { why: string };

/** The workers this Mac can run: builtin ones for each model key the agent holds, plus every harness found. */
export function workerCandidates(body: Body, secrets: SecretStore, det: HarnessDetection): WorkerCandidate[] {
  const brains = body.identity().identities;
  const okModels = (prov: Provider) => (brains[`brain_${prov}`]?.details?.models ?? {}) as Record<string, { ok: boolean }>;
  const candidates: (WorkerSpec & { why: string })[] = [];
  for (const prov of ['openrouter', 'anthropic', 'deepseek'] as Provider[]) {
    if (!secrets.get(`${prov}_api_key`)) continue;
    const cand = TIER_CANDIDATES[prov];
    const ok = okModels(prov);
    candidates.push({ id: `builtin-${prov}-cheap`, label: `便宜档 · ${cand.cheap.split(':')[1]}`, harness: 'builtin', model: cand.cheap, tier: 1, enabled: ok[cand.cheap]?.ok !== false, description: '便宜：重复性的杂活、查资料、整理', why: ok[cand.cheap]?.ok === false ? '测试没通过' : '' });
    candidates.push({ id: `builtin-${prov}-mid`, label: `中档 · ${cand.mid.split(':')[1]}`, harness: 'builtin', model: cand.mid, tier: 2, enabled: ok[cand.mid]?.ok !== false, description: '日常任务：写东西、发邮件、用浏览器办事', why: ok[cand.mid]?.ok === false ? '测试没通过' : '' });
  }
  if (det.opencode.installed && det.opencode.providers.length) {
    const prov = det.opencode.providers.includes('openrouter') ? 'openrouter' : det.opencode.providers[0];
    const model = prov === 'openrouter' ? 'openrouter/deepseek/deepseek-v4.1-flash' : `${prov}/default`;
    candidates.push({ id: 'opencode-deepseek', label: `OpenCode · ${model.split('/').slice(1).join('/')}`, harness: 'opencode', model, tier: 1, enabled: true, description: 'OpenCode harness，便宜模型，适合批量杂活', why: '' });
  }
  if (det.dsh.installed && (secrets.get('openrouter_api_key') || secrets.get('deepseek_api_key'))) {
    const model = secrets.get('openrouter_api_key') ? 'openrouter/deepseek/deepseek-v4.1-flash' : 'deepseek/deepseek-v4-flash';
    candidates.push({ id: 'deepseek-harness', label: `DeepSeek Harness（官方 dsh）· ${model.split('/').slice(-1)[0]}`, harness: 'dsh', model, tier: 1, enabled: true, description: 'DeepSeek 官方的 agent harness，便宜，适合杂活和网页任务', why: '' });
  }
  if (det.codewhale.installed && (secrets.get('openrouter_api_key') || secrets.get('deepseek_api_key'))) {
    const model = secrets.get('openrouter_api_key') ? 'openrouter/deepseek/deepseek-v4.1-flash' : 'deepseek/deepseek-v4-flash';
    candidates.push({ id: 'codewhale-deepseek', label: `Codewhale · ${model.split('/').slice(-1)[0]}`, harness: 'codewhale', model, tier: 1, enabled: true, description: 'DeepSeek 专用 harness（Codewhale），便宜，适合杂活和网页任务', why: '' });
  }
  if (det.claude.installed) {
    candidates.push({ id: 'claude-code', label: '最强档 · Claude Code (Opus)', harness: 'claude-code', model: 'opus', tier: 3, enabled: det.claude.loggedIn, description: '最难的任务：复杂的多步操作、写代码、难搞的网站', why: det.claude.loggedIn ? '' : '还没登录：运行 claude auth login' });
  }
  if (det.codex.works) {
    candidates.push({ id: 'codex', label: 'Codex', harness: 'codex', tier: 3, enabled: false, description: 'OpenAI Codex CLI', why: '' });
  }
  return candidates;
}

/** Records which harnesses this Mac has (the harness_* identities). */
export function recordHarnesses(body: Body, det: HarnessDetection): void {
  const now = new Date().toISOString();
  if (det.opencode.installed) {
    body.setIdentityRecord('harness_opencode', { status: det.opencode.providers.length ? 'open' : 'needs-parent', value: det.opencode.providers.join(', ') || undefined, provider: 'OpenCode', openedBy: 'parent', openedAt: now, note: det.opencode.providers.length ? undefined : 'opencode auth login' });
  }
  if (det.dsh.installed) body.setIdentityRecord('harness_deepseek', { status: 'open', value: 'dsh', provider: 'DeepSeek', openedBy: 'parent', openedAt: now });
  if (det.codewhale.installed) body.setIdentityRecord('harness_codewhale', { status: 'open', value: 'codewhale', provider: 'Codewhale', openedBy: 'parent', openedAt: now });
  if (det.claude.installed) {
    body.setIdentityRecord('harness_claude_code', { status: det.claude.loggedIn ? 'open' : 'needs-parent', value: det.claude.loggedIn ? det.claude.detail : undefined, provider: 'Anthropic', openedBy: 'parent', openedAt: now, note: det.claude.loggedIn ? undefined : 'claude auth login' });
  }
}

/**
 * Adds the workers this Mac can run that are not listed yet, keeping the
 * parent's on/off choices for the ones that are. `det` skips harness detection
 * (connectBrain only needs the builtin workers for its new key).
 */
export function addWorkers(body: Body, secrets: SecretStore, det?: HarnessDetection): { added: string[] } {
  const found = det ?? detectHarnesses();
  const existing = body.workers();
  const ids = new Set(existing.map((w) => w.id));
  const added = workerCandidates(body, secrets, found)
    .filter((c) => !ids.has(c.id))
    .map(({ why: _why, ...spec }) => spec);
  if (added.length) body.saveWorkers([...existing, ...added]);
  if (det === undefined) recordHarnesses(body, found);
  if (body.workers().some((w) => w.enabled)) body.markLevel('workers');
  return { added: added.map((w) => w.id) };
}

const NO_HARNESSES: HarnessDetection = { claude: { installed: false, loggedIn: false }, opencode: { installed: false, providers: [] }, codex: { installed: false, works: false }, dsh: { installed: false }, codewhale: { installed: false } };

// ---------------- Lv1 channel ----------------

export async function connectTelegram(body: Body, secrets: SecretStore, input: { token: string }): Promise<{ handle: string; claimUrl: string; bindCode: string }> {
  const token = required(input.token, ' Telegram bot token');
  const name = body.identity().name;
  const cfg = body.config();
  const tg = new TelegramChannel({ token, apiBase: cfg.channel.apiBase });
  let me: { handle: string; id: string };
  try {
    me = await tg.describe();
  } catch (err) {
    if (err instanceof TelegramError && err.code >= 400 && err.code < 500) throw new StepError(`Telegram 不认这个 token：${err.message}`.slice(0, 300));
    throw err;
  }
  secrets.set('telegram_bot_token', token);
  await tg.presentAs(name, `我是 ${name}，一个独立的 AI agent。我只接受我家长布置的任务。`);
  const code = crypto.randomBytes(4).toString('hex');
  const s = body.onboarding();
  s.bindCode = code;
  body.saveOnboarding(s);
  body.setIdentityRecord('telegram_bot', { status: 'open', value: me.handle, provider: 'Telegram', openedBy: 'parent', openedAt: now(), details: { botId: me.id } });
  body.markLevel('channel', 'waiting for /start');
  return { handle: me.handle, claimUrl: `https://t.me/${me.handle.replace(/^@/, '')}?start=${code}`, bindCode: code };
}

// ---------------- Lv2 email ----------------

function mailFor(body: Body, key: string): AgentMail {
  return new AgentMail({ apiKey: key, base: body.config().services.agentmail });
}

async function listInboxes(mail: AgentMail): Promise<Inbox[]> {
  try {
    return (await mail.listInboxes(10)).inboxes ?? [];
  } catch (err) {
    throw asStepError(err, 'AgentMail 不认这个 key');
  }
}

export async function emailOptions(body: Body, key: string): Promise<{ inboxes: { id: string; email: string }[] }> {
  const inboxes = await listInboxes(mailFor(body, required(key, ' AgentMail API key')));
  return { inboxes: inboxes.map((i) => ({ id: i.inbox_id, email: i.email ?? i.inbox_id })) };
}

/** `use`: an existing inbox (id or address). Otherwise the agent opens its own, named `username`. */
export async function openEmail(body: Body, secrets: SecretStore, input: { key: string; use?: string; username?: string }): Promise<IdentityRecord> {
  const key = required(input.key, ' AgentMail API key');
  const mail = mailFor(body, key);
  const id = body.identity();
  let inbox: Inbox | undefined;
  if (input.use) {
    inbox = (await listInboxes(mail)).find((i) => i.inbox_id === input.use || i.email === input.use);
    if (!inbox) throw new StepError(`找不到邮箱 ${input.use}`);
  }
  const created = !inbox;
  if (!inbox) {
    const username = input.username?.trim() || `${body.slug}-${crypto.randomBytes(2).toString('hex')}`;
    try {
      inbox = await mail.createInbox({ username, display_name: `${id.name} (AI agent)`, client_id: `vibefox-${body.slug}-${username}` });
    } catch (err) {
      throw asStepError(err, '没能开这个邮箱');
    }
  }
  secrets.set('agentmail_api_key', key);
  body.setIdentityRecord('email', { status: 'open', value: inbox.email ?? inbox.inbox_id, provider: 'AgentMail', openedBy: created ? 'self' : 'parent', openedAt: now(), details: { inboxId: inbox.inbox_id } });
  body.markLevel('email');
  return body.identity().identities.email;
}

// ---------------- Lv3 phone ----------------

function phoneFor(body: Body, key: string): AgentPhone {
  return new AgentPhone({ apiKey: key, base: body.config().services.agentphone });
}

async function listNumbers(ap: AgentPhone): Promise<PhoneNumber[]> {
  try {
    return (await ap.listNumbers()).data ?? [];
  } catch (err) {
    throw asStepError(err, 'AgentPhone 不认这个 key');
  }
}

export async function phoneOptions(body: Body, key: string): Promise<{ numbers: { id: string; phoneNumber: string }[] }> {
  const numbers = await listNumbers(phoneFor(body, required(key, ' AgentPhone API key')));
  return { numbers: numbers.map((n) => ({ id: n.id, phoneNumber: n.phoneNumber })) };
}

export interface OpenPhoneInput {
  key: string;
  /** An existing number (id or +1… number), attached to the agent's own voice agent at no extra cost. */
  use?: string;
  /** For a new number: three digits (US/Canada), or empty for any. */
  areaCode?: string;
  /**
   * The existing number could not be attached. Return an area code ('' = any) to
   * open a new number instead; without this callback openPhone throws.
   */
  onAttachFailed?: (message: string) => Promise<string>;
}

function areaCodeOf(v: string | undefined): string | undefined {
  const a = (v ?? '').trim();
  if (a && !/^\d{3}$/.test(a)) throw new StepError('区号是三位数字（美国/加拿大），或者留空');
  return a || undefined;
}

export async function openPhone(body: Body, secrets: SecretStore, input: OpenPhoneInput): Promise<IdentityRecord> {
  const key = required(input.key, ' AgentPhone API key');
  let areaCode = areaCodeOf(input.areaCode);
  const ap = phoneFor(body, key);
  const existing = await listNumbers(ap);
  let num: PhoneNumber | undefined;
  if (input.use) {
    num = existing.find((n) => n.id === input.use || n.phoneNumber === input.use);
    if (!num) throw new StepError(`找不到号码 ${input.use}`);
  }
  secrets.set('agentphone_api_key', key);
  const id = body.identity();
  const agent = await ap.createAgent({
    name: id.name,
    description: `${id.name}, an independent AI agent (parent: ${id.parent.name})`,
    voiceMode: 'hosted',
    systemPrompt: `You are ${id.name}, an independent AI agent. People who call this number reach you. Say you are an AI agent. Take a message: who they are, what they want, how to reach them. Do not make commitments, do not share personal data or payment details. Personality: ${body.soul().slice(0, 500)}`,
    beginMessage: `Hi, this is ${id.name}, an AI agent. How can I help?`,
  });
  if (num) {
    try {
      await ap.attachNumber(agent.id, num.id);
    } catch (err) {
      const message = `没能把 ${num.phoneNumber} 挂到它的语音 agent 上：${(err as Error).message}`;
      if (!input.onAttachFailed) throw new StepError(message);
      areaCode = areaCodeOf(await input.onAttachFailed(message));
      num = undefined;
    }
  }
  const createdNumber = !num;
  if (!num) {
    try {
      num = await ap.createNumber({ areaCode, agentId: agent.id });
    } catch (err) {
      throw asStepError(err, '没能开新号码');
    }
    if (!num.agentId) await ap.attachNumber(agent.id, num.id);
  }
  const at = now();
  body.setIdentityRecord('phone', { status: 'open', value: num.phoneNumber, provider: 'AgentPhone', openedBy: createdNumber ? 'self' : 'parent', openedAt: at, details: { numberId: num.id, agentId: agent.id, outboundSms: num.outboundSms } });
  body.setIdentityRecord('sms_codes', { status: 'open', value: num.phoneNumber, openedBy: 'self', openedAt: at });
  body.setIdentityRecord('voice', { status: 'open', value: 'AgentPhone hosted voice', openedBy: 'self', openedAt: at, details: { agentId: agent.id } });
  body.markLevel('phone');
  return body.identity().identities.phone;
}

// ---------------- Lv4 money: mandate ----------------

export const MANDATE_CONSENTS = ['我同意', 'yes', 'i agree'];

export function consentGiven(text: unknown): boolean {
  return typeof text === 'string' && MANDATE_CONSENTS.includes(text.trim().toLowerCase());
}

function cents(v: unknown, label: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || Math.round(n) <= 0) throw new StepError(`${label}必须是大于 0 的金额`);
  return Math.round(n);
}

/**
 * The parent signs (again): a new revision that points at the previous one,
 * which is kept in `<body>/mandate-history/<revision>.json`. The four scam
 * cash-out categories are always blocked. The agent countersigns with its own key.
 */
export function signMandate(body: Body, input: { monthlyCents: number; perTxCents: number; allowed: string[]; consent: string }): Mandate {
  const monthly = cents(input.monthlyCents, '每月额度');
  const perTx = cents(input.perTxCents, '单笔上限');
  if (perTx > monthly) throw new StepError(`单笔上限 ${fmtCents(perTx)} 不能超过每月额度 ${fmtCents(monthly)}`);
  const wanted = new Set(Array.isArray(input.allowed) ? input.allowed : []);
  for (const c of wanted) {
    if ((BLOCKED_CATEGORIES as readonly string[]).includes(c)) throw new StepError(`授权书永远不允许 ${c}`);
    if (!(SPEND_CATEGORIES as readonly string[]).includes(c)) throw new StepError(`不认识的类别：${c}`);
  }
  if (!consentGiven(input.consent)) throw new StepError('需要你签字：输入"我同意"');
  const allowed = SPEND_CATEGORIES.filter((c) => wanted.has(c));
  // The agent countersigns with its own key; open it if birth didn't.
  if (!fs.existsSync(path.join(body.paths.keys, 'signing_ed25519.pem'))) body.setIdentityRecord('signing_key', openSigningKey(body));
  const id = body.identity();
  const previous = body.mandate();
  if (previous) archiveMandate(body, previous);
  const m = createMandate(body, {
    monthlyLimitCents: monthly,
    perTransactionLimitCents: perTx,
    allowedCategories: allowed,
    blockedCategories: [...BLOCKED_CATEGORIES],
    parentName: id.parent.name,
    revision: previous ? mandateRevision(previous) + 1 : 1,
    previousHash: previous?.hash,
  });
  body.saveMandate(m);
  body.setIdentityRecord('mandate', { status: 'open', value: `${fmtCents(monthly)}/月，单笔 ${fmtCents(perTx)}`, openedBy: 'parent', openedAt: m.signedAt, details: { hash: m.hash, revision: m.revision } });
  return m;
}

// ---------------- Lv4 money: wallet ----------------

function walletFor(body: Body): LinkWallet {
  return new LinkWallet({ bin: body.config().linkCli });
}

/** Link is connected: record the wallet exactly as the wizard always has, and the money level. */
async function recordWallet(body: Body, wallet: LinkWallet): Promise<Record<string, unknown>> {
  const prev = body.identity().identities.wallet;
  const fetched = await wallet.userInfo().catch(() => undefined);
  const failed = !fetched || 'error' in fetched || ('code' in fetched && 'message' in fetched);
  // A failed lookup keeps what we knew rather than overwriting it with an error.
  const info = ((failed ? prev?.details?.userInfo : fetched) as Record<string, unknown> | undefined) ?? {};
  body.setIdentityRecord('wallet', {
    status: 'open',
    value: 'Stripe Link agent wallet',
    provider: 'Stripe Link',
    openedBy: 'parent',
    openedAt: prev?.status === 'open' && prev.openedAt ? prev.openedAt : now(),
    details: { userInfo: info },
    note: undefined,
  });
  const level = body.onboarding().levels.money;
  if (!level?.done || level.note) body.markLevel('money');
  return info;
}

/**
 * "Connect Link": starts the device login. The parent opens `verificationUrl`
 * (or the Link app), checks `phrase` and approves; then poll walletCheck.
 */
export async function walletConnectStart(body: Body): Promise<{ already: boolean; verificationUrl?: string; phrase?: string }> {
  const wallet = walletFor(body);
  const r = await wallet.loginStart(body.identity().name);
  if (r.already) await recordWallet(body, wallet);
  return r;
}

/**
 * Completes a pending login once the parent approved, and writes the wallet
 * identity when Link is connected. While waiting, `details` carries the pending
 * URL and phrase so a reloaded page can show them again.
 */
export async function walletCheck(body: Body): Promise<{ authenticated: boolean; details?: Record<string, unknown> }> {
  const wallet = walletFor(body);
  const st = await wallet.authStatus();
  if (st.authenticated) return { authenticated: true, details: await recordWallet(body, wallet) };
  if (body.identity().identities.wallet?.status === 'open') {
    body.setIdentityRecord('wallet', { status: 'needs-parent', provider: 'Stripe Link', value: undefined, details: undefined, note: 'Link 登录失效了：在控制台点"连接 Link"重新连接' });
  }
  if (st.pending === true && typeof st.verification_url === 'string') {
    return { authenticated: false, details: { pending: true, verificationUrl: st.verification_url, phrase: typeof st.phrase === 'string' ? st.phrase : undefined } };
  }
  return { authenticated: false };
}

export async function walletDisconnect(body: Body): Promise<void> {
  await walletFor(body).logout();
  body.setIdentityRecord('wallet', { status: 'needs-parent', provider: 'Stripe Link', value: undefined, openedBy: undefined, openedAt: undefined, details: undefined, note: '家长断开了 Link：在控制台点"连接 Link"重新连接' });
  const s = body.onboarding();
  if (body.mandate()) s.levels.money = { done: true, at: now(), note: 'mandate only' };
  else delete s.levels.money;
  body.saveOnboarding(s);
}

// ---------------- parent ----------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkEmail(v: string, label: string): string {
  if (!EMAIL_RE.test(v)) throw new StepError(`${label}格式不对：${v}`);
  return v;
}

function checkPhone(v: string, label: string): string {
  if (!/^\+?\d{7,15}$/.test(v.replace(/[\s().-]/g, ''))) throw new StepError(`${label}格式不对（比如 +14155550123）：${v}`);
  return v;
}

function legalProfile(l: LegalProfile): LegalProfile {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const a = (l.address ?? {}) as Partial<LegalProfile['address']>;
  const country = s(a.country);
  const out: LegalProfile = {
    fullName: s(l.fullName),
    company: s(l.company) || undefined,
    email: s(l.email),
    phone: s(l.phone),
    address: { line1: s(a.line1), line2: s(a.line2) || undefined, city: s(a.city), state: s(a.state) || undefined, postalCode: s(a.postalCode), country: country.length === 2 ? country.toUpperCase() : country },
    consentAt: s(l.consentAt),
  };
  const missing = ([['姓名', out.fullName], ['邮箱', out.email], ['电话', out.phone], ['地址', out.address.line1], ['城市', out.address.city], ['邮编', out.address.postalCode], ['国家', out.address.country]] as const)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new StepError(`登记信息还缺：${missing.join('、')}`);
  checkEmail(out.email, '登记邮箱');
  checkPhone(out.phone, '登记电话');
  const consent = Date.parse(out.consentAt);
  if (!Number.isFinite(consent)) throw new StepError('需要你同意一次：它可以用这些信息替你登记（实名、域名登记人）');
  out.consentAt = new Date(consent).toISOString();
  return out;
}

/** The parent's own contact (so the agent recognizes their mail and texts) and, optionally, their legal identity. Empty fields are left as they were. */
export function setParent(body: Body, input: { email?: string; phone?: string; legal?: LegalProfile }): void {
  const email = typeof input.email === 'string' && input.email.trim() ? checkEmail(input.email.trim(), '邮箱') : undefined;
  const phone = typeof input.phone === 'string' && input.phone.trim() ? checkPhone(input.phone.trim(), '手机号') : undefined;
  const legal = input.legal ? legalProfile(input.legal) : undefined;
  body.updateIdentity((id) => {
    if (email) id.parent.email = email;
    if (phone) id.parent.phone = phone;
    if (legal) id.parent.legal = legal;
  });
  body.markLevel('parent');
  if (legal) body.markLevel('legal');
}
