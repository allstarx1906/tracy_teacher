import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAttendanceCatalog, SESSION_STATUS, localDateTimeToUtcIso } from '../dist/ba-domain.js';
import { tryRenderBaView, parseBaRoute } from '../dist/ba-ui.js';
import { registerDirtyProbe } from '../dist/ux-forms.js';
import {
  installBaDomEnvironment,
  findDomNodes,
  aggregateDomTextContent,
  domClassIncludes,
} from './helper-browser-window.mjs';

test('parseBaRoute includes tutor attendance session route', () => {
  assert.deepEqual(parseBaRoute(['tutor', 'attendance', 'sess-1']), {
    view: 'tutor-attendance',
    sessionId: 'sess-1',
  });
});

test('schedule view prioritizes attendance actions on session rows', (t) => {
  installBaDomEnvironment(t, { confirm: () => true });
  const root = document.getElementById('app-root');
  const sessionId = 'sess-a';
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
    state: {
      data: {
        classes: [{ id: 'c1', name: 'Lớp thử' }],
        students: [],
        classSessions: [{
          id: sessionId,
          classId: 'c1',
          startAt: localDateTimeToUtcIso('2026-06-01', '19:00'),
          endAt: localDateTimeToUtcIso('2026-06-01', '20:00'),
          status: SESSION_STATUS.SCHEDULED,
        }],
        memberships: [],
        parents: [],
        parentStudentLinks: [],
        attendanceStatusCatalog: defaultAttendanceCatalog(),
      },
    },
  };
  assert.equal(tryRenderBaView(ctx, { view: 'tutor-schedule', classId: 'c1' }), true);
  const text = aggregateDomTextContent(root);
  assert.ok(text.includes('Điểm danh lớp học'));
  assert.ok(text.includes('Thiết lập lớp & lịch học'));
  const attBtns = findDomNodes(
    root,
    (n) => n.tagName === 'BUTTON' && aggregateDomTextContent(n) === 'Điểm danh',
  );
  assert.equal(attBtns.length, 1);
  registerDirtyProbe(null);
});

test('schedule session rows resolve class name from session classId', (t) => {
  installBaDomEnvironment(t, { confirm: () => true });
  const root = document.getElementById('app-root');
  const baseSessions = [
    {
      id: 'sess-c1',
      classId: 'c1',
      startAt: localDateTimeToUtcIso('2026-06-10', '19:00'),
      endAt: localDateTimeToUtcIso('2026-06-10', '20:00'),
      status: SESSION_STATUS.SCHEDULED,
    },
    {
      id: 'sess-c2',
      classId: 'c2',
      startAt: localDateTimeToUtcIso('2026-06-11', '19:00'),
      endAt: localDateTimeToUtcIso('2026-06-11', '20:00'),
      status: SESSION_STATUS.SCHEDULED,
    },
  ];
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
    state: {
      data: {
        classes: [
          { id: 'c1', name: 'Lớp Alpha' },
          { id: 'c2', name: 'Lớp Beta' },
        ],
        students: [],
        classSessions: baseSessions,
        memberships: [],
        parents: [],
        parentStudentLinks: [],
        attendanceStatusCatalog: defaultAttendanceCatalog(),
      },
    },
  };
  assert.equal(tryRenderBaView(ctx, { view: 'tutor-schedule', classId: null }), true);
  const unfilteredClassLabels = findDomNodes(
    root,
    (n) => n.tagName === 'SPAN' && domClassIncludes(n, 'ba-schedule-session-class'),
  );
  assert.equal(unfilteredClassLabels.length, 2);
  assert.deepEqual(
    unfilteredClassLabels.map((n) => aggregateDomTextContent(n)).sort(),
    ['Lớp Alpha', 'Lớp Beta'],
  );

  assert.equal(tryRenderBaView(ctx, { view: 'tutor-schedule', classId: 'c1' }), true);
  const filteredClassLabels = findDomNodes(
    root,
    (n) => n.tagName === 'SPAN' && domClassIncludes(n, 'ba-schedule-session-class'),
  );
  assert.equal(filteredClassLabels.length, 1);
  assert.equal(aggregateDomTextContent(filteredClassLabels[0]), 'Lớp Alpha');
  const filteredRows = findDomNodes(root, (n) => domClassIncludes(n, 'ba-schedule-session-row'));
  assert.equal(filteredRows.length, 1);
  registerDirtyProbe(null);
});

