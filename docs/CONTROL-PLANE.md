# 控制台（本地 UI）与 agent 的资源

`vf init` 在浏览器里打开出生向导；之后 `vf ui` 打开控制台。都只在这台 Mac 上（127.0.0.1）。

## 出生只要三步

1. 名字（和你的名字）
2. 它自己的邮箱（AgentMail）
3. 它自己的电话号码（AgentPhone）

其他的都可以之后在控制台里一项一项加：大脑（模型 key）、Telegram、钱包和零花钱、worker、各种资源。没有大脑和对话渠道之前，它已经存在、能收邮件短信，但还不能接任务——控制台首页会明说。

## 资源（agent resources）

agent 拥有或能用的一切都是**资源**：邮箱、号码、钱包、平台账号、API token、云项目、数据库、域名……每个资源记着：

| 字段 | 意思 |
|---|---|
| `origin` | `parent`：你开好交给它 · `self`：它自己开的 |
| `access` | `full`：你给了 100% 权限的凭证 · `scoped` · `read` |
| `method` | `token` · `password`（账号 + 密码 + 可选两步验证密钥）· `browser`（在它的浏览器里登好）· `file`（比如 GCP 服务账号 JSON）· `none` |
| `parent` | 它是在哪个资源上建出来的（比如 Supabase 数据库 `fox-site` ← 你给的 Supabase token） |
| `status` | `ok`（验证通过）· `unverified` · `failed` · `pending`（注册到一半） |

凭证只存在 agent 自己的钥匙串条目里（`res.<资源id>.<字段>`），`resources.json` 只记"是什么"。worker 用 `vf resources` / `vf resource get <id> [字段]` / `vf resource otp <id>` 取用，每次取用都进审计日志。

**对 worker 只读。** 身份和资源只有家长能在控制台里改、收回、删除；worker 的 API 和工具只能读。agent 唯一能做的写操作是**追加**一个它自己建的资源（`origin: self`），不能用已有的 id、不能覆盖，每次都告诉你。
worker 和 daemon 是同一个 macOS 用户，理论上能在 shell 里直接删文件或钥匙串条目，所以 daemon 还有一层看守：它记着资源清单、身份、授权书、worker 配置和各个凭证的最后一份正确版本，发现有它以外的进程改了或删了，就立刻恢复、把被改的版本留作证据、在 Telegram 告诉你。这是"发现并恢复"，不是硬隔离——真要做到改不了，需要让 worker 跑在另一个 macOS 用户下。

### 哪些必须是人，哪些它自己能做

**只有人能给的根：**

- **钱**：Link 钱包 + 你签的零花钱授权书（或者你在某个服务里绑的卡）
- **法律身份**：要实名的东西（Stripe 收款账号、银行、公司）；域名的登记人是你或你的公司（你同意一次）
- **只许真人注册的平台**：Google、GitHub、Cloudflare、AWS、GCP、Apple、X……（验证码、条款）。每个平台你注册一次，交给它 100% 权限的 token 或账号密码
- **你账号里的 key**：AgentMail、AgentPhone

**有了这些，它自己能做：** 生成自己的密钥；点自己邮箱里的验证链接、读自己号码上的验证码；在你给的根资源里开东西（仓库、部署、bucket、数据库、DNS、域名邮箱……）；在允许 agent 注册的服务上用自己的邮箱和号码注册。遇到验证码（CAPTCHA）就停下来找你，从不绕过。

缺根资源时它会在 Telegram 里问你，并给你控制台里对应页面的链接。

## 进程与鉴权

