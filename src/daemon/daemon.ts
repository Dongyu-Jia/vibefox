import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { BrowserService } from '../browser/service.ts';
import { TelegramChannel } from '../channels/telegram.ts';
import type { Channel } from '../channels/types.ts';
import { Body } from '../core/body.ts';
import { configureLogs, log, logEvent } from '../core/log.ts';
import { openSecrets } from '../core/secrets.ts';
import { Store } from '../core/store.ts';
import { resolveModel, usableModel, type ChatModel } from '../llm/index.ts';
import { Router } from '../router/router.ts';
import { WorkerManager } from '../workers/manager.ts';
import { createApi } from './api.ts';
import { Heartbeat } from './heartbeat.ts';
import { Services } from './services.ts';

export interface RunningDaemon {
  url: string;
  token: string;
  body: Body;
  store: Store;
  router: Router;
  services: Services;
  browser: BrowserService;
  manager: WorkerManager;
  heartbeat: Heartbeat;
  channel: Channel;
  stop(): Promise<void>;
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onErr = (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && port !== 0) {
        server.off('error', onErr);
        listen(server, 0).then(resolve, reject);
      } else reject(e);
    };
    server.once('error', onErr);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onErr);
      resolve((server.address() as { port: number }).port);
    });
  });
}

export async function startDaemon(opts: { slug?: string; port?: number; channel?: Channel } = {}): Promise<RunningDaemon> {
  const body = Body.open(opts.slug);
  configureLogs(body.paths.logs);
  const config = body.config();
  const secrets = openSecrets(body.slug, body.paths.secretsFile);
  const store = new Store(body.paths.db);

  let token = secrets.get('daemon_token');
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    secrets.set('daemon_token', token);
  }

  const browser = new BrowserService({
    profileDir: body.paths.browserProfile,
    recordingsDir: body.paths.recordings,
    headless: process.env.VF_BROWSER_HEADED ? false : config.browser.headless,
    record: Boolean(process.env.VF_BROWSER_RECORD) || config.browser.record,
    slowMoMs: Number(process.env.VF_BROWSER_SLOWMO ?? config.browser.slowMoMs),
  });

  const tgToken = secrets.get('telegram_bot_token');
  const channel: Channel =
    opts.channel ??
    new TelegramChannel({
      token: tgToken ?? 'missing',
      apiBase: config.channel.apiBase,
      pollTimeoutSec: config.channel.pollTimeoutSec,
      loadOffset: () => Number(store.get('telegram_offset') ?? 0),
      saveOffset: (n) => store.set('telegram_offset', String(n)),
    });

  const modelCache = new Map<string, ChatModel>();
  const routerModel = (): ChatModel | undefined => {
    const low = store.get('budget_mode') === 'low';
    const spec = usableModel(low ? config.voiceModel : config.router.model, low ? 'cheap' : 'mid', secrets);
    if (!spec) return undefined;
    if (!modelCache.has(spec)) modelCache.set(spec, resolveModel(spec, config, secrets));
    return modelCache.get(spec);
  };

  const services = new Services(body, store, secrets);
  // Late-bound: the API needs the router and the router needs the manager, which needs the API URL.
  let router!: Router;
  const server = createApi({
    body,
    store,
    get router() {
      return router;
    },
    services,
    browser,
    token,
  } as never);
  const port = await listen(server, opts.port ?? Number(process.env.VF_DAEMON_PORT ?? config.daemon.port));
  const url = `http://127.0.0.1:${port}`;

  const manager = new WorkerManager({
    body,
    store,
    apiUrl: url,
    apiToken: token,
    timeoutMinutes: config.workerTimeoutMinutes,
    secrets,
    onProgress: (runId, text) => router.onProgress(runId, text),
    onExit: (runId, exit, intentional) => router.onRunExit(runId, exit, intentional),
  });
  router = new Router({ body, store, channel, manager, model: routerModel, brainBudget: () => services.brainBudget() });
  services.sink = router;

  fs.writeFileSync(body.paths.daemonJson, JSON.stringify({ url, token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });

  if (tgToken || opts.channel) {
    await channel.start((msg) => router.handleInbound(msg));
  } else {
    log('no Telegram token yet: the agent runs without a chat channel (vf init --step channel)');
  }
  services.start();
  await router.resumeInterrupted();
  const heartbeat = new Heartbeat(router, store, config);
  heartbeat.start();
  logEvent('daemon.started', { url, pid: process.pid, agent: body.slug });
  log(`vibefox: ${body.identity().name} is awake at ${url}`);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    heartbeat.stop();
    await services.stop();
    await channel.stop();
    await manager.stopAll();
    router.dispose();
    await browser.close();
    const closed = new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections();
    await closed;
    store.close();
    if (fs.existsSync(body.paths.daemonJson)) fs.rmSync(body.paths.daemonJson);
    logEvent('daemon.stopped', {});
  };

  return { url, token, body, store, router, services, browser, manager, heartbeat, channel, stop };
}
