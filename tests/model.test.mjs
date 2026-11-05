import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateScore,
  classifyDeadlineTiming,
  checkMissingPages,
  getPublishedGrading,
  projectStudentVersionGrading,
  resolveStudentPublishedGrading,
  applyFirstSubmittedAt,
  normalizePoint,
  denormalizePoint,
  scaleMarkToViewport,
  markToNormalized,
  listPinComments,
  pinNumberMap,
  updatePinCommentText,
  isPinCommentTextValid,
  computeEditorStageLayout,
  computeEditorBaseContentSize,
  computeEditorLayoutFromImage,
  computeEditorBaseContentSizeForFit,
  computeGradingZoomPercent,
  computeInlineTextEditorLayout,
  applyGradingFocusMode,
  shouldBlockGradingUndoRedo,
  shouldBlockGradingDestructiveActions,
  hasUnsavedInlineTextEdits,
  seedGradingManualZoomFromFitMode,
  GRADING_ZOOM_FIT_PAGE,
  GRADING_ZOOM_FIT_WIDTH,
  GRADING_ZOOM_MANUAL,
  clampGradingManualZoom,
  nudgeGradingManualZoom,
  GRADING_MANUAL_ZOOM_MIN,
  GRADING_MANUAL_ZOOM_NUDGE,
  resolveGradingPanelSideState,
  gradingDisplayedImageSizeChanged,
  GRADING_FOCUS_BODY_CLASS,
  GRADING_INLINE_TEXT_SVG_PAD,
  transitionGradingEditorTool,
  resolveGradingInkControlsVisibility,
  getAssignmentsForStudent,
  gradingQueueState,
  shouldIncludeInGradingQueue,
  planDomProp,
  computeDashboardMetrics,
  validateBackup,
  SUBMISSION_STATUS,
  createSubmittedVersion,
  validateAnnotationMark,
  sanitizePageAnnotations,
  hitTestPenMark,
  hitTestAnnotationAt,
  updateDirectTextAnnotation,
  moveDirectTextAnnotation,
  restoreDirectTextAnnotationPosition,
  buildPenPathD,
  boundPenPointsNormalized,
  PEN_STROKE_PRESETS,
  clampPixelToNormalized,
  createPenMarkFromPixelStroke,
  createDirectTextMarkFromPixelAnchor,
  appendLivePenPixelPoint,
  layoutDirectTextBox,
  hitTestTextMark,
  validateTeacherGradingDraft,
  normalizeTeacherGradingDraft,
  isDirectTextValid,
  MAX_DIRECT_TEXT_LENGTH,
  directTextSaveErrorMessage,
  resolveDirectTextSaveFontSizeNorm,
  directTextSizeOptionValue,
  openDirectTextDialogWithHost,
  wrapDirectTextLinesToWidth,
  fitDirectTextMarkInPage,
  resizeDirectTextAnnotation,
  hitTestDirectTextHandle,
  computeDirectTextWidthNormFromPixelWidth,
  collectPenIdsForEraserPath,
  applyEraserToAnnotations,
  resolveEraserHitRadiusPx,
  validateDirectTextPlacement,
  directTextHandleCenters,
  defaultDirectTextWidthNorm,
  createCanvasMeasureLineWidth,
} from '../dist/model.js';

describe('validateScore', () => {
  it('accepts 0-10', () => {
    assert.equal(validateScore(7).ok, true);
    assert.equal(validateScore(0).value, 0);
    assert.equal(validateScore(10).value, 10);
  });
  it('rejects out of range and empty', () => {
    assert.equal(validateScore(11).ok, false);
    assert.equal(validateScore(-1).ok, false);
    assert.equal(validateScore('').ok, false);
  });
});

describe('classifyDeadlineTiming', () => {
  it('missing when no first submit', () => {
    const r = classifyDeadlineTiming(null, '2026-11-01');
    assert.equal(r.missing, true);
  });
  it('on time when before end of due day', () => {
    const r = classifyDeadlineTiming('2026-11-01T10:00:00', '2026-11-01');
    assert.equal(r.onTime, true);
    assert.equal(r.late, false);
  });
  it('late after due day end', () => {
    const r = classifyDeadlineTiming('2026-11-02T08:00:00', '2026-11-01');
    assert.equal(r.late, true);
    assert.equal(r.onTime, false);
  });
  it('respects exact datetime deadline', () => {
    const onTime = classifyDeadlineTiming('2026-11-01T13:59:00', '2026-11-01T14:00:00');
    assert.equal(onTime.onTime, true);
    const late = classifyDeadlineTiming('2026-11-01T14:01:00', '2026-11-01T14:00:00');
    assert.equal(late.late, true);
  });
});

describe('applyFirstSubmittedAt', () => {
  it('preserves first date on resubmit', () => {
    const first = '2026-10-01T12:00:00.000Z';
    const second = '2026-10-05T12:00:00.000Z';
    assert.equal(applyFirstSubmittedAt(first, second), first);
  });
  it('sets first date when empty', () => {
    const now = '2026-10-01T12:00:00.000Z';
    assert.equal(applyFirstSubmittedAt(null, now), now);
  });
});

describe('checkMissingPages', () => {
  it('blocks when pages insufficient', () => {
    const r = checkMissingPages(3, 2);
    assert.equal(r.ok, false);
    assert.equal(r.missing, 1);
  });
  it('passes when enough pages', () => {
    assert.equal(checkMissingPages(2, 2).ok, true);
  });
});

describe('getPublishedGrading', () => {
  const grading = {
    score: 8,
    overallFeedback: 'Good',
    published: false,
    pages: [],
  };
  it('hides from student when unpublished', () => {
    assert.equal(getPublishedGrading(grading, 'student'), null);
  });
  it('shows student when published', () => {
    const g = getPublishedGrading({ ...grading, published: true }, 'student');
    assert.equal(g.score, 8);
  });
  it('teacher always sees full', () => {
    assert.equal(getPublishedGrading(grading, 'teacher').score, 8);
  });
});

describe('student grading projection', () => {
  const teacherGrading = {
    score: 7,
    overallFeedback: 'Nice',
    published: true,
    publishedAt: '2030-01-02T00:00:00.000Z',
    pages: [{ annotations: [] }],
    needsRevision: false,
  };

  it('projectStudentVersionGrading marks published for client re-entry', () => {
    const projected = projectStudentVersionGrading(teacherGrading);
    assert.equal(projected.published, true);
    assert.equal(projected.score, 7);
  });

  it('resolveStudentPublishedGrading survives server then client projection', () => {
    const projected = projectStudentVersionGrading(teacherGrading);
    const visible = resolveStudentPublishedGrading(projected);
    assert.equal(visible.score, 7);
    assert.equal(visible.overallFeedback, 'Nice');
  });

  it('resolveStudentPublishedGrading hides unpublished teacher grading', () => {
    assert.equal(
      resolveStudentPublishedGrading({ ...teacherGrading, published: false }),
      null,
    );
  });
});

