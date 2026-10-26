import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { chunkText, esc, mdToHtml, toPlain } from '../../src/channels/format.ts';
import { Body, defaultRouting, type Mandate, type WorkerSpec } from '../../src/core/body.ts';
import { redact, redactString, unlessEmpty } from '../../src/core/log.ts';
import { Store } from '../../src/core/store.ts';
import { extractCode, verifyAgentPhoneSignature } from '../../src/identity/agentphone.ts';
import { bech32Encode, openSigningKey, sign, verify } from '../../src/identity/selfmade.ts';
import { IDENTITY_KINDS } from '../../src/identity/registry.ts';
import { extractJson, parseModelSpec } from '../../src/llm/index.ts';
import { usageCost } from '../../src/llm/pricing.ts';
import { learnedBulletsFromStats, matchRequestedWorker, nextTier, replaceLearnedSection, statsByKind } from '../../src/router/routing.ts';
import { checkSpend, createMandate, mandateIntact } from '../../src/wallet/mandate.ts';
import { parseArgs } from '../../src/cli/main.ts';
import { formatSnapshot } from '../../src/browser/service.ts';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { KeyFileStore } from '../../src/core/secrets.ts';
import { PROJECT_ROOT } from '../../src/core/paths.ts';

const mandate: Mandate = {
  version: 1,
  currency: 'usd',
  monthlyLimitCents: 3000,
  perTransactionLimitCents: 1500,
  allowedCategories: ['compute'],
  blockedCategories: ['gift_cards', 'money_transfer', 'crypto', 'gambling'],
  rules: { tasksOnlyFromParent: true, discloseAI: true, notifyAfterSpend: true },
  parentStatement: '',
  signedAt: '',
  signedBy: 'p',
};

describe('mandate: authorized once, enforced every time', () => {
  const req = { amountCents: 500, merchantName: 'OpenRouter', merchantUrl: 'https://openrouter.ai', context: 'credits' };
  it('allows spend inside the allowance', () => assert.equal(checkSpend(mandate, req, 0, false).ok, true));
  it('blocks over the per-transaction limit', () => assert.match(checkSpend(mandate, { ...req, amountCents: 1501 }, 0, false).reason!, /单笔上限/));
  it('blocks over the monthly allowance', () => assert.match(checkSpend(mandate, req, 2600, false).reason!, /本月额度/));
  it('blocks forbidden categories', () => {
    assert.match(checkSpend(mandate, { ...req, context: 'buy steam gift card' }, 0, false).reason!, /礼品卡/);
    assert.match(checkSpend(mandate, { ...req, merchantName: 'Western Union', context: 'send' }, 0, false).reason!, /转账/);
    assert.match(checkSpend(mandate, { ...req, merchantUrl: 'https://coinbase.com' }, 0, false).reason!, /加密货币/);
  });
  it('blocks when frozen or when there is no mandate', () => {
    assert.equal(checkSpend(mandate, req, 0, true).ok, false);
    assert.equal(checkSpend(undefined, req, 0, false).ok, false);
  });
  it('is signed by the agent and tamper-evident', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-unit-'));
    const body = Body.create(root);
    body.saveIdentity({ name: 'Fox', slug: 'fox', bornAt: new Date().toISOString(), parent: { name: 'P' }, identities: {} });
    openSigningKey(body);
    const m = createMandate(body, { monthlyLimitCents: 3000, perTransactionLimitCents: 1500, allowedCategories: [], blockedCategories: [], parentName: 'P' });
    assert.ok(mandateIntact(m));
    assert.ok(verify(body, m.hash!, m.agentSignature!));
    assert.equal(mandateIntact({ ...m, monthlyLimitCents: 999999 }), false);
    assert.equal(m.hashVersion, 2);
    assert.equal(mandateIntact({ ...m, rules: { ...m.rules, discloseAI: false } }), false, 'v2 covers nested rules');
    const { hashVersion: _v, ...downgraded } = m;
    assert.equal(mandateIntact(downgraded as typeof m), false, 'dropping hashVersion does not downgrade the check');
    assert.equal(verify(body, 'other', sign(body, 'data')), false);
  });
});

