import type { AgentConfig, Body, Mandate } from '../core/body.ts';
import { log, logEvent, loggedFetch } from '../core/log.ts';
import type { SecretStore } from '../core/secrets.ts';
import { shortId, type InboxItem, type Store } from '../core/store.ts';
import { AgentMail, MailWatcher, addressOf, mailBody, type MailItem } from '../identity/agentmail.ts';
import { AgentPhone, callSystemPrompt, extractCode } from '../identity/agentphone.ts';
import { verify } from '../identity/selfmade.ts';
import { LinkWallet } from '../wallet/link.ts';
import { checkSpend, fmtCents, mandateIntact } from '../wallet/mandate.ts';
import path from 'node:path';

export interface InboxSink {
  onInboxItem(item: InboxItem): Promise<void>;
  notifyParent(text: string, opts?: { taskId?: string }): Promise<unknown>;
}

/** A verification code or link that reached the agent: what the parent needs on screen while signing it up somewhere. */
export interface RecentCode {
  at: string;
  channel: 'email' | 'sms';
  from: string;
  subject?: string;
  code?: string;
  link?: string;
}

export const TAMPERED_MANDATE = '授权书和签名对不上（可能被改过），先不花钱；请家长在控制台重新签一次';

/** The agent's identities, as live services: its inbox, its phone, its wallet. */
export class Services {
  private body: Body;
  private store: Store;
  private secrets: SecretStore;
  private config: AgentConfig;
  sink?: InboxSink;
  mail?: { client: AgentMail; inboxId: string; address: string };
  phone?: { client: AgentPhone; agentId: string; numberId: string; number: string };
  wallet: LinkWallet;
  private watcher?: MailWatcher;
  private timers = new Set<NodeJS.Timeout>();
  /** start() was called and stop() wasn't since: what reload() restores. */
  private wanted = false;
  private running = false;
  /** Bumped by every start/stop, so a poll loop from before a restart never schedules itself again. */
  private generation = 0;
  private inflight = new Set<Promise<void>>();
  private reloading: Promise<void> = Promise.resolve();

  constructor(body: Body, store: Store, secrets: SecretStore) {
    this.body = body;
    this.store = store;
    this.secrets = secrets;
    this.config = body.config();
    this.wallet = new LinkWallet({ bin: this.config.linkCli });
    this.init();
  }

  init(): void {
    this.mail = undefined;
    this.phone = undefined;
    const id = this.body.identity();
    const mailKey = this.secrets.get('agentmail_api_key');
    const email = id.identities.email;
    if (mailKey && email?.status === 'open' && email.value) {
      this.mail = { client: new AgentMail({ apiKey: mailKey, base: this.config.services.agentmail }), inboxId: String(email.details?.inboxId ?? email.value), address: email.value };
    }
    const phoneKey = this.secrets.get('agentphone_api_key');
    const phone = id.identities.phone;
    if (phoneKey && phone?.status === 'open' && phone.details?.numberId) {
      this.phone = {
        client: new AgentPhone({ apiKey: phoneKey, base: this.config.services.agentphone }),
        agentId: String(phone.details.agentId),
        numberId: String(phone.details.numberId),
        number: String(phone.value),
      };
    }
  }

  private frozen(): boolean {
    return this.store.get('frozen') === '1';
  }

  private assertNotFrozen(): void {
    if (this.frozen()) throw new Error('The parent froze outbound actions (/unfreeze to resume).');
  }

