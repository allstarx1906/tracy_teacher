/**
 * Transaction helpers for node:sqlite DatabaseSync (no .transaction API).
 * Uses BEGIN/COMMIT/ROLLBACK; nested callers use SAVEPOINT/RELEASE.
 */

/** @type {WeakMap<object, number>} */
const txDepth = new WeakMap();

function currentDepth(db) {
  return txDepth.get(db) || 0;
}

function setDepth(db, depth) {
  if (depth <= 0) txDepth.delete(db);
  else txDepth.set(db, depth);
}

function rollbackQuiet(db) {
  try {
    db.exec('ROLLBACK;');
  } catch {
    /* ignore */
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {'deferred'|'immediate'} [mode]
 * @param {() => void} fn
 */
export function runSqliteTransaction(db, fn, mode = 'immediate') {
  const depth = currentDepth(db);
  if (depth > 0) {
    const sp = `bn_sp_${depth}_${Math.random().toString(36).slice(2, 10)}`;
    db.exec(`SAVEPOINT ${sp};`);
    setDepth(db, depth + 1);
    try {
      fn();
      db.exec(`RELEASE ${sp};`);
    } catch (e) {
      try {
        db.exec(`ROLLBACK TO ${sp};`);
        db.exec(`RELEASE ${sp};`);
      } catch {
        rollbackQuiet(db);
      }
      throw e;
    } finally {
      setDepth(db, depth);
    }
    return;
  }

  db.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE;' : 'BEGIN;');
  setDepth(db, 1);
  try {
    fn();
    db.exec('COMMIT;');
  } catch (e) {
    rollbackQuiet(db);
    throw e;
  } finally {
    setDepth(db, 0);
  }
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function assertNotInSqliteTransaction(db) {
  if (currentDepth(db) > 0) {
    throw new Error('Unexpected nested SQLite transaction');
  }
}