- **控制台**由 daemon 提供：`GET /ui/*`（静态文件）和 `/v1/control/*`（JSON）。
- **出生向导**由 `vf init` 起的临时 setup 服务器提供（随机端口）：同一份 UI + `/v1/setup/*`。出生完成后它装好 launchd、等 daemon 起来、把浏览器交给 daemon 的控制台，然后退出。
- **家长会话**：`vf ui` 先在这台 Mac 上弹一个对话框，你点「打开控制台」（worker 的 shell 点不了；daemon token 在每个 worker 的环境里，光有它不够）。然后它拿到一个码、和 daemon 保持一条连接，打开 `…/ui/#code=<码>`。**`vf ui` 开着的时候，这个链接可以反复打开**（新标签页、刷新），都是同一个会话；**按 Ctrl-C 或者杀掉 `vf ui`，会话立刻结束**，链接作废；最长 12 小时。会话 token 只在 daemon 内存里，页面放在 `sessionStorage`，用 `Authorization: Bearer` 发。**worker 的 daemon token 访问不了 `/v1/control/*`。** `vf ui` 在 worker 里（有 `VF_RUN_ID` 或 `.vf-run.json`）拒绝运行。每开一个会话都会在 Telegram 告诉你。`vf init` 也一样：出生向导的链接在它运行期间可以反复打开，出生完它直接接着持有控制台的会话。
- **所有请求**：`Host` 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`（防 DNS rebinding）；带 `Origin` 时必须同源；`OPTIONS` 一律 405；请求体上限 1 MB；token 用常量时间比较。
- **静态页**：`Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`，`X-Frame-Options: DENY`，`X-Content-Type-Options: nosniff`，`Referrer-Policy: no-referrer`，`Cache-Control: no-store`。页面里从不放 token；收到的不可信文字（邮件标题、短信）一律 `textContent`。
- agent 自己的浏览器打不开 daemon 自己的端口（防止被网页注入的 worker 操作控制台）。

## 模块接口

```ts
// src/core/totp.ts
export function totp(secretBase32: string, at?: number, digits?: number, step?: number): string; // RFC 6238, SHA-1
export function base32Decode(s: string): Buffer;

// src/resources/catalog.ts
export type ResourceGroup = 'identity' | 'money' | 'brain' | 'code' | 'cloud' | 'data' | 'work' | 'social' | 'errands' | 'custom';
export type HumanNeed = 'signup' | 'legal' | 'money' | 'key' | null;
export type CredentialMethod = 'token' | 'password' | 'browser' | 'file';
export interface CredentialField { id: string; label: string; secret: boolean; optional?: boolean; kind?: 'text' | 'password' | 'totp' | 'url' | 'file'; placeholder?: string; help?: string }
export interface VerifyResult { ok: boolean; handle?: string; detail: string; access?: 'full' | 'scoped' | 'read' }
export interface ResourceKind {
  id: string; label: string; group: ResourceGroup; human: HumanNeed;
  methods: CredentialMethod[];
  fields: Partial<Record<CredentialMethod, CredentialField[]>>;
  signupUrl?: string; loginUrl?: string;
  tokenUrl?: string;        // deep link; pre-selects full power where the provider allows it
  fullPowerHint?: string;   // how to make a 100%-power credential, in the UI's language
  unlocks: string[];        // what the agent can do with it
  agentCreates?: string[];  // child resources it can make on its own
  workerEnv?: Record<string, string>; // ENV_NAME -> field id handed to workers, e.g. { GITHUB_TOKEN: 'token' }
  verify?: (fields: Record<string, string>) => Promise<VerifyResult>;
  notes?: string;
}
export const RESOURCE_GROUPS: { id: ResourceGroup; label: string }[];
export const RESOURCE_KINDS: ResourceKind[];
export function resourceKind(id: string): ResourceKind | undefined;
export function publicKind(k: ResourceKind): Omit<ResourceKind, 'verify'> & { verifiable: boolean };

// src/resources/store.ts
export interface Resource {
  id: string; kind: string; label: string; handle?: string;
  origin: 'parent' | 'self'; access: 'full' | 'scoped' | 'read' | 'unknown';
  method: CredentialMethod | 'none'; parent?: string;
  status: 'ok' | 'unverified' | 'failed' | 'pending';
  verifiedAt?: string; lastError?: string;
  secretFields: string[];             // names only
  fields?: Record<string, string>;    // non-secret values (username, instance URL, project id…)
  addedAt: string; addedBy: 'parent' | 'agent'; note?: string;
}
export interface AddResourceInput {
  kind: string; id?: string; label?: string; handle?: string;
  origin?: 'parent' | 'self'; access?: Resource['access']; method?: Resource['method'];
  fields?: Record<string, string>; parent?: string; note?: string; status?: Resource['status'];
  addedBy?: 'parent' | 'agent';
}
export class Resources {
  constructor(body: Body, secrets: SecretStore);
  list(): Resource[];
  get(id: string): Resource | undefined;
  add(input: AddResourceInput): Resource;        // secret fields -> secrets.set(`res.${id}.${field}`); id defaults to kind (or kind:slug when taken)
  update(id: string, patch: Partial<Resource> & { fields?: Record<string, string> }): Resource;
  remove(id: string): void;                       // also deletes its secrets
  secret(id: string, field: string): string | undefined;
  otp(id: string): string | undefined;            // from a `totp` field
  verify(id: string): Promise<Resource>;          // runs kind.verify, records status/handle/verifiedAt
  workerEnv(): Record<string, string>;            // env for workers from resources with workerEnv
}
export function generatePassword(length?: number): string;

