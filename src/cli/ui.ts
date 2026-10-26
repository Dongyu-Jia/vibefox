import fs from 'node:fs';
import path from 'node:path';
import { Body } from '../core/body.ts';
import { currentAgentSlug } from '../core/paths.ts';
import { install, status as launchdStatus } from '../onboarding/launchd.ts';
import { openInBrowser } from '../onboarding/openrouterOAuth.ts';
import { startSetupServer } from '../control/setup.ts';

/**
 * `vf ui` and `vf init`: the parent's way into the agent, in the browser.
 * Both refuse to run inside a worker — a worker holds the daemon token, and the
 * control plane is the one place where only the parent may act.
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

/** A fresh control-plane link (one-time code) for an agent whose daemon is up. */
export async function controlUrl(body: Body): Promise<string> {
  if (!fs.existsSync(body.paths.daemonJson)) throw new Error('not running');
  const info = JSON.parse(fs.readFileSync(body.paths.daemonJson, 'utf8')) as { url: string; token: string };
  const health = await fetch(`${info.url}/v1/health`).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error('not running');
  const res = await fetch(`${info.url}/v1/control/login-code`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } });
  if (!res.ok) throw new Error(`control plane refused: ${res.status}`);
  const { code } = (await res.json()) as { code: string };
  return `${info.url}/ui/#code=${code}`;
}

async function waitForDaemon(body: Body, timeoutMs: number): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await controlUrl(body);
    } catch (err) {
      if (Date.now() > until) throw new Error(`the agent did not wake up in ${Math.round(timeoutMs / 1000)}s (${(err as Error).message}); try vf start`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Wakes the agent under launchd (24/7) and returns its control-plane link. */
async function wake(body: Body): Promise<string> {
  const r = install(body);
  if (!r.loaded) throw new Error(`launchd: ${r.out}`);
  body.markLevel('install');
  return waitForDaemon(body, 45_000);
}

/** `route` deep-links after login, e.g. `resources/add/github` from a Telegram "I need a resource" message. */
export async function openControlPlane(route?: string): Promise<void> {
  refuseInWorker();
  const slug = currentAgentSlug();
  if (!slug) return runSetupInBrowser();
  const body = Body.open(slug);
  let url: string;
  try {
    url = await controlUrl(body);
  } catch {
    if (!launchdStatus(slug).installed) {
      console.log(`${body.identity().name} 没在运行。用 vf start 叫醒它（或 vf install 让它常驻），再运行 vf ui。`);
      return;
    }
    console.log(`叫醒 ${body.identity().name}…`);
    url = await wake(body);
  }
  if (route && /^[\w/:.-]+$/.test(route)) url += `&to=/${route.replace(/^\/+/, '')}`;
  console.log(`控制台：${url.replace(/#code=.*/, '')}（一次性链接已在浏览器里打开）`);
  openInBrowser(url);
}

export async function runSetupInBrowser(): Promise<void> {
  refuseInWorker();
  const setup = await startSetupServer({ launch: wake });
  const link = `${setup.url}/ui/#code=${setup.code}`;
  console.log(`🦊 在浏览器里让它出生：${setup.url}/ui/`);
  console.log('   只要三步：名字、它自己的邮箱、它自己的号码。其他的之后在控制台里加。');
  openInBrowser(link);
  const redirect = await setup.done;
  console.log(`✔ 它住下来了。控制台：${redirect.replace(/#code=.*/, '')}`);
  // Give the page a moment to follow the redirect before this server goes away.
  await new Promise((r) => setTimeout(r, 4000));
  await setup.close();
}