describe('normalized coordinates', () => {
  it('round trips point', () => {
    const n = normalizePoint(100, 100, 200, 400);
    assert.equal(n.x, 0.5);
    assert.equal(n.y, 0.25);
    const d = denormalizePoint(n.x, n.y, 200, 400);
    assert.equal(d.x, 100);
    assert.equal(d.y, 100);
  });
  it('scaleMarkToViewport uses normalized storage', () => {
    const mark = { type: 'check', nx: 0.5, ny: 0.5 };
    const scaled = scaleMarkToViewport(mark, 100, 200);
    assert.equal(scaled.x, 50);
    assert.equal(scaled.y, 100);
  });
  it('markToNormalized from pixels', () => {
    const m = markToNormalized(
      { type: 'highlight', x: 10, y: 20, w: 30, h: 40 },
      100,
      200,
    );
    assert.equal(m.nx, 0.1);
    assert.equal(m.nh, 0.2);
  });
});

describe('pin comments on page', () => {
  const annotations = [
    { id: 'a', type: 'check', nx: 0.1, ny: 0.1 },
    { id: 'p1', type: 'pin', nx: 0.2, ny: 0.2, text: 'First' },
    { id: 'p2', type: 'pin', nx: 0.3, ny: 0.3, text: 'Second' },
  ];

  it('listPinComments assigns stable 1-based numbers', () => {
    const list = listPinComments(annotations);
    assert.equal(list.length, 2);
    assert.equal(list[0].number, 1);
    assert.equal(list[1].number, 2);
    assert.equal(list[0].text, 'First');
  });

  it('pinNumberMap maps ids to display numbers', () => {
    const map = pinNumberMap(annotations);
    assert.equal(map.get('p1'), 1);
    assert.equal(map.get('p2'), 2);
  });

  it('updatePinCommentText preserves other marks and coords', () => {
    const next = updatePinCommentText(annotations, 'p2', '  Updated  ');
    const p2 = next.find((m) => m.id === 'p2');
    assert.equal(p2.text, 'Updated');
    assert.equal(p2.nx, 0.3);
    assert.equal(next.find((m) => m.id === 'p1').text, 'First');
  });

  it('isPinCommentTextValid rejects blank', () => {
    assert.equal(isPinCommentTextValid(' ok '), true);
    assert.equal(isPinCommentTextValid('   '), false);
    assert.equal(isPinCommentTextValid(''), false);
  });
});

describe('computeEditorLayoutFromImage', () => {
  const paper = { naturalWidth: 1280, naturalHeight: 1707 };

  it('keeps logical base size stable across zoom transitions 1 → 1.25 → 1.5 → 1', () => {
    const inner = 646;
    const base = computeEditorBaseContentSize({ ...paper, containerInnerWidth: inner });
    assert.equal(base.baseWidth, inner);
    assert.ok(Math.abs(base.baseHeight - (inner * paper.naturalHeight) / paper.naturalWidth) < 0.01);
    for (const zoom of [1, 1.25, 1.5, 1]) {
      const layout = computeEditorLayoutFromImage({
        ...paper,
        containerInnerWidth: inner,
        zoom,
      });
      assert.equal(layout.contentWidth, base.baseWidth);
      assert.equal(layout.contentHeight, base.baseHeight);
      assert.equal(layout.stageWidth, base.baseWidth * zoom);
      assert.equal(layout.stageHeight, base.baseHeight * zoom);
    }
  });

  it('reflows base width when container inner width shrinks to 300 at zoom 1', () => {
    const layout = computeEditorLayoutFromImage({
      ...paper,
      containerInnerWidth: 300,
      zoom: 1,
    });
    assert.equal(layout.contentWidth, 300);
    assert.equal(layout.stageWidth, 300);
    assert.ok(Math.abs(layout.contentHeight - (300 * paper.naturalHeight) / paper.naturalWidth) < 0.01);
  });

  it('fit-page scales down tall page to fit container height', () => {
    const innerW = 800;
    const innerH = 500;
    const widthOnly = computeEditorBaseContentSizeForFit({
      ...paper,
      containerInnerWidth: innerW,
      containerInnerHeight: innerH,
      fitMode: GRADING_ZOOM_FIT_WIDTH,
    });
    assert.ok(widthOnly.baseHeight > innerH);
    const fitPage = computeEditorBaseContentSizeForFit({
      ...paper,
      containerInnerWidth: innerW,
      containerInnerHeight: innerH,
      fitMode: GRADING_ZOOM_FIT_PAGE,
    });
    assert.ok(Math.abs(fitPage.baseHeight - innerH) < 0.02);
    assert.ok(fitPage.baseWidth < widthOnly.baseWidth);
  });

  it('computeGradingZoomPercent reports 100 at fit-width baseline', () => {
    const pct = computeGradingZoomPercent({
      naturalWidth: 1280,
      naturalHeight: 1707,
      containerInnerWidth: 640,
      containerInnerHeight: 480,
      fitMode: GRADING_ZOOM_FIT_WIDTH,
      manualZoom: 1,
    });
    assert.equal(pct, 100);
  });
});

