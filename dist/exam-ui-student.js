import { el } from './ba-ui-dom.js';
import {
  fetchStudentExamAssignments,
  fetchStudentExamDetail,
  startExamAttempt,
  saveExamAnswer,
  submitExamAttempt,
  fetchExamServerNow,
} from './exam-api.js';
import { withBusyButton } from './ux-forms.js';

export function renderExamStudentHub(ctx, root) {
  root.appendChild(el('h1', { className: 'page-title' }, 'Bài thi được giao'));
  const host = el('div');
  root.appendChild(host);

  fetchStudentExamAssignments().then((data) => {
    if (!data.assignments?.length) {
      host.appendChild(el('p', {}, 'Chưa có bài thi.'));
      return;
    }
    const ul = el('ul');
    for (const a of data.assignments) {
      ul.appendChild(el('li', { style: 'margin:0.5rem 0' }, [
        el('span', {}, `${a.title} — hạn ${new Date(a.dueAt).toLocaleString('vi-VN')}`),
        ' ',
        el('button', {
          type: 'button',
          className: 'btn btn-primary',
          onClick: () => ctx.navigate(`#/exams/take/${a.id}`),
        }, 'Làm bài'),
      ]));
    }
    host.appendChild(ul);
  }).catch((e) => ctx.toastErr(e.message));
}

export function renderExamTakeView(ctx, root, assignmentId) {
  root.appendChild(el('h1', { className: 'page-title' }, 'Làm bài thi'));
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
  let flushChain = Promise.resolve();
  let flushScheduled = false;

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    flushChain = flushChain.then(async () => {
      flushScheduled = false;
      while (pendingByQuestion.size && !disposed) {
        const [questionId, optionId] = pendingByQuestion.entries().next().value;
        pendingByQuestion.delete(questionId);
        saveStateEl.textContent = 'Đang lưu…';
        saveStateEl.className = 'save-status pending';
        try {
          const res = await saveExamAnswer(attemptId, questionId, optionId, revision);
          if (disposed) return;
          revision = res.revision;
          saveStateEl.textContent = 'Đã lưu';
          saveStateEl.className = 'save-status ok';
        } catch (e) {
          if (disposed) return;
          pendingByQuestion.set(questionId, optionId);
          saveStateEl.textContent = e.status === 409 ? 'Xung đột — tải lại trang' : 'Lỗi lưu — thử lại';
          saveStateEl.className = 'save-status err';
          break;
        }
      }
    });
    return flushChain;
  }

  function persistAnswer(questionId, optionId) {
    if (!exam?.attempt) return;
    exam.attempt.answers = { ...(exam.attempt.answers || {}), [questionId]: optionId };
    pendingByQuestion.set(questionId, optionId);
    scheduleFlush();
  }

  async function drainSaves() {
    await scheduleFlush();
    while ((pendingByQuestion.size || saveStateEl.className.includes('pending')) && !disposed) {
      await scheduleFlush();
      await new Promise((r) => setTimeout(r, 20));
    }
    if (saveStateEl.className.includes('err')) {
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

  function passageForQuestion(q) {
    if (!q.passageId) return null;
    return (exam.passages || []).find((p) => p.id === q.passageId) || null;
  }

  function renderQuestions() {
    while (host.firstChild) host.removeChild(host.firstChild);
    const renderedPassages = new Set();
    for (const q of exam.questions || []) {
      const passage = passageForQuestion(q);
      if (passage && !renderedPassages.has(passage.id)) {
        renderedPassages.add(passage.id);
        const pCard = el('div', {
          className: 'card exam-passage',
          style: 'margin:0.75rem 0;padding:0.75rem;background:#f8f8f8',
        });
        if (passage.title) pCard.appendChild(el('h3', {}, passage.title));
        pCard.appendChild(el('div', {}, passage.bodyText || ''));
        host.appendChild(pCard);
      }
      const card = el('div', { className: 'card', style: 'margin:0.5rem 0;padding:0.75rem' });
      card.appendChild(el('p', {}, el('strong', {}, `Câu ${q.displayNumber}: `), q.stemText));
      const chosen = exam.attempt?.answers?.[q.id];
      for (const o of q.options || []) {
        card.appendChild(el('label', { style: 'display:block' }, [
          el('input', {
            type: 'radio',
            name: q.id,
            checked: chosen === o.id,
            onChange: () => persistAnswer(q.id, o.id),
          }),
          ` ${o.label}. ${o.text}`,
        ]));
      }
      host.appendChild(card);
    }
    const submitBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Nộp bài');
    submitBtn.addEventListener('click', () => withBusyButton(submitBtn, 'Đang nộp…', async () => {
      try {
        await drainSaves();
        const res = await submitExamAttempt(attemptId);
        const showScore = exam.assignment?.showScore !== false;
        if (showScore && res.score10 != null) {
          ctx.toastOk(`Điểm: ${res.score10}/10 (${res.correctCount}/${res.totalCount})`);
        } else {
          ctx.toastOk('Đã nộp bài.');
        }
        await load();
      } catch (e) {
        ctx.toastErr(e.message || 'Không nộp được bài.');
      }
    }));
    host.appendChild(submitBtn);
  }

  function renderResult(ex) {
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(el('p', {}, ex.disclaimer || ''));
    if (ex.result?.score10 != null) {
      host.appendChild(el('p', {}, `Điểm: ${ex.result.score10}/10`));
    } else {
      host.appendChild(el('p', {}, 'Điểm sẽ hiển thị theo cài đặt giáo viên.'));
    }
  }

  async function load() {
    const detail = await fetchStudentExamDetail(assignmentId);
    if (disposed) return;
    exam = detail.exam;
    if (exam.attempt?.status === 'submitted') {
      renderResult(exam);
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
    statusEl.textContent = `Hạn nộp: ${new Date(deadlineAt).toLocaleString('vi-VN')}`;
    if (!exam.attempt) exam.attempt = { answers: {}, revision: 0 };
    renderQuestions();
    updateClock();
  }

  load().catch((e) => ctx.toastErr(e.message));
  startClock();

  root.__examDispose = () => {
    disposed = true;
    if (clockTimer) clearInterval(clockTimer);
  };
}
