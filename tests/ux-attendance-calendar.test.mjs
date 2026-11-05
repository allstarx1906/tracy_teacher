import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAttendanceCatalog, localDateTimeToUtcIso, SESSION_STATUS } from '../dist/ba-domain.js';
import { tryRenderBaView, parseBaRoute } from '../dist/ba-ui.js';
import { registerDirtyProbe } from '../dist/ux-forms.js';
import { installBaDomEnvironment, findDomNodes, aggregateDomTextContent } from './helper-browser-window.mjs';

test('parseBaRoute matches attendance-calendar before attendance session route', () => {
  assert.deepEqual(parseBaRoute(['tutor', 'attendance-calendar']), {
    view: 'tutor-attendance-calendar',
    classId: null,
    studentId: null,
    month: null,
  });
  assert.deepEqual(parseBaRoute(['tutor', 'attendance-calendar?studentId=s1&classId=c1&month=2026-06']), {
    view: 'tutor-attendance-calendar',
    classId: 'c1',
    studentId: 's1',
    month: '2026-06',
  });
  assert.deepEqual(parseBaRoute(['tutor', 'attendance', 'sess-1']), {
    view: 'tutor-attendance',
    sessionId: 'sess-1',
  });
});

test('attendance calendar view smoke', (t) => {
  installBaDomEnvironment(t, { confirm: () => true });
  const root = document.getElementById('app-root');
  const sessionMorning = 'sess-am';
  const sessionAfternoon = 'sess-pm';
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
    state: {
      data: {
        classes: [{ id: 'c1', name: 'Lớp thử' }],
        students: [{ id: 's1', name: 'Minh Anh' }],
        classSessions: [
          {
            id: sessionMorning,
            classId: 'c1',
            startAt: localDateTimeToUtcIso('2026-06-10', '09:00'),
            endAt: localDateTimeToUtcIso('2026-06-10', '10:00'),
            status: SESSION_STATUS.COMPLETED,
          },
          {
            id: sessionAfternoon,
            classId: 'c1',
            startAt: localDateTimeToUtcIso('2026-06-10', '19:00'),
            endAt: localDateTimeToUtcIso('2026-06-10', '20:00'),
            status: SESSION_STATUS.COMPLETED,
          },
        ],
        memberships: [{
          classId: 'c1',
          studentId: 's1',
          effectiveFrom: '2020-01-01T00:00:00.000Z',
        }],
        parents: [],
        parentStudentLinks: [],
        attendanceStatusCatalog: defaultAttendanceCatalog(),
        attendanceRecords: [
          { sessionId: sessionMorning, studentId: 's1', statusId: 'present' },
          { sessionId: sessionAfternoon, studentId: 's1', statusId: 'late' },
        ],
      },
    },
  };
  tryRenderBaView(ctx, parseBaRoute(['tutor', 'attendance-calendar?studentId=s1&classId=c1&month=2026-06']));
  const text = aggregateDomTextContent(root);
  assert.ok(text.includes('Lịch điểm danh học sinh'));
  assert.ok(text.includes('Tỷ lệ tham dự (buổi đã điểm danh chuẩn)'));
  assert.ok(text.includes('Có mặt'));
  assert.ok(text.includes('Đi muộn'));
  assert.ok(text.includes('CM'));

  const studentSel = findDomNodes(root, (n) => n.tagName === 'SELECT' && String(n.getAttribute?.('class') || n.attributes?.className || '').includes('ba-acal-student-select'))[0];
  assert.ok(studentSel);
  studentSel.value = 's1';

  const chips = findDomNodes(root, (n) => n.tagName === 'BUTTON' && String(n.getAttribute?.('class') || n.attributes?.className || '').includes('ba-acal-chip'));
  assert.equal(chips.length, 2);
  assert.ok(chips.some((c) => String(c.getAttribute?.('data-session-id') || c.attributes?.['data-session-id']) === sessionMorning));
  assert.ok(chips.some((c) => String(c.getAttribute?.('aria-label') || c.attributes?.['aria-label'] || '').includes('Có mặt')));
  const classSpans = findDomNodes(root, (n) => n.tagName === 'SPAN' && String(n.getAttribute?.('class') || n.attributes?.className || '').includes('ba-acal-chip-class'));
  assert.equal(classSpans.length, 2);
  const timeSpans = findDomNodes(root, (n) => n.tagName === 'SPAN' && String(n.getAttribute?.('class') || n.attributes?.className || '').includes('ba-acal-chip-time'));
  assert.equal(timeSpans.length, 2);
  registerDirtyProbe(null);
});
