import test from 'node:test';
import assert from 'node:assert/strict';
import { tryRenderBaView, parseBaRoute } from '../dist/ba-ui.js';
import { registerDirtyProbe } from '../dist/ux-forms.js';
import { installBaDomEnvironment, findDomNodes, aggregateDomTextContent } from './helper-browser-window.mjs';

test('parseBaRoute covers tutor workflow routes', () => {
  assert.deepEqual(parseBaRoute(['tutor']), { view: 'tutor-hub' });
  assert.equal(parseBaRoute(['tutor', 'schedule']).view, 'tutor-schedule');
  assert.equal(parseBaRoute(['tutor', 'memberships']).view, 'tutor-memberships');
  assert.equal(parseBaRoute(['tutor', 'catalog']).view, 'tutor-catalog');
  assert.equal(parseBaRoute(['tutor', 'notifications']).view, 'tutor-notifications');
});

test('tryRenderBaView mounts schedule recurrence controls in DOM', (t) => {
  installBaDomEnvironment(t, { confirm: () => true });
  const root = document.getElementById('app-root');
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
    state: {
      data: {
        classes: [{ id: 'c1', name: 'A' }],
        students: [],
        classSessions: [],
        memberships: [],
        parents: [],
        parentStudentLinks: [],
        attendanceStatusCatalog: [],
      },
    },
  };
  const ok = tryRenderBaView(ctx, { view: 'tutor-schedule', classId: 'c1' });
  assert.equal(ok, true);
  assert.ok(root.childNodes.length > 2);

  const text = aggregateDomTextContent(root);
  assert.ok(text.includes('Lịch lặp (xem trước → lưu)'));

  const labeled = (label) => findDomNodes(
    root,
    (n) => n.tagName === 'INPUT' && n.attributes?.['aria-label'] === label,
  );
  assert.ok(labeled('Từ ngày').length >= 1, 'range from date control');
  assert.ok(labeled('Đến ngày').length >= 1, 'range to date control');
  assert.ok(labeled('Giờ bắt đầu').length >= 1, 'start time control');
  assert.ok(labeled('Giờ kết thúc').length >= 1, 'end time control');

  const previewBtn = findDomNodes(
    root,
    (n) => n.tagName === 'BUTTON' && aggregateDomTextContent(n) === 'Xem trước',
  );
  const applyBtn = findDomNodes(
    root,
    (n) => n.tagName === 'BUTTON' && aggregateDomTextContent(n) === 'Lưu buổi lặp',
  );
  assert.equal(previewBtn.length, 1);
  assert.equal(applyBtn.length, 1);
  assert.equal(previewBtn[0].disabled, false);
  assert.equal(applyBtn[0].disabled, false);

  const classSel = findDomNodes(
    root,
    (n) => n.tagName === 'SELECT' && n.attributes?.['aria-label'] === 'Chọn lớp',
  );
  assert.equal(classSel.length, 1);
  assert.equal(classSel[0].value, 'c1');

  registerDirtyProbe(null);
});
