import path from 'node:path';

/** @type {Map<string, { chain: Promise<void> }>} */
const locksByDir = new Map();

export function getStoreLock(dataDir) {
  const key = path.resolve(dataDir);
  let entry = locksByDir.get(key);
  if (!entry) {
    entry = { chain: Promise.resolve() };
    locksByDir.set(key, entry);
  }
  return entry;
}

export function runSerialized(lockEntry, fn) {
  const run = lockEntry.chain.then(fn);
  lockEntry.chain = run.catch(() => undefined);
  return run;
}
