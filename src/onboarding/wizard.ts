import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramChannel } from '../channels/telegram.ts';
import { Body, defaultConfig, defaultRouting, defaultSoul, SOUL_PRESETS, type AgentConfig, type WorkerSpec } from '../core/body.ts';
import { configureLogs, loggedFetch } from '../core/log.ts';
import { agentsDir, setCurrentAgent, slugify, currentAgentSlug } from '../core/paths.ts';
import { openSecrets, type SecretStore } from '../core/secrets.ts';
import { AgentMail } from '../identity/agentmail.ts';
import { AgentPhone } from '../identity/agentphone.ts';
import { IDENTITY_KINDS, OPENER_LABEL } from '../identity/registry.ts';
import { openSelfIdentities } from '../identity/selfmade.ts';
import { resolveModel, type Provider } from '../llm/index.ts';
import { LinkWallet } from '../wallet/link.ts';
import { CATEGORY_LABELS, createMandate, fmtCents } from '../wallet/mandate.ts';
import { detectHarnesses, importOpencodeKey } from './detect.ts';
import { install, STAY_AWAKE_ADVICE } from './launchd.ts';
import { openRouterLogin } from './openrouterOAuth.ts';
import { color as C, type Prompter } from './prompter.ts';
import { setupKeys, tail } from '../cli/keys.ts';

/**
 * `vf init`: the agent's birth. Each step unlocks one level; every step can be
 * re-run alone (`vf init --step email`). This is the one moment the parent
 * grants permissions — afterwards the agent doesn't ask again.
 */

export const STEPS = ['birth', 'brain', 'workers', 'channel', 'email', 'phone', 'money', 'parent', 'install'] as const;
export type Step = (typeof STEPS)[number];

export interface WizardOptions {
  prompter: Prompter;
  steps?: Step[];
  openBrowser?: (url: string) => void | Promise<void>;
  /** Merged into config.json at birth (tests point services at local mocks). */
  configOverrides?: Partial<AgentConfig>;
}

interface Ctx {
  p: Prompter;
  body: Body;
  secrets: SecretStore;
  opts: WizardOptions;
}

const TIER_CANDIDATES: Record<Provider, { cheap: string; mid: string; strong: string }> = {
  openrouter: { cheap: 'openrouter:deepseek/deepseek-v4.1-flash', mid: 'openrouter:anthropic/claude-sonnet-5.5', strong: 'openrouter:anthropic/claude-opus-5.5' },
  anthropic: { cheap: 'anthropic:claude-haiku-5-5', mid: 'anthropic:claude-sonnet-5-5', strong: 'anthropic:claude-opus-5-5' },
  deepseek: { cheap: 'deepseek:deepseek-v4-flash', mid: 'deepseek:deepseek-v4-pro', strong: 'deepseek:deepseek-v4-pro' },
};

/** A key typed earlier with `vf keys`, if the parent wants it; otherwise ask (hidden). */
async function keyFor(ctx: Ctx, name: string, id: string, label: string): Promise<string> {
  const preset = setupKeys().get(name);
  if (!preset) return ctx.p.secret(id, label);
  // Hidden input even here: people paste keys into whatever prompt is on screen.
  const typed = await ctx.p.secret(`${id}_override`, `${label}：回车 = 用 vf keys 存的（${tail(preset)}），或者粘贴一个新的`);
  return typed || preset;
}

function header(p: Prompter, level: string, title: string): void {
  p.say('');
  p.say(C.orange(`━━ ${level} · ${title} ━━`));
}

export async function runWizard(opts: WizardOptions): Promise<Body> {
  const p = opts.prompter;
  p.say(C.bold('🦊 vibefox — 让一个独立的 AI agent 在你的 Mac 上出生'));
  p.say(C.dim('它会有自己的名字、邮箱、电话和零花钱。任务只来自你；授权只在现在这一刻发生。'));

  const steps = opts.steps ?? [...STEPS];
  let body: Body | undefined;
  const existing = currentAgentSlug();
  if (!steps.includes('birth') && existing) body = Body.open(existing);

  for (const step of steps) {
    if (step === 'birth') {
      body = await birth(p, opts);
      continue;
    }
    if (!body) body = Body.open();
    configureLogs(body.paths.logs);
    const ctx: Ctx = { p, body, secrets: openSecrets(body.slug, body.paths.secretsFile), opts };
    if (step === 'brain') await brain(ctx);
    if (step === 'workers') await workers(ctx);
    if (step === 'channel') await channel(ctx);
    if (step === 'email') await email(ctx);
    if (step === 'phone') await phone(ctx);
    if (step === 'money') await money(ctx);
    if (step === 'parent') await parent(ctx);
    if (step === 'install') await installStep(ctx);
  }
  if (body && steps.length > 1) finish(p, body);
  return body!;
}

