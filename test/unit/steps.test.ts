import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AgentConfig, Body, Mandate } from '../../src/core/body.ts';
import { configureLogs } from '../../src/core/log.ts';
import { PROJECT_ROOT } from '../../src/core/paths.ts';
import { openSecrets } from '../../src/core/secrets.ts';
import { sign, verify } from '../../src/identity/selfmade.ts';
import {
  bornAgent,
  connectBrain,
  connectTelegram,
  consentGiven,
  emailOptions,
  openEmail,
  openPhone,
  phoneOptions,
  setParent,
  signMandate,
  StepError,
  walletCheck,
  walletConnectStart,
  walletDisconnect,
  type LegalProfile,
} from '../../src/onboarding/steps.ts';
import { LinkWallet, parseLinkOutput } from '../../src/wallet/link.ts';
import { mandateHistory, mandateHistoryDir, mandateIntact, mandateSigned } from '../../src/wallet/mandate.ts';
import { AgentMailMock } from '../mocks/agentmailMock.ts';
import { AgentPhoneMock } from '../mocks/agentphoneMock.ts';
import { LlmMock } from '../mocks/llmMock.ts';
import { TelegramMock } from '../mocks/telegramMock.ts';

/**
 * The onboarding steps the wizard and the local UI share, called directly with
 * explicit input — against the fake link-cli and the local service mocks.
 */

const ENV = ['VF_HOME', 'VF_AGENT', 'VF_SECRETS', 'VF_KEYS_FILE', 'VF_LLM_TAG_HEADER', 'VF_LINK_CLI', 'VF_MOCK_LINK_STATE', 'VF_MOCK_LINK_AUTH', 'VF_MOCK_LINK_APPROVE_AFTER'];
const saved: Record<string, string | undefined> = {};
const mockLink = path.join(PROJECT_ROOT, 'test', 'mocks', 'bin', 'link-cli');
let home = '';

before(() => {
  for (const k of ENV) saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-steps-'));
  process.env.VF_HOME = home;
  delete process.env.VF_AGENT;
  process.env.VF_SECRETS = 'file';
  // Never read the developer's real key file (.env.local) in tests.
  process.env.VF_KEYS_FILE = path.join(home, 'keys.env');
  process.env.VF_LLM_TAG_HEADER = '1';
  process.env.VF_LINK_CLI = mockLink;
});

after(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  configureLogs(path.join(os.tmpdir(), 'vibefox-test-logs'));
  fs.rmSync(home, { recursive: true, force: true });
});

function agent(name: string, overrides: Partial<AgentConfig> = {}): Promise<Body> {
  return bornAgent({ name, parentName: 'Dongyu', configOverrides: { linkCli: mockLink, ...overrides } });
}

/** A fresh fake Link account for one test. */
function linkState(name: string, opts: { authenticated: boolean; approveAfter?: string }): string {
  const file = path.join(home, `link-${name}.json`);
  process.env.VF_MOCK_LINK_STATE = file;
  process.env.VF_MOCK_LINK_AUTH = opts.authenticated ? '1' : '0';
  if (opts.approveAfter) process.env.VF_MOCK_LINK_APPROVE_AFTER = opts.approveAfter;
  else delete process.env.VF_MOCK_LINK_APPROVE_AFTER;
  return file;
}

const linkCalls = (file: string) => (JSON.parse(fs.readFileSync(file, 'utf8')) as { calls: string[][] }).calls;

