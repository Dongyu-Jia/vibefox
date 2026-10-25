import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { log, logEvent } from '../core/log.ts';

/**
 * The agent's own browser: one persistent Chromium profile (its cookies, its
 * logins) shared by every worker through the daemon API. `vf browser …`, the
 * builtin harness tools and the MCP tools all land here, so Claude Code,
 * OpenCode and the builtin loop drive exactly the same browser.
 *
 * The parent can borrow it (beginParentSession): the same profile in a visible
 * window, to sign the agent up on human-only platforms or log it in. Workers
 * wait meanwhile, and whatever the parent logged into stays logged in after.
 */

interface SnapItem {
  ref: string;
  tag: string;
  type: string | null;
  role: string | null;
  label: string;
  name: string | null;
  value?: string;
  href: string | null;
  checked?: boolean;
  options?: string[];
}

interface RawSnapshot {
  title: string;
  url: string;
  items: SnapItem[];
  text: string;
}

const SNAPSHOT_FN = () => {
  const selector =
    'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [contenteditable=true], summary';
  const w = window as unknown as { __vfRef?: number };
  let n = w.__vfRef ?? 0;
  const items: SnapItem[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if ((rect.width === 0 && rect.height === 0) || style.visibility === 'hidden' || style.display === 'none') continue;
    let ref = el.getAttribute('data-vf-ref');
    if (!ref) {
      ref = 'e' + ++n;
      el.setAttribute('data-vf-ref', ref);
    }
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const type = el.getAttribute('type');
    const labelEl = input.id ? document.querySelector(`label[for="${input.id}"]`) : null;
    const label = (
      el.getAttribute('aria-label') ||
      (labelEl as HTMLElement | null)?.innerText ||
      // <label><input type=radio> Medium</label>: the wrapping label is the name
      (tag === 'input' ? (el.closest('label') as HTMLElement | null)?.innerText : '') ||
      (tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : el.innerText) ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('name') ||
      ''
    )
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    items.push({
      ref,
      tag,
      type,
      role: el.getAttribute('role'),
      label,
      name: el.getAttribute('name'),
      value: isField ? (type === 'password' ? (input.value ? '••••' : '') : input.value) : undefined,
      href: el.getAttribute('href'),
      checked: type === 'checkbox' || type === 'radio' ? input.checked : undefined,
      options: tag === 'select' ? Array.from((el as HTMLSelectElement).options).slice(0, 30).map((o) => o.label.trim()) : undefined,
    });
  }
  w.__vfRef = n;
  const text = document.body ? document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 8000) : '';
  return { title: document.title, url: location.href, items, text };
};

export function formatSnapshot(s: RawSnapshot): string {
  const lines = [`Page: ${s.title}`, `URL: ${s.url}`, '', 'Interactive elements (use the [ref] with click/type/select):'];
  for (const it of s.items.slice(0, 150)) {
    const kind = it.tag === 'a' ? 'link' : it.tag === 'input' ? `input[${it.type ?? 'text'}]` : it.role ?? it.tag;
    const parts = [`[${it.ref}]`, kind];
    if (it.label) parts.push(JSON.stringify(it.label));
    if (it.name && it.name !== it.label) parts.push(`name=${it.name}`);
    if (it.value !== undefined) parts.push(`value=${JSON.stringify(it.value)}`);
    if (it.checked !== undefined) parts.push(it.checked ? 'checked' : 'unchecked');
    if (it.options?.length) parts.push(`options=${JSON.stringify(it.options)}`);
    if (it.href && it.tag === 'a') parts.push(`-> ${it.href}`);
    lines.push(parts.join(' '));
  }
  if (s.items.length > 150) lines.push(`… ${s.items.length - 150} more`);
  lines.push('', 'Visible text:', s.text);
  return lines.join('\n');
}

export interface BrowserOptions {
  profileDir: string;
  recordingsDir: string;
  headless: boolean;
  record: boolean;
  slowMoMs?: number;
}

type SessionCookie = Awaited<ReturnType<BrowserContext['storageState']>>['cookies'][number];