// ---------------- Lv0 birth ----------------

async function birth(p: Prompter, opts: WizardOptions): Promise<Body> {
  header(p, 'Lv0', '出生');
  const name = (await p.ask('name', '给它起个名字', 'Fox')).trim() || 'Fox';
  const slug = slugify(name);
  const root = path.join(agentsDir(), slug);
  const parentName = await p.ask('parent_name', '你的名字（它会叫你"家长"）', os.userInfo().username);
  const preset = await p.choose('soul', '它的性格', [
    ...Object.keys(SOUL_PRESETS).map((k) => ({ value: k, label: `${k}：${SOUL_PRESETS[k].split('\n')[0]}` })),
    { value: 'custom', label: '自己写一段' },
  ]);
  const soulText = preset === 'custom' ? await p.ask('soul_custom', '用几句话描述它的性格') : preset;

  const body = Body.create(root);
  configureLogs(body.paths.logs);
  if (!body.exists()) {
    body.saveIdentity({ name, slug, bornAt: new Date().toISOString(), parent: { name: parentName }, identities: {} });
  } else {
    body.updateIdentity((id) => {
      id.name = name;
      id.parent.name = parentName;
    });
  }
  body.saveSoul(defaultSoul(name, soulText));
  if (!fs.existsSync(body.paths.routing)) body.saveRouting(defaultRouting(), 'born');
  const cfg = { ...defaultConfig(), ...(opts.configOverrides ?? {}) } as AgentConfig;
  if (opts.configOverrides) {
    for (const k of Object.keys(opts.configOverrides) as (keyof AgentConfig)[]) {
      const v = opts.configOverrides[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) (cfg as unknown as Record<string, unknown>)[k] = { ...(defaultConfig()[k] as object), ...(v as object) };
    }
  }
  body.saveConfig(cfg);
  setCurrentAgent(slug);
  const opened = openSelfIdentities(body);
  p.say(`${C.green('✔')} ${name} 出生了：${C.dim(root)}`);
  if (opened.length) p.say(`${C.green('✔')} 它自己开了这些身份：${opened.join('、')}`);
  body.markLevel('birth');
  return body;
}

// ---------------- Lv1 brain ----------------

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

