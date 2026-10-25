import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openrouterPrice, usageCost, type TokenUsage } from '../../llm/pricing.ts';
import type { Harness, HarnessContext, HarnessExit } from './types.ts';
import { onLines, shorten, which } from './types.ts';

/**
 * DeepSeek Harness (`dsh`, github.com/deepseek-ai/deepseek-harness) — DeepSeek's
 * official open-source agent harness, run headless:
 *   dsh --profile headless --json "<task>"
 * Each agent gets its own DSH_HOME inside its body folder, so the parent's own
 * dsh settings are never touched. Every run also gets the vibefox MCP server
 * (`--patch`), so the browser and the agent's identities are native tools, not
 * only shell commands. Model spec: `openrouter/deepseek/deepseek-v4.1-flash`
 * (OpenRouter as a custom OpenAI-compatible provider) or `deepseek/deepseek-v4-flash`
 * (DeepSeek's official API).
 */

export function dshModel(spec: string): { provider: 'openrouter' | 'deepseek'; model: string } {
  const [first, ...rest] = spec.split('/');
  if (first === 'openrouter' && rest.length) return { provider: 'openrouter', model: rest.join('/') };
  if (first === 'deepseek' && rest.length === 1) return { provider: 'deepseek', model: rest[0] };
  return { provider: 'openrouter', model: spec };
}

/** Writes the per-agent profile overlay; returns the env the harness needs (key names, not values). */
export function prepareDshHome(dshHome: string, spec: string): { provider: 'openrouter' | 'deepseek'; keyEnv: string } {
  const { provider, model } = dshModel(spec);
  const dir = path.join(dshHome, 'profiles', 'headless');
  fs.mkdirSync(dir, { recursive: true });
  const yaml =
    provider === 'openrouter'
      ? `# written by vibefox: OpenRouter as a custom OpenAI-compatible provider
- id: llm-pi-ai
  config:
    providers:
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        api: openai-completions
        baseURL: https://openrouter.ai/api/v1
        models:
          - id: ${model}
- id: agent-default-model
  config:
    provider: openrouter
    model: ${model}
`
      : `# written by vibefox: DeepSeek's official API
- id: agent-default-model
  config:
    provider: deepseek-official
    model: ${model}
`;
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), yaml);
  return { provider, keyEnv: provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'DEEPSEEK_API_KEY' };
}

/**
 * A per-run `--patch` overlay that mounts `vf mcp` through dsh's MCP client. Values
 * are read from the environment (`!!js process.env.X`), so the overlay holds no token.
 */
export function writeDshMcpPatch(mcpConfigPath: string, file: string): void {
  const cfg = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
  const server = cfg.mcpServers.vibefox;
  const q = (v: string) => JSON.stringify(v);
  const yaml = `# written by vibefox for this run: the agent's tools over MCP
- insert:
    - id: mcp-vibefox
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: vibefox
        transport: stdio
        command: ${q(server.command)}
        args: [${server.args.map(q).join(', ')}]
        env:
${Object.keys(server.env)
  .map((k) => `          ${k}: !!js process.env.${k}`)
  .join('\n')}
        # ask waits for the router, which may wait for the parent.
        toolCallTimeoutMs: 900000
`;
  fs.writeFileSync(file, yaml);
}

/**
 * dsh reports a failed model call only as "Connection error.". This preload keeps the
 * real cause (TLS alert, dead HTTP/2 session, …) in VF_FETCH_LOG; no bodies, no header values.
 */
export function dshTraceEnv(logsDir: string): Record<string, string> {
  const preload = `--import=${pathToFileURL(path.join(import.meta.dirname, 'fetch-trace.mjs')).href}`;
  return { NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '), VF_FETCH_LOG: path.join(logsDir, 'fetch-failures.jsonl') };
}

/** The deepest causes of model-call failures since `since`, e.g. "ERR_SSL_… → ERR_HTTP2_INVALID_SESSION ×5". */
export function fetchFailureCauses(file: string | undefined, since: string): string {
  if (!file || !fs.existsSync(file)) return '';
  const codes: string[] = [];
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
    try {
      const e = JSON.parse(line) as { ts: string; chain: { code?: string; message: string }[] };
      if (e.ts < since) continue;
      const deep = e.chain[e.chain.length - 1];
      codes.push(deep?.code ?? deep?.message.slice(0, 60) ?? '?');
    } catch {}
  }
  const runs: string[] = [];
  for (const c of codes) {
    const last = runs[runs.length - 1];
    const m = last && /^(.*?)(?: ×(\d+))?$/.exec(last);
    if (m && m[1] === c) runs[runs.length - 1] = `${c} ×${Number(m[2] ?? 1) + 1}`;
    else runs.push(c);
  }
  return runs.join(' → ');
}

