import type http from 'node:http';
import type { BrowserService } from '../browser/service.ts';
import { KEY_SPECS, setupKeys, tail } from '../cli/keys.ts';
import type { Body, IdentityRecord } from '../core/body.ts';
import { logEvent } from '../core/log.ts';
import type { SecretStore } from '../core/secrets.ts';
import type { Store } from '../core/store.ts';
import { IDENTITY_KINDS } from '../identity/registry.ts';
import { verify as verifySignature } from '../identity/selfmade.ts';
import { parseModelSpec, usableModel } from '../llm/index.ts';
import { addWorkers, connectBrain, connectTelegram, setParent, signMandate, walletCheck, walletConnectStart, walletDisconnect } from '../onboarding/steps.ts';
import { RESOURCE_GROUPS, RESOURCE_KINDS, publicKind, resourceKind, type ResourceGroup } from '../resources/catalog.ts';
import { generatePassword, type Resource, type Resources } from '../resources/store.ts';
import type { Router } from '../router/router.ts';
import { CATEGORY_LABELS, fmtCents, mandateIntact } from '../wallet/mandate.ts';
import type { WorkerManager } from '../workers/manager.ts';
import type { Services } from '../daemon/services.ts';
import { parentConfirms } from './confirm.ts';
import { errorStatus } from './errors.ts';
import { bearer, HttpError, readJson, sameToken, sendJson, type Ops, type Sessions } from './http.ts';

/**
 * `/v1/control/*`: what the parent does in the local UI after birth. Only a
 * parent session (from `vf ui`) gets in — never the token workers carry.
 * Every change is mirrored to the parent in Telegram and the journal.
 */

export interface ControlDeps {
  body: Body;
  store: Store;
  router: Router;
  services: Services;
  browser: BrowserService;
  manager: WorkerManager;
  secrets: SecretStore;
  resources: Resources;
  daemonToken: string;
  sessions: Sessions;
  ops: Ops;
  /** The daemon's own origins; the parent's browser window may not be sent there. */
  ownOrigins: string[];
  connectChannel(token: string): Promise<void>;
  onBrainChanged(): void;
}

const BLOCKED = ['gift_cards', 'money_transfer', 'crypto', 'gambling'];

const CATEGORY_GROUP: Record<string, ResourceGroup> = { 沟通: 'identity', 大脑: 'brain', 钱: 'money', 密码学: 'identity', 网络形象: 'identity', 账号: 'identity', 法律: 'identity' };

export type ResourceView = Resource & { source: 'identity' | 'resource'; group: ResourceGroup; hasSecret: Record<string, boolean> };

export function identityViews(body: Body): ResourceView[] {
  const recs = body.identity().identities;
  const status = (r: IdentityRecord): Resource['status'] => (r.status === 'open' ? 'ok' : r.status === 'failed' ? 'failed' : 'pending');
  return IDENTITY_KINDS.filter((k) => recs[k.id] && recs[k.id].status !== 'not-started').map((k) => {
    const r = recs[k.id];
    return {
      id: k.id,
      kind: k.id,
      label: k.name,
      handle: r.value,
      origin: r.openedBy === 'self' ? 'self' : 'parent',
      access: 'full',
      method: 'none',
      status: status(r),
      secretFields: [],
      addedAt: r.openedAt ?? '',
      addedBy: r.openedBy === 'self' ? 'agent' : 'parent',
      note: r.note,
      source: 'identity',
      group: CATEGORY_GROUP[k.category] ?? 'identity',
      hasSecret: {},
    };
  });
}

export function resourceView(resources: Resources, r: Resource): ResourceView {
  return {
    ...r,
    source: 'resource',
    group: resourceKind(r.kind)?.group ?? 'custom',
    // secretFields is kept in step with the keychain by the store (and the guard restores deletions): no audited read per listing.
    hasSecret: Object.fromEntries(r.secretFields.map((f) => [f, true])),
  };
}