/** What workers get while the parent is using the agent's browser (signing it up, logging it in). */
export class BrowserBusyError extends Error {
  status = 423;
  constructor() {
    super("家长正在用它的浏览器（在帮它注册或登录），稍后再试。The parent is using the agent's browser right now; try again in a few minutes.");
    this.name = 'BrowserBusyError';
  }
}

function isLoopback(hostname: string): boolean {
  return /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\])$/i.test(hostname);
}

function effectivePort(u: URL): string {
  return u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80');
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return '(invalid url)';
  }
}

export class BrowserService {
  private opts: BrowserOptions;
  private ctx?: BrowserContext;
  private page?: Page;
  private videos: string[] = [];
  /** One launch or close at a time: a persistent profile can only be open once. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Set while the parent is using the browser; every worker call gets BrowserBusyError meanwhile. */
  private parent?: { url: string; ready: Promise<void> };
  private workerOps = 0;
  /**
   * Session cookies (no expiry) die with the browser process. They are kept here and in
   * `session-cookies.json` next to the profile, and re-added on the next launch, so a login
   * made in one session (the parent's, a worker's) survives the relaunch and daemon restarts.
   */
  private carry?: SessionCookie[];
  private cookieFile: string;
  private guarded = new Set<string>();
  private guardedPorts = new Set<string>();
  private routed = new WeakSet<BrowserContext>();

  constructor(opts: BrowserOptions) {
    this.opts = opts;
    this.cookieFile = path.join(path.dirname(opts.profileDir), 'session-cookies.json');
  }

  setRecording(record: boolean): void {
    this.opts.record = record;
  }

  isOpen(): boolean {
    return Boolean(this.ctx);
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Launch the context. Only under the lock, and only when none is open. */
  private async launch(): Promise<Page> {
    fs.mkdirSync(this.opts.profileDir, { recursive: true });
    fs.mkdirSync(this.opts.recordingsDir, { recursive: true });
    const parent = Boolean(this.parent);
    // The parent gets a real window; it is never recorded (the parent types passwords there).
    const headless = parent ? process.env.VF_PARENT_BROWSER_HEADLESS === '1' : this.opts.headless;
    const record = !parent && this.opts.record;
    const ctx = await chromium.launchPersistentContext(this.opts.profileDir, {
      headless,
      viewport: parent ? null : { width: 1280, height: 800 },
      slowMo: parent ? undefined : this.opts.slowMoMs,
      recordVideo: record ? { dir: this.opts.recordingsDir, size: { width: 1280, height: 800 } } : undefined,
    });
    this.ctx = ctx;
    ctx.on('close', () => {
      if (this.ctx !== ctx) return; // closed by shut(), which already moved on
      this.ctx = undefined;
      this.page = undefined;
      if (parent && this.parent) {
        // The parent quit the browser outright: the session is over, the next worker call relaunches headless.
        this.parent = undefined;
        logEvent('browser.parent.end', { how: 'browser quit' });
      }
    });
    const cookies = this.carry ?? this.readCookieFile();
    if (cookies.length) await ctx.addCookies(cookies).catch((e) => log('browser: could not restore session cookies', String((e as Error).message ?? e)));
    this.carry = undefined;
    if (this.guarded.size) await this.installGuard(ctx);
    if (parent) this.watchParent(ctx);
    this.page = ctx.pages()[0] ?? (await ctx.newPage());
    logEvent('browser.started', { record, headless, parent });
    return this.page;
  }

  /** Close the context (under the lock), keeping its session cookies. Returns finished recordings. */
  private async shut(): Promise<string[]> {
    const ctx = this.ctx;
    const page = this.page;
    if (!ctx) return [];
    const state = await ctx.storageState().catch(() => undefined);
    if (state) this.keepCookies(state.cookies);
    this.ctx = undefined;
    this.page = undefined;
    const video = page?.video();
    await ctx.close().catch(() => {});
    if (video) {
      const p = await video.path().catch(() => '');
      if (p) {
        this.videos.push(p);
        logEvent('browser.recording', { path: p });
        return [p];
      }
    }
    return [];
  }

  private keepCookies(all: SessionCookie[]): void {
    this.carry = all.filter((c) => c.expires === -1);
    try {
      fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
      fs.writeFileSync(this.cookieFile, JSON.stringify(this.carry), { mode: 0o600 });
    } catch (e) {
      log('browser: could not save session cookies', String((e as Error).message ?? e));
    }
  }

  private readCookieFile(): SessionCookie[] {
    try {
      return JSON.parse(fs.readFileSync(this.cookieFile, 'utf8')) as SessionCookie[];
    } catch {
      return [];
    }
  }

  private async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    return this.locked(async () => {
      if (this.parent) throw new BrowserBusyError();
      if (this.page && !this.page.isClosed()) return this.page;
      if (this.ctx) {
        this.page = this.ctx.pages().find((p) => !p.isClosed()) ?? (await this.ctx.newPage());
        return this.page;
      }
      return this.launch();
    });
  }

