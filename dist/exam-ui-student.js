import { el } from './ba-ui-dom.js';
import {
  fetchStudentExamAssignments,
  fetchStudentExamDetail,
  startExamAttempt,
  saveExamAttemptAnswer,
  submitExamAttempt,
  submitExamAttemptPart,
  saveStudentPdfAnnotations,
  studentExamSourcePdfUrl,
  studentExamAudioUrl,
  teacherAttachmentPreviewUrl,
  fetchExamServerNow,
} from './exam-api.js';
import { mountExamPdfEditor } from './exam-pdf-editor.js';
import { withBusyButton, registerDirtyProbe, getDirtyProbe } from './ux-forms.js';
import {
  EXAM_ATTEMPT_STATUS,
  EXAM_QUESTION_TYPE,
  normalizeReadingGroup,
  parseExpectedQuestionRange,
  EXAM_ASSIGNMENT_PURPOSE,
  EXAM_DELIVERY_MODE,
  EXAM_PART_STATUS,
  assignmentRequiredParts,
  isExamHomeworkAssignment,
  normalizeExamDeliveryMode,
  normalizeExamQuestionType,
  isChoiceBasedQuestion,
  isStudentResponseQuestion,
  summarizeExamItems,
  formatExamChoiceOptionLabel,
  pickExamMediaAttachmentFromSnapshot,
} from './exam-domain.js';

export const EXAM_TEACHER_PREVIEW_BANNER = 'Chế độ xem trước — bài làm thử không được lưu';

function mediaHasGroupAudio(media, groupId) {
  return !!(media?.mediaBindings?.groups?.[groupId]?.audioAttachmentId
    || media?.mediaBindings?.groups?.[groupId]?.frozenAudioAttachmentId);
}

function mediaHasPaperAudio(media) {
  return !!(media?.audioAttachmentId
    || media?.mediaBindings?.paper?.audioAttachmentId
    || media?.mediaBindings?.paper?.frozenAudioAttachmentId);
}

function resolveExamAudioStreamUrl(assignmentId, groupId, media, { teacherPreview = false } = {}) {
  if (teacherPreview && media) {
    const att = pickExamMediaAttachmentFromSnapshot(media, { groupId: groupId || null });
    if (att) return teacherAttachmentPreviewUrl(att);
  }
  if (!assignmentId) return null;
  return studentExamAudioUrl(assignmentId, groupId);
}

function mountExamAudioPlayer(parent, assignmentId, groupId, label, { media = null, teacherPreview = false } = {}) {
  if (!parent) return null;
  const src = resolveExamAudioStreamUrl(assignmentId, groupId, media, { teacherPreview });
  if (!src) return null;
  const wrap = el('div', {
    className: 'exam-audio-player-wrap',
    'data-exam-audio-player': groupId || 'paper',
    style: 'margin:0.35rem 0',
  });
  const audio = el('audio', {
    controls: true,
    preload: 'metadata',
    src,
    style: 'width:100%;max-width:32rem',
  });
  let errShown = false;
  audio.addEventListener('error', () => {
    if (errShown) return;
    errShown = true;
    wrap.appendChild(el('p', {
      className: 'form-hint exam-audio-inline-err',
      role: 'alert',
    }, label ? `Không phát được âm thanh — ${label}` : 'Không phát được âm thanh.'));
  });
  if (label) wrap.appendChild(el('span', { className: 'form-hint', style: 'display:block' }, label));
  wrap.appendChild(audio);
  parent.appendChild(wrap);
  return wrap;
}

function groupForQuestion(exam, q) {
  const gid = q.passageId || q.groupId;
  if (!gid) return null;
  const raw = (exam.passages || []).find((p) => p.id === gid);
  return raw ? normalizeReadingGroup(raw) : null;
}

