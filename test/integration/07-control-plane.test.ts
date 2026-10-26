import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startSetupServer } from '../../src/control/setup.ts';
import { openSecrets } from '../../src/core/secrets.ts';
import { startDaemon, type RunningDaemon } from '../../src/daemon/daemon.ts';
import { createWorld, waitForAsync, type World } from '../helpers/world.ts';

/**
 * The parent's local UI: birth in three steps, then resources, money, workers —
 * and the line between the parent's session and the token every worker carries.
 */

async function call(base: string, p: string, opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${base}${p}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, headers: res.headers };
}

/** A raw request with any Host header (fetch will not let us forge Host). */
function rawStatus(base: string, p: string, headers: Record<string, string>, method = 'GET'): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function controlSession(d: RunningDaemon): Promise<string> {
  const { json: c } = await call(d.url, '/v1/control/login-code', { method: 'POST', token: d.token });
  const { status, json } = await call(d.url, '/v1/control/session', { body: { code: c.code } });
  assert.equal(status, 200);
  return json.token as string;
}

/** A pretend GitHub that knows one full-power token. */
function fakeGithub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/user' && req.headers.authorization === 'Bearer ghp_fulltoken0000000000000000000000000000') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-oauth-scopes': 'repo, workflow, admin:org, admin:repo_hook, admin:public_key, delete_repo, gist, user, write:packages' });
      return res.end(JSON.stringify({ login: 'fox-agent', id: 1 }));
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((c) => server.close(() => c())) })));
}

