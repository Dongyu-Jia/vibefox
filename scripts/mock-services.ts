/**
 * Runs the local stand-ins for Telegram, AgentMail, AgentPhone, OpenRouter
 * and a website as one process, and prints the env vars that point a fresh
 * agent at them. Used to record the interactive onboarding and for demos
 * without real accounts.
 *
 *   node scripts/mock-services.ts > /tmp/vf-mocks.env   (Ctrl-C to stop)
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/core/paths.ts';
import { startShop } from '../test/fixtures/shop.ts';
import { AgentMailMock } from '../test/mocks/agentmailMock.ts';
import { AgentPhoneMock } from '../test/mocks/agentphoneMock.ts';
import { LlmMock } from '../test/mocks/llmMock.ts';
import { TelegramMock } from '../test/mocks/telegramMock.ts';

const tg = new TelegramMock();
const mail = new AgentMailMock();
const phone = new AgentPhoneMock();
const llm = new LlmMock();
await Promise.all([tg.start(), mail.start(), phone.start(), llm.start()]);
const shop = await startShop();
llm.shopUrl = shop.url;

const mockBin = path.join(PROJECT_ROOT, 'test', 'mocks', 'bin');
const env: Record<string, string> = {
  VF_TELEGRAM_API: tg.url,
  VF_AGENTMAIL_API: mail.url,
  VF_AGENTPHONE_API: phone.url,
  VF_OPENROUTER_API: llm.apiBase,
  VF_LLM_TAG_HEADER: '1',
  VF_LINK_CLI: path.join(mockBin, 'link-cli'),
  VF_BROWSER_OPEN: 'curl -sL',
  MOCK_TELEGRAM_TOKEN: tg.token,
  MOCK_AGENTMAIL_KEY: mail.key,
  MOCK_AGENTPHONE_KEY: phone.key,
  MOCK_SHOP_URL: shop.url,
  MOCK_TELEGRAM_UI: `${tg.url}/ui`,
};
const out = process.argv[2];
const text = Object.entries(env).map(([k, v]) => `export ${k}="${v}"`).join('\n') + '\n';
if (out) fs.writeFileSync(out, text);
else process.stdout.write(text);
process.stderr.write(`mock services up; Telegram UI: ${tg.url}/ui\n`);
setInterval(() => {}, 1 << 30);