  start(): void {
    this.wanted = true;
    if (this.running) return;
    this.running = true;
    const gen = ++this.generation;
    const live = () => this.running && this.generation === gen;
    if (this.mail) {
      const mailKey = this.secrets.get('agentmail_api_key')!;
      const realtime = !/localhost|127\.0\.0\.1/.test(this.config.services.agentmail);
      this.watcher = new MailWatcher({
        mail: this.mail.client,
        apiKey: mailKey,
        inboxId: this.mail.inboxId,
        pollSeconds: this.config.mail.pollSeconds,
        realtimeUrl: realtime ? this.config.services.agentmail.replace(/^https:\/\/api\./, 'wss://ws.').replace(/\/v0$/, '/v0') : undefined,
        onMessage: (m) => this.onMail(m),
        loadCursor: () => this.store.get('mail_cursor'),
        saveCursor: (iso) => this.store.set('mail_cursor', iso),
      });
      this.watcher.start();
    }
    if (this.phone) {
      const pollMs = this.config.mail.pollSeconds * 1000;
      const loop = (fn: () => Promise<void>, every: number) => {
        const tick = async () => {
          if (!live()) return;
          const p = fn().catch((e) => log('phone poll error', String(e.message ?? e)));
          this.inflight.add(p);
          await p;
          this.inflight.delete(p);
          if (!live()) return;
          const t = setTimeout(() => {
            this.timers.delete(t);
            void tick();
          }, every);
          this.timers.add(t);
        };
        void tick();
      };
      loop(() => this.pollSms(), pollMs);
      loop(() => this.pollInboundCalls(), Math.max(pollMs, 30_000));
    }
  }

  async stop(): Promise<void> {
    this.wanted = false;
    await this.halt();
  }

  private async halt(): Promise<void> {
    this.running = false;
    this.generation++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const watcher = this.watcher;
    this.watcher = undefined;
    await watcher?.stop();
    await Promise.all([...this.inflight]);
  }

  /**
   * Re-read identity, keys and config (the parent just gave it an email, a number or a wallet in
   * the console) and restart the watchers. Restarts only what was running: after stop(), it just
   * refreshes. Calls queue up, so two quick saves in the console don't race.
   */
  reload(): Promise<void> {
    const run = this.reloading.then(async () => {
      await this.halt();
      this.config = this.body.config();
      this.wallet = new LinkWallet({ bin: this.config.linkCli });
      this.init();
      // A stop() that lands while this reload waits for the old watchers still wins.
      if (this.wanted) this.start();
      logEvent('services.reloaded', { mail: Boolean(this.mail), phone: Boolean(this.phone), running: this.running });
    });
    this.reloading = run.catch(() => {});
    return run;
  }

  private signature(): string {
    const id = this.body.identity();
    return `\n\n—\n${id.name}\n${id.name} is an independent AI agent working for ${id.parent.name}. 我是一个 AI agent，不是真人。`;
  }

  // ---------- mail ----------

  async sendMail(input: { to: string; subject: string; text: string; taskId?: string }): Promise<Record<string, unknown>> {
    this.assertNotFrozen();
    if (!this.mail) throw new Error('I have no email yet (parent: run `vf init --step email`).');
    this.mail.client.taskId = input.taskId;
    const res = await this.mail.client.send(this.mail.inboxId, { to: input.to, subject: input.subject, text: input.text + this.signature() }, shortId('send_'));
    this.store.linkThread(res.thread_id, 'email', input.taskId ?? null);
    if (input.taskId) this.store.addEvent(input.taskId, 'email.sent', { to: input.to, subject: input.subject, threadId: res.thread_id });
    logEvent('mail.sent', { to: input.to, subject: input.subject, taskId: input.taskId, threadId: res.thread_id });
    return { ...res, from: this.mail.address };
  }

  async replyMail(input: { messageId: string; text: string; taskId?: string }): Promise<Record<string, unknown>> {
    this.assertNotFrozen();
    if (!this.mail) throw new Error('no email');
    const res = await this.mail.client.reply(this.mail.inboxId, input.messageId, { text: input.text + this.signature() }, shortId('reply_'));
    if (input.taskId && this.store.threadTask(res.thread_id) === undefined) this.store.linkThread(res.thread_id, 'email', input.taskId);
    return { ...res };
  }

  async listMail(limit = 10): Promise<unknown> {
    if (!this.mail) throw new Error('no email');
    const r = await this.mail.client.listMessages(this.mail.inboxId, { limit });
    return r.messages.map((m) => ({ id: m.message_id, from: m.from, to: m.to, subject: m.subject, preview: m.preview, labels: m.labels, at: m.timestamp }));
  }

