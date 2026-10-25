import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createWorld, strip, type World } from '../helpers/world.ts';

describe('birth → bind → first task → supplement → feedback', () => {
  let w: World;
  before(async () => {
    w = await createWorld();
    await w.start();
  });
  after(async () => w?.close());

  it('onboarding gave the agent its own identities', () => {
    const id = JSON.parse(fs.readFileSync(path.join(w.home, 'agents/fox/identity.json'), 'utf8'));
    assert.equal(id.name, 'Fox');
    assert.equal(id.identities.email.status, 'open');
    assert.equal(id.identities.email.value, 'fox-test@agentmail.to');
    assert.equal(id.identities.email.openedBy, 'self');
    assert.match(id.identities.phone.value, /^\+1415/);
    assert.equal(id.identities.telegram_bot.value, '@fox_vibefox_bot');
    assert.equal(id.identities.wallet.status, 'open');
    assert.equal(id.identities.brain_openrouter.status, 'open');
    for (const self of ['signing_key', 'ssh_key', 'nostr', 'avatar', 'agent_card', 'homepage', 'browser_profile']) {
      assert.equal(id.identities[self].status, 'open', self);
      assert.equal(id.identities[self].openedBy, 'self', self);
    }
    assert.match(id.identities.nostr.value, /^npub1/);
    const mandate = JSON.parse(fs.readFileSync(path.join(w.home, 'agents/fox/mandate.json'), 'utf8'));
    assert.equal(mandate.monthlyLimitCents, 3000);
    assert.equal(mandate.perTransactionLimitCents, 1500);
    assert.ok(mandate.agentSignature, 'agent signed its mandate');
    assert.deepEqual(mandate.blockedCategories, ['gift_cards', 'money_transfer', 'crypto', 'gambling']);
    // the OpenRouter key came through OAuth PKCE
    const oauth = w.apiLog().find((e) => String(e.url).endsWith('/auth/keys'));
    assert.ok(oauth, 'PKCE exchange logged');
    assert.equal((oauth!.response as { body: { key: string } }).body.key, '[REDACTED]');
  });

  it('only the parent with the bind code can claim it', async () => {
    w.tg.strangerSays('/start wrong-code');
    await w.bind();
    const id = JSON.parse(fs.readFileSync(path.join(w.home, 'agents/fox/identity.json'), 'utf8'));
    assert.equal(id.parent.telegram.userId, 777001);
  });

  it('a task from the parent is routed, done in the browser and reported', async () => {
    const before = w.tg.botMessages().length;
    const ask = await w.say(`帮我查一下 ${w.shop.url} 这周末适合带小孩的活动`);
    const result = await w.waitBot((m) => m.text.startsWith('✅') && m.text.includes('适合带小孩'), 30_000);
    assert.ok(w.tg.botMessages().length > before);
    assert.match(strip(result.text), /Kids bread-shaping class/);
    assert.match(strip(result.text), /Cupcake decorating/);
    assert.doesNotMatch(strip(result.text), /Sourdough starter workshop/);
    assert.ok(result.buttons?.flat().some((b) => b.text.includes('很好')));
    const status = w.tg.botMessages().find((m) => m.reply_to === ask.message_id);
    assert.ok(status, 'status message replies to the request');
    assert.match(strip(status!.text), /#t1/);
  });

  it('a reply to the result is a supplement to the same task', async () => {
    const result = w.tg.botMessages().filter((m) => m.text.startsWith('✅')).pop()!;
    await w.say('再加上预算', result.message_id);
    const updated = await w.waitBot((m) => m.text.startsWith('✅') && m.text.includes('预算'), 30_000);
    assert.match(strip(updated.text), /#t1/);
    const tasks = w.daemon!.store.recentTasks(10);
    assert.equal(tasks.length, 1, 'still one task');
  });

  it('feedback buttons are recorded as outcomes', async () => {
    const result = w.tg.botMessages().filter((m) => m.text.startsWith('✅')).pop()!;
    w.tg.parentClicks(result.message_id, '很好');
    await new Promise((r) => setTimeout(r, 800));
    const outcomes = w.daemon!.store.outcomes();
    assert.ok(outcomes.some((o) => o.feedback === 'good' && o.success === 1));
    assert.ok(w.tg.callbacksAnswered.some((c) => c.text?.includes('记下了')));
  });

  it('every outside call is in the API log with secrets redacted', () => {
    const log = w.apiLog();
    const services = new Set(log.map((e) => e.service));
    for (const s of ['telegram', 'agentmail', 'agentphone', 'openrouter', 'link-cli']) assert.ok(services.has(s), `api log has ${s}`);
    const text = JSON.stringify(log);
    assert.ok(!text.includes(w.tg.token), 'telegram token redacted');
    assert.ok(!text.includes(w.mail.key), 'agentmail key redacted');
    assert.ok(!text.includes(w.llm.key), 'openrouter key redacted');
  });
});