export const dshHarness: Harness = {
  kind: 'dsh',
  liveSupplement: false,
  available(spec) {
    if (!which('dsh')) return { ok: false, reason: 'DeepSeek Harness not installed (npm i -g @deepseek-ai/dsh)' };
    if (!spec.model) return { ok: false, reason: 'dsh worker needs a model like openrouter/deepseek/deepseek-v4.1-flash' };
    return { ok: true };
  },
  start(ctx: HarnessContext) {
    const mcpPatch = path.join(ctx.workspace, '.vf-dsh-mcp.yml');
    writeDshMcpPatch(ctx.mcpConfigPath, mcpPatch);
    const args = ['--profile', 'headless', '--patch', mcpPatch, '--json'];
    if (ctx.resumeSession) args.push('--session-id', ctx.resumeSession);
    // dsh mounts the tools natively (see writeDshMcpPatch); arguments then skip the shell's quoting.
    const native = 'You have the tools below as native tools too: mcp__vibefox__browser_open, …_click, …_type, …_select, …_wait, mcp__vibefox__report and the rest (same names, prefixed). Prefer them over running `vf` in bash.';
    args.push(ctx.resumeSession ? ctx.prompt : `${ctx.systemPrompt}\n\n${native}\n\n---\n\n${ctx.prompt}`);
    const startedAt = new Date().toISOString();
    const child = spawn('dsh', args, { cwd: ctx.workspace, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const transcript = fs.createWriteStream(ctx.transcriptPath, { flags: 'a' });
    const exit: HarnessExit = { code: 1 };
    let text = '';
    let stderr = '';
    // dsh reports tokens per step, not dollars; priced on exit.
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    child.stderr?.on('data', (d) => {
      stderr += d;
      transcript.write(JSON.stringify({ type: 'stderr', text: String(d) }) + '\n');
    });
    onLines(child.stdout, (line) => {
      transcript.write(line + '\n');
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === 'session' && ev.sessionId) {
        exit.sessionId = String(ev.sessionId);
        ctx.onSession(exit.sessionId);
      }
      if (ev.type === 'tool_call') {
        const input = (ev.input ?? {}) as Record<string, unknown>;
        const detail = String(input.command ?? input.url ?? input.path ?? (input.ref ? `${input.ref}${input.text ? ' ← ' + input.text : ''}` : ''));
        ctx.onProgress(`🔧 ${String(ev.tool).replace(/^mcp__vibefox__/, 'vf ')}${detail ? ' · ' + shorten(detail, 80) : ''}`);
      }
      if (ev.type === 'text' && typeof ev.text === 'string') text = ev.text;
      if (ev.type === 'final' && typeof ev.text === 'string') exit.finalText = ev.text;
      if (ev.type === 'error') exit.error = shorten(String(ev.message ?? JSON.stringify(ev)), 600);
      if (ev.type === 'status' && ev.phase === 'step_end' && ev.usage) {
        const u = ev.usage as Partial<TokenUsage>;
        usage.inputTokens += u.inputTokens ?? 0;
        usage.outputTokens += u.outputTokens ?? 0;
        usage.cacheReadTokens += u.cacheReadTokens ?? 0;
      }
      if (ev.type === 'status' && ev.phase === 'turn_end') {
        const reason = (ev.reason ?? {}) as { kind?: string; message?: string; error?: { message?: string; code?: string } };
        const why = [reason.error?.code, reason.error?.message ?? reason.message].filter(Boolean).join(' ');
        if (reason.kind && reason.kind !== 'completed') exit.error = shorten(`turn ended: ${reason.kind}${why ? ' — ' + why : ''}`, 600);
      }
    });
    const done = new Promise<HarnessExit>((resolve) => {
      child.on('error', (err) => resolve({ ...exit, code: 127, error: err.message }));
      child.on('close', async (code) => {
        transcript.end();
        exit.finalText ??= text.trim();
        if (code !== 0 && !exit.error) exit.error = shorten(stderr || `exit ${code}`, 500);
        if (exit.error && /TRANSPORT|Connection error/i.test(exit.error)) {
          const causes = fetchFailureCauses(ctx.env.VF_FETCH_LOG, startedAt);
          if (causes) exit.error = shorten(`${exit.error} (cause: ${causes})`, 600);
        }
        const { provider, model } = dshModel(ctx.spec.model ?? '');
        if (provider === 'openrouter' && usage.inputTokens + usage.outputTokens > 0) {
          const price = await openrouterPrice(model).catch(() => undefined);
          if (price) exit.costUsd = usageCost(usage, price);
        }
        resolve({ ...exit, code: code ?? 1 });
      });
    });
    return { child, done };
  },
};