describe('signMandate: the parent signs once, every change is a new revision', () => {
  const base = { monthlyCents: 3000, perTxCents: 1500, allowed: ['compute'], consent: '我同意' };

  it('needs the parent to agree, sane amounts and only categories a parent may allow', async () => {
    const body = await agent('Mandy');
    for (const consent of ['', 'no', 'ok', '我不同意', 'yes please']) assert.throws(() => signMandate(body, { ...base, consent }), StepError, consent);
    for (const c of ['我同意', ' YES ', 'I Agree', 'i agree']) assert.ok(consentGiven(c), c);
    assert.throws(() => signMandate(body, { ...base, monthlyCents: 0 }), /每月额度/);
    assert.throws(() => signMandate(body, { ...base, perTxCents: -100 }), /单笔上限/);
    assert.throws(() => signMandate(body, { ...base, monthlyCents: Number.NaN }), StepError);
    assert.throws(() => signMandate(body, { ...base, perTxCents: 5000 }), /不能超过每月额度/);
    assert.throws(() => signMandate(body, { ...base, allowed: ['gift_cards'] }), /永远不允许/);
    assert.throws(() => signMandate(body, { ...base, allowed: ['yachts'] }), /不认识/);
    assert.equal(body.mandate(), undefined, 'nothing was signed');
    assert.equal(body.identity().identities.mandate, undefined);
  });

  it('chains revisions, keeps every previous mandate in mandate-history, all intact and signed by the agent', async () => {
    const body = await agent('Rev');
    const m1 = signMandate(body, { monthlyCents: 3000, perTxCents: 1500, allowed: ['travel', 'compute', 'compute'], consent: ' I agree ' });
    assert.equal(m1.revision, 1);
    assert.equal(m1.previousHash, undefined);
    assert.deepEqual(m1.allowedCategories, ['compute', 'travel']);
    assert.deepEqual(m1.blockedCategories, ['gift_cards', 'money_transfer', 'crypto', 'gambling']);
    assert.equal(m1.signedBy, 'Dongyu');
    assert.ok(mandateIntact(m1));
    assert.ok(verify(body, m1.hash!, m1.agentSignature!));
    assert.deepEqual(mandateHistory(body), []);

    const m2 = signMandate(body, { monthlyCents: 5000, perTxCents: 2000, allowed: [], consent: 'yes' });
    assert.equal(m2.revision, 2);
    assert.equal(m2.previousHash, m1.hash);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mandateHistoryDir(body), '1.json'), 'utf8')), m1);

    const m3 = signMandate(body, { monthlyCents: 10000, perTxCents: 2500, allowed: ['software'], consent: '我同意' });
    assert.equal(m3.revision, 3);
    assert.equal(m3.previousHash, m2.hash);
    assert.deepEqual(body.mandate(), m3);
    assert.deepEqual(mandateHistory(body).map((m) => m.revision), [1, 2]);
    assert.deepEqual(m3.blockedCategories, ['gift_cards', 'money_transfer', 'crypto', 'gambling'], 'blocked categories never change');
    for (const m of [m1, m2, m3]) assert.ok(mandateSigned(body, m), `revision ${m.revision} signed`);

    // the revision chain is part of what is hashed and signed
    assert.equal(mandateIntact({ ...m3, revision: 7 }), false);
    assert.equal(mandateIntact({ ...m3, previousHash: m1.hash }), false);
    assert.equal(mandateSigned(body, { ...m3, agentSignature: m2.agentSignature }), false);

    const rec = body.identity().identities.mandate;
    assert.equal(rec.status, 'open');
    assert.equal(rec.value, '$100.00/月，单笔 $25.00');
    assert.equal(rec.openedBy, 'parent');
    assert.equal(rec.openedAt, m3.signedAt);
    assert.equal(rec.details?.hash, m3.hash);
    assert.equal(rec.details?.revision, 3);
  });

  it('a mandate signed before revisions existed keeps its hash and becomes revision 1 of the chain', async () => {
    const body = await agent('Legacy');
    // Hash computed with the canonical form every existing mandate was signed with.
    const legacy: Mandate = {
      version: 1,
      currency: 'usd',
      monthlyLimitCents: 3000,
      perTransactionLimitCents: 1500,
      allowedCategories: ['compute', 'software'],
      blockedCategories: ['gift_cards', 'money_transfer', 'crypto', 'gambling'],
      rules: { tasksOnlyFromParent: true, discloseAI: true, notifyAfterSpend: true },
      parentStatement: 'legacy',
      signedAt: '2026-10-01T00:00:00.000Z',
      signedBy: 'Dongyu',
      hash: 'ec06ea9ddeabaad7d23d8f12834db46a1dffb297f79a58426d6d55da23c0e3df',
    };
    assert.ok(mandateIntact(legacy), 'old hash still verifies');
    legacy.agentSignature = sign(body, legacy.hash!);
    body.saveMandate(legacy);
    const m = signMandate(body, { ...base, consent: 'yes' });
    assert.equal(m.revision, 2);
    assert.equal(m.previousHash, legacy.hash);
    const archived = JSON.parse(fs.readFileSync(path.join(mandateHistoryDir(body), '1.json'), 'utf8')) as Mandate;
    assert.deepEqual(archived, legacy);
    assert.equal('revision' in archived, false);
    assert.ok(mandateSigned(body, archived));
  });
});