describe('routing rules', () => {
  const workers: WorkerSpec[] = [
    { id: 'cheap', label: 'c', harness: 'builtin', model: 'openrouter:deepseek/x', tier: 1, description: '', enabled: true },
    { id: 'mid', label: 'Mid Sonnet', harness: 'builtin', model: 'openrouter:anthropic/claude-sonnet-5.5', tier: 2, description: '', enabled: true },
    { id: 'claude-code', label: 'Claude Code', harness: 'claude-code', tier: 3, description: '', enabled: true },
  ];
  it('replaces only the learned section; parent rules survive', () => {
    const r = defaultRouting().replace('- （还没有。家长可以直接在这里加，比如：写代码、改代码 → claude-code）', '- coding → claude-code');
    const next = replaceLearnedSection(r, ['research 类任务 → cheap（3/3）']);
    assert.match(next, /## 家长定的[\s\S]*- coding → claude-code/);
    assert.match(next, /## 我学到的[^\n]*\n\n- research 类任务 → cheap（3\/3）\n\n## 默认/);
  });
  it('learns the cheapest reliable worker per kind, with evidence', () => {
    const outcomes = [1, 1, 1].map((s, i) => ({ id: i, task_id: 't', run_id: 'r' + i, kind: 'research', worker_id: 'cheap', tier: 1, success: s, feedback: null, cost_usd: 0.001, duration_ms: 1, exploration: 0, created_at: '' }));
    outcomes.push({ id: 9, task_id: 't', run_id: 'x', kind: 'research', worker_id: 'mid', tier: 2, success: 1, feedback: null, cost_usd: 0.01, duration_ms: 1, exploration: 0, created_at: '' });
    const bullets = learnedBulletsFromStats(statsByKind(outcomes), workers);
    assert.deepEqual(bullets, ['research 类任务 → cheap（最近 3 次成功 3 次，平均 $0.0010）']);
  });
  it('matches a worker the parent names', () => {
    assert.equal(matchRequestedWorker('claude code', workers)?.id, 'claude-code');
    assert.equal(matchRequestedWorker('sonnet', workers)?.id, 'mid');
    assert.equal(matchRequestedWorker('deepseek', workers)?.id, 'cheap');
    const more = [...workers, { id: 'deepseek-harness', label: 'DeepSeek Harness（官方 dsh）· deepseek-v4.1-flash', harness: 'dsh' as const, model: 'openrouter/deepseek/deepseek-v4.1-flash', tier: 1 as const, description: '', enabled: true }];
    assert.equal(matchRequestedWorker('deepseek harness', more)?.id, 'deepseek-harness');
    assert.equal(matchRequestedWorker('DeepSeek-Harness', more)?.id, 'deepseek-harness');
    assert.equal(matchRequestedWorker('dsh', more)?.id, 'deepseek-harness');
    assert.equal(matchRequestedWorker('deepseek-harness', more)?.id, 'deepseek-harness');
  });
  it('escalates to the next untried tier', () => {
    assert.equal(nextTier(workers, workers[0], new Set(['cheap']))?.id, 'mid');
    assert.equal(nextTier(workers, workers[1], new Set(['cheap', 'mid']))?.id, 'claude-code');
    assert.equal(nextTier(workers, workers[2], new Set()), undefined);
  });
});

describe('audit log redaction', () => {
  it('redacts keys, tokens and card numbers', () => {
    assert.equal(redactString('https://api.telegram.org/bot123456789:FAKE-token-for-redaction-tests/getMe'), 'https://api.telegram.org/bot<redacted>/getMe');
    assert.match(redactString('Bearer sk-or-v1-abcdefgh0123456789abcdef'), /sk-or-v1-abcdefgh…<redacted>/);
    assert.equal(redactString('card 4242424242424242 ok'), 'card •••• 4242 ok');
    assert.equal(redactString('ts 1729771234567 phone +14155550100'), 'ts 1729771234567 phone +14155550100');
    assert.deepEqual(redact({ authorization: 'Bearer x', card: { number: '4000009990001984', cvc: '100' }, key: 'k' }), { authorization: '[REDACTED]', card: { number: '•••• 1984', cvc: '[REDACTED]' }, key: '[REDACTED]' });
  });
});

describe('the parent’s key file', () => {
  it('reads and writes dotenv lines, keeps comments, stays 0600', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vf-keys-')), '.env.local');
    fs.writeFileSync(file, '# my keys\nOPENROUTER_API_KEY=\nexport AGENTMAIL_API_KEY="am_quoted"\n', { mode: 0o644 });
    const store = new KeyFileStore(file);
    assert.equal(store.get('openrouter_api_key'), undefined, 'an empty value is no key');
    assert.equal(store.get('agentmail_api_key'), 'am_quoted');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a loose file is tightened on read');
    store.set('openrouter_api_key', 'sk-or-v1-abc');
    store.set('telegram_bot_token', '123:has space');
    assert.equal(store.get('openrouter_api_key'), 'sk-or-v1-abc');
    assert.equal(store.get('telegram_bot_token'), '123:has space');
    store.delete('agentmail_api_key');
    assert.equal(fs.readFileSync(file, 'utf8'), '# my keys\nOPENROUTER_API_KEY=sk-or-v1-abc\nTELEGRAM_BOT_TOKEN="123:has space"\n');
    process.env.VF_SECRET_OPENROUTER_API_KEY = 'from-env';
    assert.equal(store.get('openrouter_api_key'), 'from-env', 'env still wins');
    delete process.env.VF_SECRET_OPENROUTER_API_KEY;
  });
  it('git never picks up key files, local agents or real-run evidence', (t) => {
    if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: PROJECT_ROOT }).status !== 0) return t.skip('not a git checkout');
    const mustIgnore = ['.env.local', '.env', 'answers.json', 'secrets.json', 'setup-keys.json', 'keys/signing_ed25519.pem', 'my.key', '.vibefox/agents/fox/identity.json', 'evidence/live-real/LIVE-RUN.md'];
    for (const f of mustIgnore) assert.equal(spawnSync('git', ['check-ignore', '-q', f], { cwd: PROJECT_ROOT }).status, 0, `${f} must be gitignored`);
    assert.notEqual(spawnSync('git', ['check-ignore', '-q', '.env.example'], { cwd: PROJECT_ROOT }).status, 0, '.env.example is the committed template');
  });
});

