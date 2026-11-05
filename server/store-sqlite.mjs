import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  SQLITE_FILE,
  IMAGES_DIR,
  ATTACHMENTS_DIR,
  emptyState,
} from './store-state.mjs';
import { getStoreLock, runSerialized } from './store-lock.mjs';
import {
  initializeFreshSchema,
  loadStateFromDb,
  writeStateToDb,
  assertSupportedSchema,
  ENTITY_READ_VIEWS_DDL,
} from './store-sqlite-schema.mjs';
import { assertNoPartialMigration } from './store-migration-markers.mjs';
import { runSqliteTransaction } from './store-sqlite-tx.mjs';

/** @typedef {import('./store-state.mjs').AppState} AppState */

/** @type {Set<DatabaseSync>} */
const openDatabases = new Set();

/**
 * @param {string} dataDir
 * @param {{ createIfMissing?: boolean }} [options]
 */
export function createSqliteStore(dataDir, options = {}) {
  const resolved = path.resolve(dataDir);
  if (!options.ignorePartialMigrationMarkers) {
    assertNoPartialMigration(resolved);
  }

  fs.mkdirSync(resolved, { recursive: true });
  fs.mkdirSync(path.join(resolved, IMAGES_DIR), { recursive: true });
  fs.mkdirSync(path.join(resolved, ATTACHMENTS_DIR), { recursive: true });

  const dbPath = path.join(resolved, SQLITE_FILE);
  const createIfMissing = options.createIfMissing !== false;
  if (!fs.existsSync(dbPath) && !createIfMissing) {
    throw new Error(`SQLite store not found: ${dbPath}`);
  }

  /** @type {import('node:sqlite').DatabaseSync} */
  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (e) {
    throw new Error(`Cannot open SQLite database at ${dbPath}: ${e?.message || e}`);
  }

  openDatabases.add(db);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = ON;');

    const needsInit =
      !fs.existsSync(dbPath) ||
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_metadata'").get() == null;
    if (needsInit) {
      initializeFreshSchema(db);
    } else {
      assertSupportedSchema(db);
      db.exec(ENTITY_READ_VIEWS_DDL);
    }
  } catch (e) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    openDatabases.delete(db);
    throw e;
  }

  const lock = getStoreLock(resolved);

  function imagePath(id) {
    return path.join(resolved, IMAGES_DIR, `${id}.bin`);
  }

  function attachmentPath(id) {
    return path.join(resolved, ATTACHMENTS_DIR, `${id}.bin`);
  }

  function loadSync() {
    return loadStateFromDb(db);
  }

  function persistSync(state) {
    runSqliteTransaction(db, () => {
      writeStateToDb(db, state, { skipTransaction: true });
    });
  }

  /**
   * @template T
   * @param {(state: AppState) => T | Promise<T>} fn
   */
  async function mutate(fn) {
    return runSerialized(lock, async () => {
      db.exec('BEGIN IMMEDIATE;');
      let state;
      try {
        state = loadStateFromDb(db);
        const result = await fn(state);
        writeStateToDb(db, state, { skipTransaction: true });
        db.exec('COMMIT;');
        return result;
      } catch (e) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          /* ignore */
        }
        throw e;
      }
    });
  }

  async function read() {
    await lock.chain;
    return runSerialized(lock, async () => loadSync());
  }

  function writeImageBuffer(id, buffer) {
    const p = imagePath(id);
    const tmp = `${p}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, p);
  }

  async function saveImage(id, buffer, meta) {
    await lock.chain;
    writeImageBuffer(id, buffer);
    await mutate((state) => {
      state.imageMeta[id] = meta;
    });
  }

  function attachImageInState(state, id, buffer, meta) {
    writeImageBuffer(id, buffer);
    state.imageMeta[id] = meta;
  }

  async function readImage(id) {
    await lock.chain;
    const p = imagePath(id);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  async function deleteImage(id) {
    await mutate((state) => {
      delete state.imageMeta[id];
    });
    const p = imagePath(id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  function writeAttachmentBuffer(id, buffer) {
    const p = attachmentPath(id);
    const tmp = `${p}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, p);
  }

  function attachAttachmentInState(state, id, buffer, meta) {
    writeAttachmentBuffer(id, buffer);
    state.attachmentMeta[id] = meta;
  }

  async function readAttachment(id) {
    await lock.chain;
    const p = attachmentPath(id);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  async function close() {
    await lock.chain;
    if (openDatabases.has(db)) {
      db.close();
      openDatabases.delete(db);
    }
  }

  function getDatabaseHandle() {
    return db;
  }

  return {
    backend: 'sqlite',
    mutate,
    read,
    saveImage,
    attachImageInState,
    readImage,
    deleteImage,
    attachAttachmentInState,
    readAttachment,
    emptyState,
    dataDir: resolved,
    close,
    getDatabaseHandle,
    persistSync,
    loadSync,
  };
}

export function listOpenDatabaseCountForTests() {
  return openDatabases.size;
}

export async function closeAllOpenDatabasesForTests() {
  for (const db of [...openDatabases]) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    openDatabases.delete(db);
  }
}
