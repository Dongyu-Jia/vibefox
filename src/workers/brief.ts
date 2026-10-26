import type { Body } from '../core/body.ts';
import { PRINCIPLES, WORKER_ROLE } from '../core/principles.ts';
import type { Store, Task } from '../core/store.ts';
import type { Resource } from '../resources/store.ts';
import { fmtCents } from '../wallet/mandate.ts';

export const TOOLS_REFERENCE = `## Your tools (same for every worker)

Everything is a shell command (\`vf …\`); MCP-capable harnesses also get the same tools via the \`vibefox\` MCP server.
In the shell, put text in single quotes: in "double quotes" bash eats \`$4.25\` and backticks.

Talk to the router (the agent itself):
  vf ask "question"                         blocks until the router answers (it may ask the parent)
  vf progress "short note"                  progress shown to the parent
  vf report --status done --summary "…"     finish (use --status failed --summary "why" if you cannot)

Browser (your own Chromium profile, shared by all workers):
  vf browser open <url>                     open a page; prints a snapshot with [refs]
  vf browser snapshot                       re-read the current page
  vf browser click <ref>                    click an element, e.g. vf browser click e12
  vf browser type <ref> 'text' [--submit]   fill an input (Enter with --submit)
  vf browser select <ref> 'value'           pick an option (value, label, or part of the label)
  vf browser wait 'text' [--seconds 15]     page renders late? wait for the text, then it re-snapshots
  vf browser press <Key> | back | screenshot [file]
  (Read pages from the snapshot text; screenshots are for showing the parent.)

Your resources (read-only for you; only the parent changes or removes them, in the control plane):
  vf resources                              what you have: accounts, tokens, cloud projects… (origin, access, status)
  vf resource get <id> [field]              a credential when a task needs it (audited); prefer the env var if one is set
  vf resource otp <id>                      the current two-step code for an account with a two-step key
  vf resource add <kind> --label "…" --handle "…" --parent <id>   record something you created yourself (a repo, a project…)
  vf resource request <kind> --why "…"      ask the parent for a root only a human can give (signup, money, legal identity)
  vf parent legal                           the parent's registrant details (only where a registration requires them)

Your identities:
  vf mail send --to a@b.com --subject "…" --text "…"     email from your own address
  vf mail list | vf mail read <id> | vf mail reply <id> --text "…"
  vf sms send --to +15551234567 --text "…"  | vf sms list | vf sms codes
  vf call --to +15551234567 --purpose "what to find out"   you call as yourself; prints the transcript
  vf pay --merchant-name "X" --merchant-url https://… --amount <cents> --context "why" [--test]
  vf identity                               your identities and their status

Memory:
  vf remember "fact worth keeping"          vf journal "note for today's journal"

Plain web reading without a browser: use curl from the shell.`;

export function identitySummary(body: Body): string {
  const id = body.identity();
  const lines = [`Name: ${id.name}`, `Parent: ${id.parent.name}`];
  for (const [kind, rec] of Object.entries(id.identities)) {
    if (rec.status === 'open' && rec.value && ['email', 'phone', 'telegram_bot', 'wallet', 'nostr', 'signing_key'].includes(kind)) lines.push(`${kind}: ${rec.value}`);
  }
  const m = body.mandate();
  if (m) lines.push(`Money mandate: up to ${fmtCents(m.monthlyLimitCents, m.currency)}/month, ${fmtCents(m.perTransactionLimitCents, m.currency)} per purchase; never: ${m.blockedCategories.join(', ') || 'nothing'}`);
  return lines.join('\n');
}

function resourcesSummary(resources: Resource[]): string {
  if (!resources.length) return 'None yet. If a task needs an account or a token you do not have, use vf resource request.';
  return resources
    .slice(0, 40)
    .map((r) => `- ${r.id}: ${r.label}${r.handle ? ` (${r.handle})` : ''} · ${r.origin === 'self' ? 'you made it' : 'given by the parent'} · access ${r.access} · ${r.status}${r.method === 'browser' ? ' · already signed in in your browser' : ''}`)
    .join('\n');
}

export function workerSystemPrompt(body: Body, resources: Resource[] = []): string {
  return `${PRINCIPLES}

${WORKER_ROLE}

## Who you are
${identitySummary(body)}

## Your resources
${resourcesSummary(resources)}

## Personality (SOUL.md)
${body.soul().slice(0, 1500)}

${TOOLS_REFERENCE}

Write your final summary in the language the parent uses (see the task). Lead with the result.`;
}

export function taskPrompt(store: Store, task: Task, extra?: string): string {
  const parts = [`# Task ${task.id}: ${task.title}`, '', task.description];
  if (task.requested_worker) {
    parts.push('', `(Routing note: the parent asked for a specific worker — "${task.requested_worker}". The router already handled that: you are that worker. Don't look for or launch another harness; just do the task with your tools.)`);
  }
  const supplements = store.allSupplements(task.id);
  if (supplements.length) {
    parts.push('', '## The parent added later');
    supplements.forEach((s) => parts.push(`- ${s}`));
  }
  const events = store.events(task.id);
  const answers = events.filter((e) => e.type === 'answer');
  if (answers.length) {
    parts.push('', '## Answers you already got');
    for (const a of answers) {
      const q = events.find((e) => e.type === 'question' && e.data.questionId === a.data.questionId);
      parts.push(`- Q: ${String(q?.data.question ?? '')}\n  A: ${String(a.data.answer)}`);
    }
  }
  const info = events.filter((e) => e.type === 'info');
  if (info.length) {
    parts.push('', '## New information related to this task');
    info.slice(-5).forEach((e) => parts.push(`- ${String(e.data.summary ?? '')}`));
  }
  const previous = store.runsForTask(task.id).filter((r) => r.status !== 'running');
  if (previous.length) {
    const lastFail = events.filter((e) => e.type === 'failed' || e.type === 'escalated').pop();
    const lastReport = events.filter((e) => e.type === 'report').pop();
    parts.push('', `## Earlier attempts: ${previous.length}`);
    if (lastReport) parts.push(`Last result: ${String(lastReport.data.summary ?? '').slice(0, 1500)}`);
    if (lastFail) parts.push(`Why it was not good enough: ${String(lastFail.data.reason ?? '')}`);
  }
  if (extra) parts.push('', extra);
  parts.push('', 'When finished, run: vf report --status done --summary "<the complete result for the parent>"');
  return parts.join('\n');
}