describe('wallet: connect Link in a couple of clicks', () => {
  it('start → the parent approves in Link → check records the wallet and the money level', async () => {
    const state = linkState('wally', { authenticated: false, approveAfter: '2' });
    const body = await agent('Wally');
    const start = await walletConnectStart(body);
    assert.equal(start.already, false);
    assert.match(start.verificationUrl!, /^https:\/\/app\.link\.com\//);
    assert.equal(start.phrase, 'brave-otter-42');
    assert.equal(body.identity().identities.wallet, undefined, 'nothing recorded before approval');
    const login = linkCalls(state).find((c) => c[0] === 'auth' && c[1] === 'login')!;
    assert.equal(login[login.indexOf('--interval') + 1], '0', 'returns at once instead of blocking');
    assert.equal(login[login.indexOf('--client-name') + 1], 'Wally');

    // still waiting: the page can show the URL and phrase again after a reload
    const waiting = await walletCheck(body);
    assert.deepEqual(waiting, { authenticated: false, details: { pending: true, verificationUrl: start.verificationUrl, phrase: 'brave-otter-42' } });

    const done = await walletCheck(body);
    assert.equal(done.authenticated, true);
    assert.equal(done.details?.email, 'parent@example.com');
    const rec = body.identity().identities.wallet;
    assert.equal(rec.status, 'open');
    assert.equal(rec.value, 'Stripe Link agent wallet');
    assert.equal(rec.provider, 'Stripe Link');
    assert.equal(rec.openedBy, 'parent');
    assert.deepEqual(Object.keys(rec.details ?? {}), ['userInfo']);
    assert.deepEqual(body.onboarding().levels.money?.done, true);
    assert.equal(body.onboarding().levels.money?.note, undefined);

    // polling again changes nothing; connecting again needs no approval
    await walletCheck(body);
    assert.equal(body.identity().identities.wallet.openedAt, rec.openedAt);
    assert.deepEqual(await walletConnectStart(body), { already: true });
  });

  it('an approval that never comes stays pending; a lapsed Link login asks the parent again', async () => {
    const state = linkState('lapsed', { authenticated: false, approveAfter: 'never' });
    const body = await agent('Lapsed');
    await walletConnectStart(body);
    for (let i = 0; i < 3; i++) assert.equal((await walletCheck(body)).details?.pending, true);
    // approved after all, then the session lapses
    fs.writeFileSync(state, JSON.stringify({ ...JSON.parse(fs.readFileSync(state, 'utf8')), authenticated: true, pending: undefined }));
    assert.equal((await walletCheck(body)).authenticated, true);
    fs.writeFileSync(state, JSON.stringify({ ...JSON.parse(fs.readFileSync(state, 'utf8')), authenticated: false }));
    assert.deepEqual(await walletCheck(body), { authenticated: false });
    const rec = body.identity().identities.wallet;
    assert.equal(rec.status, 'needs-parent');
    assert.equal(rec.details, undefined);
  });

  it('disconnect logs out of Link, forgets what Link told us and keeps the signed mandate', async () => {
    const state = linkState('dis', { authenticated: true });
    const body = await agent('Dis');
    signMandate(body, { monthlyCents: 2000, perTxCents: 1000, allowed: ['compute'], consent: '我同意' });
    assert.deepEqual(await walletConnectStart(body), { already: true });
    assert.equal(body.identity().identities.wallet.status, 'open');
    await walletDisconnect(body);
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).authenticated, false);
    const rec = body.identity().identities.wallet;
    assert.equal(rec.status, 'needs-parent');
    assert.equal(rec.value, undefined);
    assert.equal(rec.details, undefined);
    assert.ok(!fs.readFileSync(body.paths.identity, 'utf8').includes('parent@example.com'), 'Link user info is gone');
    assert.equal(body.onboarding().levels.money?.note, 'mandate only');
    assert.ok(body.mandate(), 'mandate kept');
    assert.deepEqual(await walletCheck(body), { authenticated: false });
    assert.ok(linkCalls(state).some((c) => c[0] === 'auth' && c[1] === 'logout'));
  });

  it('reads link-cli output robustly and never trusts a non-https verification link', async () => {
    assert.deepEqual(parseLinkOutput('Update available: 0.31.0\n[\n  {\n    "verification_url": "https://x"\n  }\n]\n'), [{ verification_url: 'https://x' }]);
    assert.deepEqual(parseLinkOutput('{"n":1}\n{"n":2}\n'), { n: 2 });
    assert.deepEqual(parseLinkOutput(''), {});
    assert.deepEqual(parseLinkOutput('nope'), { raw: 'nope' });
    const fake = (name: string, script: string) => {
      const file = path.join(home, name);
      fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      return new LinkWallet({ bin: file });
    };
    await assert.rejects(fake('link-down', `echo '{"code":"NETWORK","message":"Link is down"}'; exit 1`).loginStart('Fox'), /Link is down/);
    await assert.rejects(fake('link-js', `echo '[{"verification_url":"javascript:alert(1)","phrase":"x"}]'`).loginStart('Fox'), /auth login failed/);
    const nested = await fake('link-nested', `echo 'warning: something'; echo '{"ok":true,"data":[{"verification_url":"https://app.link.com/d/1","phrase":"calm-fox"}]}'`).loginStart('Fox');
    assert.deepEqual(nested, { already: false, verificationUrl: 'https://app.link.com/d/1', phrase: 'calm-fox' });
  });
});

