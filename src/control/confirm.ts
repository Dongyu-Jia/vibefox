import { execFile } from 'node:child_process';

/**
 * A person at this Mac clicks yes — the one thing a worker (same macOS user, a
 * shell, no hands on the screen) cannot do on its own. Used before a parent
 * session is handed out. VF_CONTROL_CONFIRM=auto is for tests and scripted
 * demos; =deny refuses.
 */
export function parentConfirms(question: string): Promise<boolean> {
  const mode = process.env.VF_CONTROL_CONFIRM;
  if (mode === 'auto') return Promise.resolve(true);
  if (mode === 'deny' || process.platform !== 'darwin') return Promise.resolve(false);
  const q = question.replace(/["\\]/g, '');
  const script = `display dialog "${q}" with title "vibefox" buttons {"不允许", "打开控制台"} default button "打开控制台" cancel button "不允许" with icon caution giving up after 60`;
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 70_000 }, (err, stdout) => {
      resolve(!err && /button returned:打开控制台/.test(stdout) && !/gave up:true/.test(stdout));
    });
  });
}