describe('audit log volume', () => {
  it('skips empty polls but keeps anything new and every error', () => {
    const logIf = unlessEmpty('messages');
    assert.equal(logIf(200, '{"count":0,"messages": [ ]}'), false);
    assert.equal(logIf(200, '{"count":1,"messages":[{"message_id":"m1"}]}'), true);
    assert.equal(logIf(500, '{"messages":[]}'), true);
  });
  it('prices token-only harness runs (dsh) from per-token prices', () => {
    const cost = usageCost({ inputTokens: 1_000_000, outputTokens: 10_000, cacheReadTokens: 2_000_000 }, { prompt: 2e-8, completion: 1e-6, cacheRead: 1.5e-8 });
    assert.ok(Math.abs(cost - (0.02 + 0.01 + 0.03)) < 1e-12);
  });
});

describe('browser snapshot', () => {
  it('shows what a model needs to operate forms: options of a select, state of a radio', () => {
    const out = formatSnapshot({
      title: 'Order',
      url: 'https://x.test/',
      text: 'Order',
      items: [
        { ref: 'e1', tag: 'select', type: null, role: null, label: 'Size', name: 'size', value: '2', href: null, options: ['Small', 'Medium'] },
        { ref: 'e2', tag: 'input', type: 'radio', role: null, label: 'Medium', name: 'size', value: 'medium', href: null, checked: true },
      ],
    });
    assert.match(out, /\[e1\] select "Size" name=size value="2" options=\["Small","Medium"\]/);
    assert.match(out, /\[e2\] input\[radio\] "Medium" name=size value="medium" checked/);
  });
});