async function brain(ctx: Ctx): Promise<void> {
  const { p, body, secrets } = ctx;
  header(p, 'Lv1', '大脑（模型）');
  const cfg = body.config();
  const det = detectHarnesses();
  const preset = setupKeys();
  const presetOptions = (['openrouter', 'anthropic', 'deepseek'] as Provider[])
    .filter((prov) => preset.get(`${prov}_api_key`))
    .map((prov) => ({ value: `preset_${prov}`, label: `用 vf keys 存的 ${prov} key（${tail(preset.get(`${prov}_api_key`)!)}）` }));
  const options = [
    ...presetOptions,
    { value: 'openrouter_oauth', label: '登录 OpenRouter（推荐，浏览器里点一下）' },
    { value: 'openrouter_key', label: '粘贴 OpenRouter API key' },
    ...(det.opencode.providers.includes('openrouter') ? [{ value: 'opencode_import', label: '用 OpenCode 里已经配好的 OpenRouter key（需要你同意）' }] : []),
    { value: 'anthropic_key', label: '粘贴 Anthropic (Claude) API key' },
    { value: 'deepseek_key', label: '粘贴 DeepSeek API key' },
    { value: 'skip', label: '先跳过' },
  ];
  for (let round = 0; round < 3; round++) {
    const choice = await p.choose(round === 0 ? 'brain' : `brain_${round}`, '它用什么模型思考？', options, presetOptions[0]?.value ?? 'openrouter_oauth');
    if (choice === 'skip') break;
    let provider: Provider = 'openrouter';
    let key = '';
    if (choice.startsWith('preset_')) {
      provider = choice.slice('preset_'.length) as Provider;
      key = preset.get(`${provider}_api_key`) ?? '';
    } else if (choice === 'openrouter_oauth') {
      p.say('浏览器会打开 OpenRouter。你可以用它自己的邮箱注册/登录，然后点"Authorize"。');
      key = await openRouterLogin({
        authBase: cfg.services.openrouter.replace(/\/api\/v1\/?$/, ''),
        apiBase: cfg.services.openrouter,
        label: `vibefox-${body.slug}`,
        open: ctx.opts.openBrowser,
        onUrl: (u) => p.say(C.dim(u)),
      });
    } else if (choice === 'opencode_import') {
      const yes = await p.confirm('brain_import_consent', 'vibefox 会读取 OpenCode 保存的 OpenRouter key，存进这个 agent 的钥匙串。同意吗？', false);
      if (!yes) continue;
      key = importOpencodeKey('openrouter') ?? '';
    } else {
      provider = choice.split('_')[0] as Provider;
      key = await p.secret(`${provider}_key`, `粘贴 ${provider} API key`);
    }
    if (!key) continue;
    secrets.set(`${provider}_api_key`, key);
    const cand = TIER_CANDIDATES[provider];
    const results: Record<string, { ok: boolean; detail: string }> = {};
    for (const spec of new Set([cand.mid, cand.cheap])) {
      results[spec] = await testModel(spec, cfg, secrets);
      p.say(`${results[spec].ok ? C.green('✔') : C.red('✘')} ${spec} ${C.dim(results[spec].detail)}`);
    }
    const anyOk = Object.values(results).some((r) => r.ok);
    body.setIdentityRecord(`brain_${provider}`, {
      status: anyOk ? 'open' : 'failed',
      value: `${provider} key …${key.slice(-4)}`,
      provider,
      openedBy: 'parent',
      openedAt: new Date().toISOString(),
      note: anyOk ? undefined : Object.values(results)[0]?.detail,
      details: { models: results },
    });
    if (provider === 'openrouter') {
      const info = await keyInfo(cfg, key);
      if (info) p.say(C.dim(`OpenRouter key：已用 $${info.usage.toFixed(2)}${info.limit != null ? `，上限 $${info.limit}` : '，没设上限——建议在 OpenRouter 给这个 key 设一个额度，这就是它的"脑子预算"'}`));
    }
    // The router talks on every message, so it defaults to the cheap model (DeepSeek v4.1 flash on OpenRouter).
    const routerSpec = results[cand.cheap]?.ok ? cand.cheap : results[cand.mid]?.ok ? cand.mid : undefined;
    if (routerSpec && (round === 0 || !body.identity().identities.router_model)) {
      body.updateConfig((c) => {
        c.router.model = routerSpec;
        c.voiceModel = results[cand.cheap]?.ok ? cand.cheap : routerSpec;
      });
      p.say(`${C.green('✔')} router（它自己）用 ${routerSpec}`);
    }
    if (!(await p.confirm(`brain_more_${round}`, '再加一个模型供应商吗？', false))) break;
  }
  body.markLevel('brain');
}

