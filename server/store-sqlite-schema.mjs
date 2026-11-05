import {
  SCHEMA_VERSION,
  ARRAY_COLLECTIONS,
  OBJECT_MAP_KEYS,
  SINGLETON_KEYS,
  entityRowId,
  collectExtensionsFromState,
  applyExtensions,
  emptyState,
  normalizeState,
  partitionRawState,
} from './store-state.mjs';
import { runSqliteTransaction } from './store-sqlite-tx.mjs';

/** Read-only views for ad hoc SQL; payloads remain JSON blobs in entity_rows. */
export const ENTITY_READ_VIEWS_DDL = `
CREATE VIEW IF NOT EXISTS v_classes AS
  SELECT entity_id AS id, order_index,
         json_extract(payload_json, '$.name') AS name,
         payload_json
  FROM entity_rows WHERE collection = 'classes';

CREATE VIEW IF NOT EXISTS v_students AS
  SELECT entity_id AS id, order_index,
         json_extract(payload_json, '$.name') AS name,
         json_extract(payload_json, '$.classId') AS class_id,
         payload_json
  FROM entity_rows WHERE collection = 'students';

CREATE VIEW IF NOT EXISTS v_assignments AS
  SELECT entity_id AS id, order_index,
         json_extract(payload_json, '$.classId') AS class_id,
         json_extract(payload_json, '$.title') AS title,
         payload_json
  FROM entity_rows WHERE collection = 'assignments';

CREATE VIEW IF NOT EXISTS v_class_sessions AS
  SELECT entity_id AS id, order_index,
         json_extract(payload_json, '$.classId') AS class_id,
         json_extract(payload_json, '$.startsAt') AS starts_at,
         payload_json
  FROM entity_rows WHERE collection = 'classSessions';

CREATE VIEW IF NOT EXISTS v_attendance_records AS
  SELECT entity_id AS id, order_index,
         json_extract(payload_json, '$.sessionId') AS session_id,
         json_extract(payload_json, '$.studentId') AS student_id,
         json_extract(payload_json, '$.statusId') AS status_id,
         payload_json
  FROM entity_rows WHERE collection = 'attendanceRecords';
`;

export const DDL = `
CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS singletons (
  name TEXT PRIMARY KEY NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_rows (
  collection TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (collection, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_rows_collection_order
  ON entity_rows (collection, order_index);

CREATE TABLE IF NOT EXISTS kv_maps (
  map_name TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (map_name, entry_key)
);

CREATE TABLE IF NOT EXISTS state_extensions (
  ext_key TEXT PRIMARY KEY NOT NULL,
  value_type TEXT NOT NULL,
  value_json TEXT
);
`;

export function readSchemaVersion(db) {
  const row = db.prepare('SELECT value FROM app_metadata WHERE key = ?').get('schemaVersion');
  if (!row) return null;
  return Number(row.value);
}

export function assertSupportedSchema(db) {
  const version = readSchemaVersion(db);
  if (version === null) return;
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported SQLite schema version ${version} (expected ${SCHEMA_VERSION}). ` +
        'Migrate with a newer app release; do not overwrite the database file.',
    );
  }
}

export function initializeFreshSchema(db) {
  db.exec(DDL);
  db.exec(ENTITY_READ_VIEWS_DDL);
  db.prepare('INSERT OR REPLACE INTO app_metadata (key, value) VALUES (?, ?)').run(
    'schemaVersion',
    String(SCHEMA_VERSION),
  );
}

export function loadStateFromDb(db) {
  assertSupportedSchema(db);
  const state = emptyState();

  for (const name of SINGLETON_KEYS) {
    const row = db.prepare('SELECT payload_json FROM singletons WHERE name = ?').get(name);
    if (!row) continue;
    const parsed = JSON.parse(row.payload_json);
    state[name] = parsed;
  }

  for (const collection of ARRAY_COLLECTIONS) {
    const rows = db
      .prepare(
        'SELECT payload_json FROM entity_rows WHERE collection = ? ORDER BY order_index ASC',
      )
      .all(collection);
    state[collection] = rows.map((r) => JSON.parse(r.payload_json));
  }

  for (const mapName of OBJECT_MAP_KEYS) {
    const rows = db.prepare('SELECT entry_key, payload_json FROM kv_maps WHERE map_name = ?').all(mapName);
    /** @type {Record<string, unknown>} */
    const map = {};
    for (const r of rows) map[r.entry_key] = JSON.parse(r.payload_json);
    state[mapName] = map;
  }

  const extRows = db.prepare('SELECT ext_key, value_type, value_json FROM state_extensions').all();
  applyExtensions(
    state,
    extRows.map((r) => ({
      key: r.ext_key,
      valueType: r.value_type,
      valueJson: r.value_json,
    })),
  );

  return normalizeState(state);
}

export function writeStateToDb(db, state, options = {}) {
  assertSupportedSchema(db);
  const normalized = normalizeState(structuredClone(state));
  const extensions = collectExtensionsFromState(normalized);

  const writeBody = () => {
    db.exec('DELETE FROM singletons');
    db.exec('DELETE FROM entity_rows');
    db.exec('DELETE FROM kv_maps');
    db.exec('DELETE FROM state_extensions');

    const insSingleton = db.prepare(
      'INSERT INTO singletons (name, payload_json) VALUES (?, ?)',
    );
    for (const name of SINGLETON_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(normalized, name)) continue;
      const value = normalized[name];
      if (value === undefined) continue;
      insSingleton.run(name, JSON.stringify(value));
    }

    const insEntity = db.prepare(
      'INSERT INTO entity_rows (collection, entity_id, order_index, payload_json) VALUES (?, ?, ?, ?)',
    );
    for (const collection of ARRAY_COLLECTIONS) {
      const list = normalized[collection];
      if (!Array.isArray(list)) continue;
      list.forEach((item, orderIndex) => {
        insEntity.run(collection, entityRowId(collection, item, orderIndex), orderIndex, JSON.stringify(item));
      });
    }

    const insKv = db.prepare(
      'INSERT INTO kv_maps (map_name, entry_key, payload_json) VALUES (?, ?, ?)',
    );
    for (const mapName of OBJECT_MAP_KEYS) {
      const map = normalized[mapName];
      if (!map || typeof map !== 'object') continue;
      for (const [entryKey, value] of Object.entries(map)) {
        insKv.run(mapName, entryKey, JSON.stringify(value));
      }
    }

    const insExt = db.prepare(
      'INSERT INTO state_extensions (ext_key, value_type, value_json) VALUES (?, ?, ?)',
    );
    for (const ext of extensions) {
      insExt.run(ext.key, ext.valueType, ext.valueJson);
    }
  };

  if (options.skipTransaction) {
    writeBody();
    return;
  }
  runSqliteTransaction(db, writeBody);
}

export function importJsonStateToDb(db, rawJson) {
  const { state, extensions } = partitionRawState(rawJson);
  runSqliteTransaction(db, () => {
    writeStateToDb(db, state, { skipTransaction: true });
    if (extensions.length) {
      const insExt = db.prepare(
        'INSERT INTO state_extensions (ext_key, value_type, value_json) VALUES (?, ?, ?)',
      );
      for (const ext of extensions) {
        insExt.run(ext.key, ext.valueType, ext.valueJson);
      }
    }
  });
  return normalizeState(state);
}

export function exportStateJsonFromDb(db) {
  return loadStateFromDb(db);
}