  /** Every worker-facing call runs through here: refused while the parent has the browser. */
  private async work<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    if (this.parent) throw new BrowserBusyError();
    this.workerOps++;
    try {
      return await fn(await this.ensure());
    } finally {
      this.workerOps--;
    }
  }

  private async snap(page: Page): Promise<string> {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const raw = (await page.evaluate(SNAPSHOT_FN)) as RawSnapshot;
    return formatSnapshot(raw);
  }

  async snapshot(): Promise<string> {
    return this.work((page) => this.snap(page));
  }

  async open(url: string): Promise<string> {
    if (this.parent) throw new BrowserBusyError();
    if (this.isGuarded(url)) throw new Error(`${originOf(url)} 是 agent 自己的控制台（daemon），它的浏览器不许打开。The agent's browser refuses to open its own daemon/console.`);
    return this.work(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      logEvent('browser.open', { url });
      return this.snap(page);
    });
  }

  private async locate(page: Page, ref: string) {
    const loc = page.locator(`[data-vf-ref="${ref}"]`).first();
    if ((await loc.count()) === 0) throw new Error(`No element [${ref}] on the page. Take a new snapshot first.`);
    // Make actions visible in recordings.
    await loc.evaluate((el: HTMLElement) => {
      el.scrollIntoView({ block: 'center' });
      const prev = el.style.outline;
      el.style.outline = '3px solid #ff3b30';
      setTimeout(() => (el.style.outline = prev), 700);
    }).catch(() => {});
    if (this.opts.record) await page.waitForTimeout(350);
    return loc;
  }

  async click(ref: string): Promise<string> {
    return this.work(async (page) => {
      const loc = await this.locate(page, ref);
      await loc.click({ timeout: 15_000 });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(300);
      logEvent('browser.click', { ref, url: page.url() });
      return this.snap(page);
    });
  }

  async type(ref: string, text: string, submit = false): Promise<string> {
    return this.work(async (page) => {
      const loc = await this.locate(page, ref);
      await loc.fill('');
      await loc.pressSequentially(text, { delay: this.opts.record ? 35 : 0 });
      if (submit) {
        // Search boxes often re-render while you type (Wikipedia does): press Enter on whatever has focus now.
        await page.keyboard.press('Enter');
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(300);
      }
      logEvent('browser.type', { ref, length: text.length, submit });
      return this.snap(page);
    });
  }

  async select(ref: string, value: string): Promise<string> {
    return this.work(async (page) => {
      const loc = await this.locate(page, ref);
      // Exact value or label first; then the closest label ("croissant" picks "Butter croissant — $4.25").
      const options = (await loc.evaluate((el: HTMLSelectElement) => Array.from(el.options).map((o) => ({ value: o.value, label: o.label.trim() })))) as { value: string; label: string }[];
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const v = norm(value);
      const exact = options.findIndex((o) => o.value === value || o.label === value);
      const loose = options.findIndex((o) => norm(o.label) === v || norm(o.value) === v);
      const near = options.findIndex((o) => (v.length >= 3 && norm(o.label).includes(v)) || (norm(o.label).length >= 3 && v.includes(norm(o.label))));
      const pick = [exact, loose, near].find((i) => i >= 0) ?? -1;
      if (pick < 0) throw new Error(`No option like "${value}". Options: ${options.map((o) => JSON.stringify(o.label)).join(', ')}`);
      await loc.selectOption({ index: pick });
      logEvent('browser.select', { ref, value, url: page.url() });
      return this.snap(page);
    });
  }

  async press(key: string): Promise<string> {
    return this.work(async (page) => {
      await page.keyboard.press(key);
      await page.waitForTimeout(300);
      logEvent('browser.press', { pressed: key, url: page.url() });
      return this.snap(page);
    });
  }

  /** Wait until `text` shows on the page (or just `seconds`), then snapshot: for pages that render late. */
  async wait(text: string | undefined, seconds = 15): Promise<string> {
    return this.work(async (page) => {
      const ms = Math.min(Math.max(seconds, 1), 60) * 1000;
      let found = false;
      if (text) {
        found = await page
          .waitForFunction((t) => document.body?.innerText.includes(t), text, { timeout: ms, polling: 250 })
          .then(() => true)
          .catch(() => false);
      } else await page.waitForTimeout(ms);
      logEvent('browser.wait', { text, seconds, found, url: page.url() });
      const snap = await this.snap(page);
      return text && !found ? `(waited ${ms / 1000}s; "${text}" did not appear)\n${snap}` : snap;
    });
  }

  async back(): Promise<string> {
    return this.work(async (page) => {
      await page.goBack().catch(() => {});
      logEvent('browser.back', { url: page.url() });
      return this.snap(page);
    });
  }

  async screenshot(file: string): Promise<string> {
    return this.work(async (page) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file, fullPage: false });
      logEvent('browser.screenshot', { file, url: page.url() });
      return file;
    });
  }

  async url(): Promise<string> {
    // Never hand workers the parent's page address (OAuth callbacks carry codes).
    return this.parent ? '' : this.page?.url() ?? '';
  }

  /** Close the context; returns any finished screen recordings. Session cookies are kept for the next launch. */
  async close(): Promise<string[]> {
    if (this.parent) throw new BrowserBusyError();
    return this.locked(() => this.shut());
  }

  /** For the daemon's own shutdown: like close(), but ends a parent session first instead of refusing. */
  async shutdown(): Promise<string[]> {
    await this.endParentSession().catch((e) => log('browser: ending the parent session failed', String((e as Error).message ?? e)));
    return this.locked(() => this.shut());
  }

  recordings(): string[] {
    return [...this.videos];
  }

  // ---------- the parent's turn ----------

  /**
   * Hand the agent's browser to the parent: a visible window on the same profile (its logins,
   * its cookies), recording off, at `url`. Workers get BrowserBusyError until endParentSession()
   * or until the parent closes the window. Called again during a session, it opens `url` in a
   * new tab of the same window (the next link of a signup flow), so the parent never waits for a relaunch.
   */
  async beginParentSession(url: string): Promise<void> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error(`不是网址：${url.slice(0, 80)}`);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('只能在它的浏览器里打开 http(s) 网址。');
    if (this.isGuarded(target)) throw new Error(`${target.origin} 是 agent 自己的控制台（daemon），它的浏览器不许打开。`);
    if (this.parent) {
      await this.parent.ready;
      await this.locked(() => this.openParentTab(target.href));
      logEvent('browser.parent.open', { origin: target.origin });
      return;
    }
    let done!: () => void;
    let failed!: (e: unknown) => void;
    const ready = new Promise<void>((res, rej) => {
      done = res;
      failed = rej;
    });
    ready.catch(() => {});
    this.parent = { url: target.href, ready };
    try {
      await this.drainWorkers(5_000);
      await this.locked(async () => {
        await this.shut();
        try {
          const page = await this.launch();
          await this.show(page, target.href);
        } catch (e) {
          this.parent = undefined;
          await this.shut();
          throw e;
        }
      });
      done();
    } catch (e) {
      this.parent = undefined;
      failed(e);
      throw e;
    }
    // Only the origin: the address may carry a signup token, and the callbacks that follow carry OAuth codes.
    logEvent('browser.parent.start', { origin: target.origin });
  }

  /** The parent is done: keep the cookies, close the window; the next worker call relaunches headless. */
  async endParentSession(): Promise<void> {
    const session = this.parent;
    if (!session) return;
    await session.ready.catch(() => {});
    await this.locked(async () => {
      if (this.parent !== session) return;
      await this.shut();
      this.parent = undefined;
    });
    logEvent('browser.parent.end', { how: 'finished' });
  }

  parentSession(): { active: boolean; url?: string } {
    return this.parent ? { active: true, url: this.parent.url } : { active: false };
  }

  private async drainWorkers(maxMs: number): Promise<void> {
    const end = Date.now() + maxMs;
    while (this.workerOps > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  }

  private async show(page: Page, url: string): Promise<void> {
    // A page that fails to load still leaves the window open: the parent sees the error and can retry.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => log('browser: parent page did not load', originOf(url), String((e as Error).message ?? e).split('\n')[0].replace(/\b(https?|wss?):\/\/\S+/g, '<url>')));
    await page.bringToFront().catch(() => {});
  }

  private async openParentTab(url: string): Promise<void> {
    if (!this.parent || !this.ctx) throw new Error('家长会话已经结束了。');
    const page = await this.ctx.newPage();
    await this.show(page, url);
    this.parent.url = url;
  }

  private watchParent(ctx: BrowserContext): void {
    // Keep fresh cookies as the parent goes, in case the browser is quit rather than finished.
    const save = () => {
      void ctx
        .storageState()
        .then((s) => {
          if (this.ctx === ctx && this.parent) this.keepCookies(s.cookies);
        })
        .catch(() => {});
    };
    const watch = (p: Page) => {
      p.on('load', save);
      p.on('close', () => {
        if (this.ctx !== ctx || !this.parent || ctx.pages().length > 0) return;
        logEvent('browser.parent.closed', {});
        void this.endParentSession().catch((e) => log('browser: ending the parent session failed', String((e as Error).message ?? e)));
      });
    };
    ctx.pages().forEach(watch);
    ctx.on('page', watch);
  }

  // ---------- origins the browser never loads ----------

  /** The agent's browser refuses these origins (the daemon's own console), so a web page can't drive a worker into it. */
  guardOrigin(origins: string[]): void {
    for (const o of origins) {
      let u: URL;
      try {
        u = new URL(o);
      } catch {
        continue;
      }
      this.guarded.add(u.origin);
      // 127.0.0.1, localhost, [::1], 0.0.0.0… all reach the same listener.
      if (isLoopback(u.hostname)) this.guardedPorts.add(effectivePort(u));
    }
    if (this.ctx && this.guarded.size) void this.installGuard(this.ctx).catch((e) => log('browser: could not install the origin guard', String((e as Error).message ?? e)));
  }

  private isGuarded(raw: string | URL): boolean {
    if (!this.guarded.size) return false;
    let u: URL;
    try {
      u = typeof raw === 'string' ? new URL(raw) : raw;
    } catch {
      return false;
    }
    if (!/^(https?|wss?):$/.test(u.protocol)) return false;
    if (this.guarded.has(u.origin)) return true;
    return isLoopback(u.hostname) && this.guardedPorts.has(effectivePort(u));
  }

  private async installGuard(ctx: BrowserContext): Promise<void> {
    if (this.routed.has(ctx)) return;
    this.routed.add(ctx);
    await ctx.route(
      (u) => this.isGuarded(u),
      (route) => {
        logEvent('browser.blocked', { origin: originOf(route.request().url()) });
        return route.abort('blockedbyclient');
      },
    );
    // Routes don't see redirects: a page that redirects into the daemon is turned back here.
    ctx.on('request', (req) => {
      if (!req.redirectedFrom() || !this.isGuarded(req.url())) return;
      logEvent('browser.blocked', { origin: originOf(req.url()), redirect: true });
      try {
        void req.frame().goto('about:blank').catch(() => {});
      } catch {}
    });
  }
}
