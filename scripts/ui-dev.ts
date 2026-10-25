/**
 * Dev server for the local UI: serves src/ui with the control plane's security
 * headers and a fake, in-memory implementation of the /v1 API from
 * docs/CONTROL-PLANE.md, so every screen can be clicked through (and
 * screenshotted) without an agent, keys or real accounts.
 *
 *   node scripts/ui-dev.ts [setup|control|lived] [--port 47900]
 *
 *   setup    the birth wizard (saved AgentMail/AgentPhone keys, one old inbox and number to reuse)
 *   control  a young agent: email and phone, no brain or Telegram yet, a few resources in every state
 *   lived    everything connected: brain, Telegram, Link wallet, a signed allowance, spending, tasks
 *
 * It prints a one-time link (…/ui/#code=…); GET /dev/code mints another.
 * Fake behaviour worth knowing: opening a signup page in "its browser" makes a
 * verification email and an SMS code arrive a few seconds later; Link and
 * Telegram approve by themselves after ~8 s; any key, token or password that
 * starts with "bad" fails verification.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

type Mode = 'setup' | 'control';
type Json = Record<string, unknown>;
type Method = 'token' | 'password' | 'browser' | 'file';
type Human = 'signup' | 'legal' | 'money' | 'key' | null;

interface Field {
  id: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  kind?: 'text' | 'password' | 'totp' | 'url' | 'file';
  placeholder?: string;
  help?: string;
}

interface Kind {
  id: string;
  label: string;
  group: string;
  human: Human;
  methods: Method[];
  fields: Partial<Record<Method, Field[]>>;
  signupUrl?: string;
  loginUrl?: string;
  tokenUrl?: string;
  fullPowerHint?: string;
  unlocks: string[];
  agentCreates?: string[];
  workerEnv?: Record<string, string>;
  notes?: string;
  verifiable: boolean;
}

interface Res {
  id: string;
  kind: string;
  label: string;
  handle?: string;
  origin: 'parent' | 'self';
  access: 'full' | 'scoped' | 'read' | 'unknown';
  method: Method | 'none';
  parent?: string;
  status: 'ok' | 'unverified' | 'failed' | 'pending';
  verifiedAt?: string;
  lastError?: string;
  secretFields: string[];
  fields?: Record<string, string>;
  addedAt: string;
  addedBy: 'parent' | 'agent';
  note?: string;
  source: 'identity' | 'resource';
  hasSecret: Record<string, boolean>;
}

interface Code {
  at: string;
  channel: 'email' | 'sms';
  from: string;
  subject?: string;
  code?: string;
  link?: string;
}

interface Op {
  status: 'running' | 'done' | 'error';
  result?: unknown;
  error?: string;
  notes: string[];
}

interface SpendRow {
  id: string;
  task_id: string | null;
  merchant_name: string;
  merchant_url: string;
  amount_cents: number;
  currency: string;
  status: string;
  approval_url: string | null;
  test: number;
  context: string;
  last4: string | null;
  created_at: string;
  updated_at: string;
}

interface Worker {
  id: string;
  label: string;
  harness: string;
  model?: string;
  tier: 1 | 2 | 3;
  enabled: boolean;
  available: boolean;
  reason?: string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const UI_DIR = path.resolve(import.meta.dirname, '..', 'src', 'ui');
const STATIC: Record<string, string> = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'app.css': 'text/css; charset=utf-8' };
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};
const DAEMON_TOKEN = 'dev-daemon-token';

const args = process.argv.slice(2);
const preset = (args.find((a) => !a.startsWith('--')) ?? 'control') as 'setup' | 'control' | 'lived';
if (!['setup', 'control', 'lived'].includes(preset)) {
  process.stderr.write('usage: node scripts/ui-dev.ts [setup|control|lived] [--port 47900]\n');
  process.exit(2);
}
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : (process.env.PORT ?? 47900));

const now = () => new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const hex = (n: number) => crypto.randomBytes(n).toString('hex');
const digits = (n: number) => Array.from({ length: n }, () => crypto.randomInt(10)).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function generatePassword(length = 20): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#%^*-_+='];
  const all = sets.join('');
  const out = sets.map((s) => s[crypto.randomInt(s.length)]);
  while (out.length < length) out.push(all[crypto.randomInt(all.length)]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

// ---------------- catalog ----------------

const TOTP: Field = { id: 'totp', label: '两步验证密钥', secret: true, optional: true, kind: 'totp' };
const LOGIN = (user = '邮箱'): Field[] => [
  { id: 'username', label: user, secret: false },
  { id: 'password', label: '密码', secret: true, kind: 'password' },
  TOTP,
];

const GROUPS = [
  { id: 'identity', label: '身份' },
  { id: 'money', label: '钱' },
  { id: 'brain', label: '大脑' },
  { id: 'code', label: '代码' },
  { id: 'cloud', label: '云' },
  { id: 'data', label: '数据' },
  { id: 'work', label: '办公' },
  { id: 'social', label: '社交' },
  { id: 'errands', label: '跑腿' },
  { id: 'custom', label: '自定义' },
];

const KINDS: Kind[] = [
  { id: 'agentmail', label: 'AgentMail 邮箱', group: 'identity', human: 'key', methods: ['token'], fields: { token: [{ id: 'key', label: 'AgentMail API key', secret: true }] }, signupUrl: 'https://console.agentmail.to', unlocks: ['收发邮件', '收验证邮件'], agentCreates: ['收件箱'], verifiable: true },
  { id: 'agentphone', label: 'AgentPhone 号码', group: 'identity', human: 'key', methods: ['token'], fields: { token: [{ id: 'key', label: 'AgentPhone API key', secret: true }] }, signupUrl: 'https://agentphone.ai', unlocks: ['收发短信', '打电话', '收验证码'], agentCreates: ['号码', '语音 agent'], verifiable: true },
  { id: 'apple', label: 'Apple ID', group: 'identity', human: 'signup', methods: ['password'], fields: { password: LOGIN('Apple ID（邮箱）') }, signupUrl: 'https://account.apple.com/account', unlocks: ['iMessage', 'FaceTime', 'App Store'], verifiable: false },
  { id: 'link_wallet', label: 'Link 钱包', group: 'money', human: 'money', methods: [], fields: {}, unlocks: ['一次性虚拟卡', '在额度内自己买东西'], verifiable: false },
  {
    id: 'stripe',
    label: 'Stripe 收款账号',
    group: 'money',
    human: 'legal',
    methods: ['token'],
    fields: { token: [{ id: 'secretKey', label: 'Secret key', secret: true, placeholder: 'sk_live_… 或 rk_live_…' }] },
    signupUrl: 'https://dashboard.stripe.com/register',
    tokenUrl: 'https://dashboard.stripe.com/apikeys',
    fullPowerHint: '用 Secret key（sk_live_…），或者建一个所有权限都选 Write 的 restricted key。',
    unlocks: ['收款', '开发票', '卖东西'],
    agentCreates: ['产品和价格', '支付链接'],
    workerEnv: { STRIPE_API_KEY: 'secretKey' },
    notes: '收款账号要实名：你在 Stripe 用你（或你公司）的身份做认证，钱进你的银行账户。',
    verifiable: true,
  },
  { id: 'openrouter', label: 'OpenRouter', group: 'brain', human: 'key', methods: ['token'], fields: { token: [{ id: 'key', label: 'API key', secret: true, placeholder: 'sk-or-v1-…' }] }, signupUrl: 'https://openrouter.ai', tokenUrl: 'https://openrouter.ai/settings/keys', unlocks: ['几百个模型'], verifiable: true },
  { id: 'anthropic', label: 'Anthropic', group: 'brain', human: 'key', methods: ['token'], fields: { token: [{ id: 'key', label: 'API key', secret: true, placeholder: 'sk-ant-…' }] }, signupUrl: 'https://console.anthropic.com', tokenUrl: 'https://console.anthropic.com/settings/keys', unlocks: ['Claude 模型'], verifiable: true },
  {
    id: 'github',
    label: 'GitHub',
    group: 'code',
    human: 'signup',
    methods: ['token', 'password', 'browser'],
    fields: {
      token: [{ id: 'token', label: 'Personal access token', secret: true, placeholder: 'ghp_… 或 github_pat_…' }],
      password: LOGIN('用户名或邮箱'),
    },
    signupUrl: 'https://github.com/signup',
    loginUrl: 'https://github.com/login',
    tokenUrl: 'https://github.com/settings/tokens/new?description=vibefox&scopes=repo,workflow,write:packages,delete:packages,admin:org,admin:public_key,admin:repo_hook,admin:org_hook,gist,notifications,user,delete_repo,write:discussion,codespace,project,admin:gpg_key,admin:ssh_signing_key',
    fullPowerHint: '经典 token（classic），所有权限已经勾好；过期时间选 No expiration，然后点 Generate token。',
    unlocks: ['开仓库、推代码', '发 Pages 个人主页', '开 issue 和 PR', '用 Actions 跑任务'],
    agentCreates: ['仓库', 'Pages 站点', 'Actions 密钥'],
    workerEnv: { GITHUB_TOKEN: 'token', GH_TOKEN: 'token' },
    verifiable: true,
  },
  { id: 'vercel', label: 'Vercel', group: 'code', human: 'signup', methods: ['token', 'browser'], fields: { token: [{ id: 'token', label: 'Token', secret: true }] }, signupUrl: 'https://vercel.com/signup', loginUrl: 'https://vercel.com/login', tokenUrl: 'https://vercel.com/account/tokens', fullPowerHint: 'Scope 选 Full Account，过期时间选 No Expiration。', unlocks: ['部署网站', '预览环境', '自定义域名'], agentCreates: ['项目', '部署'], workerEnv: { VERCEL_TOKEN: 'token' }, verifiable: true },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    group: 'cloud',
    human: 'signup',
    methods: ['token', 'password', 'browser'],
    fields: { token: [{ id: 'token', label: 'API token', secret: true }], password: LOGIN() },
    signupUrl: 'https://dash.cloudflare.com/sign-up',
    loginUrl: 'https://dash.cloudflare.com/login',
    tokenUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    fullPowerHint: 'Create Token → Create Custom Token：Account 和 Zone 下面每一项都选 Edit，资源选 All accounts / All zones。',
    unlocks: ['管 DNS', '部署 Workers 和 Pages', 'R2 存储', '域名邮件转发'],
    agentCreates: ['DNS 记录', 'Worker', 'R2 bucket'],
    workerEnv: { CLOUDFLARE_API_TOKEN: 'token' },
    verifiable: true,
  },
  {
    id: 'aws',
    label: 'AWS',
    group: 'cloud',
    human: 'signup',
    methods: ['token', 'password'],
    fields: { token: [{ id: 'accessKeyId', label: 'Access key ID', secret: false, placeholder: 'AKIA…' }, { id: 'secretAccessKey', label: 'Secret access key', secret: true }], password: LOGIN('root 邮箱') },
    signupUrl: 'https://signin.aws.amazon.com/signup?request_type=register',
    loginUrl: 'https://signin.aws.amazon.com/signin',
    tokenUrl: 'https://us-east-1.console.aws.amazon.com/iam/home#/users/create',
    fullPowerHint: '别给 root 建 access key：建一个 IAM 用户，挂 AdministratorAccess，再给这个用户建 access key。',
    unlocks: ['开服务器', 'S3 存储', '发邮件（SES）'],
    agentCreates: ['EC2 实例', 'S3 bucket', 'IAM 角色'],
    workerEnv: { AWS_ACCESS_KEY_ID: 'accessKeyId', AWS_SECRET_ACCESS_KEY: 'secretAccessKey' },
    verifiable: true,
  },
  {
    id: 'gcp',
    label: 'Google Cloud',
    group: 'cloud',
    human: 'signup',
    methods: ['file'],
    fields: { file: [{ id: 'serviceAccount', label: '服务账号 JSON', secret: true, kind: 'file' }] },
    signupUrl: 'https://console.cloud.google.com/freetrial',
    tokenUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts/create',
    fullPowerHint: '建一个服务账号，角色选 Owner；然后"密钥 → 添加密钥 → JSON"，把下载的文件拖进来。',
    unlocks: ['开虚拟机', 'Cloud Run', 'BigQuery'],
    agentCreates: ['项目', '服务'],
    verifiable: true,
  },
  {
    id: 'porkbun',
    label: '域名（Porkbun）',
    group: 'cloud',
    human: 'legal',
    methods: ['token'],
    fields: { token: [{ id: 'apiKey', label: 'API key', secret: true, placeholder: 'pk1_…' }, { id: 'secretKey', label: 'Secret API key', secret: true, placeholder: 'sk1_…' }] },
    signupUrl: 'https://porkbun.com/account/register',
    tokenUrl: 'https://porkbun.com/account/api',
    unlocks: ['买域名（登记人是你）', '管 DNS', '域名邮箱'],
    agentCreates: ['域名', 'DNS 记录'],
    notes: '域名的登记人是你或你的公司；它用你在"家长"页填的登记信息。',
    verifiable: true,
  },
  { id: 'supabase', label: 'Supabase', group: 'data', human: 'signup', methods: ['token'], fields: { token: [{ id: 'token', label: 'Access token', secret: true, placeholder: 'sbp_…' }] }, signupUrl: 'https://supabase.com/dashboard/sign-up', loginUrl: 'https://supabase.com/dashboard/sign-in', tokenUrl: 'https://supabase.com/dashboard/account/tokens', unlocks: ['Postgres 数据库', '存文件', '用户登录'], agentCreates: ['数据库项目'], workerEnv: { SUPABASE_ACCESS_TOKEN: 'token' }, verifiable: true },
  { id: 'google', label: 'Google 账号', group: 'work', human: 'signup', methods: ['password', 'browser'], fields: { password: LOGIN('Gmail 地址') }, signupUrl: 'https://accounts.google.com/signup', loginUrl: 'https://accounts.google.com', unlocks: ['Gmail', '日历', 'Drive', '用 Google 登录别的网站'], verifiable: false },
  { id: 'notion', label: 'Notion', group: 'work', human: 'signup', methods: ['token', 'browser'], fields: { token: [{ id: 'token', label: 'Integration secret', secret: true, placeholder: 'ntn_…' }] }, signupUrl: 'https://www.notion.so/signup', loginUrl: 'https://www.notion.so/login', tokenUrl: 'https://www.notion.so/profile/integrations', unlocks: ['写文档', '管数据库和看板'], verifiable: true },
  { id: 'x', label: 'X（Twitter）', group: 'social', human: 'signup', methods: ['password', 'browser'], fields: { password: LOGIN('用户名或邮箱') }, signupUrl: 'https://x.com/i/flow/signup', loginUrl: 'https://x.com/login', unlocks: ['公开发帖', '回复和私信'], notes: '自动化账号要在资料里标注为 bot（Automated）。', verifiable: false },
  { id: 'resend', label: 'Resend（发邮件 API）', group: 'work', human: null, methods: ['token'], fields: { token: [{ id: 'key', label: 'API key', secret: true, placeholder: 're_…' }] }, signupUrl: 'https://resend.com/signup', unlocks: ['用自己的域名发邮件'], verifiable: true },
  { id: 'instacart', label: 'Instacart', group: 'errands', human: 'signup', methods: ['password', 'browser'], fields: { password: LOGIN() }, signupUrl: 'https://www.instacart.com/signup', loginUrl: 'https://www.instacart.com/login', unlocks: ['买菜送到家'], verifiable: false },
  { id: 'uber', label: 'Uber', group: 'errands', human: 'signup', methods: ['browser', 'password'], fields: { password: LOGIN('手机号或邮箱') }, signupUrl: 'https://auth.uber.com/v2/', loginUrl: 'https://auth.uber.com/v2/', unlocks: ['叫车', '外卖'], verifiable: false },
  { id: 'custom', label: '自定义资源', group: 'custom', human: null, methods: ['token', 'password', 'file'], fields: { token: [{ id: 'name', label: '叫什么', secret: false, placeholder: '比如 Mailgun' }, { id: 'token', label: 'Token 或 key', secret: true }], password: [{ id: 'name', label: '叫什么', secret: false }, { id: 'url', label: '登录地址', secret: false, kind: 'url', optional: true }, ...LOGIN()], file: [{ id: 'name', label: '叫什么', secret: false }, { id: 'file', label: '文件', secret: true, kind: 'file' }] }, unlocks: ['任何你想交给它的东西'], verifiable: false },
];

const CATEGORIES = [
  { id: 'compute', label: '自己的 token 和服务费', blocked: false },
  { id: 'software', label: '软件和订阅', blocked: false },
  { id: 'food', label: '外卖和日用品', blocked: false },
  { id: 'shopping', label: '网购', blocked: false },
  { id: 'travel', label: '机票酒店', blocked: false },
  { id: 'gift_cards', label: '礼品卡', blocked: true },
  { id: 'money_transfer', label: '转账汇款', blocked: true },
  { id: 'crypto', label: '加密货币', blocked: true },
  { id: 'gambling', label: '赌博', blocked: true },
];

// ---------------- state ----------------

const st = {
  mode: (preset === 'setup' ? 'setup' : 'control') as Mode,
  codes: new Map<string, { mode: Mode; exp: number }>(),
  tokens: new Map<string, Mode>(),
  setup: {
    born: false,
    agent: undefined as undefined | { name: string; slug: string; parentName: string },
    email: undefined as string | undefined,
    phone: undefined as string | undefined,
  },
  agent: { name: 'Fox', slug: 'fox', bornAt: ago(60 * 24 * 4 + 90), parentName: 'Dongyu', email: 'fox-7a2c@agentmail.to', phone: '+14155550182' },
  brain: null as string | null,
  telegram: { handle: undefined as string | undefined, claimUrl: undefined as string | undefined, bound: false, claimAt: 0 },
  wallet: { authenticated: false, approveAt: 0, frozen: false, mandate: undefined as Json | undefined },
  spend: [] as SpendRow[],
  ops: new Map<string, Op>(),
  resources: [] as Res[],
  inbox: [] as Code[],
  browser: { active: false, url: undefined as string | undefined },
  parent: { name: 'Dongyu', email: undefined as string | undefined, phone: undefined as string | undefined, legal: undefined as Json | undefined },
  workers: [] as Worker[],
  keys: [
    { name: 'openrouter_api_key', label: 'OpenRouter', present: true, tail: '…x9Qa' },
    { name: 'anthropic_api_key', label: 'Anthropic', present: false },
    { name: 'deepseek_api_key', label: 'DeepSeek', present: true, tail: '…72bd' },
    { name: 'telegram_bot_token', label: 'Telegram bot token', present: true, tail: '…Hk3w' },
    { name: 'agentmail_api_key', label: 'AgentMail', present: true, tail: '…k3Fz' },
    { name: 'agentphone_api_key', label: 'AgentPhone', present: true, tail: '…9QpL' },
  ] as { name: string; label: string; present: boolean; tail?: string }[],
};

const res = (r: Partial<Res> & Pick<Res, 'id' | 'kind' | 'label'>): Res => ({
  origin: 'parent',
  access: 'full',
  method: 'token',
  status: 'ok',
  secretFields: [],
  addedAt: ago(60 * 24 * 3),
  addedBy: 'parent',
  source: 'resource',
  hasSecret: {},
  ...r,
});

function identityResources(): void {
  const a = st.agent;
  st.resources = st.resources.filter((r) => r.source !== 'identity');
  const ids: Res[] = [];
  if (a.email) ids.push(res({ id: 'email', kind: 'agentmail', label: '它的邮箱', handle: a.email, origin: 'self', addedBy: 'agent', source: 'identity', addedAt: a.bornAt, verifiedAt: ago(30) }));
  if (a.phone) ids.push(res({ id: 'phone', kind: 'agentphone', label: '它的号码', handle: a.phone, origin: 'self', addedBy: 'agent', source: 'identity', addedAt: a.bornAt, verifiedAt: ago(30) }));
  ids.push(res({ id: 'signing_key', kind: 'signing_key', label: '签名密钥 (Ed25519)', handle: 'ed25519:7f3a9c…c21b', origin: 'self', method: 'none', addedBy: 'agent', source: 'identity', addedAt: a.bornAt }));
  if (st.brain) ids.push(res({ id: `brain_${st.brain}`, kind: st.brain, label: st.brain === 'openrouter' ? 'OpenRouter' : st.brain === 'anthropic' ? 'Anthropic' : 'DeepSeek', handle: `key ${st.keys.find((k) => k.name === `${st.brain}_api_key`)?.tail ?? '…'}`, source: 'identity', addedAt: ago(5), verifiedAt: ago(5), secretFields: ['key'], hasSecret: { key: true } }));
  st.resources.unshift(...ids);
}

function seedResources(): void {
  st.resources = [
    res({ id: 'github', kind: 'github', label: 'GitHub', handle: '@fox-vibefox', verifiedAt: ago(60 * 20), secretFields: ['token'], hasSecret: { token: true } }),
    res({ id: 'supabase', kind: 'supabase', label: 'Supabase', handle: 'fox-vibefox 的组织', verifiedAt: ago(60 * 26), secretFields: ['token'], hasSecret: { token: true } }),
    res({ id: 'supabase:fox-site', kind: 'supabase', label: 'fox-site 数据库', handle: 'db.qxhfoxsite.supabase.co', origin: 'self', method: 'none', parent: 'supabase', addedBy: 'agent', addedAt: ago(60 * 25), verifiedAt: ago(60 * 25), fields: { region: 'us-west-1', plan: 'free' }, note: '给 fox-site 的联系表单存留言。' }),
    res({ id: 'cloudflare', kind: 'cloudflare', label: 'Cloudflare', status: 'pending', method: 'password', access: 'unknown', secretFields: ['password'], hasSecret: { password: true }, fields: { username: st.agent.email }, addedAt: ago(60 * 2) }),
    res({ id: 'stripe', kind: 'stripe', label: 'Stripe 收款账号', status: 'failed', access: 'unknown', lastError: 'Stripe 说：Invalid API Key provided: sk_live_****3xQk（401）', secretFields: ['secretKey'], hasSecret: { secretKey: true }, addedAt: ago(60 * 30) }),
    res({ id: 'google', kind: 'google', label: 'Google 账号', handle: 'fox.vibefox@gmail.com', status: 'unverified', method: 'browser', addedAt: ago(60 * 50) }),
  ];
  identityResources();
}

function seedWorkers(): void {
  const brain = Boolean(st.brain);
  st.workers = [
    { id: 'builtin-openrouter-cheap', label: '便宜档 · deepseek/deepseek-v4.1-flash', harness: 'builtin', model: 'openrouter:deepseek/deepseek-v4.1-flash', tier: 1, enabled: brain, available: brain, reason: brain ? undefined : '先接上大脑' },
    { id: 'builtin-openrouter-mid', label: '中档 · anthropic/claude-sonnet-5.5', harness: 'builtin', model: 'openrouter:anthropic/claude-sonnet-5.5', tier: 2, enabled: brain, available: brain, reason: brain ? undefined : '先接上大脑' },
    { id: 'deepseek-harness', label: 'DeepSeek Harness（官方 dsh）· deepseek-v4.1-flash', harness: 'dsh', model: 'openrouter/deepseek/deepseek-v4.1-flash', tier: 1, enabled: false, available: brain, reason: brain ? undefined : '先接上大脑' },
    { id: 'claude-code', label: '最强档 · Claude Code (Opus)', harness: 'claude-code', model: 'opus', tier: 3, enabled: true, available: true },
    { id: 'opencode-deepseek', label: 'OpenCode · deepseek/deepseek-v4.1-flash', harness: 'opencode', tier: 1, enabled: false, available: false, reason: '这台 Mac 上没装 OpenCode' },
    { id: 'codex', label: 'Codex', harness: 'codex', tier: 3, enabled: false, available: false, reason: '还没登录：运行 codex login' },
  ];
}

function signMandate(monthly: number, perTx: number, allowed: string[], signedAt = now()): Json {
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
  const m: Json = {
    version: 1,
    currency: 'usd',
    monthlyLimitCents: monthly,
    perTransactionLimitCents: perTx,
    allowedCategories: allowed,
    blockedCategories: CATEGORIES.filter((c) => c.blocked).map((c) => c.id),
    rules: { tasksOnlyFromParent: true, discloseAI: true, notifyAfterSpend: true },
    parentStatement: `我授权 ${st.agent.name} 每月最多花 ${fmt(monthly)}，单笔不超过 ${fmt(perTx)}。这个数字是我愿意让它搞砸的最大金额。`,
    signedAt,
    signedBy: st.parent.name,
  };
  m.hash = crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex');
  m.agentSignature = crypto.randomBytes(64).toString('base64');
  return m;
}

function spendRow(merchant: string, url: string, cents: number, status: string, test: boolean, minutesAgo: number, last4: string | null): SpendRow {
  const at = ago(minutesAgo);
  return { id: `lsrq_${hex(6)}`, task_id: null, merchant_name: merchant, merchant_url: url, amount_cents: cents, currency: 'usd', status, approval_url: null, test: test ? 1 : 0, context: '', last4, created_at: at, updated_at: at };
}

if (preset !== 'setup') {
  if (preset === 'lived') {
    st.brain = 'openrouter';
    st.telegram = { handle: '@fox_vibefox_bot', claimUrl: 'https://t.me/fox_vibefox_bot?start=ab12cd34', bound: true, claimAt: 0 };
    st.wallet = { authenticated: true, approveAt: 0, frozen: false, mandate: signMandate(5000, 2500, ['compute', 'software', 'food', 'shopping'], ago(60 * 24 * 3)) };
    st.spend = [
      spendRow('vibefox onboarding test', 'https://github.com/Dongyu-Jia/vibefox', 100, 'approved', true, 60 * 24 * 3, '4242'),
      spendRow('OpenRouter credits', 'https://openrouter.ai/settings/credits', 1000, 'approved', false, 60 * 30, '8831'),
      spendRow('Namecheap — fox-site.dev', 'https://www.namecheap.com', 1240, 'pending_approval', false, 12, null),
    ];
    st.parent = { name: 'Dongyu', email: 'parent@example.com', phone: '+14155550100', legal: { fullName: 'Dongyu Jia', company: 'Fox Studio LLC', email: 'parent@example.com', phone: '+14155550100', address: { line1: '1 Market St', line2: 'Suite 300', city: 'San Francisco', state: 'CA', postalCode: '94105', country: 'US' }, consentAt: ago(60 * 24 * 2) } };
  }
  seedResources();
  seedWorkers();
}

const spentThisMonth = () => {
  const m = new Date().toISOString().slice(0, 7);
  return st.spend.filter((s) => !s.test && s.status === 'approved' && s.created_at.startsWith(m)).reduce((a, s) => a + s.amount_cents, 0);
};

function mintCode(mode: Mode): string {
  const code = hex(12);
  st.codes.set(code, { mode, exp: Date.now() + 120_000 });
  return code;
}

// ---------------- fake behaviour ----------------

function tick(): void {
  if (!st.wallet.authenticated && st.wallet.approveAt && Date.now() > st.wallet.approveAt) st.wallet.authenticated = true;
  if (st.telegram.handle && !st.telegram.bound && st.telegram.claimAt && Date.now() > st.telegram.claimAt) st.telegram.bound = true;
}

/** A signup page "sends" a verification email and an SMS code a few seconds after it opens. */
function scheduleCodes(url: string): void {
  if (!/sign-?up|register|join|create|freetrial|account\/account|auth\./i.test(url)) return;
  const host = new URL(url).hostname.replace(/^(www|dash|console|accounts|auth|signin|account)\./, '');
  const brand = host.split('.')[0];
  const Brand = brand[0].toUpperCase() + brand.slice(1);
  const github = host === 'github.com';
  setTimeout(() => {
    st.inbox.push(
      github
        ? { at: now(), channel: 'email', from: 'noreply@github.com', subject: 'Your GitHub launch code', code: digits(8) }
        : { at: now(), channel: 'email', from: `no-reply@${host}`, subject: `[${Brand}] 请验证你的邮箱地址 <${st.agent.email}>`, link: `https://${host}/verify-email?token=${hex(16)}` },
    );
  }, 5000);
  const sms = digits(6);
  setTimeout(() => st.inbox.push({ at: now(), channel: 'sms', from: '+12065550147', subject: `${Brand}: ${sms} is your verification code. Don't share it.`, code: sms }), 11000);
}