  async readMail(id: string): Promise<unknown> {
    if (!this.mail) throw new Error('no email');
    const m = await this.mail.client.getMessage(this.mail.inboxId, id);
    return { id: m.message_id, thread: m.thread_id, from: m.from, to: m.to, subject: m.subject, text: mailBody(m), at: m.timestamp };
  }

  async onMail(m: MailItem): Promise<void> {
    if (!m.labels?.includes('received') || addressOf(m.from) === this.mail?.address.toLowerCase()) return;
    const parentEmail = this.body.identity().parent.email?.toLowerCase();
    const text = mailBody(m);
    const threadTask = this.store.threadTask(m.thread_id);
    const code = extractCode(`${m.subject ?? ''} ${text}`);
    const classification: InboxItem['classification'] = threadTask ? 'task-related' : parentEmail && addressOf(m.from) === parentEmail ? 'parent' : code ? 'code' : 'stranger';
    // The html part keeps links the plain text may have lost ("Verify email" buttons).
    const link = verificationLink(text) ?? (m.html ? verificationLink(htmlText(m.html)) : undefined);
    const data = { ...(classification === 'code' ? { code } : {}), ...(link ? { link } : {}) };
    const item = this.store.addInbox({
      source: 'email',
      external_id: m.message_id,
      thread_id: m.thread_id,
      sender: m.from,
      recipient: (m.to ?? []).join(', '),
      subject: m.subject ?? null,
      body: text,
      received_at: m.timestamp,
      task_id: threadTask ?? null,
      classification,
      data: Object.keys(data).length ? JSON.stringify(data) : null,
    });
    if (item) await this.sink?.onInboxItem(item);
  }

  // ---------- sms ----------

  async sendSms(input: { to: string; text: string; taskId?: string }): Promise<Record<string, unknown>> {
    this.assertNotFrozen();
    if (!this.phone) throw new Error('I have no phone number yet (parent: run `vf init --step phone`).');
    this.phone.client.taskId = input.taskId;
    const res = await this.phone.client.sendSms({ agentId: this.phone.agentId, numberId: this.phone.numberId, to: input.to, body: input.text });
    if (input.taskId) {
      this.store.set(`sms_contact:${normalizeNumber(input.to)}`, input.taskId);
      this.store.addEvent(input.taskId, 'sms.sent', { to: input.to });
    }
    logEvent('sms.sent', { to: input.to, taskId: input.taskId });
    return { ...res, from: this.phone.number };
  }

  async listSms(): Promise<unknown> {
    if (!this.phone) throw new Error('no phone');
    const r = await this.phone.client.listNumberMessages(this.phone.numberId, { limit: 20 });
    return r.data.map((s) => ({ id: s.id, from: s.from_, to: s.to, body: s.body, direction: s.direction, at: s.receivedAt }));
  }

  async pollSms(): Promise<void> {
    if (!this.phone) return;
    const after = this.store.get('sms_cursor');
    const r = await this.phone.client.listNumberMessages(this.phone.numberId, { limit: 50, after });
    const inbound = r.data.filter((s) => s.direction === 'inbound').sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const parentPhone = normalizeNumber(this.body.identity().parent.phone ?? '');
    for (const s of inbound) {
      const from = normalizeNumber(s.from_);
      const taskId = this.store.get(`sms_contact:${from}`);
      const otp = extractCode(s.body);
      const classification: InboxItem['classification'] = parentPhone && from === parentPhone ? 'parent' : taskId ? 'task-related' : otp ? 'code' : 'stranger';
      const item = this.store.addInbox({
        source: 'sms',
        external_id: s.id,
        thread_id: null,
        sender: s.from_,
        recipient: s.to,
        subject: null,
        body: s.body,
        received_at: s.receivedAt,
        task_id: classification === 'task-related' ? taskId! : null,
        classification,
        data: otp ? JSON.stringify({ code: otp }) : null,
      });
      this.store.set('sms_cursor', s.receivedAt);
      if (item) await this.sink?.onInboxItem(item);
    }
  }

  codes(): unknown {
    const rows = this.store.db.prepare(`SELECT source, sender, body, received_at, data FROM inbox WHERE data LIKE '%"code"%' ORDER BY received_at DESC LIMIT 10`).all() as { source: string; sender: string; body: string; received_at: string; data: string }[];
    return rows.map((r) => ({ code: JSON.parse(r.data).code, from: r.sender, via: r.source, at: r.received_at, text: r.body.slice(0, 160) }));
  }