describe('formatting for channels', () => {
  it('escapes and converts light markdown', () => {
    assert.equal(esc('<a&b>'), '&lt;a&amp;b&gt;');
    assert.equal(mdToHtml('**hi** `x` [l](https://a.b)'), '<b>hi</b> <code>x</code> <a href="https://a.b">l</a>');
    assert.equal(toPlain('<b>a</b> <a href="u">l</a> &lt;'), 'a l (u) <');
  });
  it('chunks long text under the channel limit without breaking tags', () => {
    const long = Array.from({ length: 400 }, (_, i) => `<b>line ${i}</b> some text here`).join('\n');
    const parts = chunkText(long, 4096);
    assert.ok(parts.length > 1);
    for (const p of parts) {
      assert.ok(p.length <= 4096);
      assert.equal((p.match(/<b>/g) ?? []).length, (p.match(/<\/b>/g) ?? []).length);
    }
  });
});

describe('identities', () => {
  it('the registry marks who opens each identity', () => {
    const byId = Object.fromEntries(IDENTITY_KINDS.map((k) => [k.id, k]));
    assert.equal(byId.email.opener, 'parent-key');
    assert.equal(byId.phone.opener, 'parent-key');
    assert.equal(byId.telegram_bot.opener, 'parent');
    assert.equal(byId.wallet.opener, 'parent');
    assert.equal(byId.signing_key.opener, 'self');
    assert.equal(byId.legal_identity.opener, 'impossible');
    assert.ok(IDENTITY_KINDS.length >= 30);
  });
  it('bech32 encodes a nostr pubkey (BIP-173 test vector checksum)', () => {
    assert.equal(bech32Encode('a', new Uint8Array([])), 'a12uel5l');
    assert.match(bech32Encode('npub', crypto.randomBytes(32)), /^npub1[02-9ac-hj-np-z]{58}$/);
  });
  it('extracts one-time codes and verifies AgentPhone webhook signatures', () => {
    assert.equal(extractCode('Your verification code is 482913.'), '482913');
    assert.equal(extractCode('【某服务】验证码 7712，5 分钟内有效'), '7712');
    assert.equal(extractCode('Meet at 1530 tomorrow'), undefined);
    assert.equal(extractCode('G-482913 is your Google verification code.'), '482913');
    assert.equal(extractCode('Order number FB-1001 confirmed'), undefined);
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"event":"agent.message"}';
    const sig = 'sha256=' + crypto.createHmac('sha256', 'whsec_test').update(`${ts}.${body}`).digest('hex');
    assert.ok(verifyAgentPhoneSignature(body, sig, ts, 'whsec_test'));
    assert.equal(verifyAgentPhoneSignature(body + ' ', sig, ts, 'whsec_test'), false);
  });
});

describe('task store', () => {
  it('maps replies to tasks and keeps supplements for the next run', () => {
    const store = new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vf-db-')), 't.db'));
    const t = store.createTask({ title: 'x', description: 'y' });
    assert.equal(t.id, 't1');
    store.mapMessage('telegram', '1:5', { taskId: t.id, kind: 'task' });
    assert.equal(store.lookupMessage('telegram', '1:5')?.task_id, 't1');
    store.addSupplement(t.id, 'more');
    assert.deepEqual(store.takeSupplements(t.id, 'r1'), ['more']);
    assert.deepEqual(store.takeSupplements(t.id, 'r2'), []);
    assert.deepEqual(store.allSupplements(t.id), ['more']);
    store.close();
  });
});

describe('misc', () => {
  it('parses model specs and CLI args, extracts JSON', () => {
    assert.deepEqual(parseModelSpec('openrouter:anthropic/claude-sonnet-5.5'), { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' });
    assert.deepEqual(parseArgs(['pay', '--amount', '500', '--test', '--context=a b']), { _: ['pay'], flags: { amount: '500', test: true, context: 'a b' } });
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('sure: {"a":2} ok'), { a: 2 });
  });
});
