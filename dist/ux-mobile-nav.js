/**
 * Mobile bottom navigation: fixed primary tabs, overflow “Menu” sheet for teachers.
 */

import { wireDialogA11y } from './ux-forms.js';

export const MOBILE_DESKTOP_MIN_WIDTH = 900;
export const TEACHER_BOTTOM_TAB_COUNT = 5;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** @type {number|null} */
let cachedBottomNavHeightPx = null;

/** Student sidebar / mobile primary tab order (teacher NAV source order unchanged). */
const STUDENT_PRIMARY_NAV_ORDER = ['assignments', 'exams', 'settings'];

export function readBottomNavHeightPx(doc = document) {
  if (cachedBottomNavHeightPx != null) return cachedBottomNavHeightPx;
  const root = doc.documentElement;
  const view = doc.defaultView ?? root?.ownerDocument?.defaultView;
  const getComputedStyleFn = view?.getComputedStyle;
  let raw = '';
  if (getComputedStyleFn && root) {
    try {
      raw = getComputedStyleFn.call(view, root).getPropertyValue('--bottom-nav-h').trim();
    } catch {
      raw = '';
    }
  }
  const n = parseFloat(raw);
  cachedBottomNavHeightPx = Number.isFinite(n) && n > 0 ? n : 72;
  return cachedBottomNavHeightPx;
}

/**
 * @param {Array<{ id: string, label: string, hash: string, teacher?: boolean, student?: boolean }>} items
 * @param {{ isTeacher: boolean }} ctx
 */
export function filterNavItemsForRole(items, { isTeacher }) {
  const out = [];
  for (const item of items) {
    if (isTeacher && item.teacher === false) continue;
    if (!isTeacher && !item.student) continue;
    if (
      !isTeacher
      && (item.id === 'grading' || item.id === 'dashboard' || item.id === 'classes' || item.id === 'accounts')
    ) {
      continue;
    }
    out.push(item);
  }
  if (!isTeacher && out.length > 1) {
    out.sort((a, b) => {
      const ia = STUDENT_PRIMARY_NAV_ORDER.indexOf(a.id);
      const ib = STUDENT_PRIMARY_NAV_ORDER.indexOf(b.id);
      const rankA = ia === -1 ? STUDENT_PRIMARY_NAV_ORDER.length : ia;
      const rankB = ib === -1 ? STUDENT_PRIMARY_NAV_ORDER.length : ib;
      return rankA - rankB;
    });
  }
  return out;
}

/**
 * @param {{ id: string }} item
 * @param {{ view: string }} route
 */
export function resolveSidebarNavActive(item, route) {
  const current = route.view;
  return (
    current === item.id
    || (item.id === 'classes' && current === 'class-detail')
    || (item.id === 'tutor' && String(current).startsWith('tutor'))
    || (item.id === 'exams' && String(current).startsWith('exams'))
  );
}

export function buildTeacherBottomTabs() {
  return [
    { id: 'dashboard', label: 'Tổng quan', hash: '#/dashboard', icon: 'dashboard' },
    { id: 'classes', label: 'Lớp học', hash: '#/classes', icon: 'classes' },
    { id: 'assignments', label: 'Bài tập', hash: '#/assignments', icon: 'assignments' },
    { id: 'grading', label: 'Chấm bài', hash: '#/grading', icon: 'grading' },
    { id: 'more', label: 'Thêm', hash: null, icon: 'more' },
  ];
}

/**
 * @param {{ includeExams: boolean }} opts
 */
export function buildStudentBottomTabs({ includeExams }) {
  const tabs = [
    { id: 'assignments', label: 'Bài tập', hash: '#/assignments', icon: 'assignments' },
  ];
  if (includeExams) {
    tabs.push({ id: 'exams', label: 'Bài trực tuyến', hash: '#/exams', icon: 'exams' });
  }
  tabs.push({ id: 'settings', label: 'Cài đặt', hash: '#/settings', icon: 'settings' });
  return tabs;
}

/**
 * @param {{ view: string }} route
 * @param {boolean} isTeacher
 */
