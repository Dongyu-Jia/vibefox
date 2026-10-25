import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Body, HarnessKind, WorkerSpec } from '../core/body.ts';
import { logEvent } from '../core/log.ts';
import { VF_BIN, vfRoot } from '../core/paths.ts';
import type { SecretStore } from '../core/secrets.ts';
import type { Run, Store, Task } from '../core/store.ts';
import { taskPrompt, workerSystemPrompt } from './brief.ts';
import { builtinHarness } from './harness/builtin.ts';
import { claudeCodeHarness } from './harness/claudeCode.ts';
import { cliHarness, codexHarness } from './harness/cli.ts';
import { opencodeHarness } from './harness/opencode.ts';
import { codewhaleHarness, codewhaleModel } from './harness/codewhale.ts';
import { dshHarness, dshTraceEnv, prepareDshHome } from './harness/dsh.ts';
import type { Harness, HarnessExit } from './harness/types.ts';
import { workerEnv } from './harness/types.ts';

const HARNESSES: Record<HarnessKind, Harness> = {
  builtin: builtinHarness,
  'claude-code': claudeCodeHarness,
  opencode: opencodeHarness,
  codewhale: codewhaleHarness,
  dsh: dshHarness,
  codex: codexHarness,
  cli: cliHarness,
};

export interface ManagerDeps {
  body: Body;
  store: Store;
  apiUrl: string;
  apiToken: string;
  timeoutMinutes: number;
  /** Lets external harnesses use the agent's own model keys instead of whatever their global config holds. */
  secrets?: SecretStore;
  onProgress: (runId: string, text: string) => void;
  onExit: (runId: string, exit: HarnessExit, intentional: boolean) => void;
}

export class WorkerManager {
  private deps: ManagerDeps;
  private procs = new Map<string, { child: ChildProcess; done: Promise<HarnessExit>; timer: NodeJS.Timeout }>();
  private stopping = new Set<string>();

  constructor(deps: ManagerDeps) {
    this.deps = deps;
  }

  harness(kind: HarnessKind): Harness {
    return HARNESSES[kind];
  }

  available(spec: WorkerSpec): { ok: boolean; reason?: string } {
    const h = HARNESSES[spec.harness];
    if (!h) return { ok: false, reason: `unknown harness ${spec.harness}` };
    return h.available(spec);
  }

  workspaceFor(task: Task): string {
    return path.join(this.deps.body.paths.workspace, task.id);
  }