describe('the control plane: the parent’s local UI', () => {
  let w: World;
  let gh: Awaited<ReturnType<typeof fakeGithub>>;
  let token: string;
  const saved = { gh: process.env.VF_API_GITHUB, headless: process.env.VF_PARENT_BROWSER_HEADLESS };
  before(async () => {
    gh = await fakeGithub();
    process.env.VF_API_GITHUB = gh.url;
    process.env.VF_PARENT_BROWSER_HEADLESS = '1';
    w = await createWorld();
    await w.start();
    await w.bind();
    token = await controlSession(w.daemon!);
  });
  after(async () => {
    await w?.close();
    await gh?.close();
    for (const [k, v] of [['VF_API_GITHUB', saved.gh], ['VF_PARENT_BROWSER_HEADLESS', saved.headless]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('serves the UI with a strict CSP and no token in the page', async () => {
    const root = await call(w.daemon!.url, '/');
    assert.equal(root.status, 302);
    const page = await call(w.daemon!.url, '/ui/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.ok(!String(page.json).includes(w.daemon!.token), 'no daemon token in the HTML');
    const who = await call(w.daemon!.url, '/v1/whoami');
    assert.deepEqual(who.json, { mode: 'control', agent: { name: 'Fox', slug: 'fox' } });
  });

  it('only this Mac, under its own name, with a parent session — never the worker token', async () => {
    assert.equal(await rawStatus(w.daemon!.url, '/v1/health', { host: 'evil.example:80' }), 421, 'DNS rebinding: wrong Host');
    assert.equal(await rawStatus(w.daemon!.url, '/v1/health', { host: new URL(w.daemon!.url).host, origin: 'https://evil.example' }), 403, 'cross-origin');
    assert.equal(await rawStatus(w.daemon!.url, '/v1/control/overview', { host: new URL(w.daemon!.url).host }, 'OPTIONS'), 405);
    assert.equal((await call(w.daemon!.url, '/v1/control/overview', { token: w.daemon!.token })).status, 401, 'the worker token cannot open the control plane');
    const { json: c } = await call(w.daemon!.url, '/v1/control/login-code', { method: 'POST', token: w.daemon!.token });
    assert.equal((await call(w.daemon!.url, '/v1/control/session', { body: { code: c.code } })).status, 200);
    assert.equal((await call(w.daemon!.url, '/v1/control/session', { body: { code: c.code } })).status, 401, 'a code works once');
    assert.equal((await call(w.daemon!.url, '/v1/control/login-code', { method: 'POST' })).status, 401);
    await w.waitBot((m) => m.text.includes('打开了我的控制台'));
    // The daemon token is in every worker's env: on its own it must not open the control plane.
    process.env.VF_CONTROL_CONFIRM = 'deny';
    try {
      assert.equal((await call(w.daemon!.url, '/v1/control/login-code', { method: 'POST', token: w.daemon!.token })).status, 403, 'nobody at the screen said yes');
    } finally {
      process.env.VF_CONTROL_CONFIRM = 'auto';
    }
    await w.waitBot((m) => m.text.includes('想打开我的控制台'));
  });

  it('the overview says what it still needs, with its own email and number', async () => {
    const { json } = await call(w.daemon!.url, '/v1/control/overview', { token });
    assert.equal(json.agent.name, 'Fox');
    assert.equal(json.agent.email, 'fox-test@agentmail.to');
    assert.match(json.agent.phone, /^\+1/);
    assert.equal(json.ready.channel, true);
    const ids = json.steps.map((s: { id: string }) => s.id);
    for (const id of ['brain', 'telegram', 'workers', 'mandate', 'wallet', 'legal', 'parent', 'resources']) assert.ok(ids.includes(id), id);
    assert.equal(json.steps.find((s: { id: string }) => s.id === 'resources').done, false);
  });

  it('a GitHub token is verified live, kept only in the keychain, and announced', async () => {
    const bad = await call(w.daemon!.url, '/v1/control/resources', { token, body: { kind: 'github', method: 'token', fields: { token: 'ghp_wrong000000000000000000000000000000' } } });
    assert.equal(bad.status, 200);
    assert.equal(bad.json.resource.status, 'failed');
    await call(w.daemon!.url, `/v1/control/resources/${bad.json.resource.id}/delete`, { method: 'POST', token });

    const { json } = await call(w.daemon!.url, '/v1/control/resources', { token, body: { kind: 'github', method: 'token', fields: { token: 'ghp_fulltoken0000000000000000000000000000' } } });
    assert.equal(json.resource.status, 'ok');
    assert.equal(json.resource.access, 'full');
    assert.match(json.resource.handle, /fox-agent/);
    assert.equal(json.resource.hasSecret.token, true);
    const onDisk = fs.readFileSync(path.join(w.home, 'agents', 'fox', 'resources.json'), 'utf8');
    assert.ok(!onDisk.includes('ghp_fulltoken'), 'no secret in resources.json');
    assert.ok(!JSON.stringify(json).includes('ghp_fulltoken'), 'no secret over HTTP');
    await w.waitBot((m) => m.text.includes('GitHub') && m.text.includes('交给我一个资源'));

    const catalog = await call(w.daemon!.url, '/v1/control/catalog', { token });
    const github = catalog.json.kinds.find((k: { id: string }) => k.id === 'github');
    assert.match(github.tokenUrl, /scopes=.*delete_repo/);
    assert.equal(github.verify, undefined, 'no functions over the wire');
  });

  it('for workers resources are read-only: list and read (audited), append their own, never change or delete', async () => {
    const d = w.daemon!;
    const list = await call(d.url, '/v1/resources', { token: d.token });
    const ids = list.json.resources.map((r: { id: string }) => r.id);
    assert.ok(ids.includes('github') && ids.includes('email') && ids.includes('phone'));
    assert.ok(!JSON.stringify(list.json).includes('ghp_fulltoken'));
    const secret = await call(d.url, '/v1/resources/github/secret', { token: d.token, body: { field: 'token' } });
    assert.equal(secret.json.value, 'ghp_fulltoken0000000000000000000000000000');
    assert.ok(w.events().some((e) => e.type === 'resource.secret.read' && e.id === 'github'), 'every read is audited');

    for (const [p, body] of [['/v1/control/resources/github/delete', {}], ['/v1/control/resources/github', { fields: { token: 'x' } }], ['/v1/control/mandate', { monthlyCents: 999999, perTxCents: 999999, allowed: [], consent: '我同意' }], ['/v1/control/freeze', { frozen: false }]] as const) {
      assert.equal((await call(d.url, p, { token: d.token, body })).status, 401, `${p} needs the parent`);
    }
    assert.equal((await call(d.url, '/v1/resources/github', { method: 'DELETE', token: d.token })).status, 404, 'no delete route for workers');

    const mine = await call(d.url, '/v1/resources', { token: d.token, body: { kind: 'github', label: 'fox-agent/site', handle: 'github.com/fox-agent/site', parent: 'github' } });
    assert.equal(mine.json.resource.origin, 'self');
    assert.notEqual(mine.json.resource.id, 'github');
    assert.equal((await call(d.url, '/v1/resources', { token: d.token, body: { kind: 'github', id: 'github', label: 'overwrite' } })).status, 409, 'cannot reuse an existing id');
    const again = await call(d.url, '/v1/control/resources', { token });
    assert.equal(again.json.resources.find((r: { id: string }) => r.id === 'github').access, 'full', 'the given one is untouched');
    await w.waitBot((m) => m.text.includes('我自己加了一个资源'));
  });

  it('a worker’s shell cannot quietly delete them either: the guard restores files and credentials and tells the parent', async () => {
    const d = w.daemon!;
    const root = path.join(w.home, 'agents', 'fox');
    const resourcesFile = path.join(root, 'resources.json');
    const before = fs.readFileSync(resourcesFile, 'utf8');
    fs.rmSync(resourcesFile);
    fs.writeFileSync(path.join(root, 'identity.json'), '{"name":"Evil"}');
    assert.deepEqual(d.guard.checkFiles().sort(), ['identity.json', 'resources.json']);
    assert.equal(fs.readFileSync(resourcesFile, 'utf8'), before);
    assert.equal(d.body.identity().name, 'Fox');
    assert.ok(fs.readdirSync(path.join(root, 'tampered')).some((f) => f.endsWith('identity.json')), 'the altered version is kept as evidence');
    // As if a shell removed a credential from the agent's secret store behind the daemon's back.
    const shell = openSecrets('fox', d.body.paths.secretsFile);
    shell.delete('res.github.token');
    assert.deepEqual(d.guard.checkSecrets(), ['res.github.token']);
    assert.equal(d.resources.secret('github', 'token'), 'ghp_fulltoken0000000000000000000000000000');
    shell.set('res.github.token', 'ghp_swapped00000000000000000000000000000');
    assert.deepEqual(d.guard.checkSecrets(), ['res.github.token'], 'a swapped credential is put back too');
    assert.equal(d.resources.secret('github', 'token'), 'ghp_fulltoken0000000000000000000000000000');
    await w.waitBot((m) => m.text.includes('🛡') && m.text.includes('resources.json'));

    // Edit the file and append right away, before any timer runs: the daemon checks before it reads.
    const list = JSON.parse(fs.readFileSync(resourcesFile, 'utf8'));
    list.resources = list.resources.filter((r: { id: string }) => r.id !== 'github');
    fs.writeFileSync(resourcesFile, JSON.stringify(list));
    const appended = await call(d.url, '/v1/resources', { token: d.token, body: { kind: 'github', id: 'github', label: 'mine now' } });
    assert.equal(appended.status, 409, 'the parent’s github is back before the existence check');
    assert.equal(d.resources.get('github')?.origin, 'parent');
    assert.deepEqual(d.resources.workerEnv().GITHUB_TOKEN, 'ghp_fulltoken0000000000000000000000000000', 'workers only ever get the parent’s credential');
  });

  it('signup help: a strong password saved before signup, and the codes it receives show up live', async () => {
    const d = w.daemon!;
    const draft = await call(d.url, '/v1/control/resources/draft', { token, body: { kind: 'google' } });
    assert.equal(draft.json.resource.status, 'pending');
    assert.ok(draft.json.password.length >= 16);
    assert.equal(draft.json.resource.hasSecret.password, true);
    const since = new Date(Date.now() - 1000).toISOString();
    w.phone.incomingSms('+18005550199', 'G-482913 is your Google verification code.');
    await call(d.url, '/v1/admin/poll', { method: 'POST', token: d.token });
    const codes = await waitForAsync(async () => {
      const r = await call(d.url, `/v1/control/codes?since=${encodeURIComponent(since)}`, { token });
      return r.json.items?.find((i: { code?: string }) => i.code === '482913');
    }, 10_000);
    assert.equal(codes.channel, 'sms');
    const again = await call(d.url, '/v1/control/resources/draft', { token, body: { kind: 'google' } });
    assert.equal(again.json.resource.id, draft.json.resource.id, 'one draft per signup, not a pile of them');
    assert.notEqual(again.json.password, draft.json.password);
    const cf = await call(d.url, '/v1/control/resources/draft', { token, body: { kind: 'cloudflare' } });
    assert.equal(cf.status, 200, 'kinds handed over by token still get a saved account password');
    await call(d.url, `/v1/control/resources/${cf.json.resource.id}/delete`, { method: 'POST', token });
    const done = await call(d.url, `/v1/control/resources/${draft.json.resource.id}`, { token, body: { handle: 'fox.agent@gmail.com', status: 'ok', method: 'password' } });
    assert.equal(done.json.resource.status, 'ok');
    assert.equal(done.json.resource.handle, 'fox.agent@gmail.com');
  });

  it('the parent can look at the agent’s browser in a window of their own; workers wait meanwhile', async () => {
    const d = w.daemon!;
    assert.equal((await call(d.url, '/v1/control/browser/start', { token, body: { url: d.url + '/ui/' } })).status, 400, 'never its own control plane');
    assert.equal((await call(d.url, '/v1/control/browser/start', { token, body: { url: w.shop.url } })).json.ok, true);
    assert.equal((await call(d.url, '/v1/control/browser', { token })).json.active, true);
    const busy = await call(d.url, '/v1/browser/snapshot', { token: d.token, body: {} });
    assert.equal(busy.status, 423);
    await call(d.url, '/v1/control/browser/finish', { token, body: {} });
    assert.equal((await call(d.url, '/v1/control/browser', { token })).json.active, false);
    assert.equal((await call(d.url, '/v1/browser/open', { token: d.token, body: { url: w.shop.url } })).status, 200);
    assert.notEqual((await call(d.url, '/v1/browser/open', { token: d.token, body: { url: d.url + '/ui/' } })).status, 200, 'the agent’s browser cannot reach its own control plane');
  });

  it('money: a new allowance needs the parent’s consent and is signed; the wallet connects in a few clicks', async () => {
    const d = w.daemon!;
    assert.equal((await call(d.url, '/v1/control/mandate', { token, body: { monthlyCents: 5000, perTxCents: 2500, allowed: ['compute'], consent: '' } })).status, 400);
    const signed = await call(d.url, '/v1/control/mandate', { token, body: { monthlyCents: 5000, perTxCents: 2500, allowed: ['compute', 'software', 'gift_cards'], consent: '我同意' } });
    assert.equal(signed.status, 200);
    assert.equal(signed.json.mandate.monthlyLimitCents, 5000);
    assert.equal(signed.json.mandate.intact, true);
    assert.ok(!signed.json.mandate.allowedCategories.includes('gift_cards'), 'blocked categories cannot be allowed');
    assert.ok(signed.json.mandate.blockedCategories.includes('gift_cards'));
    await w.waitBot((m) => m.text.includes('签了零花钱授权书') && m.text.includes('$50.00'));

    await call(d.url, '/v1/control/wallet/disconnect', { token, body: {} });
    assert.equal((await call(d.url, '/v1/control/wallet', { token })).json.authenticated, false);
    const start = await call(d.url, '/v1/control/wallet/connect', { token, body: {} });
    assert.equal(start.json.already, false);
    assert.match(start.json.verificationUrl, /^https?:\/\//);
    assert.ok(start.json.phrase);
    const wallet = await waitForAsync(async () => {
      const r = await call(d.url, '/v1/control/wallet', { token });
      return r.json.authenticated ? r.json : undefined;
    }, 15_000);
    assert.equal(wallet.mandate.intact, true);
    assert.equal(wallet.mandateIntact, true);
    assert.ok(wallet.categories.some((c: { id: string; blocked: boolean }) => c.id === 'crypto' && c.blocked));
  });

  it('workers can be switched off and on from the control plane', async () => {
    const d = w.daemon!;
    const { json } = await call(d.url, '/v1/control/workers', { token });
    const first = json.workers[0];
    const off = await call(d.url, `/v1/control/workers/${encodeURIComponent(first.id)}`, { token, body: { enabled: false } });
    assert.equal(off.json.worker.enabled, false);
    assert.equal(d.body.workers().find((x) => x.id === first.id)?.enabled, false);
    await call(d.url, `/v1/control/workers/${encodeURIComponent(first.id)}`, { token, body: { enabled: true } });
  });

  it('registrant details need explicit consent and are readable by workers (audited)', async () => {
    const d = w.daemon!;
    const legal = { fullName: 'Test Parent', email: 'parent@example.com', phone: '+14155550100', address: { line1: '123 Test St', city: 'Testville', postalCode: '00000', country: 'US' } };
    assert.equal((await call(d.url, '/v1/control/parent', { token, body: { legal } })).status, 400);
    assert.equal((await call(d.url, '/v1/control/parent', { token, body: { legal, consent: true } })).status, 200);
    assert.equal((await call(d.url, '/v1/control/parent', { token, body: { legal: { ...legal, consentAt: new Date().toISOString() } } })).status, 200, 'the UI’s tick box');
    const read = await call(d.url, '/v1/parent/legal', { token: d.token, body: {} });
    assert.equal(read.json.legal.fullName, 'Test Parent');
    assert.ok(read.json.legal.consentAt);
    for (const p of ['/v1/identity', '/v1/identity/summary']) {
      const shared = JSON.stringify((await call(d.url, p, { token: d.token })).json);
      assert.ok(!shared.includes('123 Test St') && !shared.includes('userInfo'), `${p} keeps the registrant address and Link account to the parent`);
    }
  });

  it('birth in the browser needs only a name, its own email and its own number', async () => {
    let second: RunningDaemon | undefined;
    const setup = await startSetupServer({
      // The new agent talks to the same stand-ins as the world's agent.
      configOverrides: {
        services: { agentmail: w.mail.url, agentphone: w.phone.url, openrouter: w.llm.apiBase, anthropic: 'http://127.0.0.1:9', deepseek: 'http://127.0.0.1:9' },
        heartbeat: { enabled: false, briefTime: '08:30', weeklyReviewDay: 0, weeklyReviewTime: '20:00', tickSeconds: 30 },
        browser: { headless: true, record: false, slowMoMs: 0 },
        linkCli: process.env.VF_LINK_CLI,
      } as never,
      launch: async (body) => {
        second = await startDaemon({ slug: body.slug, port: 0 });
        const c = await call(second.url, '/v1/control/login-code', { method: 'POST', token: second.token });
        return `${second.url}/ui/#code=${c.json.code}`;
      },
    });
    try {
      assert.equal((await call(setup.url, '/v1/whoami')).json.mode, 'setup');
      assert.equal((await call(setup.url, '/v1/setup/state')).status, 401);
      const { json: s } = await call(setup.url, '/v1/setup/session', { body: { code: setup.code } });
      const t = s.token as string;
      assert.equal((await call(setup.url, '/v1/setup/finish', { token: t, body: {} })).status, 409, 'nothing to finish yet');
      const born = await call(setup.url, '/v1/setup/birth', { token: t, body: { name: 'Pip', parentName: 'Test Parent' } });
      assert.equal(born.json.agent.name, 'Pip');
      const inboxes = await call(setup.url, '/v1/setup/email/options', { token: t, body: { key: w.mail.key } });
      assert.ok(Array.isArray(inboxes.json.inboxes));
      const email = await call(setup.url, '/v1/setup/email', { token: t, body: { key: w.mail.key, username: 'pip-test' } });
      assert.equal(email.json.email, 'pip-test@agentmail.to');
      const numbers = await call(setup.url, '/v1/setup/phone/options', { token: t, body: { key: w.phone.key } });
      assert.ok(Array.isArray(numbers.json.numbers));
      const phone = await call(setup.url, '/v1/setup/phone', { token: t, body: { key: w.phone.key, areaCode: '415' } });
      assert.match(phone.json.phone, /^\+1/);
      const fin = await call(setup.url, '/v1/setup/finish', { token: t, body: {} });
      assert.match(fin.json.redirect, /\/ui\/#code=/);
      assert.equal(await setup.done, fin.json.redirect);
      const code = new URL(fin.json.redirect).hash.slice('#code='.length);
      const sess = await call(second!.url, '/v1/control/session', { body: { code } });
      assert.equal(sess.json.agent.name, 'Pip');
      const ov = await call(second!.url, '/v1/control/overview', { token: sess.json.token });
      assert.equal(ov.json.agent.email, 'pip-test@agentmail.to');
      assert.equal(ov.json.ready.channel, false, 'no chat channel yet — that comes later');
      assert.equal(ov.json.steps.find((s: { id: string }) => s.id === 'workers').done, false);
      const brain = await call(second!.url, '/v1/control/brain', { token: sess.json.token, body: { provider: 'openrouter', key: w.llm.key } });
      assert.equal(brain.json.ok, true);
      const ws = await call(second!.url, '/v1/control/workers', { token: sess.json.token });
      assert.ok(ws.json.workers.some((x: { id: string; enabled: boolean }) => x.id === 'builtin-openrouter-cheap' && x.enabled), 'a brain comes with workers that use it');
      const det = await call(second!.url, '/v1/control/workers/detect', { token: sess.json.token, body: {} });
      assert.equal(det.status, 200);
      const ov2 = await call(second!.url, '/v1/control/overview', { token: sess.json.token });
      assert.equal(ov2.json.steps.find((s: { id: string }) => s.id === 'workers').done, true);
    } finally {
      await setup.close();
      await second?.stop();
    }
  });
});
