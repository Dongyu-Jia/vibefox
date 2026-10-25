import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon, type RunningDaemon } from '../../src/daemon/daemon.ts';
import { configureLogs } from '../../src/core/log.ts';
import { PROJECT_ROOT } from '../../src/core/paths.ts';
import { ScriptedPrompter } from '../../src/onboarding/prompter.ts';
import { runWizard } from '../../src/onboarding/wizard.ts';
import { startShop, type Order } from '../fixtures/shop.ts';
import { AgentMailMock } from '../mocks/agentmailMock.ts';
import { AgentPhoneMock } from '../mocks/agentphoneMock.ts';
import { LlmMock } from '../mocks/llmMock.ts';
import { TelegramMock, type TgMsg } from '../mocks/telegramMock.ts';

/**
 * A whole little world for one integration test: Telegram, AgentMail,
 * AgentPhone, OpenRouter (scripted), Stripe Link (fake CLI), a website — and
 * a freshly born agent living in a temp VF_HOME.
 */
export interface World {
  home: string;
  tg: TelegramMock;
  mail: AgentMailMock;
  phone: AgentPhoneMock;
  llm: LlmMock;
  shop: { url: string; orders: Order[]; close: () => Promise<void> };
  daemon?: RunningDaemon;
  bindCode?: string;
  transcript: string[];
  start(): Promise<RunningDaemon>;
  restart(): Promise<RunningDaemon>;
  bind(): Promise<void>;
  say(text: string, replyTo?: number): Promise<TgMsg>;
  waitBot(pred: (m: TgMsg) => boolean, timeoutMs?: number): Promise<TgMsg>;
  apiLog(): Record<string, unknown>[];
  events(): Record<string, unknown>[];
  close(): Promise<void>;
}

const ENV_KEYS = ['VF_HOME', 'VF_AGENT', 'VF_SECRETS', 'VF_KEYS_FILE', 'VF_LLM_TAG_HEADER', 'VF_LINK_CLI', 'VF_MOCK_LINK_STATE', 'PATH', 'VF_DAEMON_PORT', 'VF_EXPLORATION_RATE', 'VF_CALL_POLL_SEC', 'VF_BROWSER_RECORD', 'VF_LOGS_DIR', 'XDG_DATA_HOME'];

