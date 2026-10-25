import fs from 'node:fs';
import readline from 'node:readline/promises';

/**
 * Onboarding asks questions through a Prompter: a real terminal, or a
 * scripted answers file (`vf init --answers onboarding.json`) for tests and
 * unattended installs. Every question has a stable id.
 */
export interface Prompter {
  ask(id: string, question: string, def?: string): Promise<string>;
  secret(id: string, question: string): Promise<string>;
  confirm(id: string, question: string, def?: boolean): Promise<boolean>;
  choose(id: string, question: string, options: { value: string; label: string }[], def?: string): Promise<string>;
  say(text: string): void;
  close(): void;
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  orange: (s: string) => `\x1b[38;5;208m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
export const color = C;

export class TerminalPrompter implements Prompter {
  async ask(_id: string, question: string, def?: string): Promise<string> {
    // A fresh interface per question, so secret() can own stdin in raw mode in between.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await rl.question(`${C.orange('?')} ${question}${def ? C.dim(` (${def})`) : ''} `)).trim();
      return a || def || '';
    } finally {
      rl.close();
    }
  }

  async secret(id: string, question: string): Promise<string> {
    const stdin = process.stdin;
    if (!stdin.isTTY) return this.ask(id, question);
    process.stdout.write(`${C.orange('?')} ${question} `);
    return new Promise((resolve) => {
      let buf = '';
      stdin.setRawMode(true);
      stdin.resume();
      const onData = (d: Buffer) => {
        for (const ch of d.toString('utf8')) {
          if (ch === '\r' || ch === '\n') {
            stdin.setRawMode(false);
            stdin.off('data', onData);
            stdin.pause();
            process.stdout.write('\n');
            resolve(buf.trim());
            return;
          }
          if (ch === '\u0003') process.exit(130);
          if (ch === '\u007f' || ch === '\b') {
            if (buf) {
              buf = buf.slice(0, -1);
              process.stdout.write('\b \b');
            }
            continue;
          }
          buf += ch;
          process.stdout.write('•');
        }
      };
      stdin.on('data', onData);
    });
  }

  async confirm(id: string, question: string, def = true): Promise<boolean> {
    const a = (await this.ask(id, `${question} ${C.dim(def ? '[Y/n]' : '[y/N]')}`)).toLowerCase();
    if (!a) return def;
    return ['y', 'yes', '是', '好', 'ok'].includes(a);
  }

  async choose(id: string, question: string, options: { value: string; label: string }[], def?: string): Promise<string> {
    this.say(`${C.orange('?')} ${question}`);
    options.forEach((o, i) => this.say(`  ${C.cyan(String(i + 1))}. ${o.label}`));
    const defIdx = def ? options.findIndex((o) => o.value === def) + 1 : 1;
    const a = await this.ask(id, '选一个', String(defIdx));
    const n = Number(a);
    return options[Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : defIdx - 1].value;
  }

  say(text: string): void {
    process.stdout.write(text + '\n');
  }

  close(): void {
    process.stdin.pause();
  }
}

export class ScriptedPrompter implements Prompter {
  private answers: Record<string, unknown>;
  private quiet: boolean;
  readonly transcript: string[] = [];

  constructor(answers: Record<string, unknown> | string, quiet = false) {
    this.answers = typeof answers === 'string' ? JSON.parse(fs.readFileSync(answers, 'utf8')) : answers;
    this.quiet = quiet;
  }

  private get(id: string): unknown {
    return this.answers[id];
  }

  async ask(id: string, question: string, def?: string): Promise<string> {
    const v = this.get(id);
    const a = v == null ? def ?? '' : String(v);
    this.say(`? ${question} → ${a}`);
    return a;
  }

  async secret(id: string, question: string): Promise<string> {
    const v = this.get(id);
    this.say(`? ${question} → ${v ? '••••••' : '(skip)'}`);
    return v == null ? '' : String(v);
  }

  async confirm(id: string, question: string, def = true): Promise<boolean> {
    const v = this.get(id);
    const a = v == null ? def : v === true || v === 'y' || v === 'yes';
    this.say(`? ${question} → ${a ? 'yes' : 'no'}`);
    return a;
  }

  async choose(id: string, question: string, options: { value: string; label: string }[], def?: string): Promise<string> {
    const v = this.get(id);
    const a = v == null ? def ?? options[0].value : String(v);
    this.say(`? ${question} → ${a}`);
    return a;
  }

  say(text: string): void {
    this.transcript.push(text);
    if (!this.quiet) process.stdout.write(text + '\n');
  }

  close(): void {}
}
