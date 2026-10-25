import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Body } from '../core/body.ts';
import { VF_BIN, vfRoot } from '../core/paths.ts';

/** Keep the agent alive 24/7: a per-user LaunchAgent with KeepAlive. */

export function label(slug: string): string {
  return `ai.vibefox.${slug}`;
}

export function plistPath(slug: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label(slug)}.plist`);
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plist(body: Body): string {
  const slug = body.slug;
  const pathEnv = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const args = [process.execPath, '--disable-warning=ExperimentalWarning', VF_BIN, 'start', '--foreground'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(slug)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VF_HOME</key><string>${xml(vfRoot())}</string>
    <key>VF_AGENT</key><string>${xml(slug)}</string>
    <key>PATH</key><string>${xml(pathEnv)}</string>
    <key>NODE_NO_WARNINGS</key><string>1</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(body.root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(path.join(body.paths.logs, 'daemon.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(body.paths.logs, 'daemon.err.log'))}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]): { status: number; out: string } {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, out: (r.stdout + r.stderr).trim() };
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;

export function install(body: Body): { plist: string; loaded: boolean; out: string } {
  const file = plistPath(body.slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist(body));
  launchctl(['bootout', `${domain()}/${label(body.slug)}`]);
  const boot = launchctl(['bootstrap', domain(), file]);
  launchctl(['kickstart', '-k', `${domain()}/${label(body.slug)}`]);
  return { plist: file, loaded: boot.status === 0, out: boot.out };
}

export function uninstall(slug: string): boolean {
  launchctl(['bootout', `${domain()}/${label(slug)}`]);
  const file = plistPath(slug);
  if (fs.existsSync(file)) fs.rmSync(file);
  return true;
}

export function status(slug: string): { installed: boolean; running: boolean; pid?: number; detail: string } {
  const installed = fs.existsSync(plistPath(slug));
  const r = launchctl(['print', `${domain()}/${label(slug)}`]);
  const pid = /pid = (\d+)/.exec(r.out)?.[1];
  const state = /state = (\w+)/.exec(r.out)?.[1] ?? (r.status === 0 ? 'loaded' : 'not loaded');
  return { installed, running: state === 'running', pid: pid ? Number(pid) : undefined, detail: state };
}

export const STAY_AWAKE_ADVICE = `为了 24 小时在线，建议在"系统设置 → 能源"里打开"断电后自动启动"，并关闭自动睡眠；
或者在终端运行（需要管理员密码）：sudo pmset -a sleep 0 autorestart 1`;
