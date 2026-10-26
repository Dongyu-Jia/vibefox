/**
 * Every write vibefox makes to a file the guard protects is announced here, so
 * the guard (src/control/guard.ts) can tell the daemon's own writes from
 * anyone else's — a worker's shell included.
 */

type Listener = (file: string, content: string) => void;

const listeners = new Set<Listener>();

export function onWrite(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function noteWrite(file: string, content: string): void {
  for (const fn of listeners) fn(file, content);
}