function fakeVerify(kind: Kind, method: Method, values: Record<string, string>, access: Res['access']): Pick<Res, 'status' | 'handle' | 'lastError' | 'access' | 'verifiedAt' | 'fields'> {
  if (Object.values(values).some((v) => v.startsWith('bad'))) {
    const why = kind.id === 'github' ? 'GitHub 说：Bad credentials（401）' : kind.id === 'stripe' ? 'Stripe 说：Invalid API Key provided（401）' : `${kind.label} 说：401 Unauthorized`;
    return { status: 'failed', lastError: why, access: 'unknown' };
  }
  if (method === 'file') {
    try {
      const j = JSON.parse(Object.values(values)[0] ?? '');
      if (j.type !== 'service_account') return { status: 'failed', lastError: '这不是服务账号的 JSON（type 不是 service_account）', access: 'unknown' };
      return { status: 'ok', handle: String(j.client_email ?? 'service account'), access, verifiedAt: now(), fields: { projectId: String(j.project_id ?? '') } };
    } catch {
      return { status: 'failed', lastError: '不是有效的 JSON', access: 'unknown' };
    }
  }
  if (method === 'browser' || !kind.verifiable) return { status: 'unverified', access };
  const handles: Record<string, string> = { github: '@fox-vibefox', cloudflare: 'Fox 的账号 · 2 个 zone', stripe: 'acct_1QfOxStUd10 · Fox Studio LLC', aws: 'arn:aws:iam::412093361175:user/fox', vercel: 'fox-vibefox', supabase: 'fox-vibefox 的组织', notion: 'Fox 的工作区', porkbun: 'Dongyu Jia（登记人）' };
  return { status: 'ok', handle: handles[kind.id] ?? values.username ?? st.agent.email, access, verifiedAt: now() };
}

