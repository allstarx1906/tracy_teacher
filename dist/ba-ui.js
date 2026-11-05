import { MOCK_PROVIDER_LABEL } from './ba-domain.js';
import { el } from './ba-ui-dom.js';
import { beginBaViewScope, disposeActiveBaViewScope } from './ba-ui-scoped.js';
import { renderParentsView } from './ba-ui-family.js';
import { renderMembershipsView } from './ba-ui-membership.js';
import { renderCatalogView } from './ba-ui-catalog.js';
import { renderNotificationsView } from './ba-ui-notifications.js';
import { renderAttendanceView } from './ba-ui-attendance.js';
import { renderAttendanceCalendarView } from './ba-ui-attendance-calendar.js';
import { renderReportsView } from './ba-ui-reports.js';
import { renderSessionDetailView, renderScheduleView } from './ba-ui-session.js';
import { renderStudentsView } from './ba-ui-students.js';

export { disposeActiveBaViewScope };

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export const BA_NAV_ITEMS = [
  { id: 'tutor', label: 'Lớp gia sư', hash: '#/tutor', teacher: true },
];

function baRouteSegment(raw) {
  if (!raw) return raw;
  return String(raw).split('?')[0];
}

function baRouteQueryString(parts) {
  for (const p of parts.slice(1)) {
    if (p?.includes('?')) return String(p).split('?').slice(1).join('?');
  }
  if (typeof location !== 'undefined' && location.hash?.includes('?')) {
    return location.hash.split('?')[1] || '';
  }
  return '';
}

export function parseBaRoute(parts) {
  if (parts[0] !== 'tutor') return null;
  if (parts.length === 1) return { view: 'tutor-hub' };
  const routeQuery = new URLSearchParams(baRouteQueryString(parts));
  const seg1 = baRouteSegment(parts[1]);
  if (seg1 === 'students') return { view: 'tutor-students' };
  if (seg1 === 'parents') return { view: 'tutor-parents' };
  if (seg1 === 'memberships') return { view: 'tutor-memberships' };
  if (seg1 === 'catalog') return { view: 'tutor-catalog' };
  if (seg1 === 'schedule') return { view: 'tutor-schedule', classId: baRouteSegment(parts[2]) || null };
  if (seg1 === 'sessions' && parts[2]) return { view: 'tutor-session', sessionId: baRouteSegment(parts[2]) };
  if (seg1 === 'attendance-calendar') {
    return {
      view: 'tutor-attendance-calendar',
      classId: routeQuery.get('classId') || baRouteSegment(parts[2]) || null,
      studentId: routeQuery.get('studentId') || baRouteSegment(parts[3]) || null,
      month: routeQuery.get('month') || null,
    };
  }
  if (seg1 === 'attendance' && parts[2]) return { view: 'tutor-attendance', sessionId: baRouteSegment(parts[2]) };
  if (seg1 === 'reports') return { view: 'tutor-reports' };
  if (seg1 === 'notifications') return { view: 'tutor-notifications' };
  return { view: 'tutor-hub' };
}

/**
 * @param {object} ctx
 * @param {object} ctx.state
 * @param {() => boolean} ctx.isTeacher
 * @param {() => void} ctx.renderApp
 * @param {(msg: string) => void} ctx.toastOk
 * @param {(msg: string) => void} ctx.toastErr
 */
export function tryRenderBaView(ctx, route) {
  if (!route.view?.startsWith('tutor')) return false;
  if (!ctx.isTeacher()) {
    ctx.navigate('#/assignments');
    return true;
  }
  const root = document.getElementById('app-root');
  clear(root);
  const scope = beginBaViewScope();
  root.appendChild(mockBanner());
  if (route.view === 'tutor-hub') renderHub(ctx, root);
  else if (route.view === 'tutor-students') renderStudentsView(ctx, root, scope);
  else if (route.view === 'tutor-parents') renderParentsView(ctx, root, scope);
  else if (route.view === 'tutor-memberships') renderMembershipsView(ctx, root, scope);
  else if (route.view === 'tutor-catalog') renderCatalogView(ctx, root, scope);
  else if (route.view === 'tutor-schedule') renderScheduleView(ctx, root, scope, route.classId);
  else if (route.view === 'tutor-session') renderSessionDetailView(ctx, root, scope, route.sessionId);
  else if (route.view === 'tutor-attendance') renderAttendanceView(ctx, root, scope, route.sessionId);
  else if (route.view === 'tutor-attendance-calendar') {
    renderAttendanceCalendarView(ctx, root, scope, route);
  } else if (route.view === 'tutor-reports') renderReportsView(ctx, root, scope);
  else if (route.view === 'tutor-notifications') renderNotificationsView(ctx, root, scope);
  else renderHub(ctx, root);
  return true;
}

function mockBanner() {
  return el('p', {
    className: 'demo-banner',
    style: 'margin-bottom:1rem;font-size:0.85rem',
    role: 'status',
  }, MOCK_PROVIDER_LABEL);
}

function renderHub(ctx, root) {
  root.appendChild(el('h1', { className: 'page-title' }, 'Quản lý lớp gia sư (MVP v1.2)'));
  root.appendChild(el('p', {}, 'Máy chủ cần chạy liên tục để xử lý nhắc lịch (mock).'));
  const links = [
    ['#/tutor/students', 'Hồ sơ học sinh'],
    ['#/tutor/parents', 'Phụ huynh & liên kết'],
    ['#/tutor/memberships', 'Khoảng tham gia lớp'],
    ['#/tutor/catalog', 'Danh mục điểm danh'],
    ['#/tutor/schedule', 'Lịch học & buổi'],
    ['#/tutor/attendance-calendar', 'Lịch điểm danh học sinh'],
    ['#/tutor/reports', 'Báo cáo điểm danh'],
    ['#/tutor/notifications', 'Thông báo mock & thủ công'],
  ];
  const grid = el('div', { className: 'class-grid' });
  for (const [hash, label] of links) {
    grid.appendChild(el('article', {
      className: 'card class-card',
      tabindex: '0',
      role: 'button',
      onClick: () => ctx.navigate(hash),
      onKeydown: (e) => { if (e.key === 'Enter') ctx.navigate(hash); },
    }, el('h3', {}, label)));
  }
  root.appendChild(grid);
}
