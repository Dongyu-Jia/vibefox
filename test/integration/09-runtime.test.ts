import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext } from 'playwright';
import { BrowserBusyError, type BrowserService } from '../../src/browser/service.ts';
import { DaemonClient } from '../../src/cli/client.ts';
import type { Mandate } from '../../src/core/body.ts';
import { TAMPERED_MANDATE, type RecentCode } from '../../src/daemon/services.ts';
import { createWorld, strip, waitFor, type World } from '../helpers/world.ts';

/**
 * A site that logs you in with session cookies (no expiry: they die with the browser process
 * unless vibefox carries them over) and remembers which cookies every request brought.
 */
function startLoginSite(): Promise<{ url: string; seen: { path: string; cookie: string }[]; close: () => Promise<void> }> {
  const seen: { path: string; cookie: string }[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    seen.push({ path: u.pathname, cookie: req.headers.cookie ?? '' });
    const html = (body: string, headers: Record<string, string> = {}) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(`<!doctype html><title>Login site</title><body>${body}</body>`);
    };
    if (u.pathname === '/agent-login') return html('<p>agent signed in</p>', { 'set-cookie': 'agent_sess=a1; Path=/; HttpOnly' });
    if (u.pathname === '/login') return html('<p>Welcome back, parent</p>', { 'set-cookie': 'parent_sess=p1; Path=/; HttpOnly' });
    if (u.pathname === '/me') return html(`<p>cookies: ${req.headers.cookie ?? '(none)'}</p>`);
    if (u.pathname === '/probe') {
      // A page that tries to reach a target behind the browser's back.
      const target = JSON.stringify(u.searchParams.get('target') ?? '');
      return html(`<p id="out">probing</p><script>fetch(${target}, { mode: 'no-cors' }).then(() => { out.textContent = 'probe: reached'; }, () => { out.textContent = 'probe: blocked'; });</script>`);
    }
    if (u.pathname === '/redirect') {
      res.writeHead(302, { location: u.searchParams.get('to') ?? '/' });
      return res.end();
    }
    html('<p>home</p>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => {
          server.closeAllConnections();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

async function eventually<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`eventually timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const busy = (e: unknown) => e instanceof BrowserBusyError && e.status === 423 && /家长正在用它的浏览器/.test(e.message) && /稍后再试/.test(e.message);

describe('runtime: the parent borrows the browser, services reload live, codes show up, a tampered mandate spends nothing', () => {
  let w: World;
  let api: DaemonClient;
  let site: Awaited<ReturnType<typeof startLoginSite>>;
  let b: BrowserService;
  const savedHeadless = process.env.VF_PARENT_BROWSER_HEADLESS;
  before(async () => {
    process.env.VF_PARENT_BROWSER_HEADLESS = '1';
    w = await createWorld();
    await w.start();
    await w.bind();
    api = new DaemonClient(w.daemon!.url, w.daemon!.token);
    site = await startLoginSite();
    b = w.daemon!.browser;
  });
  after(async () => {
    await b?.endParentSession().catch(() => {});
    await site?.close();
    await w?.close();
    if (savedHeadless === undefined) delete process.env.VF_PARENT_BROWSER_HEADLESS;
    else process.env.VF_PARENT_BROWSER_HEADLESS = savedHeadless;
  });

  it('while the parent has the browser every worker call gets BrowserBusyError (423); after, logins from both sides survive', async () => {
    // The agent logs in somewhere on its own first: a session cookie in the headless browser.
    assert.match(await b.open(`${site.url}/agent-login`), /agent signed in/);

    await b.beginParentSession(w.shop.url);
    assert.deepEqual(b.parentSession(), { active: true, url: new URL(w.shop.url).href });

    const calls: [string, () => Promise<unknown>][] = [
      ['snapshot', () => b.snapshot()],
      ['open', () => b.open(w.shop.url)],
      ['click', () => b.click('e1')],
      ['type', () => b.type('e1', 'hello')],
      ['select', () => b.select('e1', 'x')],
      ['press', () => b.press('Enter')],
      ['wait', () => b.wait('x', 1)],
      ['back', () => b.back()],
      ['screenshot', () => b.screenshot(path.join(w.home, 'shot.png'))],
      ['close', () => b.close()],
    ];
    for (const [name, call] of calls) await assert.rejects(call(), busy, `${name} is refused during the parent session`);
    // …and through the daemon API, which is what workers actually call.
    await assert.rejects(api.post('/v1/browser/snapshot', {}), /家长正在用它的浏览器/);
    assert.equal(await b.url(), '', 'workers never see the address of the parent page');

    // The parent clicks the next link of the flow: same window, new tab, no relaunch. The agent's own login came along.
    await b.beginParentSession(`${site.url}/login?next=%2Fdashboard`);
    assert.equal(b.parentSession().url, `${site.url}/login?next=%2Fdashboard`);
    const login = site.seen.find((s) => s.path === '/login');
    assert.ok(login, 'the parent tab opened');
    assert.match(login.cookie, /agent_sess=a1/, "the agent's session cookie is in the parent's window");

    await b.endParentSession();
    assert.deepEqual(b.parentSession(), { active: false });
    await b.endParentSession(); // finishing twice is harmless

    // Workers are back, headless, and the parent's login (a session cookie) survived the relaunch.
    const me = await b.open(`${site.url}/me`);
    assert.match(me, /agent_sess=a1/);
    assert.match(me, /parent_sess=p1/);
    const cookieFile = path.join(w.home, 'agents', 'fox', 'browser', 'session-cookies.json');
    assert.equal(fs.statSync(cookieFile).mode & 0o777, 0o600);

    const parentEvents = w.events().filter((e) => String(e.type).startsWith('browser.parent'));
    assert.ok(parentEvents.some((e) => e.type === 'browser.parent.start' && e.origin === new URL(w.shop.url).origin));
    assert.ok(parentEvents.some((e) => e.type === 'browser.parent.end'));
    assert.ok(!JSON.stringify(w.events()).includes('/login?next'), 'parent-session addresses are never logged in full');
    const started = w.events().filter((e) => e.type === 'browser.started');
    assert.ok(started.some((e) => e.parent === true && e.record === false), 'the parent window is never recorded');
  });

  it('when the parent closes the window the session ends by itself', async () => {
    await b.beginParentSession(`${site.url}/me`);
    await b.beginParentSession(`${site.url}/login`);
    // The parent closes the window (both tabs) instead of pressing "done" in the console.
    const ctx = (b as unknown as { ctx: BrowserContext }).ctx;
    for (const p of ctx.pages()) await p.close();
    await eventually(async () => (b.parentSession().active ? undefined : true));
    assert.match(await b.open(`${site.url}/me`), /parent_sess=p1/);
    assert.ok(w.events().some((e) => e.type === 'browser.parent.closed'));
  });

  it("the agent's browser never opens the daemon's own port, under any loopback name", async () => {
    const daemon = new URL(w.daemon!.url);
    b.guardOrigin([daemon.origin, `http://localhost:${daemon.port}`]);
    for (const u of [`${daemon.origin}/v1/health`, `http://localhost:${daemon.port}/ui/`, `http://0.0.0.0:${daemon.port}/`, `http://[::1]:${daemon.port}/`]) {
      await assert.rejects(b.open(u), /不许打开/, u);
    }
    await assert.rejects(b.beginParentSession(`${daemon.origin}/ui/`), /不许打开/);
    assert.equal(b.parentSession().active, false);

    // A page's own requests to it are cut off at the network…
    await b.open(`${site.url}/probe?target=${encodeURIComponent(`${daemon.origin}/v1/health`)}`);
    assert.match(await b.wait('probe: ', 5), /probe: blocked/);
    // …and so is a redirect into it.
    const viaRedirect = await b.open(`${site.url}/redirect?to=${encodeURIComponent(`${daemon.origin}/v1/health`)}`).catch((e: Error) => e.message);
    assert.doesNotMatch(viaRedirect, /"ok":\s*true/);
    assert.ok(!(await b.url()).startsWith(daemon.origin), 'not sitting on the daemon');
    assert.ok(w.events().some((e) => e.type === 'browser.blocked' && e.redirect === true));

    // Everything else still loads, and other ports on the same host are fine.
    await b.open(`${site.url}/probe?target=${encodeURIComponent(`${w.shop.url}/`)}`);
    assert.match(await b.wait('probe: ', 5), /probe: reached/);
    assert.match(await b.open(w.shop.url), /Fox Bakery/);
  });

  it('reload() re-reads identity and keys and keeps mail polling going, even after stop()', async () => {
    const services = w.daemon!.services;
    const body = w.daemon!.body;
    const store = w.daemon!.store;
    const arrived = (subject: string) => store.inboxItems(200).filter((i) => i.subject === subject);

    await Promise.all([services.reload(), services.reload()]);
    w.mail.deliver({ from: 'Pen Pal <pal@example.com>', subject: 'hello after reload', text: 'Just saying hi.' });
    await waitFor(() => (arrived('hello after reload').length ? true : undefined));

    // The parent takes the email away in the console: after a reload the agent stops reading it…
    const email = body.identity().identities.email;
    body.setIdentityRecord('email', { ...email, status: 'needs-parent' });
    await services.reload();
    assert.equal(services.mail, undefined);
    w.mail.deliver({ from: 'Pen Pal <pal@example.com>', subject: 'while away', text: 'Are you there?' });
    await sleep(1000);
    assert.equal(arrived('while away').length, 0);
    // …and gives it back: the mail that came meanwhile arrives, once.
    body.setIdentityRecord('email', email);
    await services.reload();
    assert.ok(services.mail);
    await waitFor(() => (arrived('while away').length ? true : undefined));

    // stop() is no longer forever: reload after it only refreshes, start() brings the watchers back.
    await services.stop();
    await services.reload();
    w.mail.deliver({ from: 'Pen Pal <pal@example.com>', subject: 'after stop', text: 'Hello again.' });
    await sleep(1000);
    assert.equal(arrived('after stop').length, 0, 'a reload after stop() does not restart anything');
    services.start();
    await waitFor(() => (arrived('after stop').length ? true : undefined));
    await sleep(800);
    for (const s of ['hello after reload', 'while away', 'after stop']) assert.equal(arrived(s).length, 1, `${s} arrived exactly once`);
  });

  it('recentCodes(): the SMS code and the email verification link the agent just got, newest first', async () => {
    w.phone.incomingSms('+18885550000', 'Old code 111111 for something else');
    await eventually(async () => ((await w.daemon!.services.recentCodes(new Date(0).toISOString())).some((c) => c.code === '111111') ? true : undefined));
    await sleep(20);
    const since = new Date().toISOString();

    w.phone.incomingSms('+18885550000', 'Your GitHub verification code is 731942.');
    await sleep(20);
    w.mail.deliver({
      from: 'GitHub <noreply@github.com>',
      subject: '[GitHub] Please verify your email address.',
      text: 'Hey fox-test!\n\nVisit https://github.com for news.\n\nTo finish signing up, verify your email address:\nhttps://github.com/users/fox-test/emails/42/confirm_verification/abcdef?via_launch_code_email=true.\n\nUnsubscribe: https://github.com/unsubscribe/zz',
    });
    w.mail.deliver({ from: 'Pen Pal <pal@example.com>', subject: 'no code here', text: 'See https://example.com/photos for the pictures.' });
    w.mail.deliver({ from: 'Dongyu <dongyu@example.com>', subject: 'from the parent', text: 'Please confirm: https://example.com/confirm/me' });

    const items = await eventually<RecentCode[]>(async () => {
      const r = await w.daemon!.services.recentCodes(since);
      return r.length >= 2 ? r : undefined;
    });
    await sleep(500);
    const final = await w.daemon!.services.recentCodes(since);
    assert.equal(final.length, 2, JSON.stringify(final));
    assert.deepEqual(items.map((i) => i.channel), ['email', 'sms'], 'newest first');
    assert.equal(final[0].link, 'https://github.com/users/fox-test/emails/42/confirm_verification/abcdef?via_launch_code_email=true');
    assert.equal(final[0].from, 'GitHub <noreply@github.com>');
    assert.match(final[0].subject ?? '', /verify your email/);
    assert.equal(final[1].code, '731942');
    assert.equal(final[1].from, '+18885550000');
    assert.ok(Date.parse(final[1].at) >= Date.parse(since));
    // The old code is outside the window; a garbled `since` means "the last few minutes".
    assert.ok(!final.some((c) => c.code === '111111'));
    assert.ok((await w.daemon!.services.recentCodes('not a date')).some((c) => c.code === '731942'));
  });

  it('a mandate edited on disk never counts: the guard restores it, and without the guard pay() refuses it, even with a recomputed hash', async () => {
    const file = path.join(w.home, 'agents', 'fox', 'mandate.json');
    const original = fs.readFileSync(file, 'utf8');
    const spendBefore = w.daemon!.store.spendRows().length;
    const tryPay = () => api.op<{ status: string; reason?: string }>('/v1/pay', { merchantName: 'Coffee Beans Co', merchantUrl: 'https://beans.example', amountCents: 500, context: 'Coffee beans for the office', test: true });
    // First line: the guard puts the signed mandate back before pay() even reads it, and tells the parent.
    const raised = JSON.parse(original) as Mandate;
    raised.perTransactionLimitCents = 1_000_000;
    fs.writeFileSync(file, JSON.stringify(raised, null, 2));
    const big = await api.op<{ status: string; reason?: string }>('/v1/pay', { merchantName: 'Coffee Beans Co', merchantUrl: 'https://beans.example', amountCents: 50_000, context: 'A very large coffee order', test: true });
    assert.equal(big.status, 'refused');
    assert.match(String(big.reason), /单笔上限/, 'judged by the signed limits, not the edited ones');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    await w.waitBot((msg) => msg.text.includes('🛡') && msg.text.includes('mandate.json'));

    // Second line, with the guard out of the way: pay() itself refuses a mandate whose hash or signature is off.
    w.daemon!.guard.stop();
    try {
      // Someone raises the allowance by hand.
      const m = JSON.parse(original) as Mandate;
      m.monthlyLimitCents = 1_000_000;
      m.perTransactionLimitCents = 1_000_000;
      fs.writeFileSync(file, JSON.stringify(m, null, 2));
      let r = await tryPay();
      assert.equal(r.status, 'refused');
      assert.equal(r.reason, TAMPERED_MANDATE);
      const told = await w.waitBot((msg) => msg.text.includes('授权书') && msg.text.includes('对不上'));
      assert.match(strip(told.text), /重新签/);

      // A cleverer edit recomputes the hash too, but cannot forge the agent's signature.
      const { hash: _h, agentSignature: _s, ...rest } = m;
      m.hash = crypto.createHash('sha256').update(JSON.stringify(rest, Object.keys(rest).sort())).digest('hex');
      fs.writeFileSync(file, JSON.stringify(m, null, 2));
      r = await tryPay();
      assert.equal(r.status, 'refused');
      assert.equal(r.reason, TAMPERED_MANDATE);

      // No signature at all is no mandate either.
      delete m.agentSignature;
      fs.writeFileSync(file, JSON.stringify(m, null, 2));
      assert.equal((await tryPay()).reason, TAMPERED_MANDATE);
      assert.equal(w.daemon!.store.spendRows().length, spendBefore, 'nothing reached Link');
      assert.ok(w.events().some((e) => e.type === 'pay.check' && e.tampered === true));
    } finally {
      fs.writeFileSync(file, original);
      w.daemon!.guard.start();
    }
    // The real, signed mandate still works.
    const ok = await tryPay();
    assert.equal(ok.status, 'approved');
  });
});
