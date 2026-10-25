import crypto from 'node:crypto';
import { loggedFetch } from '../core/log.ts';
import type { VerifyResult } from './catalog.ts';

/**
 * Cheap, read-only "who am I" checks for resource credentials, one per provider
 * where the endpoint and its auth header are certain. Every call goes through
 * `loggedFetch('resource:<kind>')`, so it is audited and redacted like any other.
 * `VF_API_<KIND>` points a check at a local mock. A check never throws: a refused
 * credential, an unknown answer or an unreachable service is `{ ok: false, detail }`.
 */

export type Fields = Record<string, string>;
export type Verifier = (fields: Fields) => Promise<VerifyResult>;
// Provider JSON is read defensively, field by field.
type J = any;

/** `VF_API_<KIND>` (e.g. VF_API_GITHUB): a test or staging base URL for that provider. */
export function apiOverride(kind: string): string | undefined {
  return process.env[`VF_API_${kind.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`]?.replace(/\/+$/, '') || undefined;
}

export function apiBase(kind: string, fallback: string): string {
  return apiOverride(kind) ?? fallback;
}

/** A field value that cannot be right; reported as is, not as "unreachable". */
class BadInput extends Error {}

interface Reply {
  status: number;
  headers: Headers;
  body: J;
  text: string;
}

async function call(kind: string, url: string, init: RequestInit = {}): Promise<Reply> {
  const res = await loggedFetch(`resource:${kind}`, url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body: J = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, headers: res.headers, body, text };
}

function errMsg(r: Reply): string {
  const b = r.body ?? {};
  const first = (v: J): J => (Array.isArray(v) ? v[0] : v);
  const e = first(b.error ?? b.errors);
  const xml = /<Message>([^<]+)<\/Message>/.exec(r.text)?.[1];
  const nested = typeof e === 'object' && e ? (e.message ?? e.code) : undefined;
  const msg = nested ?? b.message ?? b.error_description ?? b.msg ?? b.detail ?? (typeof e === 'string' ? e : undefined) ?? xml ?? b.raw ?? 'error';
  return String(msg).split('\n')[0].slice(0, 160);
}

function refused(r: Reply): VerifyResult {
  if (r.status === 401 || r.status === 403) return { ok: false, detail: `凭证被拒绝（HTTP ${r.status}）：${errMsg(r)}` };
  return { ok: false, detail: `HTTP ${r.status}：${errMsg(r)}` };
}

function missing(fields: Fields, ...ids: string[]): VerifyResult | undefined {
  const gone = ids.filter((id) => !fields[id]?.trim());
  return gone.length ? { ok: false, detail: `缺少 ${gone.join('、')}` } : undefined;
}

/** Wraps a check so nothing it does can throw past it. */
function safe(fn: Verifier): Verifier {
  return async (fields) => {
    try {
      return await fn(fields);
    } catch (err) {
      if (err instanceof BadInput) return { ok: false, detail: err.message };
      const e = err as Error & { cause?: { code?: string } };
      return { ok: false, detail: `连不上：${e?.message ?? String(err)}${e?.cause?.code ? `（${e.cause.code}）` : ''}` };
    }
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token.trim()}` });

/** A user-given base URL (a self-hosted GitLab, a Mastodon instance); only http(s). */
function userBase(raw: string | undefined, fallback: string): string {
  const v = raw?.trim();
  if (!v) return fallback;
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    throw new BadInput(`不像网址：${v}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new BadInput(`不像网址：${v}`);
  return u.origin;
}

interface WhoamiSpec {
  need: string[];
  url: (f: Fields) => string;
  method?: string;
  headers: (f: Fields) => Record<string, string>;
  body?: (f: Fields) => string;
  /** 2xx bodies that still mean "no" (Slack answers 200 `{ ok: false }`). */
  rejects?: (b: J) => string | undefined;
  handle?: (b: J, f: Fields, r: Reply) => string | undefined;
  detail?: (b: J, f: Fields, r: Reply) => string;
  access?: (b: J, f: Fields, r: Reply) => VerifyResult['access'];
}

