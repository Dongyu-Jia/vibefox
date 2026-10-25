import { VERIFIERS } from './verify.ts';

/**
 * Every kind of resource an agent can own or use, and what it takes to get one.
 *
 *  human     who has to be a person: `signup` (a platform only people may join: CAPTCHA,
 *            terms), `legal` (a real name: KYC, a registrant), `money` (the parent's card
 *            inside that service), `key` (a key from the parent's own account), null (the
 *            agent manages alone)
 *  methods   how the credential is handed over, best first: `token`, `password`
 *            (+ two-step secret), `browser` (logged in once in the agent's browser), `file`
 *  tokenUrl  deep link to where the credential is made, with full power pre-selected
 *            wherever the provider allows it; `fullPowerHint` says the rest in a few clicks
 *
 * The UI reads this through `publicKind` (no functions); `verify` stays on the server.
 */

export type ResourceGroup = 'identity' | 'money' | 'brain' | 'code' | 'cloud' | 'data' | 'work' | 'social' | 'errands' | 'custom';
export type HumanNeed = 'signup' | 'legal' | 'money' | 'key' | null;
export type CredentialMethod = 'token' | 'password' | 'browser' | 'file';

export interface CredentialField {
  id: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  kind?: 'text' | 'password' | 'totp' | 'url' | 'file';
  placeholder?: string;
  help?: string;
}

export interface VerifyResult {
  ok: boolean;
  handle?: string;
  detail: string;
  access?: 'full' | 'scoped' | 'read';
}

export interface ResourceKind {
  id: string;
  label: string;
  group: ResourceGroup;
  human: HumanNeed;
  methods: CredentialMethod[];
  fields: Partial<Record<CredentialMethod, CredentialField[]>>;
  signupUrl?: string;
  loginUrl?: string;
  /** Deep link; pre-selects full power where the provider allows it. */
  tokenUrl?: string;
  /** How to make a 100%-power credential, in the UI's language. */
  fullPowerHint?: string;
  /** What the agent can do with it. */
  unlocks: string[];
  /** Child resources it can make on its own. */
  agentCreates?: string[];
  /** ENV_NAME -> field id handed to workers, e.g. { GITHUB_TOKEN: 'token' }. */
  workerEnv?: Record<string, string>;
  verify?: (fields: Record<string, string>) => Promise<VerifyResult>;
  notes?: string;
}

export const RESOURCE_GROUPS: { id: ResourceGroup; label: string }[] = [
  { id: 'identity', label: '身份账号' },
  { id: 'money', label: '钱和收款' },
  { id: 'brain', label: '大脑（模型）' },
  { id: 'code', label: '代码' },
  { id: 'cloud', label: '云、部署和域名' },
  { id: 'data', label: '数据库' },
  { id: 'work', label: '协作工具' },
  { id: 'social', label: '社交平台' },
  { id: 'errands', label: '跑腿（购物、出行、订餐）' },
  { id: 'custom', label: '其他' },
];

// ---------- field builders ----------

const TOTP_HELP =
  '开两步验证时选"验证器 app"，点"无法扫码 / 显示密钥"，把那串字母（或者整条 otpauth:// 链接）粘贴到这里。有了它，它自己算验证码，不用再找你的手机。';

/** The UI gets the catalog as JSON: no keys holding `undefined`. */
function field(f: CredentialField): CredentialField {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as unknown as CredentialField;
}

function text(id: string, label: string, o: Partial<CredentialField> = {}): CredentialField {
  return field({ id, label, secret: false, kind: 'text', ...o });
}

function secret(id: string, label: string, o: Partial<CredentialField> = {}): CredentialField {
  return field({ id, label, secret: true, kind: 'password', ...o });
}

function token(label: string, o: Partial<CredentialField> = {}, more: CredentialField[] = []): CredentialField[] {
  return [secret('token', label, o), ...more];
}

/** Account + password + (optional) two-step secret, so it can log in like the parent would. */
function login(o: { user?: string; placeholder?: string; totp?: boolean; more?: CredentialField[] } = {}): CredentialField[] {
  return [
    text('username', o.user ?? '账号（邮箱或用户名）', { placeholder: o.placeholder }),
    secret('password', '密码', { help: '注册前可以让控制台替你生成一个强密码，已经替你存好' }),
    ...(o.totp === false ? [] : [secret('totp', '两步验证密钥', { optional: true, kind: 'totp', help: TOTP_HELP })]),
    ...(o.more ?? []),
  ];
}

/** Logged in once in the agent's own browser; nothing to paste. */
function browser(): CredentialField[] {
  return [text('username', '登的是哪个账号（可选）', { optional: true })];
}

const BROWSER_DIY = '最省事：在它的浏览器里登好一次，它就能自己去建 token。';

// ---------- the catalog ----------