export function resolveMobileBottomActive(route, isTeacher) {
  const view = route?.view ?? '';
  if (!isTeacher) {
    if (view === 'assignments' || view === 'assignment-detail') {
      return { tabId: 'assignments', moreActive: false };
    }
    if (String(view).startsWith('exams')) {
      return { tabId: 'exams', moreActive: false };
    }
    if (view === 'settings') {
      return { tabId: 'settings', moreActive: false };
    }
    return { tabId: null, moreActive: false };
  }
  if (view === 'dashboard') return { tabId: 'dashboard', moreActive: false };
  if (view === 'classes' || view === 'class-detail') return { tabId: 'classes', moreActive: false };
  if (view === 'assignments' || view === 'assignment-detail') {
    return { tabId: 'assignments', moreActive: false };
  }
  if (view === 'grading' || view === 'grading-editor') {
    return { tabId: 'grading', moreActive: false };
  }
  return { tabId: 'more', moreActive: true };
}

export function listTeacherMoreMenuItems() {
  return [
    { label: 'Điểm danh', hash: '#/tutor/schedule', group: 'Gia sư' },
    { label: 'Báo cáo điểm danh', hash: '#/tutor/reports', group: 'Gia sư' },
    { label: 'Lịch điểm danh học sinh', hash: '#/tutor/attendance-calendar', group: 'Gia sư' },
    { label: 'Lớp gia sư', hash: '#/tutor', group: 'Gia sư', tutorHub: true },
    { label: 'Kho đề', hash: '#/exams', group: 'Ứng dụng' },
    { label: 'Tài khoản', hash: '#/accounts', group: 'Ứng dụng' },
    { label: 'Cài đặt', hash: '#/settings', group: 'Ứng dụng' },
  ];
}

/**
 * @param {Array<{ tutorHub?: boolean, hash: string }>} items
 */
export function filterTeacherMoreMenuItems(items) {
  return items;
}

/** @type {Record<string, string>} */
const ICON_PATHS = {
  dashboard: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z',
  classes: 'M5 8.5 12 4l7 4.5V18a1 1 0 0 1-1 1h-4v-5H10v5H6a1 1 0 0 1-1-1V8.5Z',
  assignments: 'M8 4h8l2 2v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4h2Zm0 0v3h8V4M9 12h6M9 16h4',
  grading: 'M5 19h14M9 16l2 2 4-4M7 5h10v8H7V5Z',
  exams: 'M7 4h10v16H7V4Zm2 3h6M9 11h6M9 15h4',
  settings: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm7.5-.9 1.2-.7-.9-1.6-1.3.2-.9-.9-1.4 1.4.2 1.3-1.6.9.7 1.2h1.5l.7 1.2 1.2-.7.7-1.2h1.5Z',
  more: 'M6 12a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm6 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm6 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z',
  attendance: 'M8 3v3M16 3v3M5 8h14M7 12h4M7 16h6M6 5h12a1 1 0 0 1 1 1v13H5V6a1 1 0 0 1 1-1Z',
  reports: 'M6 20V10M12 20V4M18 20v-6',
  calendar: 'M8 3v2M16 3v2M5 7h14v14H5V7Zm3 5h4M8 15h8',
  accounts: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0',
  tutor: 'M5 19V9l7-4 7 4v10M9 19v-6h6v6',
};