function whoami(kind: string, spec: WhoamiSpec): Verifier {
  return safe(async (f) => {
    const m = missing(f, ...spec.need);
    if (m) return m;
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'vibefox', ...spec.headers(f) };
    if (spec.body) headers['content-type'] ??= 'application/json';
    const r = await call(kind, spec.url(f), { method: spec.method ?? (spec.body ? 'POST' : 'GET'), headers, body: spec.body?.(f) });
    if (r.status < 200 || r.status >= 300) return refused(r);
    const no = spec.rejects?.(r.body);
    if (no) return { ok: false, detail: no };
    const handle = spec.handle?.(r.body, f, r) || undefined;
    const access = spec.access?.(r.body, f, r);
    return { ok: true, ...(handle ? { handle } : {}), ...(access ? { access } : {}), detail: spec.detail?.(r.body, f, r) ?? (handle ? `已登录：${handle}` : '凭证有效') };
  });
}

// ---------- GitHub: classic token scopes tell whether it is 100% power ----------

export const GITHUB_FULL_SCOPES = ['repo', 'workflow', 'admin:org', 'admin:repo_hook', 'admin:public_key', 'delete_repo', 'gist', 'user', 'write:packages'];

/** `X-OAuth-Scopes` → which of the full-power scopes are missing. A missing header (fine-grained token) is `undefined`. */
export function githubMissingScopes(header: string | null): string[] | undefined {
  if (header == null) return undefined;
  const have = new Set(header.split(',').map((s) => s.trim()).filter(Boolean));
  return GITHUB_FULL_SCOPES.filter((s) => !have.has(s));
}

const github: Verifier = safe(async (f) => {
  const m = missing(f, 'token');
  if (m) return m;
  const r = await call('github', `${apiBase('github', 'https://api.github.com')}/user`, {
    headers: { ...bearer(f.token), accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'vibefox' },
  });
  if (r.status !== 200) return refused(r);
  const login = String(r.body.login ?? '');
  if (!login) return { ok: false, detail: 'GitHub 没说这是谁' };
  const lack = githubMissingScopes(r.headers.get('x-oauth-scopes'));
  if (!lack) return { ok: true, handle: login, access: 'scoped', detail: `@${login}，fine-grained token（GitHub 不告诉它的权限范围）` };
  if (lack.length) return { ok: true, handle: login, access: 'scoped', detail: `@${login}，classic token，缺 ${lack.join('、')}` };
  return { ok: true, handle: login, access: 'full', detail: `@${login}，classic token，全部权限` };
});

// ---------- Stripe: a restricted key may not read the account, but a 403 still proves it is real ----------

const stripe: Verifier = safe(async (f) => {
  const m = missing(f, 'token');
  if (m) return m;
  const key = f.token.trim();
  const restricted = key.startsWith('rk_');
  const live = /_live_/.test(key);
  const r = await call('stripe', `${apiBase('stripe', 'https://api.stripe.com')}/v1/account`, { headers: bearer(key) });
  if (r.status === 403 && restricted) return { ok: true, access: 'scoped', detail: `restricted key 有效（${live ? '正式' : '测试'}环境，没有读账户信息的权限）` };
  if (r.status !== 200) return refused(r);
  const b = r.body;
  const handle = b.settings?.dashboard?.display_name || b.business_profile?.name || b.email || b.id;
  const state = b.charges_enabled ? '能收款' : b.details_submitted ? '资料已交，还在审核' : '还不能收款（实名没做完）';
  return { ok: true, handle, access: restricted ? 'scoped' : 'full', detail: `${live ? '正式' : '测试'}环境，${state}` };
});

// ---------- Google Cloud: a service-account key signs its own JWT (RS256) ----------