const KINDS: Omit<ResourceKind, 'verify'>[] = [
  // ---- 身份账号 ----
  {
    id: 'google',
    label: 'Google 账号',
    group: 'identity',
    human: 'signup',
    methods: ['password', 'browser'],
    fields: {
      password: login({
        user: 'Gmail 地址',
        placeholder: 'fox@gmail.com',
        more: [secret('appPassword', '应用专用密码（可选）', { optional: true, help: '只有 IMAP/SMTP 收发 Gmail 才需要：开了两步验证后在 myaccount.google.com/apppasswords 生成' })],
      }),
      browser: browser(),
    },
    signupUrl: 'https://accounts.google.com/signup',
    loginUrl: 'https://accounts.google.com/',
    tokenUrl: 'https://myaccount.google.com/apppasswords',
    fullPowerHint: '给它账号 + 密码 + 两步验证密钥（在 Google 账号 → 安全 → 两步验证 → 身份验证器里添加，点"无法扫描"拿到密钥），它就能像你一样登录。只想让它收发邮件的话，再生成一个应用专用密码。',
    unlocks: ['Gmail 收发邮件', '用"使用 Google 账号登录"注册别的网站', '日历、Drive、Docs、YouTube', '同一个账号进 Google Cloud 控制台'],
    agentCreates: ['日历和文档', 'Google 表单', 'Google Cloud 项目（要你的结算账号才能花钱）'],
    notes:
      'Workspace 账号（公司域名邮箱）由管理员在 admin.google.com 直接创建，不用人机验证，管理员还能决定它能用哪些服务；普通 Gmail 注册要手机验证和人机验证，只能你来——可以用它自己的号码收验证短信。应用专用密码只在开了两步验证后出现，Workspace 管理员可能把它关了。Google 对新设备登录很敏感，第一次最好你在它的浏览器里登一次。',
  },
  {
    id: 'microsoft',
    label: 'Microsoft 账号',
    group: 'identity',
    human: 'signup',
    methods: ['password', 'browser'],
    fields: { password: login({ user: 'Microsoft 账号（邮箱）', placeholder: 'fox@outlook.com' }), browser: browser() },
    signupUrl: 'https://signup.live.com/',
    loginUrl: 'https://login.live.com/',
    fullPowerHint: '给它账号 + 密码 + 两步验证密钥（account.microsoft.com → 安全 → 高级安全选项 → 添加登录方式 → 验证器应用，选"无法扫描"拿到密钥）。',
    unlocks: ['Outlook 邮箱', 'OneDrive 和 Office 网页版', '用"使用 Microsoft 登录"注册别的网站', 'Azure 门户（同一个账号）'],
    notes: '注册要人机验证，只能你来。公司的工作或学校账号由管理员在 Microsoft Entra 后台创建。Azure 的服务主体（client id + secret）可以记成"其他"资源。',
  },
  {
    id: 'apple',
    label: 'Apple 账户',
    group: 'identity',
    human: 'signup',
    methods: ['password', 'browser'],
    fields: {
      password: login({
        user: 'Apple 账户（邮箱）',
        totp: false,
        more: [secret('appPassword', 'App 专用密码（可选）', { optional: true, help: '用 iCloud 邮件的 IMAP/SMTP 时需要：account.apple.com → 登录与安全 → App 专用密码' })],
      }),
      browser: browser(),
    },
    signupUrl: 'https://appleid.apple.com/account',
    loginUrl: 'https://account.apple.com/',
    fullPowerHint: 'Apple 的两步验证不用验证器 app，而是发到受信任设备或短信：把它自己的号码设成受信任号码，它就能自己收验证码。',
    unlocks: ['在这台 Mac 上用 iMessage 和 FaceTime', 'iCloud 邮箱和存储', 'App Store', '用"通过 Apple 登录"注册别的网站'],
    notes: '注册要短信验证和人机验证，只能你来。上架 App 的开发者计划要每年 $99 和你的法律身份。',
  },

  // ---- 钱和收款 ----
  {
    id: 'stripe',
    label: 'Stripe 收款账号',
    group: 'money',
    human: 'legal',
    methods: ['token'],
    fields: { token: token('Secret key 或 Restricted key', { placeholder: 'sk_live_… / rk_live_…', help: '测试环境的 sk_test_… 也可以' }) },
    signupUrl: 'https://dashboard.stripe.com/register',
    loginUrl: 'https://dashboard.stripe.com/login',
    tokenUrl: 'https://dashboard.stripe.com/apikeys',
    fullPowerHint: 'Developers → API keys → Secret key 点 Reveal，复制（这是 100% 权限）。想限制它，就点"Create restricted key"只勾需要的。',
    unlocks: ['收款：建商品、价格、Payment Link 和 Checkout', '开发票和订阅', '查订单、余额，处理退款'],
    agentCreates: ['商品和价格', 'Payment Link', 'Webhook 端点', '给 worker 用的 restricted key'],
    notes: '实名认证（KYC）、绑银行账户、税务信息只能你在 Stripe 里做，一次就好。它只用 key 收钱，不碰你的提现设置；它自己花钱永远走零花钱授权书。这个 key 默认不交给 worker。',
  },

  // ---- 大脑 ----
  {
    id: 'openai',
    label: 'OpenAI API',
    group: 'brain',
    human: 'key',
    methods: ['token'],
    fields: { token: token('API key', { placeholder: 'sk-proj-…' }) },
    signupUrl: 'https://platform.openai.com/signup',
    loginUrl: 'https://platform.openai.com/login',
    tokenUrl: 'https://platform.openai.com/api-keys',
    fullPowerHint: 'Create new secret key → Permissions 选 All → Create。记得在 Billing 里充值，最好设个月度上限。',
    unlocks: ['GPT 模型、图像、语音、Embedding', 'Codex 之类用 OpenAI 的 worker'],
    workerEnv: { OPENAI_API_KEY: 'token' },
  },
  {
    id: 'gemini',
    label: 'Gemini API（Google AI Studio）',
    group: 'brain',
    human: 'key',
    methods: ['token'],
    fields: { token: token('API key', { placeholder: 'AIza…' }) },
    loginUrl: 'https://aistudio.google.com/',
    tokenUrl: 'https://aistudio.google.com/apikey',
    fullPowerHint: 'Create API key → 选一个 Google Cloud 项目（没有就让它新建）→ 复制。',
    unlocks: ['Gemini 模型（长上下文、看图、看视频）', 'Imagen 和 Veo（要开结算）'],
    workerEnv: { GEMINI_API_KEY: 'token' },
    notes: '用你的 Google 账号登录 AI Studio 就能建 key。免费档的请求可能被 Google 用来改进模型，绑了结算账号就不会。',
  },
  {
    id: 'replicate',
    label: 'Replicate',
    group: 'brain',
    human: 'key',
    methods: ['token'],
    fields: { token: token('API token', { placeholder: 'r8_…' }) },
    signupUrl: 'https://replicate.com/signin',
    loginUrl: 'https://replicate.com/signin',
    tokenUrl: 'https://replicate.com/account/api-tokens',
    fullPowerHint: '起个名字（比如 vibefox）→ Create token → 复制。Replicate 的 token 本来就是全部权限；按用量付费，要先绑卡。',
    unlocks: ['跑开源模型：生图、视频、语音、放大', '部署自己的模型'],
    agentCreates: ['模型部署（deployment）'],
    workerEnv: { REPLICATE_API_TOKEN: 'token' },
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    group: 'brain',
    human: 'key',
    methods: ['token'],
    fields: { token: token('API key', { placeholder: 'sk_…' }) },
    signupUrl: 'https://elevenlabs.io/app/sign-up',
    loginUrl: 'https://elevenlabs.io/app/sign-in',
    tokenUrl: 'https://elevenlabs.io/app/settings/api-keys',
    fullPowerHint: 'Create API key → 不限制权限（至少打开 User: Read，验证要用）→ 复制。',
    unlocks: ['文字转语音、声音克隆、配音', '给它自己的电话声音'],
    agentCreates: ['声音（voice）'],
    workerEnv: { ELEVENLABS_API_KEY: 'token' },
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    group: 'brain',
    human: 'signup',
    methods: ['token', 'password', 'browser'],
    fields: { token: token('Access token', { placeholder: 'hf_…' }), password: login(), browser: browser() },
    signupUrl: 'https://huggingface.co/join',
    loginUrl: 'https://huggingface.co/login',
    tokenUrl: 'https://huggingface.co/settings/tokens/new?tokenType=write',
    fullPowerHint: '链接已经选好 Write 类型：起个名字 → Create token → 复制。',
    unlocks: ['下载模型和数据集（包括要同意条款的）', '发布自己的模型、数据集和 Spaces', 'Inference API'],
    agentCreates: ['模型仓库', '数据集', 'Spaces（小网页应用）'],
    workerEnv: { HF_TOKEN: 'token' },
    notes: '注册要人机验证，用它自己的邮箱注册，验证邮件会出现在卡片里。',
  },

  // ---- 代码 ----
  {
    id: 'github',
    label: 'GitHub',
    group: 'code',
    human: 'signup',
    methods: ['token', 'password', 'browser'],
    fields: {
      token: token('Personal access token（classic）', { placeholder: 'ghp_…', help: 'fine-grained 的 github_pat_… 也能用，但看不出权限范围' }),
      password: login({ user: '用户名或邮箱' }),
      browser: browser(),
    },
    signupUrl: 'https://github.com/signup',
    loginUrl: 'https://github.com/login',
    tokenUrl: 'https://github.com/settings/tokens/new?scopes=repo,workflow,admin:org,admin:repo_hook,admin:public_key,delete_repo,gist,user,write:packages&description=vibefox',
    fullPowerHint: '链接已经勾好全部权限：Expiration 选 No expiration → 拉到最下面 Generate token → 复制粘贴到这里。',
    unlocks: ['建仓库、推代码、开 PR 和 issue', 'GitHub Actions 和 Pages（免费发布网站）', 'Gist 和 Packages', '用"使用 GitHub 登录"注册开发者服务（Vercel、Supabase、Netlify……）'],
    agentCreates: ['仓库', 'GitHub Pages 网站', 'Actions secrets', '部署 key 和 SSH key', 'Gist'],
    workerEnv: { GITHUB_TOKEN: 'token', GH_TOKEN: 'token' },
    notes: '注册要过人机验证，只能你来：用它的邮箱注册，GitHub 发来的验证码会出现在卡片里。GitHub 要求开两步验证——选验证器 app，把密钥也交给它。之后它用自己的 SSH 密钥推代码。',
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    group: 'code',
    human: 'signup',
    methods: ['token', 'password', 'browser'],
    fields: {
      token: token('Personal access token', { placeholder: 'glpat-…' }, [text('instance', '自建 GitLab 地址（可选）', { optional: true, kind: 'url', placeholder: 'https://gitlab.com' })]),
      password: login(),
      browser: browser(),
    },
    signupUrl: 'https://gitlab.com/users/sign_up',
    loginUrl: 'https://gitlab.com/users/sign_in',
    tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens?name=vibefox&scopes=api,read_user,read_repository,write_repository,read_registry,write_registry',
    fullPowerHint: '链接已经勾好 api 等全部权限：到期日选能选的最晚一天（GitLab 最长约一年）→ Create token → 复制。',
    unlocks: ['建项目、推代码、开 merge request', 'CI/CD 和 GitLab Pages', '容器和包仓库'],
    agentCreates: ['项目', 'CI/CD 变量', '部署 token'],
    workerEnv: { GITLAB_TOKEN: 'token' },
    notes: '自建 GitLab 的 token 页在 <你的地址>/-/user_settings/personal_access_tokens。',
  },
  {
    id: 'npm',
    label: 'npm',
    group: 'code',
    human: 'signup',
    methods: ['token', 'password'],
    fields: { token: token('Granular access token', { placeholder: 'npm_…' }), password: login({ user: '用户名' }) },
    signupUrl: 'https://www.npmjs.com/signup',
    loginUrl: 'https://www.npmjs.com/login',
    fullPowerHint: '登录后点右上角头像 → Access Tokens → Generate New Token → Granular Access Token：Packages and scopes 选 Read and write、All packages；如果有"绕过两步验证"的选项就勾上（不然每次发布都要验证码）→ Generate → 复制。',
    unlocks: ['发布和更新 npm 包', '安装私有包'],
    agentCreates: ['npm 包'],
    workerEnv: { NPM_TOKEN: 'token' },
    notes: '有写权限的 token 最长 90 天，到期它会提醒你再开一个；也可以把账号密码和两步验证密钥交给它，让它自己续。',
  },
  {
    id: 'pypi',
    label: 'PyPI',
    group: 'code',
    human: 'signup',
    methods: ['token', 'password'],
    fields: { token: token('API token', { placeholder: 'pypi-…' }), password: login({ user: '用户名' }) },
    signupUrl: 'https://pypi.org/account/register/',
    loginUrl: 'https://pypi.org/account/login/',
    tokenUrl: 'https://pypi.org/manage/account/token/',
    fullPowerHint: 'Add API token → 起个名字 → Scope 选 Entire account (all projects) → Create token → 复制（只显示一次）。',
    unlocks: ['发布和更新 Python 包'],
    agentCreates: ['Python 包', '只管一个项目的 token'],
    workerEnv: { PYPI_TOKEN: 'token', UV_PUBLISH_TOKEN: 'token' },
    notes: 'PyPI 强制两步验证：注册后开验证器 app，把密钥也交给它（账号密码那一栏），它就能自己登录。',
  },
  {
    id: 'dockerhub',
    label: 'Docker Hub',
    group: 'code',
    human: 'signup',
    methods: ['token', 'password'],
    fields: { token: [text('username', 'Docker 用户名'), secret('token', 'Personal access token', { placeholder: 'dckr_pat_…' })], password: login({ user: '用户名' }) },
    signupUrl: 'https://hub.docker.com/signup',
    loginUrl: 'https://hub.docker.com/',
    tokenUrl: 'https://app.docker.com/settings/personal-access-tokens',
    fullPowerHint: 'Generate new token → 到期选 None → Access permissions 选 Read, Write, Delete → Generate → 复制。',
    unlocks: ['推送和拉取镜像', '私有镜像仓库'],
    agentCreates: ['镜像仓库'],
    workerEnv: { DOCKERHUB_USERNAME: 'username', DOCKERHUB_TOKEN: 'token' },
  },

  // ---- 云、部署和域名 ----
  {
    id: 'gcp',
    label: 'Google Cloud',
    group: 'cloud',
    human: 'signup',
    methods: ['file', 'browser'],
    fields: {
      file: [secret('json', '服务账号 JSON 密钥', { kind: 'file', help: '把下载的 .json 文件拖进来' })],
      browser: browser(),
    },
    signupUrl: 'https://console.cloud.google.com/',
    loginUrl: 'https://console.cloud.google.com/',
    tokenUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts/create',
    fullPowerHint: '选好项目 → 建服务账号（比如 fox）→ 角色选"Owner（所有者）"→ 完成 → 点进这个服务账号 → 密钥 → 添加密钥 → 创建新密钥 → JSON，把下载的文件拖进来。',
    unlocks: ['Cloud Run、虚拟机、Cloud Storage', 'BigQuery、Firebase、Vertex AI', '这个项目里的一切（Owner）'],
    agentCreates: ['Cloud Run 服务', 'Storage bucket', '虚拟机', 'BigQuery 数据集', '权限更小的服务账号'],
    workerEnv: { GOOGLE_CREDENTIALS: 'json' },
    notes:
      'GCP 要 Google 账号和一个绑了卡的结算账号（这是钱，只能你来）。2024 年以后新建的组织默认禁止下载服务账号密钥（组织政策 iam.disableServiceAccountKeyCreation）：要么在组织政策里关掉，要么改用"在它的浏览器里登好"。',
  },
  {
    id: 'aws',
    label: 'AWS',
    group: 'cloud',
    human: 'signup',
    methods: ['token', 'browser'],
    fields: {
      token: [
        secret('accessKeyId', 'Access key ID', { kind: 'text', placeholder: 'AKIA…' }),
        secret('secretAccessKey', 'Secret access key'),
        text('region', '默认区域（可选）', { optional: true, placeholder: 'us-east-1' }),
      ],
      browser: browser(),
    },
    signupUrl: 'https://signin.aws.amazon.com/signup?request_type=register',
    loginUrl: 'https://console.aws.amazon.com/',
    tokenUrl: 'https://console.aws.amazon.com/iam/home#/users/create',
    fullPowerHint: 'IAM → 创建用户（比如 fox）→ "直接附加策略"勾 AdministratorAccess → 创建 → 点进这个用户 → 安全凭证 → 创建访问密钥（用途选"命令行界面 CLI"）→ 复制 Access key ID 和 Secret。别用 root 账号的密钥。',
    unlocks: ['EC2、Lambda、S3、RDS……AWS 的一切', 'Route 53 域名和 SES 发信'],
    agentCreates: ['S3 bucket', 'Lambda 函数', '虚拟机', '权限更小的 IAM 用户和角色'],
    workerEnv: { AWS_ACCESS_KEY_ID: 'accessKeyId', AWS_SECRET_ACCESS_KEY: 'secretAccessKey', AWS_DEFAULT_REGION: 'region', AWS_REGION: 'region' },
    notes: 'AWS 注册要绑卡、手机验证和人机验证，只能你来。建议在 Billing → Budgets 里设一个预算提醒。',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    group: 'cloud',
    human: 'signup',
    methods: ['token', 'browser'],
    fields: {
      token: token('API token', {}, [text('accountId', 'Account ID（可选）', { optional: true, help: '控制台首页账号名旁边的 ··· → 复制账户 ID' })]),
      browser: browser(),
    },
    signupUrl: 'https://dash.cloudflare.com/sign-up',
    loginUrl: 'https://dash.cloudflare.com/login',
    tokenUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    fullPowerHint: `Create Token → 最下面 Create Custom Token → 权限里把 Account 和 Zone 下面的每一项都加上、选 Edit（至少：DNS、Email Routing、Workers、R2、Pages、Registrar、Zone Settings）→ Account Resources 选 All accounts，Zone Resources 选 All zones → Continue → Create Token。${BROWSER_DIY}`,
    unlocks: ['管 DNS', '域名邮箱：Email Routing 把 你@你的域名 转进它的收件箱', 'Workers 和 Pages：发布网站和 API', 'R2 存储', 'Registrar：按成本价买域名、续费（用你绑的卡）'],
    agentCreates: ['DNS 记录', 'Email Routing 地址', 'Workers 和 Pages 项目', 'R2 bucket', '域名（Registrar；花你的钱，先问你）'],
    workerEnv: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'accountId' },
    notes: '注册要人机验证，只能你来。验证只认用户 token（个人资料 → API Tokens）；账户级 token 也能用，但这里验证不了。',
  },
  {
    id: 'vercel',
    label: 'Vercel',
    group: 'cloud',
    human: 'signup',
    methods: ['token', 'browser'],
    fields: { token: token('Access token'), browser: browser() },
    signupUrl: 'https://vercel.com/signup',
    loginUrl: 'https://vercel.com/login',
    tokenUrl: 'https://vercel.com/account/settings/tokens',
    fullPowerHint: 'Create Token → Scope 选你的个人账号（Full Account）→ Expiration 选 No Expiration → Create → 复制。',
    unlocks: ['部署网站和 Next.js 应用', '管域名和环境变量'],
    agentCreates: ['项目和部署', '预览链接', '环境变量'],
    workerEnv: { VERCEL_TOKEN: 'token' },
    notes: '用它的 GitHub 账号注册最快（"Continue with GitHub"）。',
  },
  {
    id: 'netlify',
    label: 'Netlify',
    group: 'cloud',
    human: 'signup',
    methods: ['token', 'browser'],
    fields: { token: token('Personal access token', { placeholder: 'nfp_…' }), browser: browser() },
    signupUrl: 'https://app.netlify.com/signup',
    loginUrl: 'https://app.netlify.com/login',
    tokenUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
    fullPowerHint: 'New access token → 起个名字 → Expiration 选 No expiration → Generate token → 复制。个人 token 本来就是全部权限。',
    unlocks: ['部署网站', '表单和 Functions', '管域名'],
    agentCreates: ['站点和部署', '环境变量'],
    workerEnv: { NETLIFY_AUTH_TOKEN: 'token' },
  },
  {
    id: 'flyio',
    label: 'Fly.io',
    group: 'cloud',
    human: 'signup',
    methods: ['token', 'browser'],
    fields: { token: token('Access token', { placeholder: 'FlyV1 fm2_…' }), browser: browser() },
    signupUrl: 'https://fly.io/app/sign-up',
    loginUrl: 'https://fly.io/app/sign-in',
    tokenUrl: 'https://fly.io/user/personal_access_tokens',
    fullPowerHint: 'Create token → 起个名字 → 复制（个人 token 有你账号的全部权限）。',
    unlocks: ['在全球就近跑容器和小服务器', 'Postgres 和 Redis'],
    agentCreates: ['应用和机器', '卷（volume）', 'secrets'],
    workerEnv: { FLY_API_TOKEN: 'token' },
    notes: 'Fly.io 注册要绑卡，只能你来。',
  },
  {
    id: 'digitalocean',
    label: 'DigitalOcean',
    group: 'cloud',
    human: 'signup',
    methods: ['token', 'browser'],
    fields: { token: token('Personal access token', { placeholder: 'dop_v1_…' }), browser: browser() },
    signupUrl: 'https://cloud.digitalocean.com/registrations/new',
    loginUrl: 'https://cloud.digitalocean.com/login',
    tokenUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    fullPowerHint: 'Generate New Token → Expiration 选 No expiry → Scopes 选 Full Access → Generate Token → 复制。',
    unlocks: ['虚拟机（Droplet）', 'App Platform', '托管数据库和对象存储'],
    agentCreates: ['Droplet', 'App', 'Spaces bucket', '数据库'],
    workerEnv: { DIGITALOCEAN_ACCESS_TOKEN: 'token' },
    notes: '注册要绑卡（或 PayPal），只能你来。',
  },
  {
    id: 'hetzner',
    label: 'Hetzner Cloud',
    group: 'cloud',
    human: 'signup',
    methods: ['token', 'browser'],
    fields: { token: token('API token（一个项目的）'), browser: browser() },
    signupUrl: 'https://accounts.hetzner.com/signUp',
    loginUrl: 'https://console.hetzner.cloud/',
    fullPowerHint: '进 Cloud 控制台 → 选项目 → Security → API tokens → Generate API token → 权限选 Read & Write → 复制。token 只管这一个项目。',
    unlocks: ['便宜的虚拟机', '卷、网络、负载均衡'],
    agentCreates: ['服务器', '快照', '防火墙'],
    workerEnv: { HCLOUD_TOKEN: 'token' },
    notes: 'Hetzner 注册可能要上传证件或先付一笔钱做验证，只能你来。',
  },
  {
    id: 'domain',
    label: '域名',
    group: 'cloud',
    human: 'legal',
    methods: ['token'],
    fields: {
      token: [
        text('domain', '域名', { placeholder: 'fox.example.com' }),
        text('registrar', '在哪注册的（可选）', { optional: true, placeholder: 'Cloudflare' }),
        secret('token', '只管这个域名的 API token（可选）', { optional: true }),
      ],
    },
    signupUrl: 'https://dash.cloudflare.com/?to=/:account/domains/register',
    unlocks: ['自己的邮箱地址 你@域名（配 Cloudflare Email Routing）', '个人主页和网站', '给别的服务做域名验证'],
    agentCreates: ['子域名', 'DNS 记录', '域名邮箱地址'],
    notes: '通常它在你给的 Cloudflare 账号里自己买（Registrar，按成本价，花你绑的卡，买之前先问你）。域名的登记人是你或你的公司：用你在"法律身份"里填的那份，同意一次就行。',
  },

  // ---- 数据库 ----
  {
    id: 'supabase',
    label: 'Supabase',
    group: 'data',
    human: 'signup',
    methods: ['token', 'browser'],
    fields: { token: token('Personal access token', { placeholder: 'sbp_…' }), browser: browser() },
    signupUrl: 'https://supabase.com/dashboard/sign-up',
    loginUrl: 'https://supabase.com/dashboard/sign-in',
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    fullPowerHint: 'Generate new token → 起个名字 → 复制。个人 token 能管你所有的组织和项目。',
    unlocks: ['建 Postgres 数据库', '登录（Auth）、文件存储、Edge Functions', '拿数据库连接串和 API key'],
    agentCreates: ['项目（数据库）', 'Edge Function', 'Storage bucket'],
    workerEnv: { SUPABASE_ACCESS_TOKEN: 'token' },
    notes: '用它的 GitHub 账号注册最快。',
  },
  {
    id: 'neon',
    label: 'Neon',
    group: 'data',
    human: 'signup',
    methods: ['token', 'browser'],
    fields: { token: token('API key'), browser: browser() },
    signupUrl: 'https://console.neon.tech/signup',
    loginUrl: 'https://console.neon.tech/login',
    tokenUrl: 'https://console.neon.tech/app/settings/api-keys',
    fullPowerHint: 'Create new API key → 起个名字 → 复制（只显示一次）。个人 API key 有你账号的全部权限。',
    unlocks: ['Serverless Postgres', '数据库分支（像 git 一样）'],
    agentCreates: ['项目和分支', '数据库和角色'],
    workerEnv: { NEON_API_KEY: 'token' },
  },
  {
    id: 'upstash',
    label: 'Upstash',
    group: 'data',
    human: 'signup',
    methods: ['token', 'browser'],
    fields: { token: [text('email', '账号邮箱'), secret('token', 'Management API key')], browser: browser() },
    signupUrl: 'https://console.upstash.com/',
    loginUrl: 'https://console.upstash.com/',
    tokenUrl: 'https://console.upstash.com/account/api',
    fullPowerHint: 'Create API Key → 起个名字 → 复制。连同账号邮箱一起填。',
    unlocks: ['Serverless Redis', '消息队列（QStash）', '向量库'],
    agentCreates: ['Redis 库', 'QStash 主题'],
    workerEnv: { UPSTASH_EMAIL: 'email', UPSTASH_API_KEY: 'token' },
  },
  {
    id: 'pinecone',
    label: 'Pinecone',
    group: 'data',
    human: 'signup',
    methods: ['token', 'browser'],
    fields: { token: token('API key', { placeholder: 'pcsk_…' }), browser: browser() },
    signupUrl: 'https://app.pinecone.io/',
    loginUrl: 'https://app.pinecone.io/',
    fullPowerHint: '控制台左边 API keys → Create API key → 权限选 All → 复制。',
    unlocks: ['向量数据库（给它的记忆和搜索用）'],
    agentCreates: ['索引'],
    workerEnv: { PINECONE_API_KEY: 'token' },
  },

  // ---- 协作工具 ----
  {
    id: 'notion',
    label: 'Notion',
    group: 'work',
    human: 'key',
    methods: ['token', 'browser'],
    fields: { token: token('Internal integration secret', { placeholder: 'ntn_…' }), browser: browser() },
    loginUrl: 'https://www.notion.so/login',
    tokenUrl: 'https://www.notion.so/profile/integrations',
    fullPowerHint: 'New integration → 类型选 Internal → 能力把读、改、插入内容和读用户都勾上 → 保存 → 复制 secret。然后在要给它的页面右上角 ··· → Connections 里加上这个 integration（加在顶层页面，下面的子页面都能用）。',
    unlocks: ['读写你分享给它的页面和数据库', '记笔记、写文档、更新任务表'],
    agentCreates: ['页面', '数据库'],
    workerEnv: { NOTION_TOKEN: 'token' },
  },
  {
    id: 'linear',
    label: 'Linear',
    group: 'work',
    human: 'key',
    methods: ['token', 'browser'],
    fields: { token: token('Personal API key', { placeholder: 'lin_api_…' }), browser: browser() },
    loginUrl: 'https://linear.app/login',
    tokenUrl: 'https://linear.app/settings/account/security',
    fullPowerHint: 'Personal API keys → New API key → 起个名字，权限选 Full access、团队选全部 → Create → 复制。',
    unlocks: ['建和更新 issue、项目、周期', '在 issue 里评论'],
    agentCreates: ['issue', '项目'],
    workerEnv: { LINEAR_API_KEY: 'token' },
  },
  {
    id: 'slack',
    label: 'Slack bot',
    group: 'work',
    human: 'key',
    methods: ['token'],
    fields: { token: token('Bot token', { placeholder: 'xoxb-…' }) },
    loginUrl: 'https://slack.com/signin',
    tokenUrl: 'https://api.slack.com/apps?new_app=1',
    fullPowerHint: 'Create New App → From scratch → 起名、选你的工作区 → OAuth & Permissions → Bot Token Scopes 加上 chat:write、channels:read、channels:history、groups:history、im:history、users:read → Install to Workspace → 复制 Bot User OAuth Token（xoxb-…）。',
    unlocks: ['在你的 Slack 里发消息、读频道', '当一个团队成员'],
    workerEnv: { SLACK_BOT_TOKEN: 'token' },
    notes: '要把它邀请进频道（在频道里 /invite @它的名字）它才看得到。',
  },
  {
    id: 'discord',
    label: 'Discord bot',
    group: 'work',
    human: 'key',
    methods: ['token'],
    fields: { token: token('Bot token') },
    signupUrl: 'https://discord.com/register',
    loginUrl: 'https://discord.com/login',
    tokenUrl: 'https://discord.com/developers/applications',
    fullPowerHint: 'New Application → 起名 → 左边 Bot → Reset Token → 复制。再到 OAuth2 → URL Generator 勾 bot 和 Administrator，用生成的链接把它拉进你的服务器。',
    unlocks: ['在你的 Discord 服务器里聊天、管频道'],
    workerEnv: { DISCORD_BOT_TOKEN: 'token' },
    notes: '只有真人账号能在开发者后台建应用；bot 本身不需要再注册。',
  },
  {
    id: 'airtable',
    label: 'Airtable',
    group: 'work',
    human: 'key',
    methods: ['token', 'browser'],
    fields: { token: token('Personal access token', { placeholder: 'pat…' }), browser: browser() },
    signupUrl: 'https://airtable.com/signup',
    loginUrl: 'https://airtable.com/login',
    tokenUrl: 'https://airtable.com/create/tokens/new',
    fullPowerHint: '起个名字 → Scopes 全部加上（data.records 读写、schema.bases 读写、user.email:read……）→ Access 选所有工作区的所有 base（包括以后新建的）→ Create token → 复制。',
    unlocks: ['读写你的表格', '建新表、加字段'],
    agentCreates: ['base 和表'],
    workerEnv: { AIRTABLE_API_KEY: 'token' },
  },
  {
    id: 'figma',
    label: 'Figma',
    group: 'work',
    human: 'key',
    methods: ['token', 'browser'],
    fields: { token: token('Personal access token', { placeholder: 'figd_…' }), browser: browser() },
    signupUrl: 'https://www.figma.com/signup',
    loginUrl: 'https://www.figma.com/login',
    tokenUrl: 'https://www.figma.com/settings',
    fullPowerHint: 'Settings → Security → Personal access tokens → Generate new token → 每个 scope 都选最高的权限 → 复制。',
    unlocks: ['读设计稿、导出图片', '在设计稿里评论'],
    workerEnv: { FIGMA_API_KEY: 'token' },
  },

  // ---- 社交平台 ----
  {
    id: 'x',
    label: 'X（Twitter）',
    group: 'social',
    human: 'signup',
    methods: ['password', 'browser'],
    fields: { password: login({ user: '用户名、邮箱或手机号' }), browser: browser() },
    signupUrl: 'https://x.com/i/flow/signup',
    loginUrl: 'https://x.com/i/flow/login',
    fullPowerHint: '给它账号 + 密码 + 两步验证密钥（设置 → 安全和账号访问 → 安全 → 双重验证 → 验证器应用）。',
    unlocks: ['发帖、回复、私信', '用"使用 X 登录"注册别的网站'],
    notes: '注册要人机验证，只能你来。X 要求自动化账号在资料里标注为自动化账号（设置 → 你的账号 → 账号信息 → 自动化），并写明谁在管它——填你的账号。API 要付费，它默认用浏览器。',
  },
  {
    id: 'reddit',
    label: 'Reddit',
    group: 'social',
    human: 'signup',
    methods: ['password', 'browser'],
    fields: { password: login({ user: '用户名' }), browser: browser() },
    signupUrl: 'https://www.reddit.com/register/',
    loginUrl: 'https://www.reddit.com/login/',
    unlocks: ['发帖、评论、私信', '查资料（很多真人经验在这里）'],
    notes: '注册要人机验证，只能你来。很多版块不欢迎机器人：发帖前它会先看版规，并说明自己是 AI。',
  },
  {
    id: 'bluesky',
    label: 'Bluesky',
    group: 'social',
    human: 'signup',
    methods: ['token', 'browser'],
    fields: {
      token: [
        text('handle', 'Handle', { placeholder: 'fox.bsky.social' }),
        secret('appPassword', 'App password', { placeholder: 'xxxx-xxxx-xxxx-xxxx' }),
        text('service', '服务器（可选）', { optional: true, kind: 'url', placeholder: 'https://bsky.social' }),
      ],
      browser: browser(),
    },
    signupUrl: 'https://bsky.app/',
    loginUrl: 'https://bsky.app/',
    tokenUrl: 'https://bsky.app/settings/app-passwords',
    fullPowerHint: '设置 → 隐私与安全 → App passwords → 添加 → 起个名字；要让它收发私信就勾上"允许访问私信"→ 复制。',
    unlocks: ['发帖、回复、关注', '有了自己的域名还能把 handle 换成域名'],
    workerEnv: { BLUESKY_HANDLE: 'handle', BLUESKY_APP_PASSWORD: 'appPassword' },
  },
  {
    id: 'mastodon',
    label: 'Mastodon',
    group: 'social',
    human: 'signup',
    methods: ['token', 'password', 'browser'],
    fields: {
      token: [text('instance', '实例地址', { kind: 'url', placeholder: 'https://mastodon.social' }), secret('token', 'Access token')],
      password: login({ user: '邮箱', more: [text('instance', '实例地址', { kind: 'url', placeholder: 'https://mastodon.social' })] }),
      browser: browser(),
    },
    signupUrl: 'https://joinmastodon.org/servers',
    fullPowerHint: '在你的实例上：首选项 → 开发 → 新建应用 → 权限勾 read、write、follow、push → 提交 → 点进应用，复制"你的访问令牌"。',
    unlocks: ['发嘟文、回复、关注'],
    workerEnv: { MASTODON_BASE_URL: 'instance', MASTODON_ACCESS_TOKEN: 'token' },
    notes: '有些实例欢迎 bot 账号（比如 botsin.space 这类），注册前看一下实例规则；资料里勾上"这是机器人账号"。',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    group: 'social',
    human: 'signup',
    methods: ['browser', 'password'],
    fields: { browser: browser(), password: login({ user: '邮箱' }) },
    signupUrl: 'https://www.linkedin.com/signup',
    loginUrl: 'https://www.linkedin.com/login',
    unlocks: ['看资料和职位', '帮你起草消息和帖子'],
    notes: 'LinkedIn 只允许真人用自己的身份开账号，而且严格限制自动化。通常是你的账号在它的浏览器里登好，它帮你看、帮你起草，发出去之前先问你。',
  },

  // ---- 跑腿 ----
  {
    id: 'amazon',
    label: 'Amazon',
    group: 'errands',
    human: 'money',
    methods: ['browser', 'password'],
    fields: { browser: browser(), password: login({ user: '邮箱或手机号' }) },
    loginUrl: 'https://www.amazon.com/gp/css/order-history',
    signupUrl: 'https://www.amazon.com/',
    unlocks: ['查订单、追踪物流、退货', '在零花钱额度内下单'],
    notes: '通常用你自己的账号（收货地址和卡都在里面），在它的浏览器里登好。下单前它按零花钱授权书检查金额，花了就告诉你；也可以结账时用 Link 一次性卡。',
  },
  {
    id: 'uber',
    label: 'Uber',
    group: 'errands',
    human: 'money',
    methods: ['browser'],
    fields: { browser: browser() },
    loginUrl: 'https://m.uber.com/',
    unlocks: ['叫车、查行程和收据', 'Uber Eats 点外卖'],
    notes: 'Uber 用短信验证码登录：给你叫车就用你的账号（在它的浏览器里登好，验证码发到你手机）。叫车前它会先问你。',
  },
  {
    id: 'doordash',
    label: 'DoorDash',
    group: 'errands',
    human: 'money',
    methods: ['browser', 'password'],
    fields: { browser: browser(), password: login({ user: '邮箱' }) },
    loginUrl: 'https://www.doordash.com/',
    unlocks: ['点外卖、买日用品', '查订单'],
    notes: '用你的账号和你绑的卡，在它的浏览器里登好；下单前按零花钱授权书检查。',
  },
  {
    id: 'opentable',
    label: 'OpenTable',
    group: 'errands',
    human: null,
    methods: ['browser', 'password'],
    fields: { browser: browser(), password: login({ user: '邮箱' }) },
    signupUrl: 'https://www.opentable.com/',
    loginUrl: 'https://www.opentable.com/',
    unlocks: ['订餐厅、改期、取消'],
    notes: '它可以用自己的邮箱注册（验证码发到它的邮箱或号码）；订位写你的名字。遇到人机验证它会停下来找你。',
  },
  {
    id: 'shopify',
    label: 'Shopify 店铺',
    group: 'errands',
    human: 'key',
    methods: ['token', 'browser'],
    fields: {
      token: [text('shop', '店铺地址', { placeholder: 'your-store.myshopify.com' }), secret('token', 'Admin API access token', { placeholder: 'shpat_…' })],
      browser: browser(),
    },
    loginUrl: 'https://admin.shopify.com/',
    fullPowerHint: '店铺后台 → 设置 → 应用和销售渠道 → 开发应用 → 创建应用 → 配置 Admin API 权限（全部勾上）→ 安装应用 → 复制 Admin API access token（只显示一次）。如果后台已经不让建这种应用，就在 Shopify Dev Dashboard 建一个应用装到店里。',
    unlocks: ['上架商品、改价格和库存', '处理订单和发货', '看销售数据'],
    agentCreates: ['商品', '折扣码', '页面和博客文章'],
    workerEnv: { SHOPIFY_SHOP: 'shop', SHOPIFY_ACCESS_TOKEN: 'token' },
    notes: '开店和收款要你的法律身份，只能你来。',
  },

  // ---- 其他 ----
  {
    id: 'custom',
    label: '其他',
    group: 'custom',
    human: null,
    methods: ['password', 'token', 'browser'],
    fields: {
      password: customFields(),
      token: customFields(),
      browser: [text('name', '名字', { placeholder: '比如：公司内网' }), text('url', '网址（可选）', { optional: true, kind: 'url' }), text('login', '登的是哪个账号（可选）', { optional: true })],
    },
    unlocks: ['任何上面没有的服务：记下网址、账号、密码、token 和两步验证密钥，它就能用'],
  },
];

function customFields(): CredentialField[] {
  return [
    text('name', '名字', { placeholder: '比如：公司内网' }),
    text('url', '网址（可选）', { optional: true, kind: 'url' }),
    text('login', '账号（可选）', { optional: true }),
    secret('password', '密码（可选）', { optional: true }),
    secret('token', 'Token / API key（可选）', { optional: true }),
    secret('totp', '两步验证密钥（可选）', { optional: true, kind: 'totp', help: TOTP_HELP }),
  ];
}

export const RESOURCE_KINDS: ResourceKind[] = KINDS.map((k) => (VERIFIERS[k.id] ? { ...k, verify: VERIFIERS[k.id] } : { ...k }));

export function resourceKind(id: string): ResourceKind | undefined {
  return RESOURCE_KINDS.find((k) => k.id === id);
}

/** What the UI gets: everything but the verify function, plus whether there is one. */
export function publicKind(k: ResourceKind): Omit<ResourceKind, 'verify'> & { verifiable: boolean } {
  const { verify, ...rest } = k;
  return { ...rest, verifiable: typeof verify === 'function' };
}
