import { EXAM_NAV_ITEM, parseExamRoute } from './exam-domain.js';
import { renderExamTeacherHub, renderExamImportView, renderExamDraftEditor, renderExamAssignView } from './exam-ui-teacher.js';
import { renderExamStudentHub, renderExamTakeView } from './exam-ui-student.js';
import { el } from './ba-ui-dom.js';

export { EXAM_NAV_ITEM, parseExamRoute };

function clear(node) {
  if (typeof node.__examDispose === 'function') {
    node.__examDispose();
    delete node.__examDispose;
  }
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * @param {object} ctx
 * @param {object} route
 * @returns {boolean}
 */
export function tryRenderExamView(ctx, route) {
  if (!route.view?.startsWith('exams')) return false;
  const root = document.getElementById('app-root');
  if (!root) return false;
  clear(root);

  if (ctx.isTeacher()) {
    if (route.view === 'exams-hub') renderExamTeacherHub(ctx, root);
    else if (route.view === 'exams-import') renderExamImportView(ctx, root);
    else if (route.view === 'exams-draft') renderExamDraftEditor(ctx, root, route.draftId);
    else if (route.view === 'exams-assign') renderExamAssignView(ctx, root, route.versionId);
    else renderExamTeacherHub(ctx, root);
    return true;
  }

  if (route.view === 'exams-take') renderExamTakeView(ctx, root, route.assignmentId);
  else renderExamStudentHub(ctx, root);
  return true;
}

export function examNavVisible(item, isTeacher) {
  if (isTeacher) return !!item.teacher;
  return !!item.student;
}

export function appendExamNavItem(items) {
  if (!items.some((i) => i.id === EXAM_NAV_ITEM.id)) {
    items.splice(3, 0, EXAM_NAV_ITEM);
  }
  return items;
}