export function createMobileNavIcon(iconId, doc = document) {
  const d = ICON_PATHS[iconId] || ICON_PATHS.more;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('mobile-nav-icon');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

function routeSnapshotKey(route) {
  if (!route) return '';
  return [
    route.view,
    route.classId,
    route.assignmentId,
    route.studentId,
    route.sessionId,
    route.draftId,
  ].filter(Boolean).join('|');
}

function clearEl(node) {
  while (node?.firstChild) node.removeChild(node.firstChild);
}

/** @type {ReturnType<typeof createMobileNavController>|null} */
let controllerSingleton = null;

export function getMobileNavController(doc = document) {
  if (!controllerSingleton) {
    controllerSingleton = createMobileNavController(doc);
  }
  return controllerSingleton;
}

/** Test hook */
export function resetMobileNavControllerForTests() {
  controllerSingleton?.destroy?.();
  controllerSingleton = null;
  cachedBottomNavHeightPx = null;
}

function createMobileNavController(doc) {
  let sheetHost = null;
  let sheetDialog = null;
  let sheetBackdrop = null;
  let moreButton = null;
  let disposeA11y = null;
  let lastRouteKey = '';
  let sheetOpen = false;
  let desktopMq = null;
  let onDesktopChange = null;
  let navigateFn = () => {};

  const SHEET_ID = 'mobile-nav-menu-sheet';
  const TITLE_ID = 'mobile-nav-menu-title';

  function ensureSheetDom() {
    if (sheetHost) return;
    sheetHost = doc.createElement('div');
    sheetHost.className = 'mobile-nav-sheet-host';
    sheetHost.hidden = true;

    sheetBackdrop = doc.createElement('button');
    sheetBackdrop.type = 'button';
    sheetBackdrop.className = 'mobile-nav-sheet-backdrop';
    sheetBackdrop.setAttribute('aria-label', 'Đóng menu');

    sheetDialog = doc.createElement('div');
    sheetDialog.id = SHEET_ID;
    sheetDialog.className = 'mobile-nav-sheet';
    sheetDialog.setAttribute('role', 'dialog');
    sheetDialog.setAttribute('aria-modal', 'true');
    sheetDialog.setAttribute('aria-labelledby', TITLE_ID);

    sheetHost.appendChild(sheetBackdrop);
    sheetHost.appendChild(sheetDialog);
    doc.body.appendChild(sheetHost);

    sheetBackdrop.addEventListener('click', () => closeSheet());

    desktopMq = doc.defaultView?.matchMedia(`(min-width: ${MOBILE_DESKTOP_MIN_WIDTH}px)`);
    onDesktopChange = () => {
      if (desktopMq?.matches) closeSheet();
    };
    desktopMq?.addEventListener('change', onDesktopChange);
  }

  function setScrollLock(on) {
    doc.body.classList.toggle('mobile-nav-menu-open', on);
  }

  function syncMoreExpanded() {
    if (!moreButton) return;
    moreButton.setAttribute('aria-expanded', sheetOpen ? 'true' : 'false');
    moreButton.setAttribute('aria-controls', SHEET_ID);
  }

  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    disposeA11y?.();
    disposeA11y = null;
    if (sheetHost) sheetHost.hidden = true;
    setScrollLock(false);
    syncMoreExpanded();
  }

  function openSheet(isTeacher) {
    if (!isTeacher) return;
    ensureSheetDom();
    clearEl(sheetDialog);

    const title = doc.createElement('h2');
    title.id = TITLE_ID;
    title.className = 'mobile-nav-sheet-title';
    title.textContent = 'Menu';
    sheetDialog.appendChild(title);

    const scroll = doc.createElement('div');
    scroll.className = 'mobile-nav-sheet-scroll';

    const menuItems = filterTeacherMoreMenuItems(listTeacherMoreMenuItems());
    let lastGroup = null;
    for (const item of menuItems) {
      if (item.group && item.group !== lastGroup) {
        lastGroup = item.group;
        const groupLabel = doc.createElement('div');
        groupLabel.className = 'mobile-nav-sheet-group';
        groupLabel.textContent = item.group;
        scroll.appendChild(groupLabel);
      }
      const link = doc.createElement('a');
      link.href = item.hash;
      link.className = 'mobile-nav-sheet-link';
      link.appendChild(createMobileNavIcon(
        item.hash.includes('schedule') ? 'attendance'
          : item.hash.includes('reports') ? 'reports'
            : item.hash.includes('attendance-calendar') ? 'calendar'
              : item.hash.includes('accounts') ? 'accounts'
                : item.hash.includes('tutor') ? 'tutor'
                  : item.hash.includes('exams') ? 'exams'
                    : item.hash.includes('settings') ? 'settings'
                      : 'assignments',
        doc,
      ));
      const span = doc.createElement('span');
      span.textContent = item.label;
      link.appendChild(span);
      link.addEventListener('click', (e) => {
        e.preventDefault();
        closeSheet();
        navigateFn(item.hash);
      });
      scroll.appendChild(link);
    }
    sheetDialog.appendChild(scroll);

    const footer = doc.createElement('div');
    footer.className = 'mobile-nav-sheet-footer';
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-secondary mobile-nav-sheet-close';
    closeBtn.textContent = 'Đóng';
    closeBtn.addEventListener('click', () => closeSheet());
    footer.appendChild(closeBtn);
    sheetDialog.appendChild(footer);

    sheetHost.hidden = false;
    sheetOpen = true;
    setScrollLock(true);
    syncMoreExpanded();

    disposeA11y = wireDialogA11y({
      backdrop: sheetBackdrop,
      dialog: sheetDialog,
      titleId: TITLE_ID,
      onRequestClose: () => closeSheet(),
      focusOpener: moreButton,
      initialFocus: closeBtn,
    });
  }

  function toggleSheet(isTeacher) {
    if (sheetOpen) closeSheet();
    else openSheet(isTeacher);
  }

  function buildBottomButton(tab, active, isTeacher) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `mobile-nav-item${active ? ' active' : ''}`;
    if (tab.id === 'more') {
      moreButton = btn;
      btn.classList.add('mobile-nav-item-more');
      btn.addEventListener('click', () => toggleSheet(isTeacher));
    } else {
      btn.addEventListener('click', () => navigateFn(tab.hash));
    }
    btn.appendChild(createMobileNavIcon(tab.icon, doc));
    const label = doc.createElement('span');
    label.className = 'mobile-nav-label';
    label.textContent = tab.label;
    btn.appendChild(label);
    if (active) btn.setAttribute('aria-current', 'page');
    return btn;
  }

  return {
    render(ctx) {
      const {
        bottomNavEl,
        route,
        isTeacher,
        navigate,
        showNav,
        includeStudentExams,
      } = ctx;

      navigateFn = navigate || navigateFn;
      ensureSheetDom();
      readBottomNavHeightPx(doc);

      const routeKey = routeSnapshotKey(route);
      const routeChanged = routeKey !== lastRouteKey;
      if (routeChanged) {
        closeSheet();
        lastRouteKey = routeKey;
      }

      if (!showNav) {
        closeSheet();
        lastRouteKey = '';
        clearEl(bottomNavEl);
        moreButton = null;
        return;
      }

      if (route?.view === 'grading-editor') {
        closeSheet();
      }

      if (desktopMq?.matches) {
        closeSheet();
      }

      const reopenSheet = sheetOpen && !routeChanged;
      if (reopenSheet) {
        closeSheet();
      }

      clearEl(bottomNavEl);
      moreButton = null;

      const tabs = isTeacher
        ? buildTeacherBottomTabs()
        : buildStudentBottomTabs({ includeExams: !!includeStudentExams });

      const { tabId, moreActive } = resolveMobileBottomActive(route, isTeacher);

      for (const tab of tabs) {
        const active = tab.id === 'more' ? moreActive : tab.id === tabId;
        bottomNavEl.appendChild(buildBottomButton(tab, active, isTeacher));
      }
      syncMoreExpanded();

      if (reopenSheet && isTeacher && !desktopMq?.matches) {
        openSheet(isTeacher);
      }
    },

    closeSheet,
    isSheetOpen: () => sheetOpen,

    destroy() {
      closeSheet();
      desktopMq?.removeEventListener('change', onDesktopChange);
      sheetHost?.remove();
      sheetHost = null;
      sheetDialog = null;
      sheetBackdrop = null;
      moreButton = null;
    },
  };
}

/**
 * @param {object} ctx
 * @param {HTMLElement|null} ctx.bottomNavEl
 * @param {{ view: string }} ctx.route
 * @param {boolean} ctx.isTeacher
 * @param {(hash: string) => void} ctx.navigate
 * @param {boolean} ctx.showNav
 * @param {boolean} [ctx.includeStudentExams]
 */
export function renderMobileNavigation(ctx) {
  if (!ctx.bottomNavEl) return;
  const doc = ctx.bottomNavEl.ownerDocument ?? document;
  getMobileNavController(doc).render(ctx);
}