async function keyInfo(cfg: AgentConfig, key: string): Promise<{ usage: number; limit: number | null } | undefined> {
  try {
    const res = await loggedFetch('openrouter', `${cfg.services.openrouter.replace(/\/$/, '')}/key`, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { data: { usage: number; limit: number | null } };
    return { usage: j.data.usage ?? 0, limit: j.data.limit ?? null };
  } catch {
    return undefined;
  }
}

// ---------------- Lv1 workers ----------------

async function workers(ctx: Ctx): Promise<void> {
  const { p, body, secrets } = ctx;
  header(p, 'Lv1', '干活的 worker（harness × 模型）');
  const det = detectHarnesses();
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
  if (!candidates.length) p.say(C.red('还没有可用的模型或 harness。先完成"大脑"这一步，或者装好 Claude Code / OpenCode。'));
  const chosen: WorkerSpec[] = [];
  for (const c of candidates) {
    const on = await p.confirm(`worker_${c.id}`, `启用 ${c.label}？${c.why ? C.dim('（' + c.why + '）') : ''}`, c.enabled);
    const { why: _why, ...spec } = c;
    chosen.push({ ...spec, enabled: on });
  }
  body.saveWorkers(chosen);
  const now = new Date().toISOString();
  if (det.opencode.installed) {
    body.setIdentityRecord('harness_opencode', { status: det.opencode.providers.length ? 'open' : 'needs-parent', value: det.opencode.providers.join(', ') || undefined, provider: 'OpenCode', openedBy: 'parent', openedAt: now, note: det.opencode.providers.length ? undefined : 'opencode auth login' });
  }
  if (det.dsh.installed) {
    body.setIdentityRecord('harness_deepseek', { status: 'open', value: 'dsh', provider: 'DeepSeek', openedBy: 'parent', openedAt: now });
  }
  if (det.codewhale.installed) {
    body.setIdentityRecord('harness_codewhale', { status: 'open', value: 'codewhale', provider: 'Codewhale', openedBy: 'parent', openedAt: now });
  }
  if (det.claude.installed) {
    body.setIdentityRecord('harness_claude_code', { status: det.claude.loggedIn ? 'open' : 'needs-parent', value: det.claude.loggedIn ? det.claude.detail : undefined, provider: 'Anthropic', openedBy: 'parent', openedAt: now, note: det.claude.loggedIn ? undefined : 'claude auth login' });
  }
  p.say(`${C.green('✔')} ${chosen.filter((w) => w.enabled).length} 个 worker 待命。谁来干由 router 按 routing.md 决定，你也可以在任务里点名。`);
  body.markLevel('workers');
}

// ---------------- Lv1 channel ----------------

async function channel(ctx: Ctx): Promise<void> {
  const { p, body, secrets } = ctx;
  header(p, 'Lv1', '对话渠道：Telegram');
  const name = body.identity().name;
  p.say(`1. 在 Telegram 里找 ${C.bold('@BotFather')}，发 /newbot`);
  p.say(`2. 名字填 ${C.bold(name)}，用户名比如 ${C.bold(body.slug + '_vibefox_bot')}`);
  p.say('3. 把它给你的 token 粘贴到这里（只有真人能创建 bot，所以这一步要你来）');
  const token = await keyFor(ctx, 'telegram_bot_token', 'telegram_token', 'Telegram bot token');
  if (!token) {
    p.say(C.dim('跳过了。之后运行 vf init --step channel'));
    return;
  }
  const cfg = body.config();
  const tg = new TelegramChannel({ token, apiBase: cfg.channel.apiBase });
  const me = await tg.describe();
  secrets.set('telegram_bot_token', token);
  await tg.presentAs(name, `我是 ${name}，一个独立的 AI agent。我只接受我家长布置的任务。`);
  const code = crypto.randomBytes(4).toString('hex');
  const s = body.onboarding();
  s.bindCode = code;
  body.saveOnboarding(s);
  body.setIdentityRecord('telegram_bot', { status: 'open', value: me.handle, provider: 'Telegram', openedBy: 'parent', openedAt: new Date().toISOString(), details: { botId: me.id } });
  const username = me.handle.replace(/^@/, '');
  p.say(`${C.green('✔')} bot ${me.handle} 准备好了`);
  p.say(`👉 认领它：打开 ${C.bold(`https://t.me/${username}?start=${code}`)}`);
  p.say(C.dim(`   （或者给 ${me.handle} 发：/start ${code}；agent 启动后才会回应）`));
  body.markLevel('channel', 'waiting for /start');
}

// ---------------- Lv2 email ----------------

async function email(ctx: Ctx): Promise<void> {
  const { p, body, secrets } = ctx;
  header(p, 'Lv2', '邮箱（AgentMail）');
  p.say(`去 ${C.bold('https://console.agentmail.to')} 注册（免费档 3 个邮箱），创建一个 API key。之后的事 agent 自己做。`);
  const key = await keyFor(ctx, 'agentmail_api_key', 'agentmail_key', 'AgentMail API key');
  if (!key) {
    p.say(C.dim('跳过了。之后运行 vf init --step email'));
    return;
  }
  const cfg = body.config();
  const mail = new AgentMail({ apiKey: key, base: cfg.services.agentmail });
  const existing = (await mail.listInboxes(10)).inboxes ?? [];
  secrets.set('agentmail_api_key', key);
  const id = body.identity();
  let inbox = undefined as (typeof existing)[number] | undefined;
  if (existing.length) {
    const pick = await p.choose('email_pick', '用哪个邮箱？', [
      { value: 'new', label: '让它给自己开一个新的（免费档最多 3 个）' },
      ...existing.map((i) => ({ value: i.inbox_id, label: `用已有的 ${i.email ?? i.inbox_id}` })),
    ], 'new');
    inbox = existing.find((i) => i.inbox_id === pick);
  }
  const created = !inbox;
  if (!inbox) {
    const username = await p.ask('email_username', '它的邮箱名', `${body.slug}-${crypto.randomBytes(2).toString('hex')}`);
    inbox = await mail.createInbox({ username, display_name: `${id.name} (AI agent)`, client_id: `vibefox-${body.slug}-${username}` });
  }
  const address = inbox.email ?? inbox.inbox_id;
  body.setIdentityRecord('email', { status: 'open', value: address, provider: 'AgentMail', openedBy: created ? 'self' : 'parent', openedAt: new Date().toISOString(), details: { inboxId: inbox.inbox_id } });
  p.say(`${C.green('✔')} ${created ? '它给自己开了邮箱' : '它的邮箱'}：${C.bold(address)}`);
  body.markLevel('email');
}

// ---------------- Lv3 phone ----------------

async function phone(ctx: Ctx): Promise<void> {
  const { p, body, secrets } = ctx;
  header(p, 'Lv3', '电话（AgentPhone）');
  p.say(`去 ${C.bold('https://agentphone.ai')} 注册（送 $5，号码 $3/月，目前只有美国/加拿大），创建 API key。`);
  const key = await keyFor(ctx, 'agentphone_api_key', 'agentphone_key', 'AgentPhone API key');
  if (!key) {
    p.say(C.dim('跳过了。之后运行 vf init --step phone'));
    return;
  }
  const cfg = body.config();
  const ap = new AgentPhone({ apiKey: key, base: cfg.services.agentphone });
  const existingNumbers = (await ap.listNumbers()).data ?? [];
  secrets.set('agentphone_api_key', key);
  const id = body.identity();
  const agent = await ap.createAgent({
    name: id.name,
    description: `${id.name}, an independent AI agent (parent: ${id.parent.name})`,
    voiceMode: 'hosted',
    systemPrompt: `You are ${id.name}, an independent AI agent. People who call this number reach you. Say you are an AI agent. Take a message: who they are, what they want, how to reach them. Do not make commitments, do not share personal data or payment details. Personality: ${body.soul().slice(0, 500)}`,
    beginMessage: `Hi, this is ${id.name}, an AI agent. How can I help?`,
  });
  let num = undefined as (typeof existingNumbers)[number] | undefined;
  if (existingNumbers.length) {
    const pick = await p.choose('phone_pick', '用哪个号码？', [
      ...existingNumbers.map((n) => ({ value: n.id, label: `用已有的 ${n.phoneNumber}（不额外花钱）` })),
      { value: 'new', label: '再开一个新号码（$3/月）' },
    ], existingNumbers[0].id);
    num = existingNumbers.find((n) => n.id === pick);
    if (num) {
      try {
        await ap.attachNumber(agent.id, num.id);
      } catch (err) {
        p.say(C.red(`没能把 ${num.phoneNumber} 挂到它的语音 agent 上：${(err as Error).message}`));
        num = undefined;
      }
    }
  }
  const createdNumber = !num;
  if (!num) {
    const area = await p.ask('phone_area_code', '想要哪个区号？（美国/加拿大三位数，留空随便）', '');
    num = await ap.createNumber({ areaCode: area || undefined, agentId: agent.id });
    if (!num.agentId) await ap.attachNumber(agent.id, num.id);
  }
  const now = new Date().toISOString();
  body.setIdentityRecord('phone', { status: 'open', value: num.phoneNumber, provider: 'AgentPhone', openedBy: createdNumber ? 'self' : 'parent', openedAt: now, details: { numberId: num.id, agentId: agent.id, outboundSms: num.outboundSms } });
  body.setIdentityRecord('sms_codes', { status: 'open', value: num.phoneNumber, openedBy: 'self', openedAt: now });
  body.setIdentityRecord('voice', { status: 'open', value: 'AgentPhone hosted voice', openedBy: 'self', openedAt: now, details: { agentId: agent.id } });
  p.say(`${C.green('✔')} ${createdNumber ? '它给自己开了号码' : '它的号码'}：${C.bold(num.phoneNumber)}${createdNumber ? '' : C.dim('（已挂到它自己的语音 agent 上）')}`);
  if (num.outboundSms === 'registration_required') p.say(C.dim('美国号码发短信要先在 AgentPhone 后台做 10DLC 登记；打电话不受影响。'));
  body.markLevel('phone');
}

// ---------------- Lv4 money ----------------

async function money(ctx: Ctx): Promise<void> {
  const { p, body } = ctx;
  header(p, 'Lv4', '零花钱（授权只发生在这一刻）');
  p.say('现在定下它每个月能花多少钱。之后它不会再逐笔请示你——花了会事后告诉你。');
  p.say(C.dim('硬上限放在机器外面：Stripe Link 每笔在 app 里批准，OpenRouter key 有额度。'));
  const monthly = Math.round(Number(await p.ask('money_monthly', '每月最多花多少美元？', '30')) * 100);
  const perTx = Math.round(Number(await p.ask('money_per_tx', '单笔最多多少美元？', '15')) * 100);
  const allowed: string[] = [];
  p.say(C.dim('下面几个问题只回答 y 或 n：'));
  for (const cat of ['compute', 'software', 'food', 'shopping', 'travel']) {
    if (await p.confirm(`money_allow_${cat}`, `可以买${CATEGORY_LABELS[cat]}？`, cat !== 'travel')) allowed.push(cat);
  }
  const blocked = ['gift_cards', 'money_transfer', 'crypto', 'gambling'];
  p.say(`永远不买：${blocked.map((c) => CATEGORY_LABELS[c]).join('、')}（这些是诈骗套现的常见出口）`);
  const id = body.identity();
  p.say('');
  p.say(C.bold(`  我授权 ${id.name} 每月最多花 ${fmtCents(monthly)}，单笔不超过 ${fmtCents(perTx)}。`));
  p.say(C.bold('  这个数字，是我愿意让它搞砸的最大金额。'));
  const sign = await p.ask('money_confirm', '输入"我同意"签字', '');
  if (!['我同意', 'yes', 'i agree'].includes(sign.trim().toLowerCase())) {
    p.say(C.dim('没有签字，零花钱这一步先跳过。'));
    return;
  }
  const m = createMandate(body, { monthlyLimitCents: monthly, perTransactionLimitCents: perTx, allowedCategories: allowed, blockedCategories: blocked, parentName: id.parent.name });
  body.saveMandate(m);
  body.setIdentityRecord('mandate', { status: 'open', value: `${fmtCents(monthly)}/月，单笔 ${fmtCents(perTx)}`, openedBy: 'parent', openedAt: m.signedAt, details: { hash: m.hash } });
  p.say(`${C.green('✔')} 授权书已签，${id.name} 用自己的签名密钥确认了（${m.hash!.slice(0, 12)}…）`);

  if (!(await p.confirm('wallet_connect', '现在连接 Stripe Link 钱包吗？（仅美国/加拿大；用你自己的 Link 账号）', true))) {
    body.setIdentityRecord('wallet', { status: 'needs-parent', provider: 'Stripe Link', note: '运行 vf init --step money 连接' });
    body.markLevel('money', 'mandate only');
    return;
  }
  const wallet = new LinkWallet({ bin: body.config().linkCli });
  let st = await wallet.authStatus();
  if (!st.authenticated) {
    p.say('下面会出现一个链接和一句话：打开链接（或看 Link app 的通知），核对这句话，然后批准。');
    let shown = false;
    await wallet.login(id.name, (line) => {
      const url = /verification_url:\s*"?([^"\s]+)/.exec(line)?.[1];
      const phrase = /^\s*phrase:\s*(\S+)/.exec(line)?.[1];
      if (url && !shown) {
        shown = true;
        p.say(`👉 ${C.bold(url)}`);
        p.say(C.dim('   正在等你批准（最多 10 分钟）——别按 Ctrl-C'));
      } else if (phrase && shown) {
        p.say(`   核对短语：${C.bold(phrase)}`);
        shown = true;
      } else if (/authenticated:\s*true/.test(line)) {
        p.say(`${C.green('✔')} Link 批准了`);
      }
    });
    st = await wallet.authStatus();
  }
  if (!st.authenticated) {
    p.say(C.red('Link 还没连上。之后运行 vf init --step money 再试。'));
    body.setIdentityRecord('wallet', { status: 'needs-parent', provider: 'Stripe Link', note: 'link-cli auth login not completed' });
    return;
  }
  const info = await wallet.userInfo().catch(() => ({}));
  body.setIdentityRecord('wallet', { status: 'open', value: 'Stripe Link agent wallet', provider: 'Stripe Link', openedBy: 'parent', openedAt: new Date().toISOString(), details: { userInfo: info } });
  p.say(`${C.green('✔')} 钱包连上了`);
  if (await p.confirm('wallet_test', '做一笔测试申请看看（测试模式，不扣钱）？', true)) {
    const sr = await wallet.create({ amountCents: 100, merchantName: 'vibefox onboarding test', merchantUrl: 'https://github.com/Dongyu-Jia/vibefox', context: `Onboarding test of ${id.name}'s wallet: a $1.00 test-mode spend request so the parent can see what an approval looks like. No real money moves.`, test: true });
    const appr = await wallet.requestApproval(sr.id);
    p.say(`在 Link app 里批准，或打开：${C.bold(appr.approval_url ?? sr.approval_url ?? '')}`);
    const decided = await wallet.waitForDecision(sr.id, 300);
    p.say(decided.status === 'approved' ? `${C.green('✔')} 测试申请批准了` : C.dim(`测试申请：${decided.status}`));
  }
  body.markLevel('money');
}