export function signJwtRs256(header: Record<string, unknown>, claims: Record<string, unknown>, privateKeyPem: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc(header)}.${enc(claims)}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKeyPem).toString('base64url')}`;
}

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

const gcp: Verifier = safe(async (f) => {
  const m = missing(f, 'json');
  if (m) return m;
  let sa: J;
  try {
    sa = JSON.parse(f.json);
  } catch {
    return { ok: false, detail: '这不是 JSON 文件' };
  }
  if (sa?.type !== 'service_account' || !sa.private_key || !sa.client_email) return { ok: false, detail: '这不是服务账号密钥（要 "type": "service_account" 的那种 JSON）' };
  // The signed assertion only ever goes to Google's own token endpoint (or the test mock).
  const aud = typeof sa.token_uri === 'string' && /^https:\/\/[a-z0-9.-]+\.googleapis\.com\//.test(sa.token_uri) ? sa.token_uri : GOOGLE_TOKEN_URI;
  const mock = apiOverride('gcp');
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwtRs256(
    { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id },
    { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud, iat: now, exp: now + 600 },
    sa.private_key,
  );
  const tok = await call('gcp', mock ? `${mock}/token` : aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (tok.status !== 200 || !tok.body.access_token) return refused(tok);
  const at = String(tok.body.access_token);
  const crm = mock ?? 'https://cloudresourcemanager.googleapis.com';
  if (!sa.project_id) return { ok: true, handle: sa.client_email, detail: '密钥有效（JSON 里没有项目 ID）' };
  const project = encodeURIComponent(sa.project_id);
  const p = await call('gcp', `${crm}/v1/projects/${project}`, { headers: bearer(at) });
  if (p.status !== 200) return { ok: true, handle: sa.client_email, detail: `密钥有效，但读不到项目 ${sa.project_id}（Cloud Resource Manager API 没开，或者没有权限）：${errMsg(p)}` };
  const perms = await call('gcp', `${crm}/v1/projects/${project}:testIamPermissions`, {
    method: 'POST',
    headers: { ...bearer(at), 'content-type': 'application/json' },
    body: JSON.stringify({ permissions: ['resourcemanager.projects.setIamPolicy', 'resourcemanager.projects.delete'] }),
  });
  const granted: string[] = perms.status === 200 && Array.isArray(perms.body.permissions) ? perms.body.permissions : [];
  const owner = granted.length === 2;
  return {
    ok: true,
    handle: sa.client_email,
    access: perms.status === 200 ? (owner ? 'full' : 'scoped') : undefined,
    detail: `项目 ${p.body.name ?? sa.project_id}（${p.body.lifecycleState ?? '?'}）${perms.status !== 200 ? '' : owner ? '，Owner 权限' : '，不是 Owner'}`,
  };
});

// ---------- AWS: SigV4-signed STS GetCallerIdentity ----------

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const sha256hex = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, s: string) => crypto.createHmac('sha256', key).update(s).digest();

export interface SigV4Input {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  date?: Date;
}

/** AWS Signature Version 4. Returns the headers to send (the given ones plus x-amz-date and authorization). */
export function sigV4(i: SigV4Input): Record<string, string> {
  const u = new URL(i.url);
  const amzDate = (i.date ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...i.headers, 'x-amz-date': amzDate };
  if (i.sessionToken) headers['x-amz-security-token'] = i.sessionToken;
  const canon: Record<string, string> = { host: u.host };
  for (const [k, v] of Object.entries(headers)) canon[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const names = Object.keys(canon).sort();
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const request = [i.method.toUpperCase(), u.pathname || '/', query, names.map((n) => `${n}:${canon[n]}\n`).join(''), names.join(';'), sha256hex(i.body)].join('\n');
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(request)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), i.service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

const aws: Verifier = safe(async (f) => {
  const m = missing(f, 'accessKeyId', 'secretAccessKey');
  if (m) return m;
  const url = `${apiBase('aws', 'https://sts.amazonaws.com')}/`;
  const body = 'Action=GetCallerIdentity&Version=2011-06-15';
  const headers = sigV4({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
    region: 'us-east-1',
    service: 'sts',
    accessKeyId: f.accessKeyId.trim(),
    secretAccessKey: f.secretAccessKey.trim(),
  });
  const r = await call('aws', url, { method: 'POST', headers, body });
  if (r.status !== 200) return refused(r);
  const arn = /<Arn>([^<]+)<\/Arn>/.exec(r.text)?.[1];
  const account = /<Account>([^<]+)<\/Account>/.exec(r.text)?.[1];
  if (!arn) return { ok: false, detail: 'AWS 没说这是谁' };
  if (arn.endsWith(':root')) return { ok: true, handle: arn, access: 'full', detail: `账号 ${account}，这是 root 用户的密钥（全部权限；更稳妥的是一个带 AdministratorAccess 的 IAM 用户）` };
  return { ok: true, handle: arn, detail: `账号 ${account}` };
});

// ---------- the rest: one whoami request each ----------

const count = (n: unknown, what: string) => `能看到 ${Array.isArray(n) ? n.length : 0} 个${what}`;

export const VERIFIERS: Record<string, Verifier> = {
  github,
  stripe,
  gcp,
  aws,
  gitlab: whoami('gitlab', {
    need: ['token'],
    url: (f) => `${apiOverride('gitlab') ?? userBase(f.instance, 'https://gitlab.com')}/api/v4/user`,
    headers: (f) => ({ 'private-token': f.token.trim() }),
    handle: (b) => b.username,
  }),
  huggingface: whoami('huggingface', {
    need: ['token'],
    url: () => `${apiBase('huggingface', 'https://huggingface.co')}/api/whoami-v2`,
    headers: (f) => bearer(f.token),
    handle: (b) => b.name,
    access: (b) => {
      const role = b.auth?.accessToken?.role;
      return role === 'write' ? 'full' : role === 'read' ? 'read' : role ? 'scoped' : undefined;
    },
    detail: (b) => `${b.name}，${b.auth?.accessToken?.role ?? '?'} token`,
  }),
  npm: whoami('npm', {
    need: ['token'],
    url: () => `${apiBase('npm', 'https://registry.npmjs.org')}/-/whoami`,
    headers: (f) => bearer(f.token),
    handle: (b) => b.username,
  }),
  cloudflare: whoami('cloudflare', {
    need: ['token'],
    url: () => `${apiBase('cloudflare', 'https://api.cloudflare.com')}/client/v4/user/tokens/verify`,
    headers: (f) => bearer(f.token),
    rejects: (b) => (b.success === false ? 'Cloudflare 说 token 无效' : b.result?.status && b.result.status !== 'active' ? `token 状态：${b.result.status}` : undefined),
    detail: (b) => `token 有效（${b.result?.status ?? 'active'}）`,
  }),
  vercel: whoami('vercel', {
    need: ['token'],
    url: () => `${apiBase('vercel', 'https://api.vercel.com')}/v2/user`,
    headers: (f) => bearer(f.token),
    handle: (b) => b.user?.username ?? b.user?.email,
  }),
  netlify: whoami('netlify', {
    need: ['token'],
    url: () => `${apiBase('netlify', 'https://api.netlify.com')}/api/v1/user`,
    headers: (f) => bearer(f.token),
    handle: (b) => b.email ?? b.slug,
    access: () => 'full',
  }),
  digitalocean: whoami('digitalocean', {
    need: ['token'],
    url: () => `${apiBase('digitalocean', 'https://api.digitalocean.com')}/v2/account`,
    headers: (f) => bearer(f.token),
    handle: (b) => b.account?.email,
    detail: (b) => `${b.account?.email ?? '?'}（账号状态 ${b.account?.status ?? '?'}）`,
  }),
  supabase: whoami('supabase', {
    need: ['token'],
    url: () => `${apiBase('supabase', 'https://api.supabase.com')}/v1/projects`,
    headers: (f) => bearer(f.token),
    access: () => 'full',
    detail: (b) => `个人 token 有效，${count(b, '项目')}`,
  }),
  neon: whoami('neon', {
    need: ['token'],
    url: () => `${apiBase('neon', 'https://console.neon.tech')}/api/v2/users/me`,
    headers: (f) => bearer(f.token),
    handle: (b) => b.email ?? b.login ?? b.name,
  }),
  upstash: whoami('upstash', {
    need: ['email', 'token'],
    url: () => `${apiBase('upstash', 'https://api.upstash.com')}/v2/redis/databases`,
    headers: (f) => ({ authorization: `Basic ${Buffer.from(`${f.email.trim()}:${f.token.trim()}`).toString('base64')}` }),
    handle: (_b, f) => f.email.trim(),
    detail: (b) => `API key 有效，${count(b, ' Redis 库')}`,
  }),
  pinecone: whoami('pinecone', {
    need: ['token'],
    url: () => `${apiBase('pinecone', 'https://api.pinecone.io')}/indexes`,
    headers: (f) => ({ 'api-key': f.token.trim() }),
    detail: (b) => `API key 有效，${count(b.indexes, '索引')}`,
  }),
  openai: whoami('openai', {
    need: ['token'],
    url: () => `${apiBase('openai', 'https://api.openai.com')}/v1/models`,
    headers: (f) => bearer(f.token),
    detail: (b) => `key 有效，${count(b.data, '模型')}`,
  }),
  gemini: whoami('gemini', {
    need: ['token'],
    // The key goes in a header, never in the query string (URLs end up in logs and proxies).
    url: () => `${apiBase('gemini', 'https://generativelanguage.googleapis.com')}/v1beta/models`,
    headers: (f) => ({ 'x-goog-api-key': f.token.trim() }),
    detail: (b) => `key 有效，${count(b.models, '模型')}`,
  }),
  replicate: whoami('replicate', {
    need: ['token'],
    url: () => `${apiBase('replicate', 'https://api.replicate.com')}/v1/account`,
    headers: (f) => bearer(f.token),
    handle: (b) => b.username,
  }),
  elevenlabs: whoami('elevenlabs', {
    need: ['token'],
    url: () => `${apiBase('elevenlabs', 'https://api.elevenlabs.io')}/v1/user`,
    headers: (f) => ({ 'xi-api-key': f.token.trim() }),
    handle: (b) => b.first_name || b.user_id,
    detail: (b) => `key 有效（套餐 ${b.subscription?.tier ?? '?'}）`,
  }),
  slack: whoami('slack', {
    need: ['token'],
    url: () => `${apiBase('slack', 'https://slack.com')}/api/auth.test`,
    method: 'POST',
    headers: (f) => bearer(f.token),
    rejects: (b) => (b.ok === true ? undefined : `Slack 说：${b.error ?? 'not ok'}`),
    handle: (b) => (b.user && b.team ? `${b.user}@${b.team}` : b.user),
  }),
  discord: whoami('discord', {
    need: ['token'],
    url: () => `${apiBase('discord', 'https://discord.com')}/api/v10/users/@me`,
    headers: (f) => ({ authorization: `Bot ${f.token.trim().replace(/^Bot\s+/i, '')}` }),
    handle: (b) => b.username,
    detail: (b) => `${b.bot ? 'bot' : '账号'} ${b.username ?? '?'}`,
  }),
  notion: whoami('notion', {
    need: ['token'],
    url: () => `${apiBase('notion', 'https://api.notion.com')}/v1/users/me`,
    headers: (f) => ({ ...bearer(f.token), 'notion-version': '2022-06-28' }),
    handle: (b) => b.name,
    detail: (b) => `integration「${b.name ?? '?'}」${b.bot?.workspace_name ? `，工作区 ${b.bot.workspace_name}` : ''}`,
  }),
  linear: whoami('linear', {
    need: ['token'],
    url: () => `${apiBase('linear', 'https://api.linear.app')}/graphql`,
    // Personal API keys go bare in Authorization; OAuth tokens carry "Bearer".
    headers: (f) => ({ authorization: f.token.trim() }),
    body: () => JSON.stringify({ query: '{ viewer { id name email } }' }),
    rejects: (b) => (b.data?.viewer ? undefined : `Linear 说：${b.errors?.[0]?.message ?? '没有 viewer'}`),
    handle: (b) => b.data?.viewer?.email ?? b.data?.viewer?.name,
  }),
  figma: whoami('figma', {
    need: ['token'],
    url: () => `${apiBase('figma', 'https://api.figma.com')}/v1/me`,
    headers: (f) => ({ 'x-figma-token': f.token.trim() }),
    handle: (b) => b.handle ?? b.email,
  }),
  airtable: whoami('airtable', {
    need: ['token'],
    url: () => `${apiBase('airtable', 'https://api.airtable.com')}/v0/meta/whoami`,
    headers: (f) => bearer(f.token),
    handle: (b) => b.email ?? b.id,
    detail: (b) => `token 有效${Array.isArray(b.scopes) ? `，${b.scopes.length} 项权限` : ''}`,
  }),
  bluesky: whoami('bluesky', {
    need: ['handle', 'appPassword'],
    url: (f) => `${apiOverride('bluesky') ?? userBase(f.service, 'https://bsky.social')}/xrpc/com.atproto.server.createSession`,
    headers: () => ({}),
    body: (f) => JSON.stringify({ identifier: f.handle.trim().replace(/^@/, ''), password: f.appPassword.trim() }),
    handle: (b) => b.handle,
  }),
  mastodon: whoami('mastodon', {
    need: ['instance', 'token'],
    url: (f) => `${apiOverride('mastodon') ?? userBase(f.instance, '')}/api/v1/accounts/verify_credentials`,
    headers: (f) => bearer(f.token),
    handle: (b, f) => (b.acct ? `@${b.acct}${String(b.acct).includes('@') ? '' : `@${new URL(userBase(f.instance, 'https://x')).host}`}` : undefined),
  }),
  shopify: whoami('shopify', {
    need: ['shop', 'token'],
    url: (f) => `${apiOverride('shopify') ?? `https://${shopDomain(f.shop)}`}/admin/api/2024-10/shop.json`,
    headers: (f) => ({ 'x-shopify-access-token': f.token.trim() }),
    handle: (b) => b.shop?.myshopify_domain ?? b.shop?.domain,
    detail: (b) => `店铺「${b.shop?.name ?? '?'}」`,
  }),
  domain: whoami('domain', {
    need: ['domain'],
    // DNS over HTTPS: does the name exist, and whose nameservers serve it?
    url: (f) => `${apiBase('domain', 'https://cloudflare-dns.com')}/dns-query?name=${encodeURIComponent(domainName(f.domain))}&type=NS`,
    headers: () => ({ accept: 'application/dns-json' }),
    rejects: (b) => (b.Status === 0 ? undefined : b.Status === 3 ? '这个域名不存在（还没注册，或者还没生效）' : `DNS 查询失败（状态 ${b.Status ?? '?'}）`),
    handle: (b) => String(b.Question?.[0]?.name ?? '').replace(/\.$/, '') || undefined,
    detail: (b) => {
      const ns: string[] = (b.Answer ?? []).filter((a: J) => a.type === 2).map((a: J) => String(a.data).replace(/\.$/, ''));
      if (!ns.length) return '域名存在';
      return `域名服务器：${ns.join('、')}${ns.every((n) => n.endsWith('.ns.cloudflare.com')) ? '（在 Cloudflare 上）' : ''}`;
    },
  }),
};

export function shopDomain(raw: string): string {
  const host = raw.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(host)) throw new BadInput(`不像店铺地址：${raw}`);
  return host.includes('.') ? host : `${host}.myshopify.com`;
}

function domainName(raw: string): string {
  const d = raw.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.$/, '').toLowerCase();
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(d)) throw new BadInput(`不像域名：${raw}`);
  return d;
}
