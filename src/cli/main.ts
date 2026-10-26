import fs from 'node:fs';
import path from 'node:path';
import { Body } from '../core/body.ts';
import { agentsDir, currentAgentSlug, setCurrentAgent } from '../core/paths.ts';
import { IDENTITY_KINDS, OPENER_LABEL } from '../identity/registry.ts';
import { TOOLS, toolByName } from '../tools/catalog.ts';
import { DaemonClient } from './client.ts';

/** `vf` — the agent's command line. Workers use the same commands as humans. */

interface Parsed {
  _: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (v !== undefined) out.flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

const HELP = `vf — vibefox, an independent AI agent individual

  vf keys [--only openrouter,telegram] [--check]   type keys once (hidden), checked live, kept in .env.local (gitignored)
  vf init                        birth in the browser: a name, its own email, its own number — the rest comes later in vf ui
  vf init --cli [--step birth|brain|workers|channel|email|phone|money|parent|install] [--answers file.json]   the terminal wizard
  vf ui [resources/add/github]   the control plane in your browser: resources, wallet, Telegram, brain, workers
  vf start [--foreground]        wake the agent (launchd if installed, else foreground)
  vf stop | vf install | vf uninstall | vf status | vf agents | vf use <name>
  vf tasks | vf task <id> | vf logs [api|events] [--n 20] [--service telegram]
  vf identity [--markdown]       identities and who opens them
  vf routing [review] | vf brief

worker tools (inside a task; same as the MCP tools):
  vf ask "question" | vf progress "note" | vf report --status done --summary "…"
  vf browser open <url> | snapshot | click <ref> | type <ref> "text" [--submit] | select <ref> <v> | press <key> | wait ["text"] [--seconds N] | back | screenshot [file]
  vf mail send --to x --subject s --text t | vf mail list | vf mail read <id> | vf mail reply <id> --text t
  vf sms send --to +1… --text t | vf sms list | vf sms codes
  vf call --to +1… --purpose "…"
  vf pay --merchant-name X --merchant-url U --amount <cents> --context "…" [--test]
  vf remember "fact" | vf journal "note"
  vf resources [--catalog] | vf resource get <id> [field] | vf resource otp <id>
  vf resource add <kind> --label "…" [--handle h] [--parent id] [--note n] | vf resource request <kind> --why "…"
  vf parent legal
`;

async function tool(name: string, args: Record<string, unknown>): Promise<void> {
  const t = toolByName(name);
  if (!t) throw new Error(`unknown tool ${name}`);
  const out = await t.run(DaemonClient.fromEnv(), args);
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
}

export async function main(argv: string[]): Promise<void> {
  const { _: pos, flags } = parseArgs(argv);
  const cmd = pos[0];
  const rest = pos.slice(1);

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(HELP);
      return;

    case 'ui': {
      const { openControlPlane } = await import('./ui.ts');
      await openControlPlane(rest[0]);
      return;
    }

    case 'init': {
      if (!flags.cli && !flags.step && !flags.answers) {
        const { runSetupInBrowser, openControlPlane } = await import('./ui.ts');
        const slug = currentAgentSlug();
        const ids = slug && fs.existsSync(path.join(agentsDir(), slug, 'identity.json')) ? Body.open(slug).identity().identities : undefined;
        // Already born (it has its own email and number): the rest happens in the control plane.
        if (ids?.email?.status === 'open' && ids.phone?.status === 'open' && !flags.new) return openControlPlane();
        return runSetupInBrowser();
      }
      const { runWizard, STEPS } = await import('../onboarding/wizard.ts');
      const { TerminalPrompter, ScriptedPrompter } = await import('../onboarding/prompter.ts');
      const answers = flags.answers ? JSON.parse(fs.readFileSync(String(flags.answers), 'utf8')) as Record<string, unknown> : undefined;
      const prompter = answers ? new ScriptedPrompter(answers) : new TerminalPrompter();
      const steps = flags.step ? (String(flags.step).split(',') as (typeof STEPS)[number][]) : undefined;
      try {
        await runWizard({ prompter, steps, configOverrides: answers?.config as never });
      } finally {
        prompter.close();
      }
      return;
    }

    case 'keys': {
      const { runKeys } = await import('./keys.ts');
      await runKeys({ only: flags.only ? String(flags.only).split(',') : undefined, check: Boolean(flags.check) });
      return;
    }

    case 'start': {
      const slug = currentAgentSlug();
      const { status } = await import('../onboarding/launchd.ts');
      if (!flags.foreground && slug && status(slug).installed) {
        const { install } = await import('../onboarding/launchd.ts');
        const r = install(Body.open(slug));
        console.log(r.loaded ? `started via launchd (${r.plist})` : `launchd: ${r.out}`);
        return;
      }
      const { startDaemon } = await import('../daemon/daemon.ts');
      const d = await startDaemon();
      const shutdown = async () => {
        await d.stop();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
      process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
      return;
    }

    case 'stop': {
      const slug = currentAgentSlug();
      const { status, uninstall } = await import('../onboarding/launchd.ts');
      if (slug && status(slug).installed && flags.service) {
        uninstall(slug);
        console.log('launchd service removed');
        return;
      }
      const body = Body.open();
      if (fs.existsSync(body.paths.daemonJson)) {
        const { pid } = JSON.parse(fs.readFileSync(body.paths.daemonJson, 'utf8')) as { pid: number };
        process.kill(pid, 'SIGTERM');
        console.log(`stopped pid ${pid}`);
      } else console.log('not running');
      return;
    }

    case 'install': {
      const { install, STAY_AWAKE_ADVICE } = await import('../onboarding/launchd.ts');
      const r = install(Body.open());
      console.log(`${r.loaded ? 'installed' : 'failed'}: ${r.plist} ${r.out}`);
      console.log(STAY_AWAKE_ADVICE);
      return;
    }

    case 'uninstall': {
      const { uninstall } = await import('../onboarding/launchd.ts');
      uninstall(Body.open().slug);
      console.log('removed');
      return;
    }

    case 'agents': {
      const dir = agentsDir();
      const cur = currentAgentSlug();
      for (const s of fs.existsSync(dir) ? fs.readdirSync(dir) : []) console.log(`${s === cur ? '*' : ' '} ${s}`);
      return;
    }

    case 'use':
      setCurrentAgent(rest[0]);
      console.log(`current agent: ${rest[0]}`);
      return;

    case 'status': {
      const body = Body.open();
      const { status } = await import('../onboarding/launchd.ts');
      const ld = status(body.slug);
      console.log(`${body.identity().name} — ${body.root}`);
      console.log(`launchd: ${ld.installed ? ld.detail : 'not installed'}${ld.pid ? ' pid ' + ld.pid : ''}`);
      try {
        const st = await DaemonClient.fromEnv().get<{ text: string }>('/v1/status');
        console.log(st.text.replace(/<[^>]+>/g, ''));
      } catch (e) {
        console.log(`daemon: ${(e as Error).message}`);
      }
      return;
    }

    case 'tasks': {
      const r = await DaemonClient.fromEnv().get<{ active: { id: string; title: string; status: string; worker_id: string }[]; recent: { id: string; title: string; status: string; worker_id: string }[] }>('/v1/tasks');
      for (const t of r.recent) console.log(`${t.id.padEnd(5)} ${t.status.padEnd(15)} ${String(t.worker_id ?? '').padEnd(24)} ${t.title}`);
      return;
    }

    case 'task': {
      const r = await DaemonClient.fromEnv().get(`/v1/tasks/${rest[0]}`);
      console.log(JSON.stringify(r, null, 2));
      return;
    }

    case 'logs': {
      const body = Body.open();
      const kind = rest[0] ?? 'events';
      const day = String(flags.date ?? new Date().toISOString().slice(0, 10));
      const file = kind === 'api' ? path.join(body.paths.apiLogs, `${day}.jsonl`) : path.join(body.paths.logs, `events-${day}.jsonl`);
      if (!fs.existsSync(file)) return console.log(`no log at ${file}`);
      let lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      if (flags.service) lines = lines.filter((l) => JSON.parse(l).service === flags.service);
      for (const l of lines.slice(-Number(flags.n ?? 20))) console.log(flags.raw ? l : JSON.stringify(JSON.parse(l), null, 2));
      return;
    }

    case 'identity': {
      if (rest[0] === 'open') {
        console.log(JSON.stringify(await DaemonClient.fromEnv().post('/v1/identity/open'), null, 2));
        return;
      }
      if (flags.markdown) {
        process.stdout.write(identityMarkdown());
        return;
      }
      try {
        await tool('identity', {});
      } catch {
        const id = Body.open().identity();
        const mark = (s?: string) => (s === 'open' ? '[open]' : s === 'needs-parent' ? '[help]' : s === 'failed' ? '[fail]' : '[ ]   ');
        for (const k of IDENTITY_KINDS) {
          const r = id.identities[k.id];
          console.log(`${mark(r?.status)} ${k.id.padEnd(20)} ${OPENER_LABEL[k.opener].padEnd(12)} ${r?.value ?? ''}${r?.note ? `  （${r.note}）` : ''}`);
        }
      }
      return;
    }

    case 'routing': {
      if (rest[0] === 'review') {
        const r = await DaemonClient.fromEnv().post<{ routing: string }>('/v1/admin/review');
        console.log(r.routing);
      } else console.log(Body.open().routing());
      return;
    }

    case 'brief':
      await DaemonClient.fromEnv().post('/v1/admin/brief');
      console.log('brief sent');
      return;

    // ---------- worker tools ----------
    case 'ask':
      return tool('ask', { question: rest.join(' ') || flags.question });
    case 'progress':
      return tool('progress', { text: rest.join(' ') || flags.text });
    case 'report':
      return tool('report', { status: flags.status ?? 'done', summary: flags.summary ?? rest.join(' ') });
    case 'resources': {
      if (flags.catalog) {
        const { RESOURCE_KINDS } = await import('../resources/catalog.ts');
        for (const k of RESOURCE_KINDS) console.log(`${k.id.padEnd(14)} ${k.label.padEnd(16)} ${k.human ? `需要人：${k.human}` : '它自己能开'}  ${k.unlocks.slice(0, 2).join('；')}`);
        return;
      }
      return tool('resources', {});
    }
    case 'resource': {
      const [action, a1, a2] = rest;
      if (action === 'get') return tool('resource_get', { id: a1, field: a2 ?? flags.field });
      if (action === 'otp') return tool('resource_otp', { id: a1 });
      if (action === 'add') return tool('resource_add', { kind: a1, label: flags.label ?? a1, handle: flags.handle, parent: flags.parent, note: flags.note });
      if (action === 'request') return tool('resource_request', { kind: a1, why: flags.why ?? rest.slice(2).join(' ') });
      throw new Error('vf resource get|otp|add|request …  (resources are read-only for workers; the parent changes them in vf ui)');
    }
    case 'parent':
      if (rest[0] === 'legal') return tool('parent_legal', {});
      throw new Error('vf parent legal');
    case 'remember':
      return tool('remember', { fact: rest.join(' ') });
    case 'journal':
      return tool('journal', { text: rest.join(' ') });
    case 'browser': {
      const [action, a1, ...more] = rest;
      const map: Record<string, () => Promise<void>> = {
        open: () => tool('browser_open', { url: a1 }),
        snapshot: () => tool('browser_snapshot', {}),
        click: () => tool('browser_click', { ref: a1 }),
        type: () => tool('browser_type', { ref: a1, text: more.join(' ') || flags.text, submit: Boolean(flags.submit) }),
        select: () => tool('browser_select', { ref: a1, value: more.join(' ') || flags.value }),
        press: () => tool('browser_press', { key: a1 }),
        back: () => tool('browser_back', {}),
        wait: () => tool('browser_wait', { text: [a1, ...more].filter(Boolean).join(' ') || undefined, seconds: flags.seconds == null ? undefined : Number(flags.seconds) }),
        screenshot: () => tool('browser_screenshot', { path: a1 }),
        close: async () => console.log(JSON.stringify(await DaemonClient.fromEnv().post('/v1/browser/close'))),
      };
      if (!map[action]) throw new Error(`vf browser ${action}? (open|snapshot|click|type|select|press|wait|back|screenshot|close)`);
      return map[action]();
    }
    case 'mail': {
      const [action, a1] = rest;
      if (action === 'send') return tool('mail_send', { to: flags.to, subject: flags.subject ?? '', text: flags.text ?? '' });
      if (action === 'list') return tool('mail_list', { limit: Number(flags.limit ?? 10) });
      if (action === 'read') return tool('mail_read', { id: a1 });
      if (action === 'reply') return tool('mail_reply', { id: a1, text: flags.text ?? '' });
      throw new Error('vf mail send|list|read|reply');
    }
    case 'sms': {
      const [action] = rest;
      if (action === 'send') return tool('sms_send', { to: flags.to, text: flags.text ?? '' });
      if (action === 'list') return tool('sms_list', {});
      if (action === 'codes') return tool('sms_codes', {});
      throw new Error('vf sms send|list|codes');
    }
    case 'codes':
      return tool('sms_codes', {});
    case 'call':
      return tool('call', { to: flags.to, purpose: flags.purpose ?? rest.join(' ') });
    case 'pay':
      return tool('pay', {
        merchant_name: flags['merchant-name'],
        merchant_url: flags['merchant-url'],
        amount_cents: Number(flags.amount),
        context: flags.context ?? '',
        test: Boolean(flags.test),
      });

    // ---------- internal ----------
    case 'worker': {
      if (rest[0] !== 'run') throw new Error('vf worker run --task <id> --run <id> --model <spec>');
      const { runBuiltinWorker } = await import('../workers/builtinLoop.ts');
      await runBuiltinWorker({ taskId: String(flags.task), runId: String(flags.run), model: String(flags.model) });
      process.exit(0); // don't linger on keep-alive sockets
      return;
    }
    case 'mcp': {
      const { runMcpServer } = await import('../mcp/server.ts');
      await runMcpServer();
      return;
    }
    case 'tools':
      for (const t of TOOLS) console.log(`${t.name.padEnd(20)} ${t.description}`);
      return;
    default:
      throw new Error(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

export function identityMarkdown(): string {
  const lines = ['| 身份 | 类别 | 谁来开 | 提供方 | 给它什么 | 怎么开 / 为什么要人 | 本版本 |', '|---|---|---|---|---|---|---|'];
  for (const k of IDENTITY_KINDS) {
    lines.push(`| ${k.name} \`${k.id}\` | ${k.category} | ${OPENER_LABEL[k.opener]} | ${k.provider ?? '—'} | ${k.gives} | ${k.how}${k.needs?.length ? `（先要：${k.needs.join('、')}）` : ''} | ${k.implemented ? '✅' : '以后'} |`);
  }
  return lines.join('\n') + '\n';
}
