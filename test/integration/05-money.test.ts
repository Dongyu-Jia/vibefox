import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { DaemonClient } from '../../src/cli/client.ts';
import { createWorld, strip, type World } from '../helpers/world.ts';

describe('money: authorized once at birth, spent within the mandate through Stripe Link', () => {
  let w: World;
  let api: DaemonClient;
  before(async () => {
    w = await createWorld();
    await w.start();
    await w.bind();
    api = new DaemonClient(w.daemon!.url, w.daemon!.token);
  });
  after(async () => w?.close());

  it('pays for its own brain within the mandate (Link test mode): card file 0600, parent notified after', async () => {
    await w.say('给你自己的 OpenRouter 充值 $5');
    const ask = await w.waitBot((m) => m.text.startsWith('💳'), 30_000);
    assert.match(strip(ask.text), /OpenRouter/);
    assert.match(strip(ask.text), /\$5\.00/);
    assert.match(strip(ask.text), /app\.link\.com\/activity\/approve\/lsrq_0001/);
    const done = await w.waitBot((m) => m.text.startsWith('✅') && m.text.includes('尾号 1984') && m.text.includes('#t1'), 30_000);
    assert.ok(done);
    const spend = w.daemon!.store.spendRows();
    assert.equal(spend.length, 1);
    assert.equal(spend[0].status, 'approved');
    assert.equal(spend[0].test, 1);
    assert.equal(spend[0].last4, '1984');
    const file = `${w.home}/agents/fox/wallet/cards/lsrq_0001.json`;
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // the card number never reaches the logs
    const logText = JSON.stringify(w.apiLog());
    assert.ok(!logText.includes('4000009990001984'), 'PAN not in API log');
    const linkCalls = JSON.parse(fs.readFileSync(`${w.home}/link-state.json`, 'utf8')).calls as string[][];
    assert.ok(linkCalls.some((c) => c.includes('--output-file')), 'card retrieved straight to a file');
  });

  it('refuses anything over the per-purchase limit without asking anyone', async () => {
    const r = await api.op<{ status: string; reason: string }>('/v1/pay', { merchantName: 'Some Store', merchantUrl: 'https://store.example', amountCents: 2000, context: 'A $20 thing' });
    assert.equal(r.status, 'refused');
    assert.match(r.reason, /单笔上限/);
  });

  it('never buys blocked categories (gift cards)', async () => {
    const r = await api.op<{ status: string; reason: string }>('/v1/pay', { merchantName: 'Gift Card Mall', merchantUrl: 'https://giftcards.example', amountCents: 1000, context: 'Buy a $10 gift card' });
    assert.equal(r.status, 'refused');
    assert.match(r.reason, /礼品卡/);
  });

  it('respects the monthly allowance across purchases', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await api.op<{ status: string }>('/v1/pay', { merchantName: 'Coffee Beans Co', merchantUrl: 'https://beans.example', amountCents: 1400, context: 'Coffee beans for the office' });
      assert.equal(r.status, 'approved');
    }
    const r = await api.op<{ status: string; reason: string }>('/v1/pay', { merchantName: 'Coffee Beans Co', merchantUrl: 'https://beans.example', amountCents: 500, context: 'More coffee beans' });
    assert.equal(r.status, 'refused');
    assert.match(r.reason, /本月额度/);
  });

  it('/freeze stops spending and outbound contact until /unfreeze', async () => {
    await w.say('/freeze');
    await w.waitBot((m) => m.text.includes('冻结了'));
    const r = await api.op<{ status: string; reason: string }>('/v1/pay', { merchantName: 'X', merchantUrl: 'https://x.example', amountCents: 100, context: 'tiny', test: true });
    assert.equal(r.status, 'refused');
    await assert.rejects(api.post('/v1/mail/send', { to: 'a@b.example', subject: 's', text: 't' }), /froze/);
    await w.say('/unfreeze');
    await w.waitBot((m) => m.text.includes('解冻了'));
  });

  it('/status shows the mandate and what was spent this month', async () => {
    await w.say('/status');
    const st = await w.waitBot((m) => m.text.includes('零花钱'));
    assert.match(strip(st.text), /本月已花 \$28\.00 \/ \$30\.00/);
  });
});
