import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { loggedFetch } from '../core/log.ts';

/**
 * "Connect OpenRouter" without copy-pasting keys: OAuth PKCE with a localhost
 * callback. The parent logs in (and can choose the agent's email as the
 * account); the key comes straight back to the wizard.
 */
export async function openRouterLogin(opts: {
  authBase?: string;
  apiBase?: string;
  label: string;
  open?: (url: string) => void | Promise<void>;
  timeoutMs?: number;
  onUrl?: (url: string) => void;
}): Promise<string> {
  const authBase = (opts.authBase ?? 'https://openrouter.ai').replace(/\/$/, '');
  const apiBase = (opts.apiBase ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(8).toString('hex');

  let resolveCode!: (code: string) => void;
  let rejectCode!: (e: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    if (u.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const code = u.searchParams.get('code');
    if (!code || (u.searchParams.get('state') && u.searchParams.get('state') !== state)) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end('<p>授权失败，回到终端重试。</p>');
      rejectCode(new Error('OpenRouter callback without a valid code'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h2>🦊 连好了</h2><p>可以关掉这个页面，回到终端。</p>');
    resolveCode(code);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const callback = `http://localhost:${port}/callback`;
  const url = `${authBase}/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256&key_label=${encodeURIComponent(opts.label)}&state=${state}`;
  opts.onUrl?.(url);
  await (opts.open ?? openInBrowser)(url);

  const timer = setTimeout(() => rejectCode(new Error('timed out waiting for OpenRouter login')), opts.timeoutMs ?? 10 * 60_000);
  try {
    const code = await codePromise;
    const res = await loggedFetch('openrouter', `${apiBase}/auth/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    if (!res.ok) throw new Error(`OpenRouter key exchange failed: ${res.status} ${await res.text()}`);
    const { key } = (await res.json()) as { key: string };
    return key;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

export function openInBrowser(url: string): void {
  // VF_BROWSER_OPEN lets headless installs (or recordings against mocks) use another opener, e.g. "curl -sL".
  const custom = process.env.VF_BROWSER_OPEN?.split(' ').filter(Boolean);
  const [cmd, ...args] = custom?.length ? custom : ['open'];
  spawn(cmd, [...args, url], { stdio: 'ignore', detached: true }).unref();
}