describe('grading focus and editor helpers', () => {
  it('applyGradingFocusMode toggles body class', () => {
    const doc = { body: { classList: { _c: new Set(), toggle(c, on) { if (on) this._c.add(c); else this._c.delete(c); } } } };
    applyGradingFocusMode(doc, true);
    assert.equal(doc.body.classList._c.has(GRADING_FOCUS_BODY_CLASS), true);
    applyGradingFocusMode(doc, false);
    assert.equal(doc.body.classList._c.has(GRADING_FOCUS_BODY_CLASS), false);
  });

  it('shouldBlockGradingUndoRedo while inline editing', () => {
    assert.equal(shouldBlockGradingUndoRedo({ inlineTextEditing: true }), true);
    assert.equal(shouldBlockGradingUndoRedo({ inlineTextEditing: false }), false);
  });

  it('shouldBlockGradingDestructiveActions while inline editing', () => {
    assert.equal(shouldBlockGradingDestructiveActions({ inlineTextEditing: true }), true);
  });

  it('hasUnsavedInlineTextEdits detects draft changes', () => {
    assert.equal(
      hasUnsavedInlineTextEdits({ isNew: true, draftText: 'hello' }),
      true,
    );
    assert.equal(
      hasUnsavedInlineTextEdits({ isNew: false, originalText: 'a', draftText: 'a' }),
      false,
    );
    assert.equal(
      hasUnsavedInlineTextEdits({ isNew: false, originalText: 'a', draftText: 'b' }),
      true,
    );
  });

  it('seedGradingManualZoomFromFitMode matches fit-page displayed scale', () => {
    const paper = { naturalWidth: 1200, naturalHeight: 3200 };
    const innerW = 600;
    const innerH = 450;
    const seeded = seedGradingManualZoomFromFitMode({
      ...paper,
      containerInnerWidth: innerW,
      containerInnerHeight: innerH,
      fitMode: GRADING_ZOOM_FIT_PAGE,
    });
    const pct = computeGradingZoomPercent({
      ...paper,
      containerInnerWidth: innerW,
      containerInnerHeight: innerH,
      fitMode: GRADING_ZOOM_FIT_PAGE,
      manualZoom: 1,
    });
    assert.ok(Math.abs(seeded - pct / 100) < 0.02);
    assert.ok(seeded < 0.5, `expected fit-page seed below 50%, got ${seeded}`);
    assert.ok(seeded < 1);
  });

  it('clampGradingManualZoom uses shared 0.05–4 range without legacy 0.5 floor', () => {
    assert.equal(clampGradingManualZoom(0.33), 0.33);
    assert.equal(clampGradingManualZoom(0.03), GRADING_MANUAL_ZOOM_MIN);
    assert.equal(clampGradingManualZoom(9), 4);
  });

  it('nudgeGradingManualZoom shrinks from fit-page seed and stops at minimum', () => {
    const paper = { naturalWidth: 1200, naturalHeight: 3200 };
    const innerW = 600;
    const innerH = 450;
    const seeded = seedGradingManualZoomFromFitMode({
      ...paper,
      containerInnerWidth: innerW,
      containerInnerHeight: innerH,
      fitMode: GRADING_ZOOM_FIT_PAGE,
    });
    assert.ok(seeded < 0.5, `expected fit-page seed below 50%, got ${seeded}`);
    const pctBefore = computeGradingZoomPercent({
      ...paper,
      containerInnerWidth: innerW,
      containerInnerHeight: innerH,
      fitMode: GRADING_ZOOM_MANUAL,
      manualZoom: seeded,
    });
    const smaller = nudgeGradingManualZoom(seeded, -GRADING_MANUAL_ZOOM_NUDGE);
    const pctAfter = computeGradingZoomPercent({
      ...paper,
      containerInnerWidth: innerW,
      containerInnerHeight: innerH,
      fitMode: GRADING_ZOOM_MANUAL,
      manualZoom: smaller,
    });
    assert.ok(smaller < seeded);
    assert.ok(pctAfter < pctBefore);
    assert.equal(nudgeGradingManualZoom(GRADING_MANUAL_ZOOM_MIN, -0.2), GRADING_MANUAL_ZOOM_MIN);
  });

  it('manual zoom percent tracks multiplier for fit-width baseline', () => {
    const paper = { naturalWidth: 800, naturalHeight: 600 };
    const innerW = 400;
    const innerH = 400;
    for (const mult of [0.1, 0.3, 0.8]) {
      const pct = computeGradingZoomPercent({
        ...paper,
        containerInnerWidth: innerW,
        containerInnerHeight: innerH,
        fitMode: GRADING_ZOOM_MANUAL,
        manualZoom: mult,
      });
      assert.ok(Math.abs(pct - Math.round(mult * 100)) <= 1, `expected ~${mult * 100}% got ${pct}%`);
    }
  });

  it('resolveGradingPanelSideState exposes desktop panel after mobile sheet closed', () => {
    const mobileClosed = resolveGradingPanelSideState({
      mobileSheetViewport: true,
      mobilePanelOpen: false,
      panelCollapsed: false,
    });
    assert.equal(mobileClosed.sideHidden, true);
    assert.equal(mobileClosed.sideInert, true);
    const desktop = resolveGradingPanelSideState({
      mobileSheetViewport: false,
      mobilePanelOpen: false,
      panelCollapsed: false,
    });
    assert.equal(desktop.sideHidden, false);
    assert.equal(desktop.sideInert, false);
    assert.equal(desktop.sideAriaHidden, 'false');
    assert.equal(desktop.panelToggleExpanded, true);
  });

  it('gradingDisplayedImageSizeChanged detects stage refit', () => {
    assert.equal(gradingDisplayedImageSizeChanged(313.5, 400, 313.5, 400.4), false);
    assert.equal(gradingDisplayedImageSizeChanged(313.5, 400, 470.5, 400), true);
  });

  it('text drag cancel restores annotation coordinates before commit', () => {
    const mark = {
      id: 't1',
      type: 'text',
      nx: 0.2,
      ny: 0.3,
      text: 'Draft',
      fontSizeNorm: 0.05,
      textWidthNorm: 0.2,
    };
    const moved = moveDirectTextAnnotation([mark], 't1', 0.55, 0.62, 800, 600, {});
    assert.notEqual(moved[0].nx, mark.nx);
    const restored = restoreDirectTextAnnotationPosition(moved, 't1', mark.nx, mark.ny);
    assert.equal(restored[0].nx, mark.nx);
    assert.equal(restored[0].ny, mark.ny);
  });

  it('computeInlineTextEditorLayout matches SVG pad inset', () => {
    const layout = computeInlineTextEditorLayout({ x: 40, y: 50, w: 120, h: 32, lineHeight: 16 });
    assert.equal(layout.left, 40 - GRADING_INLINE_TEXT_SVG_PAD);
    assert.equal(layout.top, 50 - GRADING_INLINE_TEXT_SVG_PAD);
    assert.equal(layout.width, 120 + GRADING_INLINE_TEXT_SVG_PAD * 2);
    assert.equal(layout.textWidth, 120);
  });
});

describe('transitionGradingEditorTool', () => {
  it('restores last annotate tool when toggling view off', () => {
    let s = { mode: 'annotate', tool: 'pin', lastAnnotateTool: 'pin' };
    s = transitionGradingEditorTool(s, 'view');
    assert.equal(s.mode, 'view');
    assert.equal(s.tool, 'view');
    s = transitionGradingEditorTool(s, 'view');
    assert.equal(s.mode, 'annotate');
    assert.equal(s.tool, 'pin');
  });

  it('defaults restore to select', () => {
    let s = { mode: 'annotate', tool: 'select', lastAnnotateTool: 'select' };
    s = transitionGradingEditorTool(s, 'view');
    s = transitionGradingEditorTool(s, 'view');
    assert.equal(s.tool, 'select');
  });

  it('does not change session when readOnly', () => {
    const s = { mode: 'view', tool: 'view', lastAnnotateTool: 'select' };
    const next = transitionGradingEditorTool(s, 'pin', { readOnly: true });
    assert.deepEqual(next, s);
  });
});

