import type { SecretStore } from './secrets.ts';

/**
 * Every read and write vibefox makes to a file the guard protects is announced
 * here, and so is every secret the daemon itself sets — so the guard
 * (src/control/guard.ts) can tell the daemon's own changes from anyone else's,
 * a worker's shell included, and check a file before it is read and rewritten.
 */

type WriteListener = (file: string, content: string) => void;
type ReadListener = (file: string) => void;
type SecretListener = (name: string, value: string | undefined) => void;

const writes = new Set<WriteListener>();
const reads = new Set<ReadListener>();
const secretsSet = new Set<SecretListener>();

export function onWrite(fn: WriteListener): () => void {
  writes.add(fn);
  return () => writes.delete(fn);
}

export function noteWrite(file: string, content: string): void {
  for (const fn of writes) fn(file, content);
}

export function onRead(fn: ReadListener): () => void {
  reads.add(fn);
  return () => reads.delete(fn);
}

/** Called before a protected file is read (and possibly rewritten from what was read). */
export function noteRead(file: string): void {
  for (const fn of reads) fn(file);
}

export function onSecret(fn: SecretListener): () => void {
  secretsSet.add(fn);
  return () => secretsSet.delete(fn);
}

/** The daemon's secret store, announcing its own sets and deletes. */
export function watchSecrets(store: SecretStore): SecretStore {
  return {
    kind: store.kind,
    get: (name) => store.get(name),
    set(name, value) {
      store.set(name, value);
      for (const fn of secretsSet) fn(name, value);
    },
    delete(name) {
      store.delete(name);
      for (const fn of secretsSet) fn(name, undefined);
    },
  };
}