// ---------------- parent contact ----------------

async function parent(ctx: Ctx): Promise<void> {
  const { p, body } = ctx;
  header(p, 'Lv4', '你的联系方式（可选）');
  p.say(C.dim('让它认得出你的邮件和短信。别人的邮件和短信只是信息，不是任务。'));
  const em = await p.ask('parent_email', '你的邮箱（留空跳过）', '');
  const ph = await p.ask('parent_phone', '你的手机号（E.164，比如 +14155550123；留空跳过）', '');
  body.updateIdentity((id) => {
    if (em) id.parent.email = em.trim();
    if (ph) id.parent.phone = ph.trim();
  });
  body.markLevel('parent');
}

// ---------------- install ----------------

async function installStep(ctx: Ctx): Promise<void> {
  const { p, body } = ctx;
  header(p, 'Lv5', '24 小时常驻');
  if (!(await p.confirm('install_launchd', '装成开机自启、崩溃自动重启的后台服务（launchd）？', true))) {
    p.say(`用 ${C.bold('vf start')} 在前台运行。`);
    return;
  }
  const r = install(body);
  p.say(`${r.loaded ? C.green('✔') : C.red('✘')} ${r.plist}${r.out ? C.dim(' ' + r.out) : ''}`);
  p.say(C.dim(STAY_AWAKE_ADVICE));
  body.markLevel('install');
}

