import fs from 'node:fs';
import path from 'node:path';
import { STATE_FILE, SQLITE_FILE } from './store-state.mjs';
import { createJsonStore } from './store-json.mjs';
import { createSqliteStore } from './store-sqlite.mjs';

export { createJsonStore, createSqliteStore };
export { emptyState, normalizeState, statesLogicallyEqual, stableStringify, stateEntityCounts } from './store-state.mjs';

const LEGACY_JSON_MESSAGE =
  'Phát hiện state.json (JSON legacy) nhưng chưa có app.sqlite. ' +
  'Dừng mọi tiến trình ghi dữ liệu, chạy offline: ' +
  'node tools/migrate-json-to-sqlite.mjs --source <thư-mục-cũ> --destination <thư-mục-mới-trống>. ' +
  'Hoặc tạm thời STORE_BACKEND=json / backend:"json" (chỉ rollback, không khuyến nghị production).';

/**
 * @param {string} dataDir
 * @param {{ backend?: 'sqlite'|'json'|'auto' }} [options]
 */
export function createStore(dataDir, options = {}) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('createStore requires dataDir');
  }

  const resolved = path.resolve(dataDir);
  const jsonPath = path.join(resolved, STATE_FILE);
  const sqlitePath = path.join(resolved, SQLITE_FILE);

  const envBackend = process.env.STORE_BACKEND;
  let backend = options.backend || envBackend || 'auto';

  if (backend === 'auto') {
    if (fs.existsSync(sqlitePath)) {
      backend = 'sqlite';
    } else if (fs.existsSync(jsonPath)) {
      throw new Error(LEGACY_JSON_MESSAGE);
    } else {
      backend = 'sqlite';
    }
  }

  if (backend === 'json') {
    return createJsonStore(resolved);
  }

  if (backend === 'sqlite') {
    if (fs.existsSync(jsonPath) && !fs.existsSync(sqlitePath)) {
      throw new Error(LEGACY_JSON_MESSAGE);
    }
    try {
      return createSqliteStore(resolved);
    } catch (e) {
      const msg = e?.message || String(e);
      if (msg.includes('Unsupported SQLite schema')) throw e;
      if (fs.existsSync(sqlitePath)) {
        throw new Error(`SQLite store corrupt or unreadable at ${sqlitePath}: ${msg}`);
      }
      throw e;
    }
  }

  throw new Error(`Unknown store backend: ${backend}`);
}
