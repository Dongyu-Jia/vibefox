import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { logEvent } from '../core/log.ts';

/**
 * The agent's own browser: one persistent Chromium profile (its cookies, its
 * logins) shared by every worker through the daemon API. `vf browser …`, the
 * builtin harness tools and the MCP tools all land here, so Claude Code,
 * OpenCode and the builtin loop drive exactly the same browser.
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

export class BrowserService {
  private opts: BrowserOptions;
  private ctx?: BrowserContext;
  private page?: Page;
  private starting?: Promise<Page>;
  private videos: string[] = [];

  constructor(opts: BrowserOptions) {
    this.opts = opts;
  }

  setRecording(record: boolean): void {
    this.opts.record = record;
  }

  isOpen(): boolean {
    return Boolean(this.ctx);
  }

  private async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      fs.mkdirSync(this.opts.profileDir, { recursive: true });
      fs.mkdirSync(this.opts.recordingsDir, { recursive: true });
      this.ctx = await chromium.launchPersistentContext(this.opts.profileDir, {
        headless: this.opts.headless,
        viewport: { width: 1280, height: 800 },
        slowMo: this.opts.slowMoMs,
        recordVideo: this.opts.record ? { dir: this.opts.recordingsDir, size: { width: 1280, height: 800 } } : undefined,
      });
      this.ctx.on('close', () => {
        this.ctx = undefined;
        this.page = undefined;
      });
      this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
      logEvent('browser.started', { record: this.opts.record, headless: this.opts.headless });
      return this.page;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async snapshot(): Promise<string> {
    const page = await this.ensure();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const raw = (await page.evaluate(SNAPSHOT_FN)) as RawSnapshot;
    return formatSnapshot(raw);
  }

  async open(url: string): Promise<string> {
    const page = await this.ensure();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    logEvent('browser.open', { url });
    return this.snapshot();
  }

  private async locate(ref: string) {
    const page = await this.ensure();
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
    return { page, loc };
  }

  async click(ref: string): Promise<string> {
    const { page, loc } = await this.locate(ref);
    await loc.click({ timeout: 15_000 });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(300);
    logEvent('browser.click', { ref, url: page.url() });
    return this.snapshot();
  }

  async type(ref: string, text: string, submit = false): Promise<string> {
    const { page, loc } = await this.locate(ref);
    await loc.fill('');
    await loc.pressSequentially(text, { delay: this.opts.record ? 35 : 0 });
    if (submit) {
      // Search boxes often re-render while you type (Wikipedia does): press Enter on whatever has focus now.
      await page.keyboard.press('Enter');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(300);
    }
    logEvent('browser.type', { ref, length: text.length, submit });
    return this.snapshot();
  }

  async select(ref: string, value: string): Promise<string> {
    const { loc } = await this.locate(ref);
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
    logEvent('browser.select', { ref, value, url: (await this.ensure()).url() });
    return this.snapshot();
  }

  async press(key: string): Promise<string> {
    const page = await this.ensure();
    await page.keyboard.press(key);
    await page.waitForTimeout(300);
    logEvent('browser.press', { pressed: key, url: page.url() });
    return this.snapshot();
  }

  /** Wait until `text` shows on the page (or just `seconds`), then snapshot: for pages that render late. */
  async wait(text: string | undefined, seconds = 15): Promise<string> {
    const page = await this.ensure();
    const ms = Math.min(Math.max(seconds, 1), 60) * 1000;
    let found = false;
    if (text) {
      found = await page
        .waitForFunction((t) => document.body?.innerText.includes(t), text, { timeout: ms, polling: 250 })
        .then(() => true)
        .catch(() => false);
    } else await page.waitForTimeout(ms);
    logEvent('browser.wait', { text, seconds, found, url: page.url() });
    const snap = await this.snapshot();
    return text && !found ? `(waited ${ms / 1000}s; "${text}" did not appear)\n${snap}` : snap;
  }

  async back(): Promise<string> {
    const page = await this.ensure();
    await page.goBack().catch(() => {});
    logEvent('browser.back', { url: page.url() });
    return this.snapshot();
  }

  async screenshot(file: string): Promise<string> {
    const page = await this.ensure();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: false });
    logEvent('browser.screenshot', { file, url: page.url() });
    return file;
  }

  async url(): Promise<string> {
    return this.page?.url() ?? '';
  }

  /** Close the context; returns any finished screen recordings. */
  async close(): Promise<string[]> {
    const page = this.page;
    const ctx = this.ctx;
    if (!ctx) return [];
    const video = page?.video();
    await ctx.close().catch(() => {});
    this.ctx = undefined;
    this.page = undefined;
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

  recordings(): string[] {
    return [...this.videos];
  }
}
