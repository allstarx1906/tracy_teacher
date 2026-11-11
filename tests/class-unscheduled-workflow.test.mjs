import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  validateClassInput,
  normalizeClassScheduleForPut,
  findNextUpcomingClassSession,
} from '../dist/model.js';
import {
  attendanceRosterForSession,
  localDateTimeToUtcIso,
  SESSION_STATUS,
} from '../dist/ba-domain.js';
import { startBaTestServer, teacherSetup, api, loadTeacherData } from './ba-test-helpers.mjs';

test('validateClassInput accepts name-only and legacy schedule', () => {
  assert.equal(validateClassInput({ name: 'Lớp mới' }).ok, true);
  assert.equal(validateClassInput({
    name: 'Legacy',
    scheduleDays: ['Thứ 2'],
    scheduleTime: '19:00',
  }).ok, true);
  assert.equal(validateClassInput({ name: '' }).ok, false);
});

test('normalizeClassScheduleForPut preserves omitted schedule on update', () => {
  const prev = { scheduleDays: ['Thứ 3'], scheduleTime: '18:00' };
  const norm = normalizeClassScheduleForPut({ name: 'Renamed' }, prev);
  assert.deepEqual(norm.scheduleDays, ['Thứ 3']);
  assert.equal(norm.scheduleTime, '18:00');
  const fresh = normalizeClassScheduleForPut({ name: 'New' }, null);
  assert.deepEqual(fresh.scheduleDays, []);
  assert.equal(fresh.scheduleTime, '');
});

test('HTTP: create class with name only stores empty legacy schedule', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const classId = randomUUID();
  const put = await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: classId, name: 'Chưa có lịch' },
  });
  assert.equal(put.res.status, 200);
  const data = await loadTeacherData(ctx, jar);
  const row = data.classes.find((c) => c.id === classId);
  assert.ok(row);
  assert.deepEqual(row.scheduleDays, []);
  assert.equal(row.scheduleTime, '');
});

test('HTTP: rename class preserves prior schedule metadata', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const classId = randomUUID();
  await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Old',
      scheduleDays: ['Thứ 5'],
      scheduleTime: '20:00',
    },
  });
  await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: classId, name: 'New name' },
  });
  const data = await loadTeacherData(ctx, jar);
  const row = data.classes.find((c) => c.id === classId);
  assert.equal(row.name, 'New name');
  assert.deepEqual(row.scheduleDays, ['Thứ 5']);
  assert.equal(row.scheduleTime, '20:00');
});

test('workflow: unscheduled class, student, session, attendance roster', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const classId = randomUUID();
  const studentId = randomUUID();
  await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: classId, name: 'Flow lớp' },
  });
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'HS Flow', classId },
  });
  const startAt = localDateTimeToUtcIso('2028-03-15', '19:00');
  const endAt = localDateTimeToUtcIso('2028-03-15', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);
  const data = await loadTeacherData(ctx, jar);
  const session = data.classSessions.find((s) => s.id === adhoc.data.id);
  assert.ok(session);
  const roster = attendanceRosterForSession(data, session);
  assert.equal(roster.length, 1);
  assert.equal(roster[0].studentId, studentId);
});

test('HTTP: adhoc session rejects end before start', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const classId = randomUUID();
  await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: classId, name: 'T' },
  });
  const startAt = localDateTimeToUtcIso('2028-04-01', '20:00');
  const endAt = localDateTimeToUtcIso('2028-04-01', '19:00');
  const bad = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(bad.res.status, 400);
});

test('findNextUpcomingClassSession ignores legacy class fields', () => {
  const classId = 'c1';
  const sessions = [{
    id: 's1',
    classId,
    startAt: '2030-01-01T12:00:00.000Z',
    endAt: '2030-01-01T13:00:00.000Z',
    status: SESSION_STATUS.SCHEDULED,
  }];
  const next = findNextUpcomingClassSession(sessions, classId, '2029-01-01T00:00:00.000Z');
  assert.equal(next?.id, 's1');
  const none = findNextUpcomingClassSession([], classId);
  assert.equal(none, null);
});
