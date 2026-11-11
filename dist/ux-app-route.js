import { parseBaRoute } from './ba-ui.js';
import { parseExamRoute } from './exam-domain.js';
import { splitAppHashPathAndQuery } from './ux-hash-navigation.js';

/**
 * Parse app view route from a location hash (path segments only; query stays on location.hash).
 * @param {string} [hash]
 */
export function parseAppRoute(hash) {
  const { path: pathOnly } = splitAppHashPathAndQuery(hash);
  const routePath = pathOnly || '/dashboard';
  const parts = routePath.split('/').filter(Boolean);
  if (parts[0] === 'grading' && parts[1]) {
    return {
      view: 'grading-editor',
      assignmentId: parts[1],
      studentId: parts[2] || null,
    };
  }
  if (parts[0] === 'classes') {
    if (parts[1]) return { view: 'class-detail', classId: parts[1] };
    return { view: 'classes' };
  }
  const ba = parseBaRoute(parts);
  if (ba) return ba;
  const exam = parseExamRoute(parts);
  if (exam) return exam;
  if (parts[0] === 'assignment' && parts[1]) {
    return { view: 'assignment-detail', assignmentId: parts[1] };
  }
  const view = parts[0] || 'dashboard';
  if (view === 'change-password') return { view: 'change-password' };
  if (view === 'accounts') return { view: 'accounts' };
  if (view === 'settings') return { view: 'settings' };
  return { view, classId: null, assignmentId: null, studentId: null };
}