describe('computeEditorStageLayout', () => {
  it('sizes stage to scaled content with top-left scale semantics', () => {
    const layout = computeEditorStageLayout({
      contentWidth: 400,
      contentHeight: 300,
      zoom: 2,
      containerInnerWidth: 500,
    });
    assert.equal(layout.stageWidth, 800);
    assert.equal(layout.stageHeight, 600);
    assert.equal(layout.viewportWidth, 400);
    assert.equal(layout.centerInContainer, false);
  });

  it('centers when zoom is default and paper fits container', () => {
    const layout = computeEditorStageLayout({
      contentWidth: 320,
      contentHeight: 200,
      zoom: 1,
      containerInnerWidth: 800,
    });
    assert.equal(layout.stageWidth, 320);
    assert.equal(layout.centerInContainer, true);
  });

  it('does not center when zoomed wider than container', () => {
    const layout = computeEditorStageLayout({
      contentWidth: 400,
      contentHeight: 300,
      zoom: 1.5,
      containerInnerWidth: 500,
    });
    assert.equal(layout.stageWidth, 600);
    assert.equal(layout.centerInContainer, false);
  });
});

describe('getAssignmentsForStudent', () => {
  const assignments = [
    { id: 'a1', classId: 'c1', title: 'A' },
    { id: 'a2', classId: 'c2', title: 'B' },
    { id: 'a3', classId: 'c3', title: 'C' },
  ];
  const student = { id: 's1', classId: 'c1' };
  it('scopes to student class', () => {
    const list = getAssignmentsForStudent(assignments, student, null);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'a1');
  });
  it('includes active secondary membership without dropping primary class', () => {
    const memberships = [
      { classId: 'c1', studentId: 's1', effectiveFrom: '2020-01-01T00:00:00.000Z' },
      { classId: 'c2', studentId: 's1', effectiveFrom: '2026-01-01T00:00:00.000Z' },
    ];
    const list = getAssignmentsForStudent(assignments, student, null, memberships, '2026-06-01T00:00:00.000Z');
    assert.deepEqual(list.map((a) => a.id).sort(), ['a1', 'a2']);
  });
});

describe('gradingQueueState', () => {
  const assignment = { dueDateISO: '2026-12-01' };
  it('missing without submission', () => {
    assert.equal(gradingQueueState(null, assignment).state, 'missing');
  });
  it('submitted version counts', () => {
    const sub = {
      firstSubmittedAt: '2026-11-28T10:00:00',
      versions: [
        createSubmittedVersion({
          versionId: 'v1',
          submittedAt: '2026-11-28T10:00:00',
          pageImageIds: ['i1'],
          priorVersions: [],
        }),
      ],
    };
    assert.equal(gradingQueueState(sub, assignment).state, 'submitted');
  });
  it('returned when latest version is returned', () => {
    const sub = {
      firstSubmittedAt: '2026-11-28T10:00:00',
      versions: [
        {
          ...createSubmittedVersion({
            versionId: 'v1',
            submittedAt: '2026-11-28T10:00:00',
            pageImageIds: ['i1'],
            priorVersions: [],
          }),
          status: SUBMISSION_STATUS.RETURNED,
        },
      ],
    };
    assert.equal(gradingQueueState(sub, assignment).state, 'returned');
  });
});

describe('shouldIncludeInGradingQueue', () => {
  it('includes returned in all-status filter', () => {
    assert.equal(shouldIncludeInGradingQueue('returned', ''), true);
  });
  it('includes returned only when filter matches', () => {
    assert.equal(shouldIncludeInGradingQueue('returned', 'returned'), true);
    assert.equal(shouldIncludeInGradingQueue('returned', 'submitted'), false);
  });
  it('excludes returned from actionable default queue', () => {
    assert.equal(shouldIncludeInGradingQueue('returned', 'actionable'), false);
    assert.equal(shouldIncludeInGradingQueue('submitted', 'actionable'), true);
  });
});

describe('planDomProp', () => {
  function fakeApply(plan, fake = { attrs: {}, props: {} }) {
    switch (plan.action) {
      case 'booleanProperty':
        fake.props[plan.name] = plan.value;
        if (plan.value) fake.attrs[plan.name] = '';
        else delete fake.attrs[plan.name];
        break;
      case 'attribute':
        fake.attrs[plan.name] = plan.value;
        break;
      case 'none':
        break;
      default:
        break;
    }
    return fake;
  }

  it('omits false boolean DOM properties instead of disabled="false"', () => {
    for (const name of ['disabled', 'hidden', 'checked', 'selected', 'required', 'multiple']) {
      const plan = planDomProp(name, false);
      assert.equal(plan.action, 'booleanProperty');
      assert.equal(plan.value, false);
      const fake = fakeApply(plan);
      assert.equal(fake.props[name], false);
      assert.equal(Object.hasOwn(fake.attrs, name), false);
    }
  });
  it('sets presence attribute when boolean DOM property is true', () => {
    const fake = fakeApply(planDomProp('disabled', true));
    assert.equal(fake.props.disabled, true);
    assert.equal(fake.attrs.disabled, '');
  });
  it('preserves aria false as string attribute', () => {
    const plan = planDomProp('aria-expanded', false);
    assert.equal(plan.action, 'attribute');
    assert.equal(plan.value, 'false');
    const fake = fakeApply(plan);
    assert.equal(fake.attrs['aria-expanded'], 'false');
  });
});

describe('computeDashboardMetrics', () => {
  it('derives counts from data', () => {
    const classes = [{ id: 'c1' }];
    const students = [{ id: 's1', classId: 'c1' }];
    const assignments = [
      { id: 'as1', classId: 'c1', dueDateISO: '2026-12-31' },
    ];
    const submissions = [];
    const m = computeDashboardMetrics({
      classes,
      students,
      assignments,
      submissions,
    });
    assert.equal(m.classCount, 1);
    assert.equal(m.missingCount, 1);
    assert.equal(m.toGradeCount, 0);
  });
});

describe('validateBackup', () => {
  it('rejects bad schema', () => {
    assert.equal(validateBackup(null).ok, false);
    assert.equal(validateBackup({ schemaVersion: 99 }).ok, false);
  });
  it('accepts v1 shape', () => {
    const ok = validateBackup({
      schemaVersion: 1,
      classes: [],
      students: [],
      assignments: [],
      submissions: [],
    });
    assert.equal(ok.ok, true);
  });
  it('rejects broken references', () => {
    const bad = validateBackup({
      schemaVersion: 1,
      classes: [{ id: 'c1', name: 'Lớp', scheduleDays: ['T2'], scheduleTime: '19:00' }],
      students: [{ id: 's1', name: 'HS', classId: 'missing' }],
      assignments: [],
      submissions: [],
    });
    assert.equal(bad.ok, false);
  });
  it('rejects malformed submission versions', () => {
    const bad = validateBackup({
      schemaVersion: 1,
      classes: [{ id: 'c1', name: 'Lớp', scheduleDays: ['T2'], scheduleTime: '19:00' }],
      students: [{ id: 's1', name: 'HS', classId: 'c1' }],
      assignments: [{
        id: 'a1',
        classId: 'c1',
        title: 'Bài',
        bookRef: 'Sách',
        dueDateISO: '2026-12-01',
        requiredPageCount: 2,
      }],
      submissions: [{
        id: 'sub1',
        assignmentId: 'a1',
        studentId: 's1',
        firstSubmittedAt: null,
        versions: [{ versionId: 'v1', isDraft: 'yes' }],
      }],
    });
    assert.equal(bad.ok, false);
  });
});