function overview(): Json {
  tick();
  const ready = { brain: Boolean(st.brain), channel: st.telegram.bound, canWork: Boolean(st.brain) && st.telegram.bound };
  const anyParentRes = st.resources.some((r) => r.source === 'resource' && r.origin === 'parent' && r.status === 'ok');
  const steps = [
    { id: 'brain', title: '接上大脑（模型 key）', done: ready.brain, note: '没有大脑，它没法想事情。' },
    { id: 'telegram', title: '连上 Telegram，和它说话', done: ready.channel, note: '它只接你在对话渠道里布置的任务。' },
    { id: 'wallet', title: '连接 Link 钱包', done: st.wallet.authenticated, note: '用你自己的 Link 账号；每一笔都在 Link app 里批准。' },
    { id: 'mandate', title: '签零花钱授权书', done: Boolean(st.wallet.mandate), note: '定一个每月额度，它在额度内自己花。' },
    { id: 'workers', title: '选干活的 worker', done: st.workers.some((w) => w.enabled && w.available) && Boolean(st.brain) },
    { id: 'legal', title: '填一次登记人（要实名的东西用）', done: Boolean(st.parent.legal), note: 'Stripe 收款、域名登记人都用这份。' },
    { id: 'parent', title: '留下你的邮箱和手机号', done: Boolean(st.parent.email || st.parent.phone), note: '它就认得出你的邮件和短信。' },
    { id: 'resources', title: '交给它一个只许真人注册的平台账号', done: anyParentRes, note: '你在它的浏览器里注册一次，之后它自己在里面开东西。' },
  ];
  const tasks = ready.canWork
    ? [
        { id: 't_3', title: '给 fox-site 加一个联系表单，留言存到 Supabase', status: 'working' },
        { id: 't_2', title: '订 Supabase Pro？它想先问你', status: 'input-required' },
        { id: 't_1', title: '查下周去西雅图的机票，周五下午出发', status: 'completed' },
        { id: 't_0', title: '把 fox-site.dev 指到 Vercel 上 <script>alert(1)</script>', status: 'failed' },
      ]
    : [];
  return {
    agent: { name: st.agent.name, slug: st.agent.slug, bornAt: st.agent.bornAt, parentName: st.parent.name, email: st.agent.email, phone: st.agent.phone },
    ready,
    steps,
    money: { mandate: st.wallet.mandate, spentThisMonthCents: spentThisMonth(), frozen: st.wallet.frozen, wallet: st.wallet.authenticated ? 'open' : st.wallet.approveAt ? 'needs-parent' : 'none' },
    counts: { resources: st.resources.length, activeTasks: tasks.filter((t) => t.status === 'working' || t.status === 'input-required').length },
    recentTasks: tasks,
  };
}