export function createControl(d: ControlDeps): (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean> {
  const notify = (text: string) => {
    d.body.appendJournal(`- 控制台：${text.replace(/<[^>]+>/g, '')}`);
    void d.router.notifyParent(text).catch(() => {});
  };
  const str = (v: unknown, name: string, max = 4000): string => {
    if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} is required`);
    if (v.length > max) throw new HttpError(400, `${name} is too long`);
    return v.trim();
  };
  const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const strMap = (v: unknown): Record<string, string> => {
    if (v == null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'fields must be an object');
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === 'string' && val !== '') out[k] = val;
    return out;
  };
  const must = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new HttpError(404, `no ${what}`);
    return v;
  };

  const brainReady = (): boolean => {
    const cfg = d.body.config();
    return Boolean(usableModel(cfg.router.model, 'mid', d.secrets));
  };
  const telegramState = () => {
    const id = d.body.identity();
    const handle = id.identities.telegram_bot?.status === 'open' ? id.identities.telegram_bot.value : undefined;
    const code = d.body.onboarding().bindCode;
    const bound = Boolean(id.parent.telegram);
    return { handle, bound, claimUrl: handle && code && !bound ? `https://t.me/${handle.replace(/^@/, '')}?start=${code}` : undefined };
  };
  const workersView = () =>
    d.body.workers().map((w) => {
      const a = d.manager.available(w);
      return { id: w.id, label: w.label, harness: w.harness, model: w.model, tier: w.tier, enabled: w.enabled, available: a.ok, reason: a.reason };
    });
  const mandateView = () => {
    const m = d.body.mandate();
    if (!m) return undefined;
    const intact = mandateIntact(m) && Boolean(m.hash && m.agentSignature && verifySignature(d.body, m.hash, m.agentSignature));
    return { ...m, intact, summary: `${fmtCents(m.monthlyLimitCents, m.currency)}/月，单笔 ${fmtCents(m.perTransactionLimitCents, m.currency)}` };
  };
  const presetKey = (name: string): string => {
    const k = setupKeys().get(name);
    if (!k) throw new HttpError(400, `.env.local 里没有 ${name}`);
    return k;
  };

  async function route(method: string, p: string, url: URL, body: Record<string, unknown>): Promise<unknown> {
    const seg = p.split('/').filter(Boolean); // v1 control …
    const post = method === 'POST';
    const get = method === 'GET';

    if (p === '/v1/control/overview' && get) {
      const id = d.body.identity();
      const m = d.body.mandate();
      const tg = telegramState();
      const workers = workersView();
      const brain = brainReady();
      const wallet = id.identities.wallet;
      const res = d.resources.list();
      const steps = [
        { id: 'brain', title: '给它一个大脑（模型 key）', done: brain, note: brain ? d.body.config().router.model : undefined },
        { id: 'telegram', title: '连上 Telegram，和它说话', done: tg.bound, note: tg.handle && !tg.bound ? `${tg.handle} 等你认领` : undefined },
        { id: 'workers', title: '让 worker 待命', done: workers.some((w) => w.enabled && w.available) },
        { id: 'mandate', title: '定零花钱（签授权书）', done: Boolean(m) },
        { id: 'wallet', title: '连接 Link 钱包', done: wallet?.status === 'open' },
        { id: 'legal', title: '登记人信息（注册域名等要用）', done: Boolean(id.parent.legal) },
        { id: 'parent', title: '你的邮箱和手机（它好认出你）', done: Boolean(id.parent.email || id.parent.phone) },
        { id: 'resources', title: '交给它第一个资源', done: res.length > 0 },
      ];
      return {
        agent: { name: id.name, slug: id.slug, bornAt: id.bornAt, parentName: id.parent.name, email: id.identities.email?.value, phone: id.identities.phone?.value },
        ready: { brain, channel: tg.bound, canWork: brain && tg.bound && steps[2].done },
        steps,
        money: {
          mandate: m ? { monthlyLimitCents: m.monthlyLimitCents, perTransactionLimitCents: m.perTransactionLimitCents, allowedCategories: m.allowedCategories, signedAt: m.signedAt } : undefined,
          spentThisMonthCents: d.store.spentThisMonthCents(),
          frozen: d.store.get('frozen') === '1',
          wallet: wallet?.status === 'open' ? 'open' : wallet ? 'needs-parent' : 'none',
        },
        counts: { resources: res.length + identityViews(d.body).length, activeTasks: d.store.activeTasks().length },
        recentTasks: d.store.recentTasks(6).map((t) => ({ id: t.id, title: t.title, status: t.status })),
      };
    }

    // ----- resources -----
    if (p === '/v1/control/catalog' && get) return { groups: RESOURCE_GROUPS, kinds: RESOURCE_KINDS.map(publicKind) };
    if (p === '/v1/control/resources' && get) {
      return { resources: [...identityViews(d.body), ...d.resources.list().map((r) => resourceView(d.resources, r))] };
    }
    if (p === '/v1/control/resources' && post) {
      const kind = must(resourceKind(str(body.kind, 'kind', 80)), 'such resource kind');
      const methodName = (optStr(body.method) ?? kind.methods[0]) as Resource['method'];
      if (methodName !== 'none' && !kind.methods.includes(methodName)) throw new HttpError(400, `${kind.label} 不支持 ${methodName}`);
      const existing = optStr(body.id) ? d.resources.get(optStr(body.id)!) : undefined;
      if (existing) {
        // The UI sends the id of a pending draft (password already saved) or of the resource whose credential it replaces.
        if (existing.kind !== kind.id) throw new HttpError(409, `${existing.id} 是 ${existing.kind}，不是 ${kind.id}`);
        const updated = d.resources.update(existing.id, {
          method: methodName,
          status: 'unverified',
          ...(optStr(body.label) ? { label: optStr(body.label) } : {}),
          ...(optStr(body.handle) ? { handle: optStr(body.handle) } : {}),
          ...(optStr(body.note) ? { note: optStr(body.note) } : {}),
          ...(optStr(body.access) ? { access: optStr(body.access) as Resource['access'] } : {}),
          fields: strMap(body.fields),
        });
        const checked = kind.verify && (methodName === 'token' || methodName === 'file') ? await d.resources.verify(updated.id) : updated;
        logEvent('control.resource.updated', { id: checked.id, kind: kind.id, method: methodName, status: checked.status });
        notify(`🧩 ${kind.label}${checked.handle ? ' ' + checked.handle : ''} 交给我了（${checked.access === 'full' ? '完全权限' : checked.access}${checked.status === 'ok' ? '，验证通过' : checked.status === 'failed' ? '，验证没通过' : ''}）`);
        return { resource: resourceView(d.resources, checked) };
      }
      const r = d.resources.add({
        kind: kind.id,
        id: optStr(body.id),
        label: optStr(body.label),
        handle: optStr(body.handle),
        parent: optStr(body.parent),
        note: optStr(body.note),
        access: (optStr(body.access) as Resource['access']) ?? 'full',
        method: methodName,
        fields: strMap(body.fields),
        origin: 'parent',
        addedBy: 'parent',
      });
      const checked = kind.verify && methodName !== 'browser' ? await d.resources.verify(r.id) : r;
      logEvent('control.resource.added', { id: checked.id, kind: kind.id, method: methodName, status: checked.status });
      notify(`🧩 你在控制台交给我一个资源：<b>${kind.label}</b>${checked.handle ? ' ' + checked.handle : ''}（${checked.access === 'full' ? '完全权限' : checked.access}${checked.status === 'ok' ? '，验证通过' : checked.status === 'failed' ? '，验证没通过' : ''}）`);
      return { resource: resourceView(d.resources, checked) };
    }
    if (p === '/v1/control/resources/draft' && post) {
      const kind = must(resourceKind(str(body.kind, 'kind', 80)), 'such resource kind');
      if (!kind.methods.includes('password') && !kind.signupUrl && !kind.loginUrl) throw new HttpError(400, `${kind.label} 不用注册`);
      // The account's own password is worth keeping even when the hand-over is a token (Cloudflare, AWS…).
      const password = generatePassword();
      const login = d.body.identity().identities.email?.value;
      const fields = { password, ...(login ? { login } : {}) };
      const asked = optStr(body.id) ? d.resources.get(optStr(body.id)!) : undefined;
      const pending = asked?.kind === kind.id ? asked : d.resources.list().find((x) => x.kind === kind.id && x.origin === 'parent' && x.status === 'pending');
      const r = pending
        ? d.resources.update(pending.id, { fields })
        : d.resources.add({ kind: kind.id, method: kind.methods.includes('password') ? 'password' : kind.methods[0], status: 'pending', origin: 'parent', addedBy: 'parent', access: 'full', fields });
      logEvent('control.resource.draft', { id: r.id, kind: kind.id, reused: Boolean(pending) });
      return { resource: resourceView(d.resources, r), password };
    }
    if (seg[2] === 'resources' && seg.length >= 4 && post) {
      const id = decodeURIComponent(seg[3]);
      const existing = must(d.resources.get(id), 'such resource');
      const action = seg[4];
      if (action === 'verify') return { resource: resourceView(d.resources, await d.resources.verify(id)) };
      if (action === 'delete') {
        d.resources.remove(id);
        logEvent('control.resource.removed', { id });
        notify(`🧹 你在控制台收回了资源：${existing.label}`);
        return { ok: true };
      }
      if (action) throw new HttpError(404, `no route ${method} ${p}`);
      const fields = strMap(body.fields);
      const r = d.resources.update(id, {
        ...(optStr(body.label) ? { label: optStr(body.label) } : {}),
        ...(optStr(body.handle) ? { handle: optStr(body.handle) } : {}),
        ...(optStr(body.note) ? { note: optStr(body.note) } : {}),
        ...(optStr(body.access) ? { access: optStr(body.access) as Resource['access'] } : {}),
        ...(optStr(body.status) ? { status: optStr(body.status) as Resource['status'] } : {}),
        ...(optStr(body.method) ? { method: optStr(body.method) as Resource['method'] } : {}),
        fields,
      });
      const kind = resourceKind(r.kind);
      const checked = kind?.verify && Object.keys(fields).length && r.method !== 'browser' ? await d.resources.verify(id) : r;
      if (existing.status === 'pending' && checked.status !== 'pending') notify(`🧩 ${checked.label} 交给我了${checked.handle ? '：' + checked.handle : ''}`);
      return { resource: resourceView(d.resources, checked) };
    }
    if (p === '/v1/control/codes' && get) {
      const since = optStr(url.searchParams.get('since')) ?? new Date(Date.now() - 15 * 60_000).toISOString();
      return { items: await d.services.recentCodes(since) };
    }

    // ----- the parent's window into the agent's own browser -----
    if (p === '/v1/control/browser' && get) return d.browser.parentSession();
    if (p === '/v1/control/browser/start' && post) {
      const target = new URL(str(body.url, 'url'));
      if (!['http:', 'https:'].includes(target.protocol) || d.ownOrigins.includes(target.origin)) throw new HttpError(400, 'url not allowed');
      await d.browser.beginParentSession(target.toString());
      logEvent('control.browser.start', { origin: target.origin });
      return { ok: true };
    }
    if (p === '/v1/control/browser/finish' && post) {
      await d.browser.endParentSession();
      logEvent('control.browser.finish', {});
      return { ok: true };
    }

    // ----- keys, brain, channel -----
    if (p === '/v1/control/keys' && get) {
      const store = setupKeys();
      return { keys: KEY_SPECS.map((s) => ({ name: s.name, label: s.label, present: Boolean(store.get(s.name)), tail: store.get(s.name) ? tail(store.get(s.name)!) : undefined })) };
    }
    if (p === '/v1/control/brain' && post) {
      const provider = str(body.provider, 'provider') as 'openrouter' | 'anthropic' | 'deepseek';
      if (!['openrouter', 'anthropic', 'deepseek'].includes(provider)) throw new HttpError(400, 'unknown provider');
      const key = body.usePreset ? presetKey(`${provider}_api_key`) : str(body.key, 'key');
      const r = await connectBrain(d.body, d.secrets, { provider, key });
      d.onBrainChanged();
      logEvent('control.brain', { provider, ok: r.ok, routerModel: r.routerModel });
      if (r.ok) notify(`🧠 你在控制台给了我大脑：${parseModelSpec(r.routerModel).model}`);
      return r;
    }
    if (p === '/v1/control/telegram' && get) return telegramState();
    if (p === '/v1/control/telegram' && post) {
      const token = body.usePreset ? presetKey('telegram_bot_token') : str(body.token, 'token');
      const before = d.body.identity().identities.telegram_bot?.details?.botId;
      const r = await connectTelegram(d.body, d.secrets, { token });
      const after = d.body.identity().identities.telegram_bot?.details?.botId;
      if (before !== undefined && before !== after) {
        // A new bot has its own update ids and has never talked to the parent: start over and let them claim it.
        d.store.del('telegram_offset');
        d.body.updateIdentity((id) => delete id.parent.telegram);
      }
      await d.connectChannel(token);
      logEvent('control.telegram', { handle: r.handle });
      return r;
    }

    // ----- money -----
    if (p === '/v1/control/wallet' && get) {
      const st = await walletCheck(d.body).catch((e: Error) => ({ authenticated: false, details: { error: e.message } }));
      return {
        ...st,
        mandate: mandateView(),
        mandateIntact: mandateView()?.intact ?? true,
        spentThisMonthCents: d.store.spentThisMonthCents(),
        frozen: d.store.get('frozen') === '1',
        spend: [...d.store.spendRows()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20),
        categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id, label, blocked: BLOCKED.includes(id) })),
      };
    }
    if (p === '/v1/control/wallet/connect' && post) {
      const r = await walletConnectStart(d.body);
      logEvent('control.wallet.connect', { already: r.already });
      return r;
    }
    if (p === '/v1/control/wallet/disconnect' && post) {
      await walletDisconnect(d.body);
      notify('💳 你在控制台断开了我的 Link 钱包');
      return { ok: true };
    }
    if (p === '/v1/control/wallet/test' && post) {
      const id = d.body.identity();
      return d.ops.start((note) =>
        d.services.pay(
          {
            merchantName: 'vibefox control-plane test',
            merchantUrl: 'https://github.com/Dongyu-Jia/vibefox',
            amountCents: 100,
            context: `A $1.00 test-mode spend request from ${id.name}'s control plane, so the parent can see what an approval looks like. No real money moves.`,
            test: true,
            waitSeconds: 300,
          },
          note,
        ),
      );
    }
    if (p === '/v1/control/mandate' && post) {
      const monthlyCents = Math.round(Number(body.monthlyCents));
      const perTxCents = Math.round(Number(body.perTxCents));
      const allowed = Array.isArray(body.allowed) ? body.allowed.filter((c): c is string => typeof c === 'string' && c in CATEGORY_LABELS && !BLOCKED.includes(c)) : [];
      let m;
      try {
        m = signMandate(d.body, { monthlyCents, perTxCents, allowed, consent: String(body.consent ?? '') });
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      logEvent('control.mandate.signed', { monthlyCents, perTxCents, allowed, revision: m.revision });
      notify(`✍️ 你在控制台签了零花钱授权书${m.revision ? `（第 ${m.revision} 版）` : ''}：每月 ${fmtCents(monthlyCents)}，单笔 ${fmtCents(perTxCents)}`);
      return { mandate: mandateView() };
    }
    if (p === '/v1/control/freeze' && post) {
      const frozen = Boolean(body.frozen);
      if (frozen) d.store.set('frozen', '1');
      else d.store.del('frozen');
      logEvent('control.freeze', { frozen });
      notify(frozen ? '🧊 你在控制台把我冻结了：不花钱、不对外联系。' : '🌤 你在控制台给我解冻了。');
      return { frozen };
    }

    // ----- workers, parent -----
    if (p === '/v1/control/workers' && get) return { workers: workersView() };
    if (p === '/v1/control/workers/detect' && post) {
      const { added } = addWorkers(d.body, d.secrets);
      logEvent('control.workers.detect', { added });
      if (added.length) notify(`🛠 你在控制台给我加了 ${added.length} 个 worker：${added.join('、')}`);
      return { added, workers: workersView() };
    }
    if (seg[2] === 'workers' && seg.length === 4 && post) {
      const wid = decodeURIComponent(seg[3]);
      const all = d.body.workers();
      const w = must(all.find((x) => x.id === wid), 'such worker');
      w.enabled = Boolean(body.enabled);
      d.body.saveWorkers(all);
      logEvent('control.worker', { id: wid, enabled: w.enabled });
      notify(`🛠 你在控制台${w.enabled ? '启用' : '停用'}了 worker：${w.label}`);
      return { worker: workersView().find((x) => x.id === wid) };
    }
    if (p === '/v1/control/parent' && get) {
      const id = d.body.identity();
      return { name: id.parent.name, email: id.parent.email, phone: id.parent.phone, legal: id.parent.legal };
    }
    if (p === '/v1/control/parent' && post) {
      let legal = undefined as Parameters<typeof setParent>[1]['legal'];
      if (body.legal && typeof body.legal === 'object') {
        const l = body.legal as Record<string, unknown>;
        if (body.consent !== true && !(typeof l.consentAt === 'string' && l.consentAt)) throw new HttpError(400, '登记人信息要你同意才能存');
        const a = (l.address ?? {}) as Record<string, unknown>;
        legal = {
          fullName: str(l.fullName, 'fullName', 200),
          company: optStr(l.company),
          email: str(l.email, 'email', 200),
          phone: str(l.phone, 'phone', 60),
          address: { line1: str(a.line1, 'address.line1', 200), line2: optStr(a.line2), city: str(a.city, 'address.city', 100), state: optStr(a.state), postalCode: str(a.postalCode, 'address.postalCode', 30), country: str(a.country, 'address.country', 60) },
          consentAt: new Date().toISOString(),
        };
      }
      setParent(d.body, { email: optStr(body.email), phone: optStr(body.phone), legal });
      logEvent('control.parent', { email: Boolean(body.email), phone: Boolean(body.phone), legal: Boolean(legal) });
      if (legal) notify('🪪 你在控制台存了登记人信息（注册域名等需要登记人时我会用它）');
      return { ok: true };
    }
    if (seg[2] === 'ops' && seg.length === 4 && get) return d.ops.get(seg[3]);
    throw new HttpError(404, `no route ${method} ${p}`);
  }

  return async (req, res, url) => {
    const p = url.pathname;
    if (!p.startsWith('/v1/control/')) return false;
    const method = req.method ?? 'GET';
    try {
      const body = await readJson(req);
      if (p === '/v1/control/login-code' && method === 'POST') {
        // Workers carry the daemon token too, so the token alone proves nothing: a person at this Mac has to click yes.
        if (!sameToken(bearer(req), d.daemonToken)) throw new HttpError(401, 'unauthorized');
        const name = d.body.identity().name;
        if (!(await parentConfirms(`打开 ${name} 的控制台？\n\n控制台能改它的资源、钱包和授权书。如果不是你刚运行了 vf ui，点"不允许"。`))) {
          logEvent('control.login.denied', {});
          notify('🛑 有进程想打开我的控制台，没得到允许。');
          throw new HttpError(403, '这台 Mac 上没有人允许打开控制台');
        }
        sendJson(res, 200, { code: d.sessions.issueCode() });
        return true;
      }
      if (p === '/v1/control/hold' && method === 'POST') {
        // `vf ui` keeps this request open; the session lives exactly as long as it does.
        if (!sameToken(bearer(req), d.daemonToken)) throw new HttpError(401, 'unauthorized');
        const code = str(body.code, 'code', 200);
        const until = d.sessions.hold(code);
        if (until === undefined) throw new HttpError(410, '这个控制台会话已经结束了');
        logEvent('control.session.held', {});
        notify('🖥 这台 Mac 上打开了我的控制台。不是你的话，发 /freeze。');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.flushHeaders();
        const beat = setInterval(() => res.write('.'), 15_000);
        const end = setTimeout(() => res.end('expired\n'), Math.max(0, until - Date.now()));
        res.on('close', () => {
          clearInterval(beat);
          clearTimeout(end);
          d.sessions.revoke(code);
          logEvent('control.session.ended', {});
        });
        return true;
      }
      if (p === '/v1/control/session' && method === 'POST') {
        const token = d.sessions.exchange(str(body.code, 'code', 200));
        if (!token) throw new HttpError(401, '控制台的会话结束了：在这台 Mac 上运行 vf ui');
        const id = d.body.identity();
        logEvent('control.session', {});
        sendJson(res, 200, { token, agent: { name: id.name, slug: id.slug } });
        return true;
      }
      if (!d.sessions.check(bearer(req))) throw new HttpError(401, 'unauthorized');
      sendJson(res, 200, await route(method, p, url, body));
    } catch (err) {
      const status = errorStatus(err);
      if (status >= 500) logEvent('control.error', { path: p, error: String((err as Error).message).slice(0, 300) });
      sendJson(res, status, { error: (err as Error).message });
    }
    return true;
  };
}