  /**
   * Codes and verification links that reached its email and number since `sinceIso` (an
   * unreadable value means the last 15 minutes), newest first. The console shows them live while
   * the parent signs it up somewhere. Messages from the parent are not codes.
   */
  async recentCodes(sinceIso: string): Promise<RecentCode[]> {
    const parsed = Date.parse(sinceIso);
    const since = Number.isFinite(parsed) ? parsed : Date.now() - 15 * 60_000;
    const rows = this.store.db
      .prepare(`SELECT * FROM inbox WHERE source IN ('email','sms') AND classification != 'parent' ORDER BY received_at DESC LIMIT 200`)
      .all() as unknown as InboxItem[];
    const out: (RecentCode & { ms: number })[] = [];
    for (const r of rows) {
      const ms = Date.parse(r.received_at);
      if (!(ms >= since)) continue;
      let data: { code?: string; link?: string } = {};
      try {
        data = r.data ? (JSON.parse(r.data) as typeof data) : {};
      } catch {}
      const code = data.code ?? (r.classification === 'code' ? extractCode(`${r.subject ?? ''} ${r.body}`) : undefined);
      const link = r.source === 'email' ? (data.link ?? verificationLink(r.body)) : undefined;
      if (!code && !link) continue;
      out.push({ ms, at: r.received_at, channel: r.source as RecentCode['channel'], from: r.sender, ...(r.subject ? { subject: r.subject } : {}), ...(code ? { code } : {}), ...(link ? { link } : {}) });
    }
    return out
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 20)
      .map(({ ms: _ms, ...c }) => c);
  }

  // ---------- calls ----------

  async placeCall(input: { to: string; purpose: string; taskId?: string }, note: (s: string) => void): Promise<Record<string, unknown>> {
    this.assertNotFrozen();
    if (!this.phone) throw new Error('I have no phone number yet.');
    const id = this.body.identity();
    this.phone.client.taskId = input.taskId;
    const call = await this.phone.client.createCall({
      agentId: this.phone.agentId,
      toNumber: input.to,
      fromNumberId: this.phone.numberId,
      initialGreeting: `Hi, this is ${id.name}, an AI agent calling on behalf of ${id.parent.name}.`,
      systemPrompt: callSystemPrompt({ agentName: id.name, parentName: id.parent.name, purpose: input.purpose, soul: this.body.soul() }),
    });
    this.store.addCall({ id: call.id, task_id: input.taskId ?? null, to_number: input.to, purpose: input.purpose, status: call.status ?? 'initiated' });
    if (input.taskId) this.store.addEvent(input.taskId, 'call.started', { callId: call.id, to: input.to });
    logEvent('call.started', { callId: call.id, to: input.to, taskId: input.taskId });
    note(`calling ${input.to} (${call.id})…`);
    const { call: done, transcript } = await this.phone.client.waitForCall(call.id, Number(process.env.VF_CALL_TIMEOUT_SEC ?? 900), Number(process.env.VF_CALL_POLL_SEC ?? 4));
    const text = transcript.map((t) => `${t.role === 'agent' ? id.name : 'Them'}: ${t.content}`).join('\n');
    this.store.updateCall(call.id, { status: done.status, transcript: text, summary: done.summary ?? null, ended_at: new Date().toISOString() });
    if (input.taskId) this.store.addEvent(input.taskId, 'call.ended', { callId: call.id, status: done.status });
    logEvent('call.ended', { callId: call.id, status: done.status, turns: transcript.length });
    return { callId: call.id, status: done.status, durationSeconds: done.durationSeconds, summary: done.summary, transcript: text };
  }

  async pollInboundCalls(): Promise<void> {
    if (!this.phone) return;
    const r = await this.phone.client.listCalls({ direction: 'inbound', limit: 10 });
    for (const c of r.data.filter((x) => ['completed', 'ended'].includes(x.status))) {
      if (this.store.db.prepare(`SELECT 1 FROM inbox WHERE source='call' AND external_id=?`).get(c.id)) continue;
      const t = await this.phone.client.getTranscript(c.id).catch(() => ({ transcript: [] }));
      const text = t.transcript.map((x) => `${x.role}: ${x.content}`).join('\n');
      const parentPhone = normalizeNumber(this.body.identity().parent.phone ?? '');
      const item = this.store.addInbox({
        source: 'call',
        external_id: c.id,
        thread_id: null,
        sender: c.fromNumber ?? 'unknown',
        recipient: c.toNumber ?? null,
        subject: '来电',
        body: text || c.summary || '(no transcript)',
        received_at: c.endedAt ?? new Date().toISOString(),
        task_id: null,
        classification: parentPhone && normalizeNumber(c.fromNumber ?? '') === parentPhone ? 'parent' : 'stranger',
        data: null,
      });
      if (item) await this.sink?.onInboxItem(item);
    }
  }

  // ---------- money ----------

  async pay(
    input: { merchantName: string; merchantUrl: string; amountCents: number; context: string; test?: boolean; taskId?: string; waitSeconds?: number },
    note: (s: string) => void,
  ): Promise<Record<string, unknown>> {
    const mandate = this.body.mandate();
    // The signed mandate is the only thing that lets it spend: one edited on disk (by a worker, a
    // stray script) is no mandate at all, and the parent hears about it.
    if (mandate && !mandateSigned(this.body, mandate)) {
      logEvent('pay.check', { ...input, ok: false, reason: TAMPERED_MANDATE, tampered: true });
      await this.sink
        ?.notifyParent(`⚠️ 我的零花钱授权书和我的签名对不上（可能被改过），所以没在 <b>${escapeHtml(input.merchantName)}</b> 花钱。请在控制台重新签一次授权书。`, { taskId: input.taskId })
        .catch(() => {});
      return { status: 'refused', reason: TAMPERED_MANDATE };
    }
    const spent = this.store.spentThisMonthCents();
    const check = checkSpend(mandate, input, input.test ? 0 : spent, this.frozen());
    logEvent('pay.check', { ...input, ok: check.ok, reason: check.reason, spentThisMonthCents: spent });
    if (!check.ok) return { status: 'refused', reason: check.reason };
    const id = this.body.identity();
    let context = `${input.context.trim()} — Requested by ${id.name}, an independent AI agent, for its parent ${id.parent.name}${input.taskId ? ` (task ${input.taskId})` : ''}. Within the monthly allowance the parent set at onboarding.`;
    if (context.length < 100) context = context.padEnd(100, '.');
    this.wallet = new LinkWallet({ bin: this.config.linkCli, taskId: input.taskId });
    const sr = await this.wallet.create({ amountCents: input.amountCents, merchantName: input.merchantName, merchantUrl: input.merchantUrl, context, test: input.test, idempotencyKey: shortId('pay_') });
    this.store.addSpend({ id: sr.id, task_id: input.taskId ?? null, merchant_name: input.merchantName, merchant_url: input.merchantUrl, amount_cents: input.amountCents, currency: mandate!.currency, status: sr.status, approval_url: sr.approval_url ?? null, test: input.test ? 1 : 0, context, last4: null });
    const approval = await this.wallet.requestApproval(sr.id);
    const approvalUrl = approval.approval_url ?? sr.approval_url;
    this.store.updateSpend(sr.id, { status: approval.status ?? 'pending_approval', approval_url: approvalUrl ?? null });
    await this.sink?.notifyParent(
      `💳 ${id.name} 想在 <b>${escapeHtml(input.merchantName)}</b> 花 <b>${fmtCents(input.amountCents, mandate!.currency)}</b>${input.test ? '（测试模式，不扣钱）' : ''}\n用途：${escapeHtml(input.context)}\n本月授权内还剩 ${fmtCents(check.remainingCents + input.amountCents, mandate!.currency)}。\nLink 会推送给你；也可以点这里批准：${approvalUrl ?? '(Link app)'}`,
      { taskId: input.taskId },
    );
    note(`waiting for Link approval: ${approvalUrl ?? sr.id}`);
    const decided = await this.wallet.waitForDecision(sr.id, input.waitSeconds ?? 1800);
    this.store.updateSpend(sr.id, { status: decided.status });
    logEvent('pay.decision', { id: sr.id, status: decided.status });
    if (decided.status !== 'approved') {
      await this.sink?.notifyParent(`💳 ${escapeHtml(input.merchantName)} 那笔 ${fmtCents(input.amountCents, mandate!.currency)} 没有批准（${decided.status}），我不买了。`, { taskId: input.taskId });
      return { status: decided.status, spendRequestId: sr.id };
    }
    const cardFile = path.join(this.body.paths.wallet, 'cards', `${sr.id}.json`);
    const withCard = await this.wallet.retrieveCard(sr.id, cardFile);
    const last4 = withCard.card?.last4 ?? null;
    this.store.updateSpend(sr.id, { status: 'approved', last4 });
    await this.sink?.notifyParent(`✅ 批准了：${escapeHtml(input.merchantName)} ${fmtCents(input.amountCents, mandate!.currency)}，一次性卡尾号 ${last4 ?? '????'}。`, { taskId: input.taskId });
    return {
      status: 'approved',
      spendRequestId: sr.id,
      cardFile,
      brand: withCard.card?.brand,
      last4,
      note: 'One-time card. Card details are in cardFile (JSON with number, cvc, exp_month, exp_year, billing_address). Use them only at this merchant for this purchase.',
    };
  }

  // ---------- brain budget ----------

  async brainBudget(): Promise<{ limitUsd: number | null; remainingUsd: number | null; usageUsd: number } | undefined> {
    const key = this.secrets.get('openrouter_api_key');
    if (!key) return undefined;
    const base = this.config.services.openrouter.replace(/\/$/, '');
    for (const p of ['/key', '/auth/key']) {
      const res = await loggedFetch('openrouter', `${base}${p}`, { headers: { authorization: `Bearer ${key}` } });
      if (res.status === 404) continue;
      if (!res.ok) return undefined;
      const j = (await res.json()) as { data?: { usage?: number; limit?: number | null; limit_remaining?: number | null } };
      return { limitUsd: j.data?.limit ?? null, remainingUsd: j.data?.limit_remaining ?? null, usageUsd: j.data?.usage ?? 0 };
    }
    return undefined;
  }
}