function wallet(): Json {
  tick();
  return { authenticated: st.wallet.authenticated, details: st.wallet.authenticated ? { email: 'parent@example.com', country: 'US' } : undefined, mandate: st.wallet.mandate, mandateIntact: true, spentThisMonthCents: spentThisMonth(), frozen: st.wallet.frozen, spend: st.spend, categories: CATEGORIES };
}

function startOp(steps: { after: number; note?: string; done?: unknown; error?: string; run?: () => void }[]): string {
  const id = `op_${hex(5)}`;
  const op: Op = { status: 'running', notes: [] };
  st.ops.set(id, op);
  for (const s of steps) {
    setTimeout(() => {
      s.run?.();
      if (s.note) op.notes.push(s.note);
      if (s.done !== undefined) {
        op.status = 'done';
        op.result = s.done;
      }
      if (s.error) {
        op.status = 'error';
        op.error = s.error;
      }
    }, s.after);
  }
  return id;
}

// ---------------- routes ----------------

const str = (v: unknown) => (typeof v === 'string' ? v : '');

async function route(method: string, url: URL, body: Json, mode: Mode | null, host: string): Promise<unknown> {
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean);
  const POST = method === 'POST';
  const need = (m: Mode) => {
    if (mode !== m) throw new HttpError(401, 'unauthorized');
  };

  if (p === '/v1/whoami') return { mode: st.mode, agent: st.mode === 'control' ? { name: st.agent.name, slug: st.agent.slug } : st.setup.agent ? { name: st.setup.agent.name, slug: st.setup.agent.slug } : undefined };

  if (POST && (p === '/v1/control/session' || p === '/v1/setup/session')) {
    const want: Mode = seg[1] === 'setup' ? 'setup' : 'control';
    const c = st.codes.get(str(body.code));
    if (!c || c.mode !== want || c.exp < Date.now() || st.mode !== want) throw new HttpError(401, '这个链接已经用过或过期了');
    st.codes.delete(str(body.code));
    const token = hex(32);
    st.tokens.set(token, want);
    return want === 'setup' ? { token } : { token, agent: { name: st.agent.name, slug: st.agent.slug } };
  }

  // ---- setup ----
  if (seg[1] === 'setup') {
    need('setup');
    const S = st.setup;
    const keyCheck = (presetName: string) => {
      if (body.usePreset) {
        if (!st.keys.find((k) => k.name === presetName && k.present)) throw new HttpError(400, '没有存好的 key');
      } else if (!str(body.key)) throw new HttpError(400, '缺 key');
      else if (str(body.key).startsWith('bad')) throw new HttpError(400, `${presetName.startsWith('agentmail') ? 'AgentMail' : 'AgentPhone'} 说这个 key 不对（401 Unauthorized）`);
    };
    if (p === '/v1/setup/state') {
      return { born: S.born, agent: S.agent, email: S.email, phone: S.phone, preset: { agentmail: '…k3Fz', agentphone: '…9QpL' } };
    }
    if (POST && p === '/v1/setup/birth') {
      const name = str(body.name).trim();
      const parentName = str(body.parentName).trim();
      if (!name || !parentName) throw new HttpError(400, '名字不能空着');
      await sleep(500);
      const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
      S.born = true;
      S.agent = { name, slug, parentName };
      return { agent: S.agent };
    }
    if (!S.born) throw new HttpError(409, '先让它出生');
    if (POST && p === '/v1/setup/email/options') {
      keyCheck('agentmail_api_key');
      await sleep(600);
      return { inboxes: [{ id: 'inb_old1', email: 'fox-old@agentmail.to' }] };
    }
    if (POST && p === '/v1/setup/email') {
      keyCheck('agentmail_api_key');
      await sleep(700);
      if (body.use) {
        if (body.use !== 'inb_old1') throw new HttpError(404, '没有这个邮箱');
        S.email = 'fox-old@agentmail.to';
      } else {
        const u = str(body.username);
        if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(u)) throw new HttpError(400, '邮箱名不合法');
        if (u === 'taken') throw new HttpError(409, 'AgentMail 说这个名字被占了，换一个');
        S.email = `${u}@agentmail.to`;
      }
      return { email: S.email };
    }
    if (POST && p === '/v1/setup/phone/options') {
      keyCheck('agentphone_api_key');
      await sleep(600);
      return { numbers: [{ id: 'num_old1', phoneNumber: '+14155550123' }] };
    }
    if (POST && p === '/v1/setup/phone') {
      keyCheck('agentphone_api_key');
      await sleep(900);
      if (body.use) {
        if (body.use !== 'num_old1') throw new HttpError(404, '没有这个号码');
        S.phone = '+14155550123';
      } else {
        const area = str(body.areaCode);
        if (area && !/^\d{3}$/.test(area)) throw new HttpError(400, '区号是三位数字');
        if (area === '000') throw new HttpError(409, 'AgentPhone 说这个区号现在没有号码，换一个或者不填');
        S.phone = `+1${area || '628'}555${digits(4)}`;
      }
      return { phone: S.phone };
    }
    if (POST && p === '/v1/setup/finish') {
      await sleep(2500);
      // The real setup server installs launchd, waits for the daemon and hands over; here the same server just switches mode.
      st.mode = 'control';
      st.agent = { ...st.agent, name: S.agent!.name, slug: S.agent!.slug, bornAt: now(), email: S.email ?? '', phone: S.phone ?? '' };
      st.parent.name = S.agent!.parentName;
      st.resources = [];
      identityResources();
      seedWorkers();
      return { redirect: `http://${host}/ui/#code=${mintCode('control')}` };
    }
    throw new HttpError(404, `no route ${method} ${p}`);
  }

  // ---- control ----
  if (POST && p === '/v1/control/login-code') {
    return { code: mintCode('control') };
  }
  if (seg[1] !== 'control') throw new HttpError(404, `no route ${method} ${p}`);
  need('control');
  tick();

  if (p === '/v1/control/overview') return overview();
  if (p === '/v1/control/catalog') return { groups: GROUPS, kinds: KINDS };
  if (p === '/v1/control/keys') return { keys: st.keys };
  if (p === '/v1/control/codes') {
    const since = str(url.searchParams.get('since')) || ago(15);
    return { items: st.inbox.filter((c) => c.at > since) };
  }

  if (seg[2] === 'resources') {
    if (seg.length === 3 && !POST) return { resources: st.resources };
    if (seg.length === 3 && POST) {
      const kind = KINDS.find((k) => k.id === body.kind);
      if (!kind) throw new HttpError(400, '没有这种资源');
      const m = str(body.method) as Method;
      if (!kind.methods.includes(m)) throw new HttpError(400, `${kind.label} 不支持这种交法`);
      const values = (body.fields ?? {}) as Record<string, string>;
      const defs = kind.fields[m] ?? [];
      for (const f of defs) if (!f.optional && !str(values[f.id])) throw new HttpError(400, `${f.label} 是必填的`);
      await sleep(900);
      const access = (['full', 'scoped', 'read'].includes(str(body.access)) ? body.access : 'full') as Res['access'];
      const v = fakeVerify(kind, m, values, access);
      const secret = defs.filter((f) => f.secret).map((f) => f.id).filter((id) => values[id]);
      const plain = Object.fromEntries(defs.filter((f) => !f.secret && values[f.id]).map((f) => [f.id, values[f.id]]));
      let r = st.resources.find((x) => x.id === body.id && x.source === 'resource');
      if (!r) {
        let id = kind.id;
        for (let n = 2; st.resources.some((x) => x.id === id); n++) id = `${kind.id}:${n}`;
        r = res({ id, kind: kind.id, label: kind.id === 'custom' ? values.name || kind.label : kind.label, addedAt: now() });
        st.resources.push(r);
      }
      Object.assign(r, { method: m, status: v.status, handle: v.handle ?? r.handle, lastError: v.lastError, access: v.access ?? access, verifiedAt: v.verifiedAt, secretFields: [...new Set([...r.secretFields.filter((s) => s === 'password' && m === 'password'), ...secret])], fields: { ...plain, ...(v.fields ?? {}) } });
      r.hasSecret = Object.fromEntries(r.secretFields.map((s) => [s, true]));
      if (v.status === 'ok') r.lastError = undefined;
      return { resource: r };
    }
    if (POST && seg[3] === 'draft') {
      const kind = KINDS.find((k) => k.id === body.kind);
      if (!kind) throw new HttpError(400, '没有这种资源');
      let r = st.resources.find((x) => x.kind === kind.id && x.status === 'pending');
      if (!r) {
        let id = kind.id;
        for (let n = 2; st.resources.some((x) => x.id === id); n++) id = `${kind.id}:${n}`;
        r = res({ id, kind: kind.id, label: kind.label, status: 'pending', method: 'password', access: 'unknown', addedAt: now(), fields: { username: st.agent.email } });
        st.resources.push(r);
      }
      r.secretFields = [...new Set([...r.secretFields, 'password'])];
      r.hasSecret = { ...r.hasSecret, password: true };
      return { resource: r, password: generatePassword() };
    }
    const r = st.resources.find((x) => x.id === decodeURIComponent(seg[3] ?? ''));
    if (!r) throw new HttpError(404, '没有这个资源');
    if (POST && seg[4] === 'verify') {
      await sleep(800);
      if (r.status === 'unverified' && r.method === 'browser') Object.assign(r, { status: 'ok', verifiedAt: now(), handle: r.handle ?? st.agent.email });
      else if (r.status === 'ok') r.verifiedAt = now();
      return { resource: r };
    }
    if (POST && seg[4] === 'delete') {
      if (r.source === 'identity') throw new HttpError(400, '身份不能在这里移除');
      st.resources = st.resources.filter((x) => x !== r);
      return { ok: true };
    }
    if (POST && seg.length === 4) {
      for (const k of ['access', 'label', 'handle', 'note', 'status'] as const) if (body[k] !== undefined) (r as unknown as Json)[k] = body[k];
      if (body.fields) r.fields = { ...(r.fields ?? {}), ...(body.fields as Record<string, string>) };
      return { resource: r };
    }
  }

  if (seg[2] === 'browser') {
    if (!POST) return { active: st.browser.active, url: st.browser.url };
    if (seg[3] === 'start') {
      let u: URL;
      try {
        u = new URL(str(body.url));
      } catch {
        throw new HttpError(400, '这不是一个网址');
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, '只能打开 http(s) 网址');
      if (u.host === host || ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === String(PORT))) throw new HttpError(400, '它的浏览器不能打开控制台自己的地址');
      await sleep(400);
      st.browser = { active: true, url: u.href };
      scheduleCodes(u.href);
      return { ok: true };
    }
    if (seg[3] === 'finish') {
      st.browser = { active: false, url: undefined };
      return { ok: true };
    }
  }

  if (p === '/v1/control/brain' && POST) {
    const provider = str(body.provider);
    if (!['openrouter', 'anthropic', 'deepseek'].includes(provider)) throw new HttpError(400, '不认识这个供应商');
    if (body.usePreset && !st.keys.find((k) => k.name === `${provider}_api_key` && k.present)) throw new HttpError(400, '没有存好的 key');
    if (!body.usePreset && !str(body.key)) throw new HttpError(400, '缺 key');
    await sleep(1400);
    if (str(body.key).startsWith('bad')) return { ok: false, detail: `key 无效：Invalid API key（401）`, routerModel: '' };
    const models: Record<string, [string, string]> = { openrouter: ['openrouter:deepseek/deepseek-v4.1-flash', 'openrouter:anthropic/claude-sonnet-5.5'], anthropic: ['anthropic:claude-haiku-5-5', 'anthropic:claude-sonnet-5-5'], deepseek: ['deepseek:deepseek-v4-flash', 'deepseek:deepseek-v4-pro'] };
    st.brain = provider;
    if (!body.usePreset) {
      const k = st.keys.find((x) => x.name === `${provider}_api_key`);
      if (k) Object.assign(k, { present: true, tail: `…${str(body.key).slice(-4)}` });
    }
    identityResources();
    seedWorkers();
    const [cheap, mid] = models[provider];
    return { ok: true, detail: `✔ ${cheap} ready；✔ ${mid} ready`, routerModel: cheap };
  }

  if (p === '/v1/control/telegram') {
    if (!POST) return { handle: st.telegram.handle, bound: st.telegram.bound, claimUrl: st.telegram.claimUrl };
    if (body.usePreset && !st.keys.find((k) => k.name === 'telegram_bot_token' && k.present)) throw new HttpError(400, '没有存好的 token');
    const token = str(body.token);
    if (!body.usePreset && (!token || token.includes('bad'))) throw new HttpError(400, 'Telegram 说这个 token 不对（401 Unauthorized）');
    await sleep(800);
    const handle = `@${st.agent.slug.replace(/-/g, '_')}_vibefox_bot`;
    st.telegram = { handle, claimUrl: `https://t.me/${handle.slice(1)}?start=${hex(4)}`, bound: false, claimAt: Date.now() + 9000 };
    return { handle, claimUrl: st.telegram.claimUrl };
  }

  if (seg[2] === 'wallet') {
    if (!POST) return wallet();
    if (seg[3] === 'connect') {
      if (st.wallet.authenticated) return { already: true };
      await sleep(900);
      st.wallet.approveAt = Date.now() + 8000;
      return { already: false, verificationUrl: 'https://app.link.com/device?code=QWRT-8KZP', phrase: 'amber-otter-lantern' };
    }
    if (seg[3] === 'disconnect') {
      st.wallet.authenticated = false;
      st.wallet.approveAt = 0;
      return { ok: true };
    }
    if (seg[3] === 'test') {
      if (!st.wallet.authenticated) throw new HttpError(409, '先连接 Link 钱包');
      if (!st.wallet.mandate) throw new HttpError(409, '先签零花钱授权书');
      if (st.wallet.frozen) throw new HttpError(409, '冻结了，先解冻');
      const row = spendRow('vibefox onboarding test', 'https://github.com/Dongyu-Jia/vibefox', 100, 'pending_approval', true, 0, null);
      st.spend.push(row);
      const approval = `https://app.link.com/approve/${row.id}`;
      return {
        opId: startOp([
          { after: 600, note: `已发起 $1.00 测试申请（${row.id}）` },
          { after: 1500, note: `等你在 Link app 里批准：${approval}` },
          { after: 7000, run: () => Object.assign(row, { status: 'approved', last4: '4242', updated_at: now() }), done: { status: 'approved', spendRequestId: row.id, brand: 'visa', last4: '4242' } },
        ]),
      };
    }
  }

  if (p === '/v1/control/mandate' && POST) {
    if (!['我同意', 'yes', 'i agree'].includes(str(body.consent).trim().toLowerCase())) throw new HttpError(400, '要签字"我同意"');
    const monthly = Number(body.monthlyCents);
    const perTx = Number(body.perTxCents);
    if (!Number.isInteger(monthly) || monthly <= 0 || !Number.isInteger(perTx) || perTx <= 0) throw new HttpError(400, '金额必须是正整数（分）');
    if (perTx > monthly) throw new HttpError(400, '单笔上限不能超过每月额度');
    const allowed = (Array.isArray(body.allowed) ? body.allowed : []).map(String).filter((c) => CATEGORIES.some((x) => x.id === c && !x.blocked));
    await sleep(600);
    st.wallet.mandate = signMandate(monthly, perTx, allowed);
    return { mandate: st.wallet.mandate };
  }

  if (p === '/v1/control/freeze' && POST) {
    st.wallet.frozen = Boolean(body.frozen);
    return { frozen: st.wallet.frozen };
  }

  if (seg[2] === 'workers') {
    if (!seg[3]) return { workers: st.workers };
    const w = st.workers.find((x) => x.id === decodeURIComponent(seg[3]));
    if (!w) throw new HttpError(404, '没有这个 worker');
    if (!w.available) throw new HttpError(409, w.reason ?? '这个 worker 现在用不了');
    await sleep(300);
    w.enabled = Boolean(body.enabled);
    return { worker: w };
  }

  if (p === '/v1/control/parent') {
    if (!POST) return st.parent;
    if (body.email !== undefined) st.parent.email = str(body.email) || undefined;
    if (body.phone !== undefined) st.parent.phone = str(body.phone) || undefined;
    if (body.legal !== undefined) {
      const l = body.legal as Json;
      if (!str(l.fullName) || !str(l.consentAt)) throw new HttpError(400, '登记人要有姓名，并且同意');
      st.parent.legal = l;
    }
    await sleep(400);
    return { ok: true };
  }

  if (seg[2] === 'ops' && seg[3]) {
    const op = st.ops.get(seg[3]);
    if (!op) throw new HttpError(404, 'unknown op');
    return { status: op.status, result: op.result, error: op.error, notes: op.notes };
  }

  throw new HttpError(404, `no route ${method} ${p}`);
}

