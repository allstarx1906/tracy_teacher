import {
  createPenMarkFromPixelStroke,
  applyEraserToAnnotations,
  markToNormalized,
} from './model.js';

/**
 * Production pen/eraser/highlight gesture settlement for the grading editor.
 * Clears live gesture state before draft mutation so autosave persist cannot re-enter commit.
 *
 * @param {object} deps
 * @param {() => object} deps.getSession
 * @param {() => object} deps.getDraft
 * @param {() => string} deps.getVersionId
 * @param {() => number} deps.getPageIndex
 * @param {() => { w: number, h: number }} deps.measureDisplaySize
 * @param {() => void} deps.pushUndo
 * @param {(pageIndex: number) => { past: unknown[], future: unknown[] }} deps.getUndoStack
 * @param {() => void} deps.renderOverlay
 * @param {() => string} deps.uid
 * @param {() => void} deps.queueAutosave
 * @param {(pointerId: number) => void} [deps.releasePointerCapture]
 */
export function createGradingGestureSettlement(deps) {
  let settling = false;

  function penGestureIsCommittable(g) {
    const session = deps.getSession();
    return (
      g.pageIndex === deps.getPageIndex() &&
      g.versionId === deps.getVersionId() &&
      g.imageLoadSeq === session.imageLoadSeq &&
      g.points.length >= 1
    );
  }

  function applyPenStrokeFromGesture(gesture) {
    if (!gesture?.points?.length) return false;
    const mark = createPenMarkFromPixelStroke({
      id: deps.uid(),
      points: gesture.points,
      w: gesture.w,
      h: gesture.h,
      color: gesture.color,
      nw: gesture.nw,
    });
    if (!mark) return false;
    const pg = deps.getDraft().pages[deps.getPageIndex()];
    deps.pushUndo();
    pg.annotations.push(mark);
    deps.renderOverlay();
    return true;
  }

  function commitLivePenGesture() {
    const session = deps.getSession();
    const g = session.penGesture;
    if (!g) return false;
    if (g.livePath?.parentNode) g.livePath.parentNode.removeChild(g.livePath);
    session.penGesture = null;
    if (!penGestureIsCommittable(g)) return false;
    return applyPenStrokeFromGesture(g);
  }

  function commitLiveEraserGesture() {
    const session = deps.getSession();
    const g = session.eraserGesture;
    if (!g) return false;
    session.eraserGesture = null;
    const pageIndex = g.pageIndex ?? deps.getPageIndex();
    const pg = deps.getDraft().pages[pageIndex];
    if (!pg) return false;
    const touched = [...(g.touchedIds || [])];
    if (touched.length) {
      const stack = deps.getUndoStack(pageIndex);
      stack.past.push(g.preSnapshot);
      stack.future = [];
      pg.annotations = applyEraserToAnnotations(JSON.parse(g.preSnapshot), touched);
      deps.renderOverlay();
      return true;
    }
    pg.annotations = JSON.parse(g.preSnapshot);
    deps.renderOverlay();
    return false;
  }

  function settleTextDrag() {
    const session = deps.getSession();
    if (session.drag?.type !== 'text-move' && session.drag?.type !== 'text-resize') return;
    session.drag = null;
    deps.renderOverlay();
  }

  function settleHighlightDrag() {
    const session = deps.getSession();
    const d = session.drag;
    if (!d || d.type !== 'highlight') return;
    session.drag = null;
    const { w, h } = deps.measureDisplaySize();
    const fw = d.frozenW ?? w;
    const fh = d.frozenH ?? h;
    deps.pushUndo();
    const x = Math.min(d.x, d.x2);
    const y = Math.min(d.y, d.y2);
    const rw = Math.abs(d.x2 - d.x);
    const rh = Math.abs(d.y2 - d.y);
    if (rw >= 3 && rh >= 3) {
      deps.getDraft().pages[deps.getPageIndex()].annotations.push(
        markToNormalized({ id: deps.uid(), type: 'highlight', x, y, w: rw, h: rh }, fw, fh),
      );
    }
    deps.renderOverlay();
  }

  function settleGradingGesturesIntoDraft() {
    if (settling) return;
    settling = true;
    try {
      if (deps.getSession().penGesture) commitLivePenGesture();
      if (deps.getSession().eraserGesture) commitLiveEraserGesture();
      const dragType = deps.getSession().drag?.type;
      if (dragType === 'text-move' || dragType === 'text-resize') settleTextDrag();
      else if (dragType === 'highlight') settleHighlightDrag();
    } finally {
      settling = false;
    }
  }

  function finishPenPointer(e) {
    const session = deps.getSession();
    const g = session.penGesture;
    if (!g || g.pointerId !== e.pointerId) return;
    if (deps.releasePointerCapture) {
      try {
        deps.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    const committed = commitLivePenGesture();
    if (committed) deps.queueAutosave();
  }

  function finishEraserPointer(e) {
    const session = deps.getSession();
    const g = session.eraserGesture;
    if (!g || g.pointerId !== e.pointerId) return;
    if (deps.releasePointerCapture) {
      try {
        deps.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    const mutated = commitLiveEraserGesture();
    if (mutated) deps.queueAutosave();
  }

  return {
    settleGradingGesturesIntoDraft,
    finishPenPointer,
    finishEraserPointer,
    commitLivePenGesture,
    commitLiveEraserGesture,
    applyPenStrokeFromGesture,
    isSettling: () => settling,
  };
}