export function renderReadingGroupCard(group) {
  const range = parseExpectedQuestionRange(group);
  const heading = range
    ? `Nhóm câu ${range.min}–${range.max}`
    : (group.title || 'Đoạn đọc');
  const passageId = group.id != null ? String(group.id) : '';
  const pCard = el('div', {
    className: 'card exam-passage',
    style: 'margin:0.75rem 0;padding:0.75rem;background:#f8f8f8;overflow-wrap:anywhere',
    ...(passageId ? { 'data-passage-id': passageId } : {}),
  });
  pCard.appendChild(el('h3', {}, heading));
  if (group.instructions) {
    pCard.appendChild(el('p', { style: 'white-space:pre-wrap' }, group.instructions));
  }
  const docs = (group.documents || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (docs.length) {
    for (const doc of docs) {
      const docHost = el('div', {
        style: 'margin-bottom:0.5rem',
        ...(doc.id != null ? { 'data-document-id': String(doc.id) } : {}),
        ...(passageId ? { 'data-passage-id': passageId } : {}),
      });
      if (doc.title) docHost.appendChild(el('h4', { style: 'margin:0.5rem 0 0.25rem' }, doc.title));
      docHost.appendChild(el('div', { style: 'white-space:pre-wrap' }, doc.bodyText || ''));
      pCard.appendChild(docHost);
    }
  } else {
    pCard.appendChild(el('div', { style: 'white-space:pre-wrap' }, group.bodyText || ''));
  }
  return pCard;
}

function countWordsSimple(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function questionTitlePrefix(q) {
  if (q.unnumberedActivity) {
    const dn = String(q.displayNumber || '').trim();
    if (dn === 'W' || dn === 'w') return 'Bài viết';
    if (dn === 'I' || dn === 'i') return 'Phỏng vấn / nói';
    return 'Hoạt động';
  }
  return `Câu ${q.displayNumber}`;
}

function wordBankOptionsForQuestion(exam, q) {
  if (Array.isArray(q.options) && q.options.length) return q.options;
  const gid = q.passageId || q.groupId;
  const passage = gid ? (exam.passages || []).find((p) => p.id === gid) : null;
  if (passage?.wordBankWords?.length) {
    return passage.wordBankWords.map((w) => ({
      id: w.id,
      label: w.id,
      text: w.text,
    }));
  }
  if (Array.isArray(q.wordBankWords)) {
    return q.wordBankWords.map((w) => ({
      id: w.id,
      label: w.id,
      text: w.text,
    }));
  }
  return [];
}

export function countRespondableAnswers(exam, answers) {
  let n = 0;
  for (const q of exam.questions || []) {
    if (!isStudentResponseQuestion(q)) continue;
    const v = answers?.[q.id];
    if (v == null || v === '') continue;
    const t = normalizeExamQuestionType(q);
    if (t === EXAM_QUESTION_TYPE.ESSAY) {
      if (v && typeof v === 'object' && (String(v.text || '').trim() || v.topicId)) n += 1;
    } else n += 1;
  }
  return n;
}

/**
 * Shared student / preview question surface (typed + legacy MCQ).
 * @param {HTMLElement} host
 * @param {object} exam
 * @param {{ answers: object, readOnly?: boolean, onChoiceAnswer?: Function, onTextAnswer?: Function, onEssayAnswer?: Function, onClearAnswer?: Function }} handlers
 */
export function mountExamTakeQuestionUi(host, exam, handlers) {
  const {
    answers = {},
    readOnly = false,
    assignmentId = null,
    media = null,
    teacherPreviewAudio = false,
    onChoiceAnswer,
    onTextAnswer,
    onEssayAnswer,
    onClearAnswer,
  } = handlers || {};
  while (host.firstChild) host.removeChild(host.firstChild);
  const needsAudio = (exam.questions || []).some((q) => q.requiresAudio);
  if ((assignmentId || teacherPreviewAudio) && mediaHasPaperAudio(media)) {
    mountExamAudioPlayer(host, assignmentId, null, 'Âm thanh toàn bài', { media, teacherPreview: teacherPreviewAudio });
  } else if (needsAudio && (assignmentId || teacherPreviewAudio)) {
    mountExamAudioPlayer(host, assignmentId, null, 'Âm thanh bài thi', { media, teacherPreview: teacherPreviewAudio });
  } else if (needsAudio) {
    host.appendChild(el('p', {
      className: 'demo-banner exam-audio-missing-banner',
      role: 'status',
    }, 'Một số câu yêu cầu audio — tệp nghe chưa có trong phiên bản này.'));
  }
  const summary = summarizeExamItems(exam);
  host.appendChild(el('p', {
    className: 'exam-take-summary-line',
    style: 'font-size:0.9rem;color:var(--muted)',
  }, `${summary.numberedQuestions} câu hỏi có số · ${summary.unnumberedActivities} hoạt động bài viết/nói · ${summary.respondableItems} mục trả lời`));

  const renderedPassages = new Set();
  for (const q of exam.questions || []) {
    const group = groupForQuestion(exam, q);
    if (group && !renderedPassages.has(group.id)) {
      renderedPassages.add(group.id);
      const gCard = renderReadingGroupCard(group);
      if ((assignmentId || teacherPreviewAudio) && mediaHasGroupAudio(media, group.id)) {
        mountExamAudioPlayer(gCard, assignmentId, group.id, 'Âm thanh nhóm', { media, teacherPreview: teacherPreviewAudio });
      }
      host.appendChild(gCard);
      if (group.wordBankInstructions) {
        host.appendChild(el('p', { className: 'exam-word-bank-hint', style: 'font-size:0.9rem' }, group.wordBankInstructions));
      }
    }
    const t = normalizeExamQuestionType(q);
    const card = el('div', {
      className: `card exam-q-card exam-q-type-${t}`,
      style: 'margin:0.5rem 0;padding:0.75rem',
      'data-question-id': q.id,
      'data-question-type': t,
    });
    card.appendChild(el('p', { className: 'exam-q-stem' }, [
      el('strong', {}, `${questionTitlePrefix(q)}: `),
      q.stemText || '',
    ]));
    if (q.maxWords != null && (t === EXAM_QUESTION_TYPE.SHORT_ANSWER || t === EXAM_QUESTION_TYPE.ESSAY)) {
      card.appendChild(el('p', { className: 'form-hint' }, `Tối đa ${q.maxWords} từ`));
    }
    if (q.minWords != null && t === EXAM_QUESTION_TYPE.ESSAY) {
      card.appendChild(el('p', { className: 'form-hint' }, `Tối thiểu ${q.minWords} từ`));
    }

    const chosen = answers?.[q.id];

    if (t === EXAM_QUESTION_TYPE.ORAL_ASSESSMENT) {
      card.appendChild(el('p', { className: 'exam-oral-note form-hint' },
        'Hoạt động này do giáo viên chấm trực tiếp — không nhập câu trả lời tại đây.'));
      host.appendChild(card);
      continue;
    }

    if (t === EXAM_QUESTION_TYPE.SHORT_ANSWER) {
      const input = el('input', {
        type: 'text',
        className: 'input exam-short-answer-input',
        value: chosen != null ? String(chosen) : '',
        disabled: readOnly,
        'aria-label': `Trả lời câu ${q.displayNumber}`,
      });
      input.addEventListener('input', () => {
        const val = input.value;
        if (!val.trim()) onClearAnswer?.(q.id);
        else onTextAnswer?.(q.id, val);
      });
      card.appendChild(input);
      host.appendChild(card);
      continue;
    }

    if (t === EXAM_QUESTION_TYPE.ESSAY) {
      const topics = Array.isArray(q.essayTopics) ? q.essayTopics : [];
      const essayVal = chosen && typeof chosen === 'object' ? chosen : { text: '', topicId: '' };
      let topicSel = null;
      if (topics.length) {
        const promptsHost = el('div', { className: 'exam-essay-topic-prompts', style: 'margin:0.5rem 0' });
        for (const row of topics) {
          const topicCard = el('div', {
            className: 'card exam-essay-topic-card',
            style: 'margin:0.35rem 0;padding:0.5rem 0.65rem',
            'data-essay-topic-id': row.id,
          });
          topicCard.appendChild(el('p', {
            className: 'exam-essay-topic-label',
            style: 'margin:0 0 0.35rem;font-weight:600',
          }, row.label || row.id));
          if (row.bodyText) {
            topicCard.appendChild(el('div', {
              className: 'exam-essay-topic-body',
              style: 'white-space:pre-wrap;font-size:0.95rem',
            }, row.bodyText));
          }
          promptsHost.appendChild(topicCard);
        }
        card.appendChild(promptsHost);
        topicSel = el('select', { className: 'input exam-essay-topic', disabled: readOnly });
        topicSel.appendChild(el('option', { value: '' }, '— Chọn chủ đề —'));
        for (const row of topics) {
          topicSel.appendChild(el('option', { value: row.id }, row.label || row.id));
        }
        topicSel.value = essayVal.topicId || '';
        topicSel.addEventListener('change', () => {
          onEssayAnswer?.(q.id, {
            text: ta.value,
            topicId: topicSel.value || null,
          });
        });
        card.appendChild(el('label', {}, ['Chủ đề ', topicSel]));
      }
      const ta = el('textarea', {
        className: 'input exam-essay-text',
        rows: '6',
        disabled: readOnly,
      });
      ta.value = essayVal.text || '';
      const wc = el('p', { className: 'exam-word-count form-hint' }, `Số từ: ${countWordsSimple(ta.value)}`);
      const notifyEssay = () => {
        wc.textContent = `Số từ: ${countWordsSimple(ta.value)}`;
        onEssayAnswer?.(q.id, {
          text: ta.value,
          topicId: topicSel?.value || essayVal.topicId || null,
        });
      };
      ta.addEventListener('input', notifyEssay);
      card.appendChild(ta);
      card.appendChild(wc);
      host.appendChild(card);
      continue;
    }

    const bankOpts = (t === EXAM_QUESTION_TYPE.WORD_BANK || t === EXAM_QUESTION_TYPE.MATCHING)
      ? wordBankOptionsForQuestion(exam, q)
      : [];
    if (bankOpts.length && (t === EXAM_QUESTION_TYPE.WORD_BANK || t === EXAM_QUESTION_TYPE.MATCHING)) {
      const sel = el('select', { className: 'input exam-bank-select', disabled: readOnly });
      sel.appendChild(el('option', { value: '' }, '— Chọn —'));
      for (const o of bankOpts) {
        sel.appendChild(el('option', { value: o.id }, formatExamChoiceOptionLabel(o)));
      }
      sel.value = chosen != null ? String(chosen) : '';
      sel.addEventListener('change', () => {
        if (!sel.value) onClearAnswer?.(q.id);
        else onChoiceAnswer?.(q.id, sel.value);
      });
      card.appendChild(sel);
      host.appendChild(card);
      continue;
    }

    if (isChoiceBasedQuestion(q)) {
      const opts = q.options || [];
      for (const o of opts) {
        const labelText = formatExamChoiceOptionLabel(o);
        card.appendChild(el('label', { className: 'exam-choice-label', style: 'display:block;margin:0.35rem 0' }, [
          el('input', {
            type: 'radio',
            name: q.id,
            className: 'exam-choice-radio',
            checked: chosen === o.id,
            disabled: readOnly,
            onChange: () => onChoiceAnswer?.(q.id, o.id),
          }),
          ` ${labelText}`,
        ]));
      }
    }
    host.appendChild(card);
  }
}

export function renderExamStudentHub(ctx, root) {
  root.appendChild(el('h1', { className: 'page-title' }, 'Bài đã giao'));
  const host = el('div');
  root.appendChild(host);

  fetchStudentExamAssignments().then((data) => {
    if (!data.assignments?.length) {
      host.appendChild(el('p', {}, 'Chưa có bài thi.'));
      return;
    }
    const ul = el('ul');
    for (const a of data.assignments) {
      const typePart = a.typeLabel ? `${a.typeLabel} · ` : '';
      const mode = a.deliveryMode && a.deliveryMode !== EXAM_DELIVERY_MODE.ONLINE
        ? ` · ${a.deliveryMode === EXAM_DELIVERY_MODE.PDF ? 'PDF' : 'Kết hợp'}`
        : '';
      ul.appendChild(el('li', { style: 'margin:0.5rem 0' }, [
        el('span', {}, `${typePart}${a.title}${mode} — hạn ${new Date(a.dueAt).toLocaleString('vi-VN')}`),
        ' ',
        el('button', {
          type: 'button',
          className: 'btn btn-primary',
          onClick: () => ctx.navigate(`#/exams/take/${a.id}`),
        }, a.status === 'submitted' ? 'Xem bài' : 'Làm bài'),
      ]));
    }
    host.appendChild(ul);
  }).catch((e) => ctx.toastErr(e.message));
}

/**
 * Full-screen teacher preview overlay; local state only (no student attempt APIs).
 * @returns {() => void} dispose
 */
export function openTeacherExamStudentPreview(ctx, exam, { onClose, assignmentPolicy } = {}) {
  let disposed = false;
  let phase = 'taking';
  const answers = { ...(exam.attempt?.answers || {}) };

  const overlay = el('div', {
    className: 'exam-teacher-preview-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': EXAM_TEACHER_PREVIEW_BANNER,
    'data-exam-teacher-preview': '',
  });
  const shell = el('div', { className: 'exam-teacher-preview-shell' });
  overlay.appendChild(shell);

  const header = el('div', { className: 'exam-teacher-preview-header' });
  header.appendChild(el('div', {
    className: 'demo-banner exam-teacher-preview-banner',
  }, EXAM_TEACHER_PREVIEW_BANNER));
  const closeBtn = el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    'data-exam-preview-close': '',
  }, 'Đóng xem trước');
  header.appendChild(closeBtn);
  shell.appendChild(header);

  const titleEl = el('h2', { className: 'page-title exam-teacher-preview-title' }, exam.title || 'Bài thi');
  shell.appendChild(titleEl);

  const metaHost = el('p', { className: 'exam-teacher-preview-meta' });
  shell.appendChild(metaHost);

  const questionHost = el('div', { className: 'exam-teacher-preview-questions' });
  shell.appendChild(questionHost);

  const actionRow = el('div', { className: 'btn-row exam-teacher-preview-actions' });
  shell.appendChild(actionRow);

  function assignmentMetaLine() {
    const a = exam.assignment || assignmentPolicy || {};
    const parts = [];
    if (a.purpose === EXAM_ASSIGNMENT_PURPOSE.HOMEWORK || isExamHomeworkAssignment(a)) {
      parts.push('Bài tập trực tuyến — không giới hạn thời gian làm');
    } else if (a.timeLimitMinutes) {
      parts.push(`Thời gian làm bài: ${a.timeLimitMinutes} phút`);
    }
    if (a.dueAt) {
      parts.push(`Hạn nộp (tham khảo): ${new Date(a.dueAt).toLocaleString('vi-VN')}`);
    }
    return parts.join(' · ');
  }

  function setAnswer(questionId, value) {
    if (value == null) delete answers[questionId];
    else answers[questionId] = value;
  }

  function renderTaking() {
    phase = 'taking';
    metaHost.textContent = assignmentMetaLine();
    mountExamTakeQuestionUi(questionHost, exam, {
      answers,
      media: exam.media || exam.assignment?.media,
      teacherPreviewAudio: true,
      onChoiceAnswer: (questionId, optionId) => setAnswer(questionId, optionId),
      onTextAnswer: (questionId, text) => setAnswer(questionId, text),
      onEssayAnswer: (questionId, essay) => setAnswer(questionId, essay),
      onClearAnswer: (questionId) => setAnswer(questionId, null),
    });
    actionRow.replaceChildren();
    const resetBtn = el('button', {
      type: 'button',
      className: 'btn btn-secondary',
      'data-exam-preview-reset': '',
    }, 'Làm lại');
    resetBtn.addEventListener('click', () => {
      for (const k of Object.keys(answers)) delete answers[k];
      renderTaking();
    });
    const submitBtn = el('button', {
      type: 'button',
      className: 'btn btn-primary',
      'data-exam-preview-submit': '',
    }, 'Nộp bài thử');
    submitBtn.addEventListener('click', () => renderSummary());
    actionRow.appendChild(resetBtn);
    actionRow.appendChild(submitBtn);
  }

  function renderSummary() {
    phase = 'summary';
    questionHost.replaceChildren();
    metaHost.textContent = '';
    actionRow.replaceChildren();
    questionHost.appendChild(el('p', {}, exam.disclaimer || 'Chế độ xem trước — bài làm thử không được lưu.'));
    questionHost.appendChild(el('p', {}, 'Đã nộp bài thử trên máy bạn — không ghi vào hệ thống.'));
    const showScore = exam.assignment?.showScore !== false;
    if (showScore) {
      questionHost.appendChild(el('p', {}, 'Điểm sẽ hiển thị theo cài đặt giao bài (xem trước không chấm).'));
    } else {
      questionHost.appendChild(el('p', {}, 'Giáo viên đã tắt hiển thị điểm ngay sau nộp.'));
    }
    const summary = summarizeExamItems(exam);
    const answered = countRespondableAnswers(exam, answers);
    questionHost.appendChild(el('p', {}, [
      `Đã trả lời ${answered}/${summary.respondableItems} mục ( `,
      `${summary.numberedQuestions} câu có số`,
      summary.unnumberedActivities ? `, ${summary.unnumberedActivities} hoạt động không tính vào tiến độ` : '',
      ' ).',
    ]));
    const backBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Quay lại làm tiếp');
    backBtn.addEventListener('click', () => renderTaking());
    actionRow.appendChild(backBtn);
    actionRow.appendChild(el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: () => dispose(),
    }, 'Đóng xem trước'));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    overlay.remove();
    if (typeof onClose === 'function') onClose();
  }

  closeBtn.addEventListener('click', () => dispose());
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') dispose();
  });

  document.body.appendChild(overlay);
  renderTaking();
  closeBtn.focus?.({ preventScroll: true });
  return dispose;
}