  dispatch(task: Task, spec: WorkerSpec, opts: { exploration?: boolean; resumeSession?: string; extraPrompt?: string } = {}): Run {
    const { body, store } = this.deps;
    const harness = HARNESSES[spec.harness];
    const run = store.createRun({ task_id: task.id, worker_id: spec.id, harness: spec.harness, model: spec.model ?? null, exploration: opts.exploration ? 1 : 0 });
    const workspace = this.workspaceFor(task);
    fs.mkdirSync(workspace, { recursive: true });

    const systemPrompt = workerSystemPrompt(body);
    const prompt = opts.resumeSession && opts.extraPrompt ? opts.extraPrompt : taskPrompt(store, store.task(task.id)!, opts.extraPrompt);
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), systemPrompt);
    fs.writeFileSync(path.join(workspace, 'TASK.md'), prompt);

    const vfEnv: Record<string, string> = {
      VF_API_URL: this.deps.apiUrl,
      VF_API_TOKEN: this.deps.apiToken,
      VF_TASK_ID: task.id,
      VF_RUN_ID: run.id,
      VF_HOME: vfRoot(),
      VF_AGENT: body.slug,
      NODE_NO_WARNINGS: '1',
    };
    for (const k of ['VF_SECRETS', 'VF_LLM_TAG_HEADER']) if (process.env[k]) vfEnv[k] = process.env[k]!;
    // Some harnesses (DeepSeek Harness) run shell tools with a scrubbed environment; `vf` finds its run here instead.
    const runFile = path.join(workspace, '.vf-run.json');
    fs.writeFileSync(runFile, JSON.stringify({ url: this.deps.apiUrl, token: this.deps.apiToken, runId: run.id, taskId: task.id, home: vfRoot(), agent: body.slug }), { mode: 0o600 });
    const mcpCommand = [process.execPath, '--disable-warning=ExperimentalWarning', VF_BIN, 'mcp'];
    const mcpConfigPath = path.join(workspace, '.vf-mcp.json');
    fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { vibefox: { command: mcpCommand[0], args: mcpCommand.slice(1), env: vfEnv } } }, null, 2), { mode: 0o600 });
    // Both hold the daemon token; `mode` only applies when a file is created (a retry reuses the workspace).
    for (const f of [runFile, mcpConfigPath]) fs.chmodSync(f, 0o600);
    const harnessEnv: Record<string, string> = {};
    if (spec.harness === 'opencode') {
      const config: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json', mcp: { vibefox: { type: 'local', command: mcpCommand, environment: vfEnv, enabled: true } } };
      // Use the agent's own OpenRouter key (via env, never written to disk), not OpenCode's global one.
      const orKey = spec.model?.startsWith('openrouter/') ? this.deps.secrets?.get('openrouter_api_key') : undefined;
      if (orKey) {
        config.provider = { openrouter: { options: { apiKey: '{env:VF_OPENCODE_OPENROUTER_KEY}' } } };
        harnessEnv.VF_OPENCODE_OPENROUTER_KEY = orKey;
      }
      fs.writeFileSync(path.join(workspace, 'opencode.json'), JSON.stringify(config, null, 2));
    }
    if (spec.harness === 'codewhale' && spec.model) {
      // Codewhale reads provider keys from the environment; hand it the agent's own key.
      const prov = codewhaleModel(spec.model).provider;
      const k = this.deps.secrets?.get(`${prov}_api_key`);
      if (k) harnessEnv[prov === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENROUTER_API_KEY'] = k;
    }
    if (spec.harness === 'dsh' && spec.model) {
      // The official DeepSeek Harness gets its own DSH_HOME inside the agent's body.
      const dshHome = path.join(body.root, 'dsh');
      const { provider, keyEnv } = prepareDshHome(dshHome, spec.model);
      harnessEnv.DSH_HOME = dshHome;
      harnessEnv.DSH_PERMISSION_MODE = 'danger-full-access'; // the Mac is the agent's room
      Object.assign(harnessEnv, dshTraceEnv(body.paths.logs));
      const k = this.deps.secrets?.get(`${provider}_api_key`);
      if (k) harnessEnv[keyEnv] = k;
    }
    const transcriptPath = path.join(workspace, `transcript-${run.id}.jsonl`);
    const env = workerEnv({ ...vfEnv, ...harnessEnv }, spec.env);

    const proc = harness.start({
      task,
      run,
      spec,
      workspace,
      prompt,
      systemPrompt,
      env,
      mcpConfigPath,
      transcriptPath,
      resumeSession: opts.resumeSession,
      onProgress: (text) => this.deps.onProgress(run.id, text),
      onSession: (id) => store.updateRun(run.id, { session_id: id }),
    });
    store.updateRun(run.id, { pid: proc.child.pid ?? null, transcript: transcriptPath });
    store.updateTask(task.id, { status: 'working', worker_id: spec.id, attempts: (store.task(task.id)?.attempts ?? 0) + 1 });
    store.addEvent(task.id, 'dispatched', { runId: run.id, worker: spec.id, harness: spec.harness, model: spec.model, exploration: Boolean(opts.exploration), resume: Boolean(opts.resumeSession) });
    logEvent('worker.dispatched', { taskId: task.id, runId: run.id, worker: spec.id, harness: spec.harness, model: spec.model });

    const timer = setTimeout(() => {
      logEvent('worker.timeout', { runId: run.id });
      proc.child.kill('SIGTERM');
    }, this.deps.timeoutMinutes * 60_000);
    this.procs.set(run.id, { child: proc.child, done: proc.done, timer });

    void proc.done.then((exit) => {
      clearTimeout(timer);
      this.procs.delete(run.id);
      const intentional = this.stopping.delete(run.id);
      const cur = store.run(run.id);
      store.updateRun(run.id, {
        status: cur?.status === 'reported' ? 'reported' : intentional ? 'stopped' : exit.code === 0 ? 'exited' : 'failed',
        ended_at: new Date().toISOString(),
        exit_code: exit.code,
        session_id: exit.sessionId ?? cur?.session_id ?? null,
        cost_usd: Math.max(cur?.cost_usd ?? 0, exit.costUsd ?? 0),
      });
      logEvent('worker.exit', { runId: run.id, code: exit.code, intentional, error: exit.error, costUsd: exit.costUsd });
      this.deps.onExit(run.id, exit, intentional);
    });
    return run;
  }

  isRunning(runId: string): boolean {
    return this.procs.has(runId);
  }

  async stop(runId: string): Promise<HarnessExit | undefined> {
    const p = this.procs.get(runId);
    if (!p) return undefined;
    this.stopping.add(runId);
    p.child.kill('SIGTERM');
    const killer = setTimeout(() => p.child.kill('SIGKILL'), 5000);
    const exit = await p.done;
    clearTimeout(killer);
    return exit;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)));
  }
}