describe('setParent: contact and, once, the legal identity', () => {
  const legal: LegalProfile = {
    fullName: ' Dongyu Jia ',
    email: 'dongyu@example.com',
    phone: '+1 415 555 0100',
    address: { line1: '1 Market St', city: 'San Francisco', state: 'CA', postalCode: '94105', country: 'us' },
    consentAt: '2026-10-25T10:00:00Z',
  };

  it('stores a complete, consented legal profile next to the contact details', async () => {
    const body = await agent('Parenty');
    setParent(body, { email: ' dongyu@example.com ', phone: '+14155550100', legal });
    const p = body.identity().parent;
    assert.equal(p.name, 'Dongyu');
    assert.equal(p.email, 'dongyu@example.com');
    assert.equal(p.phone, '+14155550100');
    assert.equal(p.legal?.fullName, 'Dongyu Jia');
    assert.equal(p.legal?.company, undefined);
    assert.deepEqual(p.legal?.address, { line1: '1 Market St', city: 'San Francisco', state: 'CA', postalCode: '94105', country: 'US' });
    assert.equal(p.legal?.consentAt, '2026-10-25T10:00:00.000Z');
    const levels = body.onboarding().levels;
    assert.ok(levels.parent?.done);
    assert.ok(levels.legal?.done);

    // empty fields leave what is there alone
    setParent(body, { email: '', phone: '  ' });
    assert.equal(body.identity().parent.email, 'dongyu@example.com');
    assert.equal(body.identity().parent.legal?.fullName, 'Dongyu Jia');
  });

  it('refuses incomplete or unconsented profiles and malformed contacts, writing nothing', async () => {
    const body = await agent('Strict');
    assert.throws(() => setParent(body, { legal: { ...legal, fullName: '', address: { ...legal.address, city: ' ' } } }), /姓名、城市/);
    assert.throws(() => setParent(body, { legal: { ...legal, consentAt: '' } }), /同意/);
    assert.throws(() => setParent(body, { legal: { ...legal, email: 'nope' } }), StepError);
    assert.throws(() => setParent(body, { email: 'not-an-email' }), StepError);
    assert.throws(() => setParent(body, { phone: 'call me maybe' }), StepError);
    assert.deepEqual(body.identity().parent, { name: 'Dongyu' });
    assert.equal(body.onboarding().levels.parent, undefined);
  });
});

