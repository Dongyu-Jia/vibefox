import http from 'node:http';
import { setupKeys, tail } from '../cli/keys.ts';
import { Body } from '../core/body.ts';
import { configureLogs, logEvent } from '../core/log.ts';
import { currentAgentSlug } from '../core/paths.ts';
import { openSecrets, type SecretStore } from '../core/secrets.ts';
import { bornAgent, emailOptions, openEmail, openPhone, phoneOptions } from '../onboarding/steps.ts';
import { bearer, gate, HttpError, readJson, sendJson, serveUi, Sessions } from './http.ts';

/**
 * The server behind `vf init`: birth in the browser, before the agent (and its
 * daemon) exists. Only three steps — a name, its own email, its own number;
 * everything else is added later in the control plane. On finish it hands the
 * page over to the daemon's control plane and goes away.
 */

export interface SetupServer {
  url: string;
  /** Open `${url}/ui/#code=${code}` once; the code becomes the page's session. */
  code: string;
  /** Resolves with the control-plane URL (with a fresh one-time code) when birth is done. */
  done: Promise<string>;
  close(): Promise<void>;
}

export interface SetupOptions {
  port?: number;
  /** Starts the agent's daemon for the new body and returns its control-plane URL with a one-time code. */
  launch: (body: Body) => Promise<string>;
  configOverrides?: Parameters<typeof bornAgent>[0]['configOverrides'];
}

export async function startSetupServer(opts: SetupOptions): Promise<SetupServer> {
  const sessions = new Sessions();
  // This server is the holder: its link works, again and again, until `vf init` ends.
  const code = sessions.issueCode({ held: true });
  let body: Body | undefined = currentAgentSlug() ? safeOpen(currentAgentSlug()!) : undefined;
  // An existing agent that already has both identities is not "being born": that is what `vf ui` is for.
  if (body && body.identity().identities.email?.status === 'open' && body.identity().identities.phone?.status === 'open') body = undefined;
  let secrets: SecretStore | undefined = body ? openSecrets(body.slug, body.paths.secretsFile) : undefined;
  let finish: (url: string) => void = () => {};
  const done = new Promise<string>((r) => (finish = r));

  const key = (b: Record<string, unknown>, name: string): string => {
    if (b.usePreset) {
      const k = setupKeys().get(name);
      if (!k) throw new HttpError(400, `.env.local 里没有 ${name}`);
      return k;
    }
    if (typeof b.key !== 'string' || !b.key.trim()) throw new HttpError(400, 'key is required');
    return b.key.trim();
  };
  const born = (): Body => {
    if (!body) throw new HttpError(409, '先给它起名字');
    return body;
  };
  const state = () => {
    const ids = body?.identity().identities;
    const keys = setupKeys();
    const t = (n: string) => (keys.get(n) ? tail(keys.get(n)!) : undefined);
    return {
      born: Boolean(body),
      agent: body ? { name: body.identity().name, slug: body.slug, parentName: body.identity().parent.name } : undefined,
      email: ids?.email?.status === 'open' ? ids.email.value : undefined,
      phone: ids?.phone?.status === 'open' ? ids.phone.value : undefined,
      preset: { agentmail: t('agentmail_api_key'), agentphone: t('agentphone_api_key') },
    };
  };

  async function route(method: string, p: string, b: Record<string, unknown>): Promise<unknown> {
    const post = method === 'POST';
    if (p === '/v1/setup/state' && method === 'GET') return state();
    if (p === '/v1/setup/birth' && post) {
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : 'Fox';
      const parentName = typeof b.parentName === 'string' && b.parentName.trim() ? b.parentName.trim().slice(0, 60) : 'parent';
      if (body) {
        // Already born in this setup (it may have an inbox and a number by now): a new name is just a new name.
        body.updateIdentity((id) => {
          id.name = name;
          id.parent.name = parentName;
        });
        logEvent('setup.renamed', { slug: body.slug });
        return { agent: state().agent };
      }
      body = await bornAgent({ name, parentName, configOverrides: opts.configOverrides });
      configureLogs(body.paths.logs);
      secrets = openSecrets(body.slug, body.paths.secretsFile);
      logEvent('setup.born', { slug: body.slug });
      return { agent: state().agent };
    }
    if (p === '/v1/setup/email/options' && post) return emailOptions(born(), key(b, 'agentmail_api_key'));
    if (p === '/v1/setup/email' && post) {
      const rec = await openEmail(born(), secrets!, { key: key(b, 'agentmail_api_key'), use: str(b.use), username: str(b.username) });
      return { email: rec.value };
    }
    if (p === '/v1/setup/phone/options' && post) return phoneOptions(born(), key(b, 'agentphone_api_key'));
    if (p === '/v1/setup/phone' && post) {
      const rec = await openPhone(born(), secrets!, { key: key(b, 'agentphone_api_key'), use: str(b.use), areaCode: str(b.areaCode) });
      return { phone: rec.value };
    }
    if (p === '/v1/setup/finish' && post) {
      const s = state();
      const missing = [!s.born && '名字', !s.email && '邮箱', !s.phone && '电话'].filter(Boolean);
      if (missing.length) throw new HttpError(409, `还差：${missing.join('、')}`);
      const redirect = await opts.launch(born());
      logEvent('setup.finished', { slug: born().slug });
      finish(redirect);
      return { redirect };
    }
    throw new HttpError(404, `no route ${method} ${p}`);
  }

  const server = http.createServer(async (req, res) => {
    if (!gate(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (serveUi(req, res, url.pathname)) return;
    const p = url.pathname;
    try {
      if (p === '/v1/whoami') return sendJson(res, 200, { mode: 'setup', agent: state().agent });
      const b = await readJson(req);
      if (p === '/v1/setup/session' && req.method === 'POST') {
        const token = sessions.exchange(typeof b.code === 'string' ? b.code : '');
        if (!token) throw new HttpError(401, '出生向导已经结束了：重新运行 vf init');
        return sendJson(res, 200, { token });
      }
      if (!sessions.check(bearer(req))) throw new HttpError(401, 'unauthorized');
      sendJson(res, 200, await route(req.method ?? 'GET', p, b));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) logEvent('setup.error', { path: p, error: String((err as Error).message).slice(0, 300) });
      sendJson(res, status, { error: (err as Error).message });
    }
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    code,
    done,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function safeOpen(slug: string): Body | undefined {
  try {
    return Body.open(slug);
  } catch {
    return undefined;
  }
}