export function normalizeNumber(n: string): string {
  const digits = n.replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return '+1' + digits;
  return '+' + digits;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The mandate's hash matches its body, and the hash carries the agent's own signature. */
function mandateSigned(body: Body, m: Mandate): boolean {
  if (!m.hash || !m.agentSignature || !mandateIntact(m)) return false;
  try {
    return verify(body, m.hash, m.agentSignature);
  } catch {
    return false;
  }
}

const VERIFY_WORDS = /verif|confirm|activat|validat|magic.?link|验证|确认|激活/i;

/**
 * The first https link in a message that verifies, confirms or activates something. A link that
 * says so itself wins; otherwise one right after such words ("Verify your email: https://…").
 * Never the unsubscribe link, never a bare homepage.
 */
export function verificationLink(text: string): string | undefined {
  const found: { url: string; before: string }[] = [];
  let prev = 0;
  for (const m of text.matchAll(/https:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    found.push({ url, before: text.slice(Math.max(prev, m.index - 160), m.index) });
    prev = m.index + m[0].length;
  }
  const usable = found.filter((f) => !/unsubscribe|opt.?out|preferences/i.test(f.url));
  const named = usable.find((f) => VERIFY_WORDS.test(f.url));
  if (named) return named.url;
  const near = usable.find((f) => {
    if (!VERIFY_WORDS.test(f.before)) return false;
    try {
      const u = new URL(f.url);
      return u.pathname.length > 1 || u.search.length > 1;
    } catch {
      return false;
    }
  });
  return near?.url;
}

/** Mail html as text, each link's address written right after its label. */
function htmlText(html: string): string {
  return html
    .replace(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href: string, label: string) => ` ${label.replace(/<[^>]+>/g, ' ')} ${href} `)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&');
}
