import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DaemonClient } from '../cli/client.ts';
import { Body } from '../core/body.ts';
import { configureLogs } from '../core/log.ts';
import { openSecrets } from '../core/secrets.ts';
import { resolveModel, type ChatMessage, type ToolCall } from '../llm/index.ts';
import { TOOLS, toolDefs, type ToolSpec } from '../tools/catalog.ts';

/** The builtin harness: a plain tool loop over any chat model. Runs inside `vf worker run`. */

const MAX_STEPS = Number(process.env.VF_MAX_STEPS ?? 40);

function emit(ev: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(ev) + '\n');
}

function runShell(command: string, cwd: string, timeoutSec: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], { cwd, env: process.env });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      out += `\n[killed after ${timeoutSec}s]`;
    }, timeoutSec * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(`exit ${code}\n${out}`.slice(0, 16000));
    });
  });
}

function localTools(workspace: string): ToolSpec[] {
  const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
  return [
    {
      name: 'shell',
      description: 'Run a bash command on your Mac (cwd = your task workspace). The `vf` command is on PATH. Returns exit code + output.',
      parameters: obj({ command: { type: 'string' }, timeout_sec: { type: 'number' } }, ['command']),
      run: async (_c, a) => runShell(String(a.command), workspace, Number(a.timeout_sec ?? 120)),
    },
    {
      name: 'read_file',
      description: 'Read a text file.',
      parameters: obj({ path: { type: 'string' } }, ['path']),
      run: async (_c, a) => fs.readFileSync(path.resolve(workspace, String(a.path)), 'utf8').slice(0, 20000),
    },
    {
      name: 'write_file',
      description: 'Write a text file (creates folders).',
      parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
      run: async (_c, a) => {
        const p = path.resolve(workspace, String(a.path));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(a.content));
        return `wrote ${p}`;
      },
    },
  ];
}

export async function runBuiltinWorker(opts: { taskId: string; runId: string; model: string }): Promise<void> {
  const client = DaemonClient.fromEnv();
  const body = Body.open();
  configureLogs(body.paths.logs);
  const config = body.config();
  const secrets = openSecrets(body.slug, body.paths.secretsFile);
  const model = resolveModel(opts.model, config, secrets);
  const ctx = await client.get<{ systemPrompt: string; prompt: string; workspace: string }>(`/v1/runs/${opts.runId}/context`);

  const specs = [...localTools(ctx.workspace), ...TOOLS];
  const tools = toolDefs(specs);
  const messages: ChatMessage[] = [
    { role: 'system', content: `${ctx.systemPrompt}\n\nIn this harness the same tools are available as function calls (shell, browser_*, mail_*, sms_*, call, pay, ask, progress, report…). Finish by calling report.` },
    { role: 'user', content: ctx.prompt },
  ];
  let cost = 0;
  let nudged = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    const sup = await client.get<{ supplements: string[] }>(`/v1/runs/${opts.runId}/supplements`);
    for (const s of sup.supplements) messages.push({ role: 'user', content: `[The parent added, via the router] ${s}` });

    const res = await model.chat({ messages, tools, tag: 'worker.step', taskId: opts.taskId, maxTokens: 4000 });
    cost += res.usage.costUsd ?? 0;
    emit({ type: 'cost', costUsd: cost });
    messages.push({ role: 'assistant', content: res.content || null, tool_calls: res.toolCalls.length ? res.toolCalls : undefined });

    if (!res.toolCalls.length) {
      if (!nudged) {
        nudged = true;
        messages.push({ role: 'user', content: 'If the task is complete, call the report tool with the full result now. Otherwise keep working with tools.' });
        continue;
      }
      await client.post(`/v1/runs/${opts.runId}/report`, { status: 'done', summary: res.content, costUsd: cost });
      emit({ type: 'final', final: res.content });
      return;
    }

    let reported = false;
    for (const tc of res.toolCalls) {
      const out = await execTool(tc, specs, client, cost);
      emit({ type: 'tool', text: `${tc.function.name} ${tc.function.arguments.slice(0, 160)}` });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out.slice(0, 12000) });
      if (tc.function.name === 'report') reported = true;
    }
    if (reported) {
      emit({ type: 'final', final: 'reported' });
      return;
    }
  }
  await client.post(`/v1/runs/${opts.runId}/report`, { status: 'failed', summary: `Ran out of steps (${MAX_STEPS}) before finishing.`, costUsd: cost });
}

async function execTool(tc: ToolCall, specs: ToolSpec[], client: DaemonClient, cost: number): Promise<string> {
  const spec = specs.find((s) => s.name === tc.function.name);
  if (!spec) return `Unknown tool ${tc.function.name}`;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.function.arguments || '{}');
  } catch {
    return 'Error: arguments were not valid JSON';
  }
  if (spec.name === 'report') args.costUsd = cost;
  try {
    return await spec.run(client, args);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
