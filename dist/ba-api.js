import { apiFetch } from './api-client.js';

/** Omit null, undefined, and empty string; keep 0 and false. */
export function serializeBaQuery(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export async function baPutParent(body) {
  return apiFetch('/api/teacher/ba/parents', { method: 'PUT', body });
}

export async function baPutParentLink(body) {
  return apiFetch('/api/teacher/ba/parent-links', { method: 'PUT', body });
}

export async function baPutMembership(body) {
  return apiFetch('/api/teacher/ba/memberships', { method: 'PUT', body });
}

export async function baPutClassMeta(body) {
  return apiFetch('/api/teacher/ba/classes/meta', { method: 'PUT', body });
}

export async function baPreviewSchedule(body) {
  return apiFetch('/api/teacher/ba/schedule/preview', { method: 'POST', body });
}

export async function baApplySchedule(body) {
  return apiFetch('/api/teacher/ba/schedule/apply', { method: 'POST', body });
}

export async function baAdhocSession(body) {
  return apiFetch('/api/teacher/ba/sessions/adhoc', { method: 'PUT', body });
}

export async function baSessionAction(sessionId, action, body) {
  return apiFetch(`/api/teacher/ba/sessions/${encodeURIComponent(sessionId)}/${action}`, {
    method: 'POST',
    body,
  });
}

export async function baPutAttendanceRecord(body) {
  return apiFetch('/api/teacher/ba/attendance/record', { method: 'PUT', body });
}

export async function baPutAttendanceCatalog(body) {
  return apiFetch('/api/teacher/ba/attendance/catalog', { method: 'PUT', body });
}

export async function baAttendanceReport(query) {
  const qs = serializeBaQuery(query);
  return apiFetch(qs ? `/api/teacher/ba/reports/attendance?${qs}` : '/api/teacher/ba/reports/attendance');
}

export async function baNotifyPreview(body) {
  return apiFetch('/api/teacher/ba/notifications/preview', { method: 'POST', body });
}

export async function baNotifySendMock(body) {
  return apiFetch('/api/teacher/ba/notifications/send-mock', { method: 'POST', body });
}

export async function baNotifyRetry(body) {
  return apiFetch('/api/teacher/ba/notifications/retry', { method: 'POST', body });
}

export async function baManualConfirm(body) {
  return apiFetch('/api/teacher/ba/manual-send/confirm', { method: 'POST', body });
}

export async function baReminderTick(body = {}) {
  return apiFetch('/api/teacher/ba/reminders/tick', { method: 'POST', body });
}
