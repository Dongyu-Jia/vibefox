import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createWorld, strip, waitFor, type World } from '../helpers/world.ts';

describe('generic workers (harness × model), escalation and self-maintained routing rules', () => {
  let w: World;
  before(async () => {
    w = await createWorld({ workers: 'all' });
    await w.start();
    await w.bind();
  });
  after(async () => w?.close());

  it('onboarding detected every harness on this Mac', () => {
    const workers = w.daemon!.body.workers();
    const ids = workers.map((x) => x.id);
    assert.deepEqual(ids.sort(), ['builtin-openrouter-cheap', 'builtin-openrouter-mid', 'claude-code', 'codewhale-deepseek', 'deepseek-harness', 'opencode-deepseek'].sort());
    for (const spec of workers) assert.ok(w.daemon!.manager.available(spec).ok, `${spec.id} available`);
  });

  it('the parent can name a worker: Claude Code drives the browser through `vf`', async () => {
    await w.say(`用 claude code 在 ${w.shop.url} 下单 6 个可颂`);
    const done = await w.waitBot((m) => m.text.startsWith('✅') && m.text.includes('Claude Code 下好单了'), 40_000);
    assert.match(strip(done.text), /FB-1001/);
    assert.equal(w.shop.orders[0].item, 'croissant');
    assert.equal(w.shop.orders[0].quantity, 6);
    const task = w.daemon!.store.recentTasks(1)[0];
    assert.equal(task.worker_id, 'claude-code');
    const run = w.daemon!.store.runsForTask(task.id)[0];
    assert.equal(run.harness, 'claude-code');
    assert.ok(run.session_id?.startsWith('fake-session'));
    const transcript = fs.readFileSync(run.transcript!, 'utf8');
    assert.match(transcript, /vf browser click/);
  });

  it('OpenCode works the same way (MCP config + vf on PATH)', async () => {
    await w.say(`用 opencode 查一下 ${w.shop.url} 周末的儿童活动`);
    const done = await w.waitBot((m) => m.text.startsWith('✅') && m.text.includes('OpenCode'), 40_000);
    assert.match(strip(done.text), /3 个适合孩子的活动/);
    const ws = path.join(w.home, 'agents/fox/workspace', w.daemon!.store.recentTasks(1)[0].id);
    const cfg = JSON.parse(fs.readFileSync(path.join(ws, 'opencode.json'), 'utf8'));
    assert.ok(cfg.mcp.vibefox.command.includes('mcp'));
    assert.ok(fs.existsSync(path.join(ws, 'AGENTS.md')));
  });

  it('the official DeepSeek Harness (dsh) runs headless on OpenRouter from its own DSH_HOME and drives the browser', async () => {
    await w.say(`用 deepseek harness 看看 ${w.shop.url} 这周末有什么免费活动`);
    const done = await w.waitBot((m) => m.text.startsWith('✅') && m.text.includes('DeepSeek Harness'), 40_000);
    assert.match(strip(done.text), /deepseek\/deepseek-v4\.1-flash/);
    assert.match(strip(done.text), /2 个免费活动/);
    const task = w.daemon!.store.recentTasks(1)[0];
    assert.equal(task.worker_id, 'deepseek-harness');
    const run = w.daemon!.store.runsForTask(task.id)[0];
    assert.equal(run.harness, 'dsh');
    assert.ok(run.session_id?.startsWith('session-fake-'));
    // dsh reports tokens only; priced from OpenRouter's model list: 8940 in, 675 out, 8448 cache read.
    const priced = await waitFor(() => w.daemon!.store.run(run.id)?.cost_usd || undefined, 5000);
    assert.ok(Math.abs(priced - (8940 * 2e-8 + 675 * 1e-6 + 8448 * 1.5e-8)) < 1e-9, `dsh cost ${priced}`);
    const patch = fs.readFileSync(path.join(w.home, 'agents/fox/dsh/profiles/headless/cordis.patch.yml'), 'utf8');
    assert.match(patch, /baseURL: https:\/\/openrouter\.ai\/api\/v1/);
    assert.doesNotMatch(patch, /sk-or-v1/, 'no key written to disk');
    // Each run mounts the agent's tools natively through dsh's MCP client; the run token stays in env.
    const mcp = fs.readFileSync(path.join(w.home, 'agents/fox/workspace', task.id, '.vf-dsh-mcp.yml'), 'utf8');
    assert.match(mcp, /name: '@deepseek-ai\/dsh-mcp-client'/);
    assert.match(mcp, /VF_API_TOKEN: !!js process\.env\.VF_API_TOKEN/);
    assert.ok(!mcp.includes(w.daemon!.token), 'run token not written to disk');
  });

  it('a dropped connection to the model resumes the same dsh session instead of failing the task', async () => {
    await w.say('用 deepseek harness 跑一个 FLAKY 测试');
    const done = await w.waitBot((m) => m.text.startsWith('✅') && m.text.includes('续上了'), 40_000);
    const task = w.daemon!.store.recentTasks(1)[0];
    const runs = w.daemon!.store.runsForTask(task.id);
    assert.deepEqual(runs.map((r) => r.worker_id), ['deepseek-harness', 'deepseek-harness'], 'same worker, not escalated');
    assert.match(strip(done.text), new RegExp(`会话 ${runs[0].session_id} 做完了`), 'resumed the first run’s session');
    const resumed = w.daemon!.store.events(task.id).find((e) => e.type === 'resumed');
    assert.match(String(resumed?.data.reason), /TRANSPORT Connection error\. \(cause: ERR_SSL_SSL\/TLS_ALERT_BAD_RECORD_MAC → ERR_HTTP2_INVALID_SESSION ×2\)/);
  });

  it('Codewhale (the DeepSeek harness) runs on OpenRouter with the agent’s own key and drives the browser', async () => {
    await w.say(`用 codewhale 看看 ${w.shop.url} 的菜单`);
    const done = await w.waitBot((m) => m.text.startsWith('✅') && m.text.includes('Codewhale'), 40_000);
    assert.match(strip(done.text), /deepseek-v4\.1-flash via openrouter/);
    assert.match(strip(done.text), /一共 4 样东西/);
    const task = w.daemon!.store.recentTasks(1)[0];
    assert.equal(task.worker_id, 'codewhale-deepseek');
    // Codewhale emits its session id at the very end, after the report.
    let run = w.daemon!.store.runsForTask(task.id)[0];
    for (let i = 0; i < 30 && !run.session_id; i++) {
      await new Promise((r) => setTimeout(r, 100));
      run = w.daemon!.store.runsForTask(task.id)[0];
    }
    assert.equal(run.harness, 'codewhale');
    assert.ok(run.session_id?.startsWith('cw-fake-'));
  });

  it('when the cheap worker fails, the router escalates to the next tier', async () => {
    // Force the cheap tier first via a parent rule, then give it a hard task.
    const routing = w.daemon!.body.routing().replace('- （还没有。家长可以直接在这里加，比如：写代码、改代码 → claude-code）', '- research 类任务 → builtin-openrouter-cheap');
    w.daemon!.body.saveRouting(routing, 'test: parent rule');
    w.llm.handlers['router.route'] = (req) => {
      const { workers } = JSON.parse(req.messages.filter((m) => m.role === 'user').pop()!.content!);
      const cheap = workers.find((x: { id: string }) => x.id === 'builtin-openrouter-cheap');
      return { content: JSON.stringify({ workerId: cheap.id, reason: '家长定的：research 用便宜档', ruleSource: 'parent' }) };
    };
    await w.say('帮我想想这个很难的研究问题');
    const done = await w.waitBot((m) => m.text.startsWith('✅') && m.text.includes('很难的研究'), 40_000);
    assert.ok(done);
    const task = w.daemon!.store.recentTasks(1)[0];
    const runs = w.daemon!.store.runsForTask(task.id);
    assert.deepEqual(runs.map((r) => r.worker_id), ['builtin-openrouter-cheap', 'builtin-openrouter-mid']);
    assert.ok(w.daemon!.store.events(task.id).some((e) => e.type === 'escalated'));
    const outcomes = w.daemon!.store.outcomes().filter((o) => o.task_id === task.id);
    assert.deepEqual(outcomes.map((o) => o.success), [0, 1]);
    delete w.llm.handlers['router.route'];
    w.llm.handlers['router.route'] = (await import('../mocks/llmMock.ts')).DEFAULT_HANDLERS['router.route'];
  });

  it('weekly review: the router learns a rule from outcomes, tells the parent, and the parent can revert it', async () => {
    const store = w.daemon!.store;
    for (let i = 0; i < 3; i++) {
      store.addOutcome({ task_id: `seed${i}`, run_id: `seedrun${i}`, kind: 'data', worker_id: 'builtin-openrouter-cheap', tier: 1, success: 1, feedback: 'good', cost_usd: 0.0002, duration_ms: 1000, exploration: 0 });
    }
    const res = await w.daemon!.router.weeklyReview(true);
    void res;
    const note = await w.waitBot((m) => m.text.includes('我调整了派活规则'), 10_000);
    assert.match(strip(note.text), /data 类任务 → builtin-openrouter-cheap/);
    const routing = w.daemon!.body.routing();
    assert.match(routing, /## 我学到的[\s\S]*data 类任务 → builtin-openrouter-cheap（最近 3 次成功 3 次/);
    assert.match(routing, /research 类任务 → builtin-openrouter-cheap/, 'parent rule untouched');
    w.tg.parentClicks(note.message_id, '不要');
    await w.waitBot((m) => m.text.includes('撤回了'), 10_000);
    assert.doesNotMatch(w.daemon!.body.routing(), /data 类任务 → builtin-openrouter-cheap/);
  });

  it('“换更强的” re-runs the task on a higher tier and records the feedback', async () => {
    await w.say('帮我写一句给同事的生日祝福');
    const done = await w.waitBot((m) => m.text.startsWith('✅') && m.text.includes('生日祝福'), 30_000);
    w.tg.parentClicks(done.message_id, '换更强的');
    await w.waitBot((m) => m.text.includes('家长要求换更强的'), 10_000);
    const task = w.daemon!.store.recentTasks(1)[0];
    await new Promise((r) => setTimeout(r, 4000));
    const runs = w.daemon!.store.runsForTask(task.id);
    assert.equal(runs[runs.length - 1].worker_id, 'claude-code');
    assert.ok(w.daemon!.store.outcomes().some((o) => o.task_id === task.id && o.feedback === 'too-weak'));
  });
});
