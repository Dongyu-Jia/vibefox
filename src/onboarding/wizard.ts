import crypto from 'node:crypto';
import os from 'node:os';
import { Body, SOUL_PRESETS, type AgentConfig, type Mandate, type WorkerSpec } from '../core/body.ts';
import { configureLogs } from '../core/log.ts';
import { currentAgentSlug } from '../core/paths.ts';
import { openSecrets, type SecretStore } from '../core/secrets.ts';
import { IDENTITY_KINDS, OPENER_LABEL } from '../identity/registry.ts';
import type { Provider } from '../llm/index.ts';
import { LinkWallet } from '../wallet/link.ts';
import { BLOCKED_CATEGORIES, CATEGORY_LABELS, fmtCents, SPEND_CATEGORIES } from '../wallet/mandate.ts';
import { detectHarnesses, importOpencodeKey } from './detect.ts';
import { install, STAY_AWAKE_ADVICE } from './launchd.ts';
import { openRouterLogin } from './openrouterOAuth.ts';
import { color as C, type Prompter } from './prompter.ts';
import { birthAgent, connectBrain, connectTelegram, consentGiven, emailOptions, openEmail, openPhone, phoneOptions, recordHarnesses, setParent, signMandate, StepError, TIER_CANDIDATES, walletCheck, workerCandidates } from './steps.ts';
import { setupKeys, tail } from '../cli/keys.ts';

export { testModel } from './steps.ts';