// ---------------- server ----------------

const server = http.createServer(async (req, resp) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const host = req.headers.host ?? '';
  const sendJson = (status: number, data: unknown) => {
    resp.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    resp.end(JSON.stringify(data ?? null));
  };
  // Same guards as the contract: DNS-rebinding-safe Host, same-origin only, no CORS preflight.
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return sendJson(403, { error: 'bad host' });
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return sendJson(403, { error: 'cross-origin request refused' });
  if (req.method === 'OPTIONS') return sendJson(405, { error: 'method not allowed' });

  if (url.pathname === '/' || url.pathname === '/ui') {
    resp.writeHead(302, { location: '/ui/' });
    return resp.end();
  }
  if (url.pathname.startsWith('/ui/')) {
    const name = url.pathname.slice(4) || 'index.html';
    if (!STATIC[name] || req.method !== 'GET') return sendJson(404, { error: 'not found' });
    resp.writeHead(200, { 'content-type': STATIC[name], ...SECURITY_HEADERS });
    return resp.end(fs.readFileSync(path.join(UI_DIR, name)));
  }
  if (url.pathname === '/dev/code') {
    const code = mintCode(st.mode);
    return sendJson(200, { code, url: `http://${host}/ui/#code=${code}` });
  }

  let raw = '';
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) return sendJson(413, { error: 'body too large' });
    raw += chunk;
  }
  let body: Json = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(400, { error: 'invalid json' });
  }
  const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const publicPath = url.pathname === '/v1/whoami' || url.pathname.endsWith('/session');
  if (url.pathname === '/v1/control/login-code' && auth !== DAEMON_TOKEN) return sendJson(401, { error: 'unauthorized' });
  const mode = auth ? (st.tokens.get(auth) ?? null) : null;
  if (!publicPath && url.pathname !== '/v1/control/login-code' && !mode) return sendJson(401, { error: 'unauthorized' });
  try {
    sendJson(200, await route(req.method ?? 'GET', url, body, mode, host));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    sendJson(status, { error: (err as Error).message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const code = mintCode(st.mode);
  process.stdout.write(`vibefox UI dev server (${preset}) on http://127.0.0.1:${PORT}\n`);
  process.stdout.write(`open: http://127.0.0.1:${PORT}/ui/#code=${code}\n`);
  process.stdout.write(`more one-time links: curl -s http://127.0.0.1:${PORT}/dev/code\n`);
});