export function renderExamTakeView(ctx, root, assignmentId) {
  root.appendChild(el('h1', { className: 'page-title' }, 'Làm bài'));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/exams'),
  }, '← Quay lại'));

  const clockEl = el('p', { className: 'exam-clock', 'aria-live': 'polite' }, 'Đang đồng bộ giờ…');
  const statusEl = el('p', { 'aria-live': 'polite' });
  const saveStateEl = el('p', { className: 'save-status', 'aria-live': 'polite' }, 'Đã đồng bộ');
  const host = el('div');
  root.appendChild(clockEl);
  root.appendChild(statusEl);
  root.appendChild(saveStateEl);
  root.appendChild(host);

  let attemptId = null;
  let revision = 0;
  let exam = null;
  let disposed = false;
  let clockTimer = null;
  let serverSkewMs = 0;
  let deadlineAt = null;

  const pendingByQuestion = new Map();
  const debounceTimers = new Map();
  const debounceLatestBody = new Map();
  let activeFlushPromise = null;
  let inflightRevision = null;
  let drainActive = false;
  let drainSaveFailure = false;

  function scheduleFlush() {
    if (activeFlushPromise) return activeFlushPromise;
    if (!pendingByQuestion.size) return Promise.resolve();
    activeFlushPromise = (async () => {
      try {
        while (pendingByQuestion.size && !disposed) {
          const [questionId, body] = pendingByQuestion.entries().next().value;
          const latest = debounceLatestBody.get(questionId);
          const outbound = latest != null ? latest : body;
          saveStateEl.textContent = 'Đang lưu…';
          saveStateEl.className = 'save-status pending';
          const baseRevision = inflightRevision ?? revision;
          try {
            const res = await saveExamAttemptAnswer(attemptId, { ...outbound, baseRevision });
            if (disposed) return;
            revision = res.revision;
            inflightRevision = revision;
            if (exam?.attempt) exam.attempt.revision = revision;
            const newer = debounceLatestBody.get(questionId);
            if (newer && JSON.stringify(newer) !== JSON.stringify(outbound)) {
              pendingByQuestion.set(questionId, newer);
              continue;
            }
            pendingByQuestion.delete(questionId);
            debounceLatestBody.delete(questionId);
            saveStateEl.textContent = 'Đã lưu';
            saveStateEl.className = 'save-status ok';
          } catch (e) {
            if (disposed) return;
            const stillLatest = debounceLatestBody.get(questionId);
            pendingByQuestion.set(questionId, stillLatest != null ? stillLatest : outbound);
            const msg = e.data?.error || e.message;
            if (e.status === 409) {
              saveStateEl.textContent = 'Xung đột — tải lại trang';
            } else if (e.status === 400 && msg) {
              saveStateEl.textContent = msg;
            } else {
              saveStateEl.textContent = 'Lỗi lưu — thử lại';
            }
            saveStateEl.className = 'save-status err';
            if (drainActive) drainSaveFailure = true;
            break;
          }
        }
      } finally {
        inflightRevision = null;
        activeFlushPromise = null;
      }
    })();
    return activeFlushPromise;
  }

  function enqueueSave(questionId, body) {
    debounceLatestBody.set(questionId, body);
    pendingByQuestion.set(questionId, body);
    scheduleFlush();
  }

  function flushPendingDebounces() {
    for (const [questionId, timer] of debounceTimers) {
      clearTimeout(timer);
      const body = debounceLatestBody.get(questionId);
      if (body) enqueueSave(questionId, body);
    }
    debounceTimers.clear();
  }

  function enqueueDebouncedSave(questionId, buildBody, delayMs = 450) {
    const body = buildBody();
    debounceLatestBody.set(questionId, body);
    const prev = debounceTimers.get(questionId);
    if (prev) clearTimeout(prev);
    debounceTimers.set(questionId, setTimeout(() => {
      debounceTimers.delete(questionId);
      const latest = debounceLatestBody.get(questionId);
      if (latest) enqueueSave(questionId, latest);
    }, delayMs));
  }

  function mergeLocalAnswer(questionId, value) {
    if (!exam?.attempt) return;
    const next = { ...(exam.attempt.answers || {}) };
    if (value == null) delete next[questionId];
    else next[questionId] = value;
    exam.attempt.answers = next;
  }

  function persistChoice(questionId, optionId) {
    mergeLocalAnswer(questionId, optionId);
    enqueueSave(questionId, { questionId, optionId });
  }

  function persistText(questionId, text) {
    mergeLocalAnswer(questionId, text);
    enqueueDebouncedSave(questionId, () => (
      text.trim() ? { questionId, answer: text } : { questionId, clear: true }
    ));
  }

  function persistEssay(questionId, essay) {
    mergeLocalAnswer(questionId, essay);
    enqueueDebouncedSave(questionId, () => {
      const empty = !String(essay?.text || '').trim() && !essay?.topicId;
      return empty
        ? { questionId, clear: true }
        : { questionId, answer: { text: essay.text || '', topicId: essay.topicId || null } };
    });
  }

  function persistClear(questionId) {
    mergeLocalAnswer(questionId, null);
    enqueueSave(questionId, { questionId, clear: true });
  }

  async function drainSaves() {
    drainActive = true;
    drainSaveFailure = false;
    try {
      flushPendingDebounces();
      await scheduleFlush();
      while (
        (pendingByQuestion.size || debounceTimers.size)
        && !disposed
        && !drainSaveFailure
      ) {
        flushPendingDebounces();
        await scheduleFlush();
      }
    } finally {
      drainActive = false;
    }
    if (drainSaveFailure || saveStateEl.className.includes('err')) {
      throw new Error('Còn câu trả lời chưa lưu.');
    }
    if (pendingByQuestion.size || debounceTimers.size) {
      throw new Error('Còn câu trả lời chưa lưu.');
    }
  }

  function updateClock() {
    if (!deadlineAt || disposed) return;
    const nowMs = Date.now() + serverSkewMs;
    const left = new Date(deadlineAt).getTime() - nowMs;
    if (left <= 0) {
      clockEl.textContent = 'Đã hết thời gian làm bài';
      return;
    }
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    clockEl.textContent = `Còn lại: ${mins}:${String(secs).padStart(2, '0')}`;
  }

  async function syncServerClock() {
    try {
      const r = await fetchExamServerNow();
      if (disposed) return;
      serverSkewMs = new Date(r.now).getTime() - Date.now();
      updateClock();
    } catch {
      /* keep last skew */
    }
  }

  function startClock() {
    syncServerClock();
    clockTimer = setInterval(() => {
      updateClock();
    }, 1000);
  }

  let pdfEditorInstance = null;

  async function mountPdfPartIfNeeded() {
    const mode = normalizeExamDeliveryMode(exam.assignment || {});
    const req = assignmentRequiredParts(exam.assignment || {});
    if (!req.pdf || mode === EXAM_DELIVERY_MODE.ONLINE) return null;
    const pageIds = exam.assignment?.selectedPdfPageIds || [];
    if (!pageIds.length) return null;
    const layers = exam.attempt?.pdfLayers || {};
    const pdfHost = el('div', { className: 'exam-take-pdf-host' });
    const pdfSubmitted = exam.attempt?.pdfSubmitted === true
      || exam.attempt?.partStatus?.pdf === EXAM_PART_STATUS.SUBMITTED;
    let mountedPdfEditor = null;
    const editor = await mountExamPdfEditor(pdfHost, {
      pageIds,
      sourcePdfUrl: studentExamSourcePdfUrl(assignmentId),
      readOnly: pdfSubmitted,
      role: 'student',
      studentPages: layers.studentPages || {},
      teacherPages: layers.teacherPages || {},
      showTeacherLayer: !!layers.teacherPages && Object.keys(layers.teacherPages).length > 0,
      baseRevision: exam.attempt?.pdfAnnotationRevision || 0,
      savePage: pdfSubmitted ? null : async (body) => saveStudentPdfAnnotations(attemptId, body),
      onExport: async () => {
        if (!mountedPdfEditor?.exportAnnotatedPdf) {
          throw new Error('Không xuất được PDF — mở lại phần PDF và thử lại.');
        }
        await mountedPdfEditor.exportAnnotatedPdf();
      },
    });
    mountedPdfEditor = editor;
    return { host: pdfHost, editor };
  }

  function renderQuestions() {
    while (host.firstChild) host.removeChild(host.firstChild);
    if (pdfEditorInstance) {
      pdfEditorInstance.dispose();
      pdfEditorInstance = null;
    }
    const qWrap = el('div', { className: 'exam-take-questions' });
    host.appendChild(qWrap);
    const takeMode = normalizeExamDeliveryMode(exam.assignment || {});
    const takeReq = assignmentRequiredParts(exam.assignment || {});
    const partStat = exam.attempt?.partStatus || {};
    const onlinePartSubmitted = partStat.online === EXAM_PART_STATUS.SUBMITTED;
    const showOnline = takeReq.online && takeMode !== EXAM_DELIVERY_MODE.PDF
      && (exam.questions || []).length > 0;
    if (!showOnline) qWrap.hidden = true;
    else mountExamTakeQuestionUi(qWrap, exam, {
      assignmentId,
      media: exam.media,
      readOnly: onlinePartSubmitted,
      answers: exam.attempt?.answers || {},
      onChoiceAnswer: (qid, oid) => persistChoice(qid, oid),
      onTextAnswer: (qid, text) => persistText(qid, text),
      onEssayAnswer: (qid, essay) => persistEssay(qid, essay),
      onClearAnswer: (qid) => persistClear(qid),
    });
    const mode = normalizeExamDeliveryMode(exam.assignment || {});
    const req = assignmentRequiredParts(exam.assignment || {});
    mountPdfPartIfNeeded().then((mounted) => {
      if (mounted && !disposed) {
        pdfEditorInstance = mounted.editor;
        qWrap.insertAdjacentElement('afterend', mounted.host);
      }
    }).catch((e) => ctx.toastErr(e.message));

    const footer = el('div', { className: 'btn-row exam-take-submit-row', style: 'margin-top:0.75rem' });
    const onlinePartBtn = req.online && mode !== EXAM_DELIVERY_MODE.PDF && !onlinePartSubmitted
      ? el('button', { type: 'button', className: 'btn btn-secondary' }, 'Nộp phần trực tuyến')
      : null;
    if (onlinePartBtn) {
      onlinePartBtn.addEventListener('click', () => withBusyButton(onlinePartBtn, 'Đang nộp…', async () => {
        try {
          await drainSaves();
          await submitExamAttemptPart(attemptId, 'online');
          ctx.toastOk('Đã nộp phần trực tuyến.');
          await load();
        } catch (e) {
          ctx.toastErr(e.data?.error || e.message);
        }
      }));
    }
    const pdfPartBtn = req.pdf && mode !== EXAM_DELIVERY_MODE.ONLINE && exam.attempt?.partStatus?.pdf !== EXAM_PART_STATUS.SUBMITTED
      ? el('button', { type: 'button', className: 'btn btn-secondary' }, 'Nộp phần PDF')
      : null;
    if (pdfPartBtn) {
      pdfPartBtn.addEventListener('click', () => withBusyButton(pdfPartBtn, 'Đang nộp…', async () => {
        try {
          if (pdfEditorInstance?.flushSaves) await pdfEditorInstance.flushSaves();
          await submitExamAttemptPart(attemptId, 'pdf');
          ctx.toastOk('Đã nộp phần PDF.');
          await load();
        } catch (e) {
          ctx.toastErr(e.data?.error || e.message);
        }
      }));
    }

    const submitBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Nộp bài');
    const submitReq = assignmentRequiredParts(exam.assignment || {});
    const partsReady = (!submitReq.online || partStat.online === EXAM_PART_STATUS.SUBMITTED)
      && (!submitReq.pdf || partStat.pdf === EXAM_PART_STATUS.SUBMITTED);
    if (mode === EXAM_DELIVERY_MODE.COMBINED && !partsReady) {
      submitBtn.disabled = true;
      submitBtn.title = 'Hoàn thành và nộp từng phần bắt buộc trước khi nộp bài cuối';
    }
    submitBtn.addEventListener('click', () => withBusyButton(submitBtn, 'Đang nộp…', async () => {
      try {
        await drainSaves();
        const submitMode = normalizeExamDeliveryMode(exam.assignment || {});
        const submitReq = assignmentRequiredParts(exam.assignment || {});
        if (
          submitReq.pdf
          && submitMode !== EXAM_DELIVERY_MODE.ONLINE
          && pdfEditorInstance?.flushSaves
        ) {
          await pdfEditorInstance.flushSaves();
        }
        const res = await submitExamAttempt(attemptId);
        const showScore = exam.assignment?.showScore !== false;
        if (showScore && res.score10 != null) {
          ctx.toastOk(`Điểm: ${res.score10}/10 (${res.correctCount}/${res.totalCount})`);
        } else if (res.gradingLabel) {
          ctx.toastOk(`Đã nộp bài — ${res.gradingLabel}`);
        } else {
          ctx.toastOk('Đã nộp bài.');
        }
        await load();
      } catch (e) {
        const msg = e.data?.error || e.message;
        ctx.toastErr(msg || 'Không nộp được bài.');
      }
    }));
    if (onlinePartBtn) footer.appendChild(onlinePartBtn);
    if (pdfPartBtn) footer.appendChild(pdfPartBtn);
    footer.appendChild(submitBtn);
    host.appendChild(footer);
  }

  async function renderResult(ex) {
    while (host.firstChild) host.removeChild(host.firstChild);
    pdfEditorInstance?.dispose();
    pdfEditorInstance = null;
    registerDirtyProbe(null);
    host.appendChild(el('p', {}, ex.disclaimer || ''));
    if (ex.result?.score10 != null) {
      host.appendChild(el('p', {}, `Điểm: ${ex.result.score10}/10`));
    } else if (ex.result?.gradingLabel) {
      host.appendChild(el('p', {}, ex.result.gradingLabel));
    } else {
      host.appendChild(el('p', {}, 'Điểm sẽ hiển thị theo cài đặt giáo viên.'));
    }
    const mode = normalizeExamDeliveryMode(ex.assignment || {});
    const req = assignmentRequiredParts(ex.assignment || {});
    if (req.online && mode !== EXAM_DELIVERY_MODE.PDF) {
      const qHost = el('div', { className: 'exam-take-questions' });
      host.appendChild(qHost);
      mountExamTakeQuestionUi(qHost, ex, {
        assignmentId,
        media: ex.media,
        answers: ex.attempt?.answers || {},
        readOnly: true,
      });
    }
    if (ex.result?.pdfFeedback?.feedback) {
      host.appendChild(el('p', { className: 'card', style: 'margin-top:0.75rem;padding:0.75rem' },
        `Nhận xét PDF: ${ex.result.pdfFeedback.feedback}`));
    }
    if (req.pdf && mode !== EXAM_DELIVERY_MODE.ONLINE) {
      const pageIds = ex.assignment?.selectedPdfPageIds || [];
      const layers = ex.attempt?.pdfLayers || {};
      if (pageIds.length) {
        const pdfHost = el('div', { className: 'exam-take-pdf-host' });
        host.appendChild(pdfHost);
        try {
          const editor = await mountExamPdfEditor(pdfHost, {
            pageIds,
            sourcePdfUrl: studentExamSourcePdfUrl(assignmentId),
            readOnly: true,
            role: 'student',
            studentPages: layers.studentPages || {},
            teacherPages: layers.teacherPages || {},
            showTeacherLayer: !!(layers.teacherPages && Object.keys(layers.teacherPages).length),
          });
          pdfEditorInstance = editor;
          const exportBtn = el('button', {
            type: 'button',
            className: 'btn btn-secondary',
            style: 'margin-top:0.5rem',
          }, 'Tải PDF có chú thích');
          exportBtn.addEventListener('click', () => withBusyButton(exportBtn, 'Đang xuất…', () => editor.exportAnnotatedPdf()));
          host.appendChild(exportBtn);
        } catch (e) {
          host.appendChild(el('p', { className: 'form-error' }, e.message || 'Không tải được phần PDF.'));
        }
      }
    }
  }

  async function load() {
    registerDirtyProbe(() => {
      if (pendingByQuestion.size || debounceTimers.size) return true;
      if (saveStateEl.className.includes('err')) return true;
      return false;
    });
    const detail = await fetchStudentExamDetail(assignmentId);
    if (disposed) return;
    exam = detail.exam;
    if (exam.attempt?.status === EXAM_ATTEMPT_STATUS.SUBMITTED) {
      await renderResult(exam);
      return;
    }
    const start = await startExamAttempt(assignmentId);
    if (disposed) return;
    attemptId = start.attemptId;
    const refreshed = await fetchStudentExamDetail(assignmentId);
    if (disposed) return;
    exam = refreshed.exam;
    revision = exam.attempt?.revision || 0;
    deadlineAt = start.deadlineAt || exam.attempt?.deadlineAt;
    const homework = isExamHomeworkAssignment(exam.assignment);
    if (homework) {
      clockEl.hidden = true;
      clockEl.textContent = '';
      statusEl.textContent = `Hạn nộp: ${new Date(exam.assignment?.dueAt || deadlineAt).toLocaleString('vi-VN')} · có thể lưu và quay lại đến hạn`;
    } else {
      clockEl.hidden = false;
      statusEl.textContent = `Hạn nộp: ${new Date(deadlineAt).toLocaleString('vi-VN')}`;
    }
    if (!exam.attempt) exam.attempt = { answers: {}, revision: 0 };
    renderQuestions();
    if (!isExamHomeworkAssignment(exam.assignment)) updateClock();
  }

  load().catch((e) => ctx.toastErr(e.message));
  startClock();

  root.__examDispose = () => {
    disposed = true;
    registerDirtyProbe(null);
    pdfEditorInstance?.dispose();
    pdfEditorInstance = null;
    if (clockTimer) clearInterval(clockTimer);
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    debounceLatestBody.clear();
    pendingByQuestion.clear();
  };
}
