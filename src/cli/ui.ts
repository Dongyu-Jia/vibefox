import fs from 'node:fs';
import path from 'node:path';
import { Body } from '../core/body.ts';
import { currentAgentSlug } from '../core/paths.ts';
import { install, status as launchdStatus } from '../onboarding/launchd.ts';
import { openInBrowser } from '../onboarding/openrouterOAuth.ts';
import { startSetupServer } from '../control/setup.ts';

/**
 * `vf ui` and `vf init`: the parent's way into the agent, in the browser.
 * The session lives as long as this command runs: its link can be opened again
 * and again, and Ctrl-C (or killing it) ends the session at once. Both refuse to
 * run inside a worker — a worker holds the daemon token, and the control plane
 * is the one place where only the parent may act.
 */

export function inWorker(): boolean {
  if (process.env.VF_RUN_ID) return true;
  for (let d = path.resolve(process.cwd()); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.vf-run.json'))) return true;
    if (path.dirname(d) === d) return false;
  }
}

function refuseInWorker(): void {
  if (inWorker()) throw new Error('vf ui / vf init are for the parent. Workers cannot open the control plane; ask the router instead.');
}

/** Nobody clicked "打开控制台" in the dialog on this Mac. */
class DeniedError extends Error {}

interface Daemon {
  url: string;
  token: string;
}

function daemonOf(body: Body): Daemon {
  if (!fs.existsSync(body.paths.daemonJson)) throw new Error('not running');
  return JSON.parse(fs.readFileSync(body.paths.daemonJson, 'utf8')) as Daemon;
}

/** A control-plane code for an agent whose daemon is up. The daemon asks the person at this Mac first. */
async function loginCode(body: Body): Promise<{ daemon: Daemon; code: string }> {
  const daemon = daemonOf(body);
  const health = await fetch(`${daemon.url}/v1/health`).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error('not running');
  const res = await fetch(`${daemon.url}/v1/control/login-code`, { method: 'POST', headers: { authorization: `Bearer ${daemon.token}` } });
  if (res.status === 403) throw new DeniedError();
  if (!res.ok) throw new Error(`control plane refused: ${res.status}`);
  const { code } = (await res.json()) as { code: string };
  return { daemon, code };
}

/** The control-plane link with a fresh code (for the setup server's hand-over). */
export async function controlUrl(body: Body): Promise<string> {
  const { daemon, code } = await loginCode(body);
  return `${daemon.url}/ui/#code=${code}`;
}

async function waitForDaemon(body: Body, timeoutMs: number): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await controlUrl(body);
    } catch (err) {
      if (err instanceof DeniedError) throw new Error('没有允许打开控制台；之后运行 vf ui 再开');
      if (Date.now() > until) throw new Error(`the agent did not wake up in ${Math.round(timeoutMs / 1000)}s (${(err as Error).message}); try vf start`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Wakes the agent under launchd (24/7) and returns its control-plane link. VF_SETUP_LAUNCH=inprocess runs it in this process instead (demos, machines without launchd). */
async function wake(body: Body): Promise<string> {
  if (process.env.VF_SETUP_LAUNCH === 'inprocess') {
    const { startDaemon } = await import('../daemon/daemon.ts');
    await startDaemon({ slug: body.slug });
    return waitForDaemon(body, 15_000);
  }
  const r = install(body);
  if (!r.loaded) throw new Error(`launchd: ${r.out}`);
  body.markLevel('install');
  return waitForDaemon(body, 45_000);
}

/**
 * Keeps the session open until Ctrl-C / kill (the daemon revokes it the moment
 * this connection drops), or until the daemon ends it. Resolves with why it ended.
 */
async function holdSession(daemon: Daemon, code: string): Promise<string> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const res = await fetch(`${daemon.url}/v1/control/hold`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: abort.signal,
    });
    if (!res.ok) return '会话没能保持住';
    let tail = '';
    for await (const chunk of res.body!) tail = (tail + Buffer.from(chunk).toString()).slice(-40);
    return tail.includes('expired') ? '会话到 12 小时了，结束了' : '它停了或重启了，会话结束了';
  } catch {
    return abort.signal.aborted ? '会话结束了，链接不能再用' : '和它的连接断了，会话结束了';
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function serve(link: string, daemon: Daemon, code: string, opts: { open: boolean }): Promise<void> {
  console.log(`控制台：${link}`);
  console.log('   这个命令开着的时候，链接可以反复打开（新标签页、刷新都行）；用完按 Ctrl-C 结束会话（最长 12 小时）。');
  if (opts.open) openInBrowser(link);
  console.log(`\n${await holdSession(daemon, code)}。`);
}

/** `route` deep-links after login, e.g. `resources/add/github` from a Telegram "I need a resource" message. */
export async function openControlPlane(route?: string): Promise<void> {
  refuseInWorker();
  const slug = currentAgentSlug();
  if (!slug) return runSetupInBrowser();
  const body = Body.open(slug);
  console.log(`在这台 Mac 上弹出的对话框里点「打开控制台」（60 秒内）。`);
  let got: { daemon: Daemon; code: string };
  try {
    got = await loginCode(body);
  } catch (err) {
    if (err instanceof DeniedError) {
      console.log('没有允许，控制台没打开。');
      return;
    }
    if (!launchdStatus(slug).installed) {
      console.log(`${body.identity().name} 没在运行。用 vf start 叫醒它（或 vf install 让它常驻），再运行 vf ui。`);
      return;
    }
    console.log(`叫醒 ${body.identity().name}…`);
    const link = await wake(body);
    got = { daemon: daemonOf(body), code: new URL(link).hash.slice('#code='.length) };
  }
  let link = `${got.daemon.url}/ui/#code=${got.code}`;
  if (route && /^[\w/:.-]+$/.test(route)) link += `&to=/${route.replace(/^\/+/, '')}`;
  await serve(link, got.daemon, got.code, { open: true });
}

export async function runSetupInBrowser(): Promise<void> {
  refuseInWorker();
  const setup = await startSetupServer({ launch: wake });
  const link = `${setup.url}/ui/#code=${setup.code}`;
  console.log(`🦊 在浏览器里让它出生：${link}`);
  console.log('   只要三步：名字、它自己的邮箱、它自己的号码。其他的之后在控制台里加。');
  openInBrowser(link);
  const redirect = await setup.done;
  // The browser follows the hand-over to the control plane; from here on this command holds that session.
  setTimeout(() => void setup.close(), 4000).unref();
  const slug = currentAgentSlug()!;
  console.log('✔ 它住下来了。');
  // The page already followed the hand-over; don't open a second tab.
  await serve(redirect, daemonOf(Body.open(slug)), new URL(redirect).hash.slice('#code='.length), { open: false });
  if (process.env.VF_SETUP_LAUNCH === 'inprocess') process.exit(0);
}