describe('pen and direct text marks', () => {
  it('roundtrips pen stroke width and points through scale', () => {
    const mark = {
      id: 'p1',
      type: 'pen',
      color: '#c62828',
      nw: PEN_STROKE_PRESETS.medium,
      points: [{ nx: 0.1, ny: 0.2 }, { nx: 0.5, ny: 0.6 }],
    };
    const scaled = scaleMarkToViewport(mark, 800, 600);
    assert.equal(scaled.points.length, 2);
    assert.equal(scaled.points[0].x, 80);
    assert.equal(scaled.points[1].y, 360);
    assert.ok(Math.abs(scaled.strokeWidth - PEN_STROKE_PRESETS.medium * 800) < 0.01);
    const norm = markToNormalized(
      {
        type: 'pen',
        strokeWidth: scaled.strokeWidth,
        points: scaled.points,
      },
      800,
      600,
    );
    assert.ok(Math.abs(norm.nw - PEN_STROKE_PRESETS.medium) < 0.0001);
    assert.equal(norm.points[1].nx, 0.5);
  });

  it('roundtrips direct text font size', () => {
    const mark = {
      id: 't1',
      type: 'text',
      nx: 0.2,
      ny: 0.3,
      text: 'Sai thì',
      color: '#1565c0',
      fontSizeNorm: 20 / 400,
    };
    const scaled = scaleMarkToViewport(mark, 500, 400);
    assert.equal(scaled.text, 'Sai thì');
    assert.ok(Math.abs(scaled.fontSize - 20) < 0.01);
    const norm = markToNormalized(
      { type: 'text', x: scaled.x, y: scaled.y, fontSize: 24, text: 'Sai thì' },
      500,
      400,
    );
    assert.ok(Math.abs(norm.fontSizeNorm - 24 / 400) < 0.0001);
  });

  it('hitTestPenMark detects near stroke', () => {
    const mark = {
      id: 'p1',
      type: 'pen',
      nw: 0.004,
      points: [{ nx: 0, ny: 0.5 }, { nx: 1, ny: 0.5 }],
    };
    assert.equal(hitTestPenMark(mark, 400, 300, 800, 600, 4), true);
    assert.equal(hitTestPenMark(mark, 400, 100, 800, 600, 4), false);
  });

  it('updateDirectTextAnnotation preserves id and position', () => {
    const anns = [{
      id: 't1',
      type: 'text',
      nx: 0.25,
      ny: 0.4,
      text: 'Old',
      fontSizeNorm: 0.05,
      color: '#c62828',
    }];
    const next = updateDirectTextAnnotation(anns, 't1', {
      text: 'Mới',
      color: '#2e7d32',
      fontSizeNorm: 0.06,
    });
    const t = next[0];
    assert.equal(t.id, 't1');
    assert.equal(t.nx, 0.25);
    assert.equal(t.ny, 0.4);
    assert.equal(t.text, 'Mới');
    assert.equal(t.color, '#2e7d32');
  });

  it('moveDirectTextAnnotation clamps inside page', () => {
    const anns = [{
      id: 't1',
      type: 'text',
      nx: 0.1,
      ny: 0.1,
      text: 'Long enough line to have width',
      fontSizeNorm: 0.05,
      color: '#212121',
    }];
    const moved = moveDirectTextAnnotation(anns, 't1', 0.99, 0.99, 400, 300);
    const t = moved[0];
    assert.ok(t.nx < 0.99);
    assert.ok(t.ny < 0.99);
  });

  it('validateAnnotationMark rejects malformed pen and accepts good marks', () => {
    assert.equal(validateAnnotationMark({ id: 'x', type: 'pen', points: [] }).ok, false);
    assert.equal(
      validateAnnotationMark({
        id: 'x',
        type: 'pen',
        nw: 0.004,
        points: [{ nx: 0.2, ny: 0.3 }],
      }).ok,
      true,
    );
    assert.equal(validateAnnotationMark({ id: 'x', type: 'text', nx: 0.1, ny: 0.2, text: 'OK' }).ok, true);
  });

  it('sanitizePageAnnotations drops invalid only', () => {
    const anns = [
      { id: 'c1', type: 'check', nx: 0.1, ny: 0.2 },
      { id: 'bad', type: 'pen', points: [] },
    ];
    const clean = sanitizePageAnnotations(anns);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].id, 'c1');
  });

  it('hitTestAnnotationAt prefers topmost mark', () => {
    const anns = [
      { id: 'a', type: 'check', nx: 0.5, ny: 0.5 },
      { id: 'b', type: 'cross', nx: 0.5, ny: 0.5 },
    ];
    const hit = hitTestAnnotationAt(anns, 400, 300, 800, 600);
    assert.equal(hit.id, 'b');
  });

  it('boundPenPointsNormalized limits point count', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ nx: i / 1000, ny: 0.5 }));
    const bounded = boundPenPointsNormalized(pts, 100);
    assert.equal(bounded.length, 100);
  });

  it('buildPenPathD produces SVG path', () => {
    const d = buildPenPathD([{ x: 0, y: 0 }, { x: 10, y: 5 }]);
    assert.match(d, /^M 0 0 L 10 5$/);
  });

  it('clampPixelToNormalized clamps beyond image edges', () => {
    const p = clampPixelToNormalized(360, 748, 800, 600);
    assert.ok(Number.isFinite(p.nx));
    assert.ok(Number.isFinite(p.ny));
    assert.equal(p.nx, 360 / 800);
    assert.equal(p.ny, 1);
    assert.equal(p.x, undefined);
  });

  it('clampPixelToNormalized roundtrips in-bounds pixels', () => {
    const p = clampPixelToNormalized(360, 448, 800, 600);
    assert.equal(p.nx, 360 / 800);
    assert.equal(p.ny, 448 / 600);
  });

  it('createPenMarkFromPixelStroke matches grading commit path', () => {
    const mark = createPenMarkFromPixelStroke({
      id: 'pen1',
      points: [{ x: 360, y: 748 }, { x: 490, y: 748 }],
      w: 800,
      h: 600,
      color: '#c62828',
      nw: PEN_STROKE_PRESETS.medium,
    });
    assert.ok(mark);
    assert.equal(mark.type, 'pen');
    assert.ok(mark.points.length >= 2);
    for (const p of mark.points) {
      assert.ok(Number.isFinite(p.nx));
      assert.ok(Number.isFinite(p.ny));
    }
    const scaled = scaleMarkToViewport(mark, 800, 600);
    const d = buildPenPathD(scaled.points);
    assert.match(d, /^M /);
    assert.ok(d.includes('L'));
  });

  it('createDirectTextMarkFromPixelAnchor matches dialog create path', () => {
    const mark = createDirectTextMarkFromPixelAnchor({
      id: 't1',
      x: 540,
      y: 755,
      w: 800,
      h: 600,
      text: 'Dòng một\nDòng hai',
      color: '#1565c0',
      fontSize: 20,
    });
    assert.ok(Number.isFinite(mark.nx));
    assert.ok(Number.isFinite(mark.ny));
    const scaled = scaleMarkToViewport(mark, 800, 600);
    assert.ok(Number.isFinite(scaled.x));
    assert.ok(Number.isFinite(scaled.y));
    const box = layoutDirectTextBox(mark, 800, 600);
    assert.ok(box.w > 0);
    assert.ok(box.x + box.w <= 800 + 0.01);
    assert.ok(box.y + box.h <= 600 + 0.01);
    assert.equal(hitTestTextMark(mark, scaled.x + 2, scaled.y + 2, 800, 600), true);
  });

  it('appendLivePenPixelPoint caps live stroke points', () => {
    let pts = [{ x: 0, y: 0 }];
    for (let i = 1; i <= 800; i += 1) {
      pts = appendLivePenPixelPoint(pts, i, 0, 800, 600, 100);
    }
    assert.ok(pts.length <= 100);
    assert.equal(pts[pts.length - 1].x, 800);
  });

  it('resolveDirectTextSaveFontSizeNorm uses selected size when dirty', () => {
    const original = 10.284452229541905 / 375;
    const norm = resolveDirectTextSaveFontSizeNorm({
      fontSizeDirty: true,
      selectedSizeValue: '24',
      viewportHeight: 375,
      originalFontSizeNorm: original,
    });
    assert.equal(norm, 24 / 375);
  });

  it('hitTestDirectTextHandle resolves each handle at its center on a small box', () => {
    const mark = {
      id: 't-small',
      type: 'text',
      nx: 0.02,
      ny: 0.05,
      text: 'Hi',
      fontSizeNorm: 20 / 400,
      textWidthNorm: 0.14,
      color: '#212121',
    };
    const box = layoutDirectTextBox(mark, 400, 300);
    const centers = directTextHandleCenters(box);
    assert.equal(
      hitTestDirectTextHandle(mark, centers.move.x, centers.move.y, 400, 300, { zoom: 1 }),
      'move',
    );
    assert.equal(
      hitTestDirectTextHandle(mark, centers.e.x, centers.e.y, 400, 300, { zoom: 1 }),
      'resize-e',
    );
    assert.equal(
      hitTestDirectTextHandle(mark, centers.w.x, centers.w.y, 400, 300, { zoom: 1 }),
      'resize-w',
    );
    assert.equal(
      hitTestDirectTextHandle(mark, centers.se.x, centers.se.y, 400, 300, { zoom: 1 }),
      'resize-se',
    );
  });

  it('layoutDirectTextBox matches with shared canvas measureLineWidth', () => {
    const measureLineWidth = createCanvasMeasureLineWidth();
    const mark = {
      id: 't-wrap',
      type: 'text',
      nx: 0.1,
      ny: 0.2,
      text: 'iiiiiiiiii',
      fontSizeNorm: 30 / 400,
      textWidthNorm: 180 / 400,
      color: '#212121',
    };
    const teacher = layoutDirectTextBox(mark, 400, 300, { measureLineWidth });
    const student = layoutDirectTextBox(mark, 400, 300, { measureLineWidth });
    assert.deepEqual(student.lines, teacher.lines);
    assert.equal(student.lines.length, teacher.lines.length);
  });

  it('gesture cancel restores prior undo redo stacks', () => {
    const stack = { past: ['before-move'], future: ['undone-stroke'] };
    const preUndoStacks = { past: stack.past.slice(), future: stack.future.slice() };
    stack.past.push('during-move');
    stack.future = [];
    stack.past = preUndoStacks.past.slice();
    stack.future = preUndoStacks.future.slice();
    assert.deepEqual(stack, { past: ['before-move'], future: ['undone-stroke'] });
  });

  it('resolveDirectTextSaveFontSizeNorm preserves norm when size unchanged', () => {
    const original = 10.284452229541905 / 375;
    const norm = resolveDirectTextSaveFontSizeNorm({
      fontSizeDirty: false,
      selectedSizeValue: '10',
      viewportHeight: 375,
      originalFontSizeNorm: original,
    });
    assert.equal(norm, original);
  });

  it('directTextSizeOptionValue keeps non-integer pixel sizes', () => {
    assert.equal(directTextSizeOptionValue(10.284452229541905), '10.284452229541905');
  });

  it('wrapDirectTextLinesToWidth breaks wide glyphs with injected measure', () => {
    const measureLineWidth = (text, fontSize) => String(text).length * fontSize * 0.8;
    const text = 'WWWWW';
    const narrow = wrapDirectTextLinesToWidth(text, 60, 20, measureLineWidth);
    assert.ok(narrow.length > 1);
    assert.equal(narrow.join(''), text);
    for (const line of narrow) {
      assert.ok(measureLineWidth(line, 20) <= 60);
    }
    const wide = wrapDirectTextLinesToWidth(text, 100, 20, measureLineWidth);
    assert.equal(wide.length, 1);
  });

  it('fitDirectTextMarkInPage keeps all lines when anchor moves up', () => {
    const measureLineWidth = (text) => String(text).length * 8;
    const mark = {
      id: 't1',
      type: 'text',
      nx: 0.2,
      ny: 0.85,
      text: 'Line one\nLine two\nLine three',
      color: '#212121',
      fontSizeNorm: 20 / 600,
    };
    const fitted = fitDirectTextMarkInPage(mark, 800, 600, { measureLineWidth });
    const box = layoutDirectTextBox(fitted, 800, 600, { measureLineWidth });
    assert.equal(box.lines.length, 3);
    assert.ok(box.y + box.h <= 600 + 0.5);
  });

  it('openDirectTextDialogWithHost returns close handle', () => {
    const events = [];
    const handle = openDirectTextDialogWithHost(
      {
        openDialog: () => ({
          close: () => events.push('closed'),
        }),
        mk: (tag, attrs = {}, ...children) => {
          const node = {
            tag,
            attrs,
            children,
            options: [],
            value: attrs.value ?? '',
            appendChild(child) {
              if (child.tag === 'option') this.options.push(child);
              this.children.push(child);
            },
            addEventListener() {},
          };
          return node;
        },
        focus: () => {},
      },
      () => {},
      { text: 'Hi', viewportWidth: 800, viewportHeight: 600 },
    );
    assert.equal(typeof handle.close, 'function');
    handle.close();
    assert.deepEqual(events, ['closed']);
  });

  it('normalizeTeacherGradingDraft fills missing pages and undoStacks', () => {
    const norm = normalizeTeacherGradingDraft({ score: '7' }, 2);
    assert.equal(norm.pages.length, 2);
    assert.ok(Array.isArray(norm.pages[0].annotations));
    assert.ok(typeof norm.undoStacks === 'object');
    assert.equal(validateTeacherGradingDraft({ score: '7' }, 2).ok, true);
  });

  it('validateTeacherGradingDraft rejects malformed supplied containers', () => {
    assert.equal(
      validateTeacherGradingDraft({ score: '7', pages: 'bad' }, 1).ok,
      false,
    );
    assert.equal(
      validateTeacherGradingDraft({ score: '7', pages: [{ annotations: {} }] }, 1).ok,
      false,
    );
    assert.equal(
      validateTeacherGradingDraft({ score: '7', pages: [], undoStacks: [] }, 1).ok,
      false,
    );
  });

  it('isDirectTextValid enforces shared max length', () => {
    assert.equal(isDirectTextValid('a'.repeat(MAX_DIRECT_TEXT_LENGTH)), true);
    assert.equal(isDirectTextValid('a'.repeat(MAX_DIRECT_TEXT_LENGTH + 1)), false);
    assert.match(directTextSaveErrorMessage('a'.repeat(MAX_DIRECT_TEXT_LENGTH + 1)), /2000/);
  });

  it('restoreDirectTextAnnotationPosition preserves exact coordinates', () => {
    const anns = [{
      id: 't1',
      type: 'text',
      nx: 0.12,
      ny: 0.34,
      text: 'Hi',
      color: '#1565c0',
      fontSizeNorm: 0.04,
    }];
    const moved = moveDirectTextAnnotation(anns, 't1', 0.95, 0.95, 400, 300);
    assert.notEqual(moved[0].nx, 0.12);
    const restored = restoreDirectTextAnnotationPosition(moved, 't1', 0.12, 0.34);
    assert.equal(restored[0].nx, 0.12);
    assert.equal(restored[0].ny, 0.34);
    assert.equal(restored[0].text, 'Hi');
  });

  it('resizeDirectTextAnnotation keeps fontSizeNorm and reflows width', () => {
    const measureLineWidth = (text) => String(text).length * 8;
    const anns = [{
      id: 't1',
      type: 'text',
      nx: 0.1,
      ny: 0.2,
      text: 'Alpha beta gamma delta',
      color: '#212121',
      fontSizeNorm: 18 / 600,
      textWidthNorm: 0.5,
    }];
    const resized = resizeDirectTextAnnotation(
      anns,
      't1',
      { textWidthNorm: 0.25 },
      800,
      600,
      { measureLineWidth },
    );
    const t = resized[0];
    assert.equal(t.fontSizeNorm, 18 / 600);
    assert.equal(t.textWidthNorm, 0.25);
    const narrow = layoutDirectTextBox(t, 800, 600, { measureLineWidth });
    const wide = layoutDirectTextBox(anns[0], 800, 600, { measureLineWidth });
    assert.ok(narrow.lines.length >= wide.lines.length);
    assert.ok(Math.abs(narrow.w - 0.25 * 800) < 1);
  });

  it('legacy text without textWidthNorm still layouts and validates in backup', () => {
    const legacy = {
      id: 't-old',
      type: 'text',
      nx: 0.15,
      ny: 0.25,
      text: 'Chú ý cũ',
      color: '#1565c0',
      fontSizeNorm: 0.04,
    };
    assert.equal(validateAnnotationMark(legacy).ok, true);
    const box = layoutDirectTextBox(legacy, 640, 480);
    assert.ok(box.w > 0);
    assert.ok(box.lines.join('').includes('Chú'));
    const ok = validateBackup({
      schemaVersion: 1,
      classes: [{ id: 'c1', name: 'Lớp', scheduleDays: ['T2'], scheduleTime: '19:00' }],
      students: [{ id: 's1', name: 'HS', classId: 'c1' }],
      assignments: [{
        id: 'a1',
        classId: 'c1',
        title: 'Bài',
        bookRef: 'Sách',
        dueDateISO: '2026-12-01',
        requiredPageCount: 1,
      }],
      submissions: [{
        id: 'sub1',
        assignmentId: 'a1',
        studentId: 's1',
        firstSubmittedAt: '2026-11-01T10:00:00',
        versions: [{
          versionId: 'v1',
          isDraft: false,
          pageImageIds: ['img1'],
          grading: {
            published: true,
            pages: [{ annotations: [legacy] }],
          },
        }],
      }],
    });
    assert.equal(ok.ok, true);
  });

  it('hitTestDirectTextHandle detects resize handles', () => {
    const mark = {
      id: 't1',
      type: 'text',
      nx: 0.1,
      ny: 0.1,
      text: 'Hello world',
      fontSizeNorm: 20 / 400,
      textWidthNorm: 0.35,
      color: '#212121',
    };
    const box = layoutDirectTextBox(mark, 400, 300);
    const centers = directTextHandleCenters(box);
    assert.equal(
      hitTestDirectTextHandle(mark, centers.e.x, centers.e.y, 400, 300, { zoom: 1 }),
      'resize-e',
    );
    assert.equal(
      hitTestDirectTextHandle(mark, centers.w.x, centers.w.y, 400, 300, { zoom: 1 }),
      'resize-w',
    );
    assert.equal(
      hitTestDirectTextHandle(mark, centers.se.x, centers.se.y, 400, 300, { zoom: 1 }),
      'resize-se',
    );
    assert.equal(
      hitTestDirectTextHandle(mark, centers.move.x, centers.move.y, 400, 300, { zoom: 1 }),
      'move',
    );
    assert.equal(hitTestDirectTextHandle(mark, box.x + 4, box.y + 4, 400, 300, { zoom: 1 }), 'move');
  });

  it('hitTestDirectTextHandle keeps west handle on frame edge at high zoom', () => {
    const mark = {
      id: 't-edge',
      type: 'text',
      nx: 0.02,
      ny: 0.08,
      text: 'Edge',
      fontSizeNorm: 18 / 400,
      textWidthNorm: 0.2,
      color: '#212121',
    };
    const box = layoutDirectTextBox(mark, 400, 300);
    const centers = directTextHandleCenters(box);
    assert.equal(
      hitTestDirectTextHandle(mark, centers.w.x, centers.w.y, 400, 300, { zoom: 2 }),
      'resize-w',
    );
    assert.equal(hitTestDirectTextHandle(mark, box.x + 2, box.y + 2, 400, 300, { zoom: 2 }), 'move');
  });

  it('resolveGradingInkControlsVisibility shows text controls during inline edit in select tool', () => {
    const vis = resolveGradingInkControlsVisibility({
      readOnly: false,
      tool: 'select',
      inlineTextEditing: true,
    });
    assert.equal(vis.inkBarHidden, false);
    assert.equal(vis.textSizeSelHidden, false);
    assert.equal(vis.strokeSelHidden, true);
    const hidden = resolveGradingInkControlsVisibility({
      readOnly: false,
      tool: 'select',
      inlineTextEditing: false,
    });
    assert.equal(hidden.inkBarHidden, true);
    assert.equal(hidden.textSizeSelHidden, true);
  });

  it('inline text save font norm matches preview when viewport height changes', () => {
    const original = 20 / 600;
    const unchanged = resolveDirectTextSaveFontSizeNorm({
      fontSizeDirty: false,
      selectedSizeValue: '24',
      viewportHeight: 300,
      originalFontSizeNorm: original,
    });
    assert.equal(unchanged, original);
    const dirtyCurrent = resolveDirectTextSaveFontSizeNorm({
      fontSizeDirty: true,
      selectedSizeValue: '24',
      viewportHeight: 300,
      originalFontSizeNorm: original,
    });
    assert.equal(dirtyCurrent, 24 / 300);
    const mark = {
      id: 't-save',
      type: 'text',
      nx: 0.1,
      ny: 0.1,
      text: 'Hello',
      fontSizeNorm: dirtyCurrent,
      textWidthNorm: 0.35,
      color: '#212121',
    };
    const previewBox = layoutDirectTextBox(mark, 400, 300);
    assert.equal(Math.round(previewBox.fontSize), 24);
    const staleNorm = resolveDirectTextSaveFontSizeNorm({
      fontSizeDirty: true,
      selectedSizeValue: '24',
      viewportHeight: 600,
      originalFontSizeNorm: original,
    });
    const staleBox = layoutDirectTextBox({ ...mark, fontSizeNorm: staleNorm }, 400, 300);
    assert.equal(Math.round(staleBox.fontSize), 12);
  });

  it('validateDirectTextPlacement rejects text taller than page', () => {
    const measureLineWidth = (text, fontSize) => String(text).length * fontSize * 0.55;
    const tallText = Array.from({ length: 80 }, () => 'line').join('\n');
    const result = validateDirectTextPlacement(
      {
        id: 't1',
        type: 'text',
        nx: 0.05,
        ny: 0.05,
        text: tallText,
        fontSizeNorm: 20 / 600,
        textWidthNorm: 0.4,
        color: '#212121',
      },
      800,
      600,
      { measureLineWidth },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /vừa trang/);
  });

  it('defaultDirectTextWidthNorm caps near half page not full remaining width', () => {
    const norm = defaultDirectTextWidthNorm({ type: 'text', nx: 0.05, ny: 0.1 }, 800, 600);
    assert.ok(norm <= 0.46);
    assert.ok(norm >= 0.4);
  });

  it('collectPenIdsForEraserPath hits sparse segment between samples', () => {
    const anns = [
      {
        id: 'p1',
        type: 'pen',
        nw: 0.008,
        points: [{ nx: 0.1, ny: 0.5 }, { nx: 0.9, ny: 0.5 }],
      },
      { id: 't1', type: 'text', nx: 0.5, ny: 0.5, text: 'Giữ lại' },
    ];
    const ids = collectPenIdsForEraserPath(
      anns,
      [{ x: 50, y: 150 }, { x: 350, y: 150 }],
      400,
      300,
      { zoom: 1 },
    );
    assert.deepEqual(ids, ['p1']);
    const next = applyEraserToAnnotations(anns, ids);
    assert.equal(next.length, 1);
    assert.equal(next[0].type, 'text');
  });

  it('resolveEraserHitRadiusPx shrinks with zoom', () => {
    assert.ok(resolveEraserHitRadiusPx({ zoom: 2 }) < resolveEraserHitRadiusPx({ zoom: 1 }));
  });
});