export async function createWorld(opts: { workers?: 'builtin' | 'all'; answers?: Record<string, unknown>; keep?: string; record?: boolean } = {}): Promise<World> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const home = opts.keep ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vibefox-world-'));
  fs.mkdirSync(home, { recursive: true });
  const mockBin = path.join(PROJECT_ROOT, 'test', 'mocks', 'bin');
  process.env.VF_HOME = home;
  delete process.env.VF_AGENT;
  process.env.VF_SECRETS = 'file';
  // Never read the developer's real key file (.env.local) in tests.
  process.env.VF_KEYS_FILE = path.join(home, 'keys.env');
  process.env.VF_LLM_TAG_HEADER = '1';
  process.env.VF_LINK_CLI = path.join(mockBin, 'link-cli');
  process.env.VF_MOCK_LINK_STATE = path.join(home, 'link-state.json');
  process.env.VF_DAEMON_PORT = '0';
  process.env.VF_EXPLORATION_RATE = '0';
  process.env.VF_CALL_POLL_SEC = '0.2';
  if (opts.record) process.env.VF_BROWSER_RECORD = '1';
  // OpenCode's provider list is read from XDG_DATA_HOME; give the world its own.
  process.env.XDG_DATA_HOME = path.join(home, 'xdg');
  fs.mkdirSync(path.join(home, 'xdg', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, 'xdg', 'opencode', 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: 'sk-or-v1-fake-opencode' } }));
  // Fake claude/opencode first on PATH, so harness integrations are exercised without spending tokens.
  process.env.PATH = `${mockBin}:${saved.PATH}`;

  const tg = new TelegramMock();
  const mail = new AgentMailMock();
  const phone = new AgentPhoneMock();
  const llm = new LlmMock();
  await Promise.all([tg.start(), mail.start(), phone.start(), llm.start()]);
  const shop = await startShop();
  llm.shopUrl = shop.url;

  const answers: Record<string, unknown> = {
    name: 'Fox',
    parent_name: 'Dongyu',
    soul: 'curious',
    brain: 'openrouter_oauth',
    brain_more_0: false,
    telegram_token: tg.token,
    agentmail_key: mail.key,
    email_username: 'fox-test',
    agentphone_key: phone.key,
    phone_area_code: '415',
    money_monthly: '30',
    money_per_tx: '15',
    money_confirm: '我同意',
    wallet_connect: true,
    wallet_test: false,
    parent_email: 'dongyu@example.com',
    parent_phone: '+14155550100',
    install_launchd: false,
    'worker_claude-code': opts.workers === 'all',
    'worker_opencode-deepseek': opts.workers === 'all',
    'worker_codewhale-deepseek': opts.workers === 'all',
    'worker_deepseek-harness': opts.workers === 'all',
    ...opts.answers,
  };
  const prompter = new ScriptedPrompter(answers, true);
  const config = {
    channel: { kind: 'telegram', apiBase: tg.url, pollTimeoutSec: 1 },
    services: { agentmail: mail.url, agentphone: phone.url, openrouter: llm.apiBase, anthropic: 'http://127.0.0.1:9', deepseek: 'http://127.0.0.1:9' },
    mail: { pollSeconds: 0.3 },
    heartbeat: { enabled: false, briefTime: '08:30', weeklyReviewDay: 0, weeklyReviewTime: '20:00', tickSeconds: 30 },
    browser: { headless: true, record: Boolean(opts.record), slowMoMs: 0 },
    linkCli: process.env.VF_LINK_CLI,
  };
  // The OAuth step "opens a browser": follow the redirect chain like a parent clicking Authorize.
  const openBrowser = async (url: string) => {
    const r = await fetch(url, { redirect: 'manual' });
    await fetch(r.headers.get('location')!);
  };
  await runWizard({ prompter, openBrowser, configOverrides: config as never, steps: ['birth', 'brain', 'workers', 'channel', 'email', 'phone', 'money', 'parent'] });

  const bodyRoot = path.join(home, 'agents', 'fox');
  const onboarding = JSON.parse(fs.readFileSync(path.join(bodyRoot, 'onboarding.json'), 'utf8')) as { bindCode?: string };

  const world: World = {
    home,
    tg,
    mail,
    phone,
    llm,
    shop,
    bindCode: onboarding.bindCode,
    transcript: prompter.transcript,
    async start() {
      world.daemon = await startDaemon();
      return world.daemon;
    },
    async restart() {
      await world.daemon?.stop();
      world.daemon = await startDaemon();
      return world.daemon;
    },
    async bind() {
      tg.parentSays(`/start ${world.bindCode}`);
      await tg.waitForBot((m) => m.text.includes('你就是我的家长'));
    },
    async say(text, replyTo) {
      return tg.parentSays(text, replyTo);
    },
    waitBot(pred, timeoutMs) {
      return tg.waitForBot(pred, timeoutMs);
    },
    apiLog() {
      const dir = path.join(bodyRoot, 'logs', 'api');
      return fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))) : [];
    },
    events() {
      const dir = path.join(bodyRoot, 'logs');
      return fs.readdirSync(dir).filter((f) => f.startsWith('events-')).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    },
    async close() {
      await world.daemon?.stop();
      await Promise.all([tg.stop(), mail.stop(), phone.stop(), llm.stop(), shop.close()]);
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      configureLogs(path.join(os.tmpdir(), 'vibefox-test-logs'));
      if (!opts.keep && !process.env.VF_KEEP_WORLD) fs.rmSync(home, { recursive: true, force: true });
    },
  };
  return world;
}

export async function waitFor<T>(fn: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function strip(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
