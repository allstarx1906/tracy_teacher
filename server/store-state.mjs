import { normalizeBaState } from './ba-state.mjs';
import { normalizeExamState } from './exam-state.mjs';

export const STATE_FILE = 'state.json';
export const SQLITE_FILE = 'app.sqlite';
export const IMAGES_DIR = 'images';
export const ATTACHMENTS_DIR = 'attachments';
export const SCHEMA_VERSION = 1;

/** @typedef {{ meta: object, settings: object, teacherAccount: object|null, studentAccounts: object[], sessions: Record<string, object>, classes: object[], students: object[], assignments: object[], submissions: object[], imageMeta: Record<string, object> }} AppState */

export const ARRAY_COLLECTIONS = [
  'classes',
  'students',
  'assignments',
  'submissions',
  'studentAccounts',
  'examImports',
  'examDrafts',
  'examVersions',
  'examAssignments',
  'examAttempts',
  'memberships',
  'parents',
  'parentStudentLinks',
  'classSessions',
  'scheduleTemplates',
  'attendanceStatusCatalog',
  'attendanceRecords',
  'attendanceAudit',
  'sessionHistory',
  'reminderJobs',
  'notificationBatches',
  'notificationAttempts',
  'manualSendEvents',
  'membershipAudit',
];

export const OBJECT_MAP_KEYS = ['sessions', 'imageMeta', 'attachmentMeta', 'operationReplay'];

export const SINGLETON_KEYS = ['meta', 'settings', 'teacherAccount', 'baSettings'];

const RESERVED_TOP_LEVEL = new Set([
  ...ARRAY_COLLECTIONS,
  ...OBJECT_MAP_KEYS,
  ...SINGLETON_KEYS,
]);

export function emptyState() {
  return {
    meta: { version: 1, initialized: false },
    settings: { teacherDisplayName: '' },
    teacherAccount: null,
    studentAccounts: [],
    sessions: {},
    classes: [],
    students: [],
    assignments: [],
    submissions: [],
    imageMeta: {},
    attachmentMeta: {},
    operationReplay: {},
  };
}

export function normalizeState(state) {
  if (!state.attachmentMeta || typeof state.attachmentMeta !== 'object') {
    state.attachmentMeta = {};
  }
  if (!state.operationReplay || typeof state.operationReplay !== 'object') {
    state.operationReplay = {};
  }
  if (!Array.isArray(state.assignments)) state.assignments = [];
  for (const a of state.assignments) {
    if (!Array.isArray(a.attachmentIds)) a.attachmentIds = [];
  }
  normalizeBaState(state);
  normalizeExamState(state);
  return state;
}

/**
 * Split raw parsed JSON into known buckets + extension entries (unknown top-level keys).
 * Does not inject emptyState defaults for keys absent from the file (matches legacy JSON load).
 * @param {Record<string, unknown>} raw
 */
export function partitionRawState(raw) {
  /** @type {Record<string, unknown>} */
  const state = structuredClone(raw);
  /** @type {{ key: string, valueType: string, valueJson: string|null }[]} */
  const extensions = [];

  for (const key of Object.keys(state)) {
    if (RESERVED_TOP_LEVEL.has(key)) continue;
    if (ARRAY_COLLECTIONS.includes(key)) continue;
    if (OBJECT_MAP_KEYS.includes(key)) continue;
    const value = state[key];
    delete state[key];
    extensions.push({
      key,
      valueType: extensionValueType(value),
      valueJson: value === undefined ? null : JSON.stringify(value),
    });
  }

  normalizeState(state);
  return { state, extensions };
}

export function extensionValueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'unknown';
}

export function applyExtensions(state, extensions) {
  for (const row of extensions) {
    if (Object.prototype.hasOwnProperty.call(state, row.key)) continue;
    if (row.valueType === 'null' || row.valueJson === null) {
      state[row.key] = null;
      continue;
    }
    state[row.key] = JSON.parse(row.valueJson);
  }
  return state;
}

export function entityRowId(collection, item, orderIndex) {
  if (item && typeof item === 'object' && typeof item.id === 'string' && item.id.length > 0) {
    return item.id;
  }
  return `${collection}:${orderIndex}`;
}

export function collectExtensionsFromState(state) {
  /** @type {{ key: string, valueType: string, valueJson: string|null }[]} */
  const extensions = [];
  for (const key of Object.keys(state)) {
    if (RESERVED_TOP_LEVEL.has(key)) continue;
    if (ARRAY_COLLECTIONS.includes(key)) continue;
    if (OBJECT_MAP_KEYS.includes(key)) continue;
    const value = state[key];
    extensions.push({
      key,
      valueType: extensionValueType(value),
      valueJson: value === undefined ? null : JSON.stringify(value),
    });
  }
  return extensions;
}

/**
 * Logical deep equality for migration verification (after normalization).
 */
export function statesLogicallyEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const keys = Object.keys(value).sort();
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of keys) out[k] = sortValue(value[k]);
  return out;
}

export function stateEntityCounts(state) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const name of ARRAY_COLLECTIONS) {
    counts[name] = Array.isArray(state[name]) ? state[name].length : 0;
  }
  for (const name of OBJECT_MAP_KEYS) {
    const m = state[name];
    counts[name] = m && typeof m === 'object' ? Object.keys(m).length : 0;
  }
  counts.singletons = SINGLETON_KEYS.length;
  return counts;
}
