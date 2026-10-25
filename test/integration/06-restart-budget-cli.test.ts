import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { DaemonClient } from '../../src/cli/client.ts';
import { PROJECT_ROOT } from '../../src/core/paths.ts';
import { createWorld, strip, type World } from '../helpers/world.ts';

const VF = path.join(PROJECT_ROOT, 'bin', 'vf');

describe('24/7: restarts lose nothing; the brain budget is watched; humans and workers share the CLI and MCP', () => {
  let w: World;
  before(async () => {
    w = await createWorld();
    await w.start();
    await w.bind();
  });
  after(async () => w?.close());

  it('a restart keeps tasks and does not re-process old Telegram messages', async () => {
    await w.say('帮我想一个周末的晚饭菜单');
    await w.waitBot((m) => m.text.startsWith('✅') && m.text.includes('晚饭菜单'), 30_000);
    const before = w.daemon!.store.recentTasks(50).length;
    await w.restart();
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(w.daemon!.store.recentTasks(50).length, before, 'no duplicate tasks after restart');
    await w.say('/tasks');
    const list = await w.waitBot((m) => m.text.includes('最近') || m.text.includes('进行中'));
    assert.match(strip(list.text), /晚饭菜单/);
  });

  it('when the OpenRouter key is nearly spent, it warns the parent once and saves money', async () => {
    w.llm.keyLimit = 1;
    w.llm.usage = 0.9;
    const api = new DaemonClient(w.daemon!.url, w.daemon!.token);
    const r = await api.post<{ mode: string }>('/v1/admin/budget');
    assert.equal(r.mode, 'low');
    const warn = await w.waitBot((m) => m.text.includes('脑子预算只剩'));
    assert.match(strip(warn.text), /\$0\.10/);
    const callsBefore = w.llm.calls.length;
    await w.say('帮我想一句晚安的话');
    await w.waitBot((m) => m.text.startsWith('✅') && m.text.includes('晚安'), 30_000);
    const classify = w.llm.calls.slice(callsBefore).find((c) => c.tag === 'router.classify');
    assert.match(classify!.model, /deepseek/, 'router thinks with the cheap model in low-budget mode');
    const worker = w.llm.calls.slice(callsBefore).find((c) => c.tag === 'worker.step');
    assert.match(worker!.model, /deepseek/, 'work goes to the cheap tier');
  });

  it('`vf` works from a terminal against the running agent', async () => {
    // Async on purpose: the daemon lives in this process, so a sync spawn would deadlock.
    const run = promisify(execFile);
    const env = { ...process.env };
    const status = await run(VF, ['status'], { env, encoding: 'utf8' });
    assert.match(status.stdout, /Fox/);
    assert.match(status.stdout, /零花钱/);
    const ident = await run(VF, ['identity'], { env, encoding: 'utf8' });
    assert.match(ident.stdout, /\[open\] email \(家长给钥匙，自己开\): fox-test@agentmail\.to/);
    const snap = await run(VF, ['browser', 'open', `${w.shop.url}/`], { env, encoding: 'utf8' });
    assert.match(snap.stdout, /Fox Bakery — Menu/);
    assert.match(snap.stdout, /\[e\d+\] link "Order"/);
  });

  it('`vf mcp` exposes the same tools over MCP stdio', async () => {
    const child = spawn(VF, ['mcp'], { env: { ...process.env, VF_API_URL: w.daemon!.url, VF_API_TOKEN: w.daemon!.token }, stdio: ['pipe', 'pipe', 'inherit'] });
    const lines: Record<string, unknown>[] = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
    const waitId = async (id: number) => {
      for (let k = 0; k < 100; k++) {
        const hit = lines.find((l) => l.id === id);
        if (hit) return hit as { result: Record<string, unknown> };
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('no MCP response ' + id);
    };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(((await waitId(1)).result.serverInfo as { name: string }).name, 'vibefox');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = ((await waitId(2)).result.tools as { name: string }[]).map((t) => t.name);
    for (const t of ['browser_open', 'browser_click', 'mail_send', 'sms_send', 'call', 'pay', 'ask', 'report']) assert.ok(tools.includes(t), t);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_open', arguments: { url: `${w.shop.url}/events` } } });
    const call = await waitId(3);
    assert.match((call.result.content as { text: string }[])[0].text, /Kids bread-shaping class/);
    child.kill();
  });
});