describe('keys the parent hands over: brain, Telegram, email, phone', () => {
  const llm = new LlmMock();
  const tg = new TelegramMock();
  const mail = new AgentMailMock();
  const phone = new AgentPhoneMock();
  let body: Body;
  before(async () => {
    await Promise.all([llm.start(), tg.start(), mail.start(), phone.start()]);
    body = await agent('Keys', {
      channel: { kind: 'telegram', apiBase: tg.url, pollTimeoutSec: 1 },
      services: { agentmail: mail.url, agentphone: phone.url, openrouter: llm.apiBase, anthropic: 'http://127.0.0.1:9', deepseek: 'http://127.0.0.1:9' },
    });
  });
  after(async () => {
    await Promise.all([llm.stop(), tg.stop(), mail.stop(), phone.stop()]);
  });

  it('connectBrain stores the key, tests both tiers and puts the router and voice on the cheap model', async () => {
    const secrets = openSecrets(body.slug, body.paths.secretsFile);
    const cheap = 'openrouter:deepseek/deepseek-v4.1-flash';
    const mid = 'openrouter:anthropic/claude-sonnet-5.5';
    llm.blockedModels.add('deepseek/deepseek-v4.1-flash');
    const blocked = await connectBrain(body, secrets, { provider: 'openrouter', key: ` ${llm.key} ` });
    assert.equal(blocked.ok, true);
    assert.equal(blocked.routerModel, mid, 'falls back to the model that answered');
    assert.equal(body.config().voiceModel, mid);
    assert.match(blocked.models[cheap].detail, /guardrail/);
    llm.blockedModels.clear();

    const r = await connectBrain(body, secrets, { provider: 'openrouter', key: llm.key });
    assert.equal(r.ok, true);
    assert.equal(r.routerModel, cheap);
    assert.equal(body.config().router.model, cheap);
    assert.equal(body.config().voiceModel, cheap);
    assert.deepEqual(Object.keys(r.models).sort(), [cheap, mid].sort());
    assert.equal(r.keyInfo?.limit, 10);
    assert.equal(secrets.get('openrouter_api_key'), llm.key);
    const rec = body.identity().identities.brain_openrouter;
    assert.equal(rec.status, 'open');
    assert.equal(rec.value, `openrouter key …${llm.key.slice(-4)}`);
    assert.equal(rec.openedBy, 'parent');
    assert.deepEqual(rec.details?.models, r.models);
    assert.ok(body.onboarding().levels.brain?.done);
    assert.ok(llm.callsFor('onboarding.test').length >= 2);

    const bad = await connectBrain(body, secrets, { provider: 'openrouter', key: 'sk-or-v1-wrong' });
    assert.equal(bad.ok, false);
    assert.equal(bad.routerModel, cheap, 'a broken key never moves the router');
    assert.equal(body.identity().identities.brain_openrouter.status, 'failed');
    await assert.rejects(connectBrain(body, secrets, { provider: 'nope' as never, key: 'k' }), StepError);
    await assert.rejects(connectBrain(body, secrets, { provider: 'deepseek', key: ' ' }), StepError);
  });

  it('connectTelegram presents the bot and hands back the claim link', async () => {
    const secrets = openSecrets(body.slug, body.paths.secretsFile);
    const r = await connectTelegram(body, secrets, { token: tg.token });
    assert.equal(r.handle, '@fox_vibefox_bot');
    assert.equal(r.claimUrl, `https://t.me/fox_vibefox_bot?start=${r.bindCode}`);
    assert.equal(body.onboarding().bindCode, r.bindCode);
    assert.equal(body.onboarding().levels.channel?.note, 'waiting for /start');
    assert.equal(secrets.get('telegram_bot_token'), tg.token);
    assert.equal(body.identity().identities.telegram_bot.value, '@fox_vibefox_bot');
    await assert.rejects(connectTelegram(body, secrets, { token: '1:wrong' }), /Telegram 不认这个 token/);
  });

  it('openEmail opens its own inbox or uses one the parent already has', async () => {
    const secrets = openSecrets(body.slug, body.paths.secretsFile);
    await assert.rejects(emailOptions(body, 'am_wrong'), /AgentMail 不认这个 key/);
    assert.deepEqual(await emailOptions(body, mail.key), { inboxes: [] });
    const own = await openEmail(body, secrets, { key: mail.key, username: 'keys-own' });
    assert.equal(own.value, 'keys-own@agentmail.to');
    assert.equal(own.openedBy, 'self');
    assert.equal(secrets.get('agentmail_api_key'), mail.key);
    assert.deepEqual((await emailOptions(body, mail.key)).inboxes, [{ id: 'keys-own@agentmail.to', email: 'keys-own@agentmail.to' }]);
    const used = await openEmail(body, secrets, { key: mail.key, use: 'keys-own@agentmail.to' });
    assert.equal(used.openedBy, 'parent');
    assert.equal(used.details?.inboxId, 'keys-own@agentmail.to');
    await assert.rejects(openEmail(body, secrets, { key: mail.key, use: 'missing@agentmail.to' }), StepError);
    assert.ok(body.onboarding().levels.email?.done);
  });

  it('openPhone buys a number in the area code, or attaches an existing one at no cost', async () => {
    const secrets = openSecrets(body.slug, body.paths.secretsFile);
    await assert.rejects(openPhone(body, secrets, { key: phone.key, areaCode: '41' }), /区号/);
    const created = await openPhone(body, secrets, { key: phone.key, areaCode: '212' });
    assert.match(created.value!, /^\+1212/);
    assert.equal(created.openedBy, 'self');
    assert.equal(body.identity().identities.sms_codes.value, created.value);
    assert.equal(body.identity().identities.voice.status, 'open');
    const { numbers } = await phoneOptions(body, phone.key);
    assert.equal(numbers.length, 1);
    const attached = await openPhone(body, secrets, { key: phone.key, use: numbers[0].id });
    assert.equal(attached.openedBy, 'parent');
    assert.equal(attached.value, created.value);
    assert.equal(phone.numbers.length, 1, 'no second number bought');
    assert.equal(phone.numbers[0].agentId, attached.details?.agentId);
    await assert.rejects(openPhone(body, secrets, { key: phone.key, use: 'num_missing' }), /找不到号码/);
    assert.equal(secrets.get('agentphone_api_key'), phone.key);
    assert.ok(body.onboarding().levels.phone?.done);
  });
});