/**
 * `vf init`: the agent's birth. Each step unlocks one level; every step can be
 * re-run alone (`vf init --step email`). This is the one moment the parent
 * grants permissions — afterwards the agent doesn't ask again.
 * The questions live here; what each step does lives in steps.ts, shared with the local UI.
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
  const parentName = await p.ask('parent_name', '你的名字（它会叫你"家长"）', os.userInfo().username);
  const preset = await p.choose('soul', '它的性格', [
    ...Object.keys(SOUL_PRESETS).map((k) => ({ value: k, label: `${k}：${SOUL_PRESETS[k].split('\n')[0]}` })),
    { value: 'custom', label: '自己写一段' },
  ]);
  const soulText = preset === 'custom' ? await p.ask('soul_custom', '用几句话描述它的性格') : preset;
  const { body, opened } = await birthAgent({ name, parentName, soul: soulText, configOverrides: opts.configOverrides });
  p.say(`${C.green('✔')} ${name} 出生了：${C.dim(body.root)}`);
  if (opened.length) p.say(`${C.green('✔')} 它自己开了这些身份：${opened.join('、')}`);
  return body;
}

// ---------------- Lv1 brain ----------------

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
    const r = await connectBrain(body, secrets, { provider, key });
    for (const [spec, res] of Object.entries(r.models)) p.say(`${res.ok ? C.green('✔') : C.red('✘')} ${spec} ${C.dim(res.detail)}`);
    const info = r.keyInfo;
    if (info) p.say(C.dim(`OpenRouter key：已用 $${info.usage.toFixed(2)}${info.limit != null ? `，上限 $${info.limit}` : '，没设上限——建议在 OpenRouter 给这个 key 设一个额度，这就是它的"脑子预算"'}`));
    // The router talks on every message, so it defaults to the cheap model (DeepSeek v4.1 flash on OpenRouter).
    if (r.routerChanged) p.say(`${C.green('✔')} router（它自己）用 ${r.routerModel}`);
    if (!(await p.confirm(`brain_more_${round}`, '再加一个模型供应商吗？', false))) break;
  }
  body.markLevel('brain');
}

// ---------------- Lv1 workers ----------------

async function workers(ctx: Ctx): Promise<void> {
  const { p, body, secrets } = ctx;
  header(p, 'Lv1', '干活的 worker（harness × 模型）');
  const det = detectHarnesses();
  const candidates = workerCandidates(body, secrets, det);
  if (!candidates.length) p.say(C.red('还没有可用的模型或 harness。先完成"大脑"这一步，或者装好 Claude Code / OpenCode。'));
  const chosen: WorkerSpec[] = [];
  for (const c of candidates) {
    const on = await p.confirm(`worker_${c.id}`, `启用 ${c.label}？${c.why ? C.dim('（' + c.why + '）') : ''}`, c.enabled);
    const { why: _why, ...spec } = c;
    chosen.push({ ...spec, enabled: on });
  }
  body.saveWorkers(chosen);
  recordHarnesses(body, det);
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
  const tg = await connectTelegram(body, secrets, { token });
  p.say(`${C.green('✔')} bot ${tg.handle} 准备好了`);
  p.say(`👉 认领它：打开 ${C.bold(tg.claimUrl)}`);
  p.say(C.dim(`   （或者给 ${tg.handle} 发：/start ${tg.bindCode}；agent 启动后才会回应）`));
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
  const { inboxes } = await emailOptions(body, key);
  let use: string | undefined;
  if (inboxes.length) {
    const pick = await p.choose('email_pick', '用哪个邮箱？', [
      { value: 'new', label: '让它给自己开一个新的（免费档最多 3 个）' },
      ...inboxes.map((i) => ({ value: i.id, label: `用已有的 ${i.email}` })),
    ], 'new');
    use = inboxes.find((i) => i.id === pick)?.id;
  }
  const username = use ? undefined : await p.ask('email_username', '它的邮箱名', `${body.slug}-${crypto.randomBytes(2).toString('hex')}`);
  const rec = await openEmail(body, secrets, { key, use, username });
  p.say(`${C.green('✔')} ${rec.openedBy === 'self' ? '它给自己开了邮箱' : '它的邮箱'}：${C.bold(rec.value ?? '')}`);
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
  const { numbers } = await phoneOptions(body, key);
  let use: string | undefined;
  if (numbers.length) {
    const pick = await p.choose('phone_pick', '用哪个号码？', [
      ...numbers.map((n) => ({ value: n.id, label: `用已有的 ${n.phoneNumber}（不额外花钱）` })),
      { value: 'new', label: '再开一个新号码（$3/月）' },
    ], numbers[0].id);
    use = numbers.find((n) => n.id === pick)?.id;
  }
  const askArea = () => p.ask('phone_area_code', '想要哪个区号？（美国/加拿大三位数，留空随便）', '');
  const areaCode = use ? undefined : await askArea();
  const rec = await openPhone(body, secrets, {
    key,
    use,
    areaCode,
    onAttachFailed: async (message) => {
      p.say(C.red(message));
      return askArea();
    },
  });
  const createdNumber = rec.openedBy === 'self';
  p.say(`${C.green('✔')} ${createdNumber ? '它给自己开了号码' : '它的号码'}：${C.bold(rec.value ?? '')}${createdNumber ? '' : C.dim('（已挂到它自己的语音 agent 上）')}`);
  if (rec.details?.outboundSms === 'registration_required') p.say(C.dim('美国号码发短信要先在 AgentPhone 后台做 10DLC 登记；打电话不受影响。'));
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
  for (const cat of SPEND_CATEGORIES) {
    if (await p.confirm(`money_allow_${cat}`, `可以买${CATEGORY_LABELS[cat]}？`, cat !== 'travel')) allowed.push(cat);
  }
  p.say(`永远不买：${BLOCKED_CATEGORIES.map((c) => CATEGORY_LABELS[c]).join('、')}（这些是诈骗套现的常见出口）`);
  const id = body.identity();
  p.say('');
  p.say(C.bold(`  我授权 ${id.name} 每月最多花 ${fmtCents(monthly)}，单笔不超过 ${fmtCents(perTx)}。`));
  p.say(C.bold('  这个数字，是我愿意让它搞砸的最大金额。'));
  const sign = await p.ask('money_confirm', '输入"我同意"签字', '');
  if (!consentGiven(sign)) {
    p.say(C.dim('没有签字，零花钱这一步先跳过。'));
    return;
  }
  let m: Mandate;
  try {
    m = signMandate(body, { monthlyCents: monthly, perTxCents: perTx, allowed, consent: sign });
  } catch (err) {
    if (!(err instanceof StepError)) throw err;
    p.say(C.red(err.message));
    p.say(C.dim('零花钱这一步先跳过。之后运行 vf init --step money'));
    return;
  }
  p.say(`${C.green('✔')} 授权书已签，${id.name} 用自己的签名密钥确认了（${m.hash!.slice(0, 12)}…）`);

  if (!(await p.confirm('wallet_connect', '现在连接 Stripe Link 钱包吗？（仅美国/加拿大；用你自己的 Link 账号）', true))) {
    body.setIdentityRecord('wallet', { status: 'needs-parent', provider: 'Stripe Link', note: '运行 vf init --step money 连接' });
    body.markLevel('money', 'mandate only');
    return;
  }
  const wallet = new LinkWallet({ bin: body.config().linkCli });
  const st = await wallet.authStatus();
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
  }
  // Same check the UI polls: completes the login and records the wallet.
  if (!(await walletCheck(body)).authenticated) {
    p.say(C.red('Link 还没连上。之后运行 vf init --step money 再试。'));
    body.setIdentityRecord('wallet', { status: 'needs-parent', provider: 'Stripe Link', note: 'link-cli auth login not completed' });
    return;
  }
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
  try {
    setParent(body, { email: em, phone: ph });
  } catch (err) {
    if (!(err instanceof StepError)) throw err;
    p.say(C.red(err.message));
    p.say(C.dim('先跳过。之后运行 vf init --step parent'));
  }
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
