import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createWorld, strip, type World } from '../helpers/world.ts';

describe('workers talk only to the router; the router answers from memory when it can', () => {
  let w: World;
  before(async () => {
    w = await createWorld({ record: Boolean(process.env.VF_RECORD) });
    await w.start();
    await w.bind();
  });
  after(async () => w?.close());

  it('a worker question reaches the parent only when the router cannot answer it', async () => {
    await w.say(`帮我在 ${w.shop.url} 订一个生日蛋糕，周六取`);
    const q = await w.waitBot((m) => m.text.startsWith('❓'), 30_000);
    assert.match(strip(q.text), /口味/);
    // The parent answers by replying to the question.
    await w.say('抹茶的，8 个人吃', q.message_id);
    const done = await w.waitBot((m) => m.text.startsWith('✅') && /订单号/.test(m.text), 40_000);
    assert.match(strip(done.text), /FB-1001/);
    assert.equal(w.shop.orders.length, 1);
    assert.equal(w.shop.orders[0].item, 'matcha-cake');
    assert.equal(w.shop.orders[0].name, 'Fox (for Dongyu)');
  });

  it('next time, the router answers the same question itself and the parent is not bothered', async () => {
    const questionsBefore = w.tg.botMessages().filter((m) => m.text.startsWith('❓')).length;
    await w.say(`帮我在 ${w.shop.url} 给同事也订一个生日蛋糕`);
    await w.waitBot((m) => m.text.startsWith('✅') && /FB-1002/.test(m.text), 40_000);
    const questionsAfter = w.tg.botMessages().filter((m) => m.text.startsWith('❓')).length;
    assert.equal(questionsAfter, questionsBefore, 'no new question to the parent');
    assert.ok(w.events().some((e) => e.type === 'router.answered.self'), 'router answered itself');
    assert.equal(w.shop.orders.length, 2);
  });

  it('chat is answered directly, without creating a task', async () => {
    const tasksBefore = w.daemon!.store.recentTasks(50).length;
    await w.say('你好');
    await w.waitBot((m) => m.text.includes('在呢'), 10_000);
    assert.equal(w.daemon!.store.recentTasks(50).length, tasksBefore);
  });
});