// src/onboarding/steps.ts — the wizard and the UI both call these
export async function bornAgent(input: { name: string; parentName: string; soul?: string; configOverrides?: Partial<AgentConfig> }): Promise<Body>;
export async function emailOptions(body: Body, key: string): Promise<{ inboxes: { id: string; email: string }[] }>;
export async function openEmail(body: Body, secrets: SecretStore, input: { key: string; use?: string; username?: string }): Promise<IdentityRecord>;
export async function phoneOptions(body: Body, key: string): Promise<{ numbers: { id: string; phoneNumber: string }[] }>;
export async function openPhone(body: Body, secrets: SecretStore, input: { key: string; use?: string; areaCode?: string }): Promise<IdentityRecord>;
export async function connectBrain(body: Body, secrets: SecretStore, input: { provider: 'openrouter' | 'anthropic' | 'deepseek'; key: string }): Promise<{ ok: boolean; detail: string; routerModel: string }>;
export async function connectTelegram(body: Body, secrets: SecretStore, input: { token: string }): Promise<{ handle: string; claimUrl: string }>;
export function signMandate(body: Body, input: { monthlyCents: number; perTxCents: number; allowed: string[]; consent: string }): Mandate; // consent ∈ 我同意 | yes | i agree; writes mandate history
export async function walletConnectStart(body: Body): Promise<{ already: boolean; verificationUrl?: string; phrase?: string }>;
export async function walletCheck(body: Body): Promise<{ authenticated: boolean; details?: Record<string, unknown> }>; // completes a pending login; writes the wallet identity when authenticated
export async function walletDisconnect(body: Body): Promise<void>;
export function setParent(body: Body, input: { email?: string; phone?: string; legal?: LegalProfile }): void;
export interface LegalProfile { fullName: string; company?: string; email: string; phone: string; address: { line1: string; line2?: string; city: string; state?: string; postalCode: string; country: string }; consentAt: string }

// src/browser/service.ts (additions)
beginParentSession(url: string): Promise<void>;  // headed, recording off, profile kept; worker calls get BrowserBusyError (423) meanwhile
endParentSession(): Promise<void>;
parentSession(): { active: boolean; url?: string };
guardOrigin(origins: string[]): void;            // the agent's browser refuses to open these origins