function finish(p: Prompter, body: Body): void {
  const id = body.identity();
  p.say('');
  p.say(C.orange('━━ 出生完成 ━━'));
  for (const opener of ['self', 'parent-key', 'parent'] as const) {
    const kinds = IDENTITY_KINDS.filter((k) => k.opener === opener && k.implemented);
    const mark = (s?: string) => (s === 'open' ? '✅' : s === 'needs-parent' ? '🙋' : '⬜');
    const line = kinds.map((k) => `${mark(id.identities[k.id]?.status)} ${k.name}`).join('  ');
    p.say(`${C.bold(OPENER_LABEL[opener])}：${line}`);
  }
  const waiting = Object.entries(id.identities).filter(([, r]) => r.status === 'needs-parent' || r.status === 'failed');
  if (waiting.length) p.say(`🙋 还需要你帮忙：${waiting.map(([k, r]) => `${k}${r.note ? `（${r.note.slice(0, 80)}）` : ''}`).join('；')}`);
  const code = body.onboarding().bindCode;
  const bot = id.identities.telegram_bot?.value;
  if (code && bot) p.say(`\n👉 最后一步：在 Telegram 打开 https://t.me/${bot.replace(/^@/, '')}?start=${code} 认领 ${id.name}`);
  p.say(C.dim(`身体文件夹：${body.root}`));
}
