import { createHash } from 'node:crypto';

const MAX_ENTRIES = 400;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function hashOperationPayload(payload) {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function ensureReplayStore(state) {
  if (!state.operationReplay || typeof state.operationReplay !== 'object') {
    state.operationReplay = {};
  }
  return state.operationReplay;
}

export function pruneReplayStore(store) {
  const now = Date.now();
  const entries = Object.entries(store);
  for (const [id, entry] of entries) {
    if (!entry?.createdAt || now - Date.parse(entry.createdAt) > MAX_AGE_MS) {
      delete store[id];
    }
  }
  const keys = Object.keys(store);
  if (keys.length <= MAX_ENTRIES) return;
  keys
    .map((id) => ({ id, t: Date.parse(store[id]?.createdAt || 0) }))
    .sort((a, b) => a.t - b.t)
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach(({ id }) => delete store[id]);
}

/**
 * @param {object} state
 * @param {{ role: string, account: { id: string }, studentId?: string }} auth
 * @param {string} action
 * @param {string|undefined|null} operationId
 * @param {object} payloadForHash body without operationId
 */
export function lookupOperationReplay(state, auth, action, operationId, payloadForHash) {
  if (!operationId || typeof operationId !== 'string') {
    return { kind: 'fresh' };
  }
  const store = ensureReplayStore(state);
  const actorKey = auth.role === 'student'
    ? `student:${auth.account.id}:${auth.studentId || ''}`
    : `teacher:${auth.account.id}`;
  const payloadHash = hashOperationPayload(payloadForHash);
  const entry = store[operationId];
  if (!entry) return { kind: 'fresh', actorKey, payloadHash };
  if (entry.actorKey !== actorKey || entry.action !== action) {
    return { kind: 'conflict', error: 'Mã thao tác không hợp lệ hoặc đã dùng cho thao tác khác.' };
  }
  if (entry.payloadHash !== payloadHash) {
    return { kind: 'conflict', error: 'Xung đột thao tác — dữ liệu gửi lên đã thay đổi so với lần trước.' };
  }
  return { kind: 'replay', result: entry.result, actorKey, payloadHash };
}

export function rememberOperationReplay(state, operationId, meta, result) {
  if (!operationId) return;
  const store = ensureReplayStore(state);
  store[operationId] = {
    actorKey: meta.actorKey,
    action: meta.action,
    payloadHash: meta.payloadHash,
    result,
    createdAt: new Date().toISOString(),
  };
  pruneReplayStore(store);
}