// src/daemon/services.ts (additions)
reload(): Promise<void>;                          // re-read email/phone/wallet config and restart watchers
recentCodes(sinceIso: string): Promise<{ at: string; channel: 'email' | 'sms'; from: string; subject?: string; code?: string; link?: string }[]>;
// pay(): refuses when the mandate fails mandateIntact or its signature check
```

## API

所有 `/v1/control/*`（除了 `session`）要家长会话 token；`/v1/setup/*`（除了 `session`）要 setup 会话 token。错误统一 `{ error }`。

```
GET  /v1/whoami                         → { mode: 'setup' | 'control', agent?: { name, slug } }   (无需鉴权)
POST /v1/control/login-code             → { code }            (daemon token + 你在对话框里点了允许；给 vf ui 用)
POST /v1/control/hold { code }          → 一直不结束的响应        (daemon token；vf ui 拿着它，连接断了会话就结束)
POST /v1/control/session  { code }      → { token, agent: { name, slug } }

GET  /v1/control/overview               → { agent: { name, slug, bornAt, parentName }, ready: { brain, channel, canWork }, steps: Step[], money: { mandate?, spentThisMonthCents, frozen, wallet: 'open'|'needs-parent'|'none' }, counts: { resources, activeTasks }, recentTasks: { id, title, status }[] }
     Step = { id: 'brain'|'telegram'|'wallet'|'mandate'|'workers'|'legal'|'parent'|'resources', title, done, note? }
GET  /v1/control/catalog                → { groups: { id, label }[], kinds: PublicKind[] }
GET  /v1/control/resources              → { resources: ResourceView[] }   (身份 + 资源合并；没有任何密钥值)
     ResourceView = Resource & { source: 'identity' | 'resource', hasSecret: Record<string, boolean> }
POST /v1/control/resources              { kind, method, fields, access?, id?, label?, handle?, parent?, note? } → { resource }   (能验证就当场验证)
POST /v1/control/resources/draft        { kind } → { resource, password }   (注册前先生成并保存一个强密码，状态 pending)
POST /v1/control/resources/:id          { fields?, access?, label?, handle?, note?, status? } → { resource }
POST /v1/control/resources/:id/verify   → { resource }
POST /v1/control/resources/:id/delete   → { ok: true }
GET  /v1/control/codes?since=ISO        → { items: { at, channel, from, subject?, code?, link? }[] }   (它刚收到的验证码/验证链接)
POST /v1/control/browser/start { url }  → { ok: true }    (在它的浏览器里给你开一个可见窗口)
POST /v1/control/browser/finish         → { ok: true }
GET  /v1/control/browser                → { active, url? }

GET  /v1/control/keys                   → { keys: { name, label, present, tail? }[] }   (你 .env.local 里存的 key)
POST /v1/control/brain  { provider, key? , usePreset? } → { ok, detail, routerModel }
GET  /v1/control/telegram               → { handle?, bound, claimUrl? }
POST /v1/control/telegram { token?, usePreset? } → { handle, claimUrl }
GET  /v1/control/wallet                 → { authenticated, details?, mandate?, mandateIntact, spentThisMonthCents, frozen, spend: SpendRow[] }
POST /v1/control/wallet/connect         → { already, verificationUrl?, phrase? }   (之后轮询 GET /v1/control/wallet)
POST /v1/control/wallet/disconnect      → { ok: true }
POST /v1/control/wallet/test            → { opId }       (GET /v1/control/ops/:id 轮询)
POST /v1/control/mandate { monthlyCents, perTxCents, allowed, consent } → { mandate }
POST /v1/control/freeze  { frozen }     → { frozen }
GET  /v1/control/workers                → { workers: { id, label, harness, model?, tier, enabled, available, reason? }[] }
POST /v1/control/workers/:id { enabled } → { worker }
GET  /v1/control/parent                 → { name, email?, phone?, legal? }
POST /v1/control/parent { email?, phone?, legal? } → { ok: true }
GET  /v1/control/ops/:id                → { status, result?, error?, notes: string[] }

POST /v1/setup/session { code }         → { token }
GET  /v1/setup/state                    → { born, agent?, email?, phone?, preset: { agentmail?: tail, agentphone?: tail } }
POST /v1/setup/birth { name, parentName } → { agent }
POST /v1/setup/email/options { key?, usePreset? } → { inboxes }
POST /v1/setup/email { key?, usePreset?, use?, username? } → { email }
POST /v1/setup/phone/options { key?, usePreset? } → { numbers }
POST /v1/setup/phone { key?, usePreset?, use?, areaCode? } → { phone }
POST /v1/setup/finish                   → { redirect }   (装 launchd、等 daemon、换好控制台的一次性码)
```

## 家长要做的事：几下点完

- **只许真人注册的平台**（例：GitHub）：① "在它的浏览器里打开注册页"——旁边是它的邮箱和号码（一键复制）和一个已经替你生成并保存好的强密码；② 它收到的验证邮件和短信验证码实时出现在卡片里，点一下就在它的浏览器里打开验证链接；③ "打开 token 页（已勾好全部权限）"→ 粘贴 → 当场验证。也可以只说"我已经在它的浏览器里登好了"。
- **法律身份**：一张表填一次（登记人姓名、地址、邮箱、电话）+ 同意一次。Stripe 收款账号：你在 Stripe 做实名，粘贴 key，当场验证（`/v1/account`）。
- **钱**：点"连接 Link"→ 大字显示核对短语和链接 → 你在 Link app 里批准，页面自己往下走 → 选零花钱（预设 $20 / $50 / $100 或自定义）和类别 → "我同意，签字" → 可选一笔 $1 测试。