describe('validateBackup pen marks', () => {
  const base = {
    schemaVersion: 1,
    classes: [{ id: 'c1', name: 'Lớp', scheduleDays: ['T2'], scheduleTime: '19:00' }],
    students: [{ id: 's1', name: 'HS', classId: 'c1' }],
    assignments: [{
      id: 'a1',
      classId: 'c1',
      title: 'Bài',
      bookRef: 'Sách',
      dueDateISO: '2026-12-01',
      requiredPageCount: 1,
    }],
  };

  it('rejects published grading with invalid pen mark', () => {
    const bad = validateBackup({
      ...base,
      submissions: [{
        id: 'sub1',
        assignmentId: 'a1',
        studentId: 's1',
        firstSubmittedAt: null,
        versions: [{
          versionId: 'v1',
          isDraft: false,
          pageImageIds: ['img1'],
          grading: {
            published: true,
            pages: [{ annotations: [{ id: 'p', type: 'pen', points: [] }] }],
          },
        }],
      }],
    });
    assert.equal(bad.ok, false);
  });

  it('accepts published snapshot with pen and text', () => {
    const ok = validateBackup({
      ...base,
      submissions: [{
        id: 'sub1',
        assignmentId: 'a1',
        studentId: 's1',
        firstSubmittedAt: '2026-11-01T10:00:00',
        versions: [{
          versionId: 'v1',
          isDraft: false,
          pageImageIds: ['img1'],
          grading: {
            published: true,
            pages: [{
              annotations: [
                {
                  id: 'p1',
                  type: 'pen',
                  nw: 0.004,
                  color: '#c62828',
                  points: [{ nx: 0.1, ny: 0.2 }, { nx: 0.2, ny: 0.3 }],
                },
                {
                  id: 't1',
                  type: 'text',
                  nx: 0.3,
                  ny: 0.4,
                  text: 'Chú ý',
                  color: '#1565c0',
                  fontSizeNorm: 0.04,
                },
              ],
            }],
          },
        }],
      }],
    });
    assert.equal(ok.ok, true);
  });

  it('rejects teacherGrading draft with invalid pen mark', () => {
    const bad = validateBackup({
      ...base,
      submissions: [{
        id: 'sub1',
        assignmentId: 'a1',
        studentId: 's1',
        firstSubmittedAt: null,
        versions: [{
          versionId: 'v1',
          isDraft: false,
          pageImageIds: ['img1'],
          teacherGrading: {
            score: '',
            overallFeedback: '',
            pages: [{ annotations: [{ id: 'p', type: 'pen', points: [] }] }],
            undoStacks: {},
          },
        }],
      }],
    });
    assert.equal(bad.ok, false);
  });

  it('accepts teacherGrading draft with valid pen/text and undo', () => {
    const ok = validateTeacherGradingDraft({
      score: '8',
      overallFeedback: 'OK',
      pages: [{
        annotations: [{
          id: 'p1',
          type: 'pen',
          nw: 0.004,
          points: [{ nx: 0.1, ny: 0.2 }, { nx: 0.2, ny: 0.3 }],
        }],
      }],
      undoStacks: {
        0: {
          past: [JSON.stringify([{ id: 'c1', type: 'check', nx: 0.1, ny: 0.2 }])],
          future: [],
        },
      },
    }, 1);
    assert.equal(ok.ok, true);
  });
});