test('attendance status buttons sync hidden select', (t) => {
  installBaDomEnvironment(t, { confirm: () => true });
  const root = document.getElementById('app-root');
  const sessionId = 'sess-b';
  const startAt = localDateTimeToUtcIso('2026-06-02', '19:00');
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
    state: {
      data: {
        classes: [{ id: 'c1', name: 'Lớp A' }],
        students: [{ id: 's1', name: 'HS 1' }],
        classSessions: [{
          id: sessionId,
          classId: 'c1',
          startAt,
          endAt: localDateTimeToUtcIso('2026-06-02', '20:00'),
          status: SESSION_STATUS.SCHEDULED,
        }],
        memberships: [{
          classId: 'c1',
          studentId: 's1',
          effectiveFrom: '2020-01-01T00:00:00.000Z',
          effectiveTo: null,
        }],
        parents: [],
        parentStudentLinks: [],
        attendanceStatusCatalog: defaultAttendanceCatalog(),
        attendanceRecords: [],
        attendanceAudit: [],
      },
    },
  };
  tryRenderBaView(ctx, parseBaRoute(['tutor', 'attendance', sessionId]));
  const presentBtn = findDomNodes(
    root,
    (n) => n.tagName === 'BUTTON' && aggregateDomTextContent(n) === 'Có mặt',
  );
  assert.equal(presentBtn.length, 1);
  const statusSel = findDomNodes(
    root,
    (n) => n.tagName === 'SELECT' && String(n.attributes?.className || '').includes('ba-attendance-status-select'),
  );
  assert.equal(statusSel.length, 1);
  assert.equal(statusSel[0].value, '');
  presentBtn[0].dispatchEvent({ type: 'click' });
  assert.equal(statusSel[0].value, 'present');
  assert.equal(presentBtn[0].getAttribute?.('aria-pressed'), 'true');
  registerDirtyProbe(null);
});

test('mark all present only fills unmarked rows', (t) => {
  installBaDomEnvironment(t, { confirm: () => true });
  const root = document.getElementById('app-root');
  const sessionId = 'sess-c';
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
    state: {
      data: {
        classes: [{ id: 'c1', name: 'Lớp A' }],
        students: [
          { id: 's1', name: 'HS 1' },
          { id: 's2', name: 'HS 2' },
        ],
        classSessions: [{
          id: sessionId,
          classId: 'c1',
          startAt: localDateTimeToUtcIso('2026-06-03', '19:00'),
          endAt: localDateTimeToUtcIso('2026-06-03', '20:00'),
          status: SESSION_STATUS.SCHEDULED,
        }],
        memberships: [
          { classId: 'c1', studentId: 's1', effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveTo: null },
          { classId: 'c1', studentId: 's2', effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveTo: null },
        ],
        parents: [],
        parentStudentLinks: [],
        attendanceStatusCatalog: defaultAttendanceCatalog(),
        attendanceRecords: [{
          sessionId,
          studentId: 's1',
          statusId: 'absent',
          revision: 1,
        }],
        attendanceAudit: [],
      },
    },
  };
  tryRenderBaView(ctx, parseBaRoute(['tutor', 'attendance', sessionId]));
  const selects = findDomNodes(
    root,
    (n) => n.tagName === 'SELECT' && String(n.attributes?.className || '').includes('ba-attendance-status-select'),
  );
  assert.equal(selects.length, 2);
  const byStudent = new Map(selects.map((sel) => {
    let row = sel.parentNode;
    while (row && !row.attributes?.['data-student-id']) row = row.parentNode;
    return [row?.attributes?.['data-student-id'], sel];
  }));
  assert.equal(byStudent.get('s1')?.value, 'absent');
  assert.equal(byStudent.get('s2')?.value, '');
  const markAll = findDomNodes(
    root,
    (n) => n.tagName === 'BUTTON' && aggregateDomTextContent(n) === 'Tất cả có mặt',
  );
  assert.equal(markAll.length, 1);
  markAll[0].dispatchEvent({ type: 'click' });
  assert.equal(byStudent.get('s1')?.value, 'absent', 'saved row unchanged');
  assert.equal(byStudent.get('s2')?.value, 'present', 'unmarked row filled');
  registerDirtyProbe(null);
});
