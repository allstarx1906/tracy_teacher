import { el } from './ba-ui-dom.js';
import { withBusyButton, wireDialogA11y } from './ux-forms.js';
import {
  fetchExamComposeSource,
  fetchEditableExamDrafts,
  appendComposedQuestionsToDraft,
  undoComposeAppend,
  createExamDraft,
} from './exam-api.js';
import {
  EXAM_SKILL,
  EXAM_QUESTION_TYPE,
  parseExamMetadataFilters,
  computeExamMetadataFilterCounts,
} from './exam-domain.js';
import { mountExamTakeQuestionUi } from './exam-ui-student.js';
import { fetchTeacherExamVersionStudentPreview } from './exam-api.js';

const SKILL_OPTIONS = [
  { id: EXAM_SKILL.LISTENING, label: 'Nghe' },
  { id: EXAM_SKILL.READING, label: 'Đọc' },
  { id: EXAM_SKILL.WRITING, label: 'Viết' },
  { id: EXAM_SKILL.SPEAKING, label: 'Nói' },
  { id: EXAM_SKILL.UNCLASSIFIED, label: 'Chưa phân loại' },
];

const TYPE_OPTIONS = [
  { id: EXAM_QUESTION_TYPE.SINGLE_CHOICE, label: 'Trắc nghiệm' },
  { id: EXAM_QUESTION_TYPE.TRUE_FALSE_NOT_GIVEN, label: 'Đúng/Sai' },
  { id: EXAM_QUESTION_TYPE.MATCHING, label: 'Ghép' },
  { id: EXAM_QUESTION_TYPE.WORD_BANK, label: 'Điền từ' },
  { id: EXAM_QUESTION_TYPE.SHORT_ANSWER, label: 'Trả lời ngắn' },
  { id: EXAM_QUESTION_TYPE.ESSAY, label: 'Bài luận' },
];

export function renderExamSourceReadView(ctx, root, versionId) {
  let disposed = false;
  let activeDialog = null;
  let loadGeneration = 0;

  const priorDispose = root.__examDispose;
  root.__examDispose = () => {
    disposed = true;
    loadGeneration += 1;
    if (activeDialog) {
      activeDialog.remove();
      activeDialog = null;
    }
    if (typeof priorDispose === 'function') priorDispose();
  };

  root.appendChild(el('h1', { className: 'page-title' }, 'Đọc nguồn như học sinh'));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/exams'),
  }, '← Kho đề'));

  const host = el('div', { className: 'exam-source-read card', 'data-exam-source-read': versionId });
  root.appendChild(host);

  const filterBar = el('div', { className: 'filter-bar exam-source-filter', 'data-exam-source-filter-bar': '' });
  const chipHost = el('div', { className: 'exam-source-filter-chips' });
  const activeFilters = { skills: [], types: [] };
  let sourceData = null;
  let previewExam = null;
  const selectedIds = new Set();

  function syncChipActive(btn, on) {
    btn.className = on
      ? 'btn btn-secondary btn-sm exam-filter-chip--active'
      : 'btn btn-ghost btn-sm';
  }

  function skillChip(skill, label) {
    const btn = el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm',
      'data-exam-filter-skill': skill,
    }, label);
    btn.addEventListener('click', () => {
      if (disposed) return;
      const on = activeFilters.skills.includes(skill);
      activeFilters.skills = on
        ? activeFilters.skills.filter((s) => s !== skill)
        : [...activeFilters.skills, skill];
      syncChipActive(btn, !on);
      loadSource().catch((e) => ctx.toastErr(e.message));
    });
    return btn;
  }

  function typeChip(type, label) {
    const btn = el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm',
      'data-exam-filter-type': type,
    }, label);
    btn.addEventListener('click', () => {
      if (disposed) return;
      const on = activeFilters.types.includes(type);
      activeFilters.types = on
        ? activeFilters.types.filter((t) => t !== type)
        : [...activeFilters.types, type];
      syncChipActive(btn, !on);
      loadSource().catch((e) => ctx.toastErr(e.message));
    });
    return btn;
  }

  filterBar.appendChild(el('span', { className: 'form-hint' }, 'Lọc kỹ năng:'));
  for (const row of SKILL_OPTIONS) filterBar.appendChild(skillChip(row.id, row.label));
  filterBar.appendChild(el('span', { className: 'form-hint', style: 'margin-left:0.5rem' }, 'Loại:'));
  for (const row of TYPE_OPTIONS) filterBar.appendChild(typeChip(row.id, row.label));
  const resetBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Đặt lại lọc');
  resetBtn.addEventListener('click', () => {
    if (disposed) return;
    activeFilters.skills = [];
    activeFilters.types = [];
    for (const b of filterBar.querySelectorAll('[data-exam-filter-skill],[data-exam-filter-type]')) {
      b.className = 'btn btn-ghost btn-sm';
    }
    loadSource().catch((e) => ctx.toastErr(e.message));
  });
  filterBar.appendChild(resetBtn);
  filterBar.appendChild(chipHost);
  host.appendChild(filterBar);

  const previewHost = el('div', { className: 'exam-source-preview', 'data-exam-source-preview': '' });
  host.appendChild(previewHost);

  const bulkBar = el('div', {
    className: 'exam-source-bulk btn-row',
    'data-exam-source-bulk': '',
    style: 'position:sticky;bottom:var(--bottom-nav-h);background:var(--surface);padding:0.5rem;border-top:1px solid var(--border-card)',
  });
  const bulkCount = el('span', { 'data-exam-bulk-count': '' }, 'Chưa chọn câu');
  const addBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Thêm vào bản nháp');
  bulkBar.appendChild(bulkCount);
  bulkBar.appendChild(addBtn);
  host.appendChild(bulkBar);

  let lastUndo = null;

  function refreshBulkCount() {
    bulkCount.textContent = selectedIds.size ? `Đã chọn ${selectedIds.size} câu` : 'Chưa chọn câu';
  }

  function renderQuickAddChrome() {
    if (disposed) return;
    previewHost.replaceChildren();
    if (!previewExam) {
      previewHost.appendChild(el('p', { className: 'exam-teacher-hub__loading' }, 'Đang tải nội dung…'));
      return;
    }
    const qWrap = el('div', { className: 'exam-source-question-actions' });
    for (const q of sourceData?.questions || []) {
      const row = el('div', {
        className: 'exam-source-q-row btn-row',
        style: 'align-items:flex-start;margin:0.35rem 0',
        'data-exam-source-q': q.id,
      });
      const cb = el('input', { type: 'checkbox', checked: selectedIds.has(q.id), disabled: !q.composeSupported });
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(q.id);
        else selectedIds.delete(q.id);
        refreshBulkCount();
      });
      const addOne = el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        disabled: !q.composeSupported,
        title: q.composeSupported ? 'Thêm câu này' : 'Loại câu không hỗ trợ sao chép',
      }, 'Thêm');
      addOne.addEventListener('click', () => openTargetDialog([q.id]).catch((e) => ctx.toastErr(e.message)));
      const meta = el('span', { style: 'font-size:0.85rem;color:var(--muted)' },
        `${q.skill || ''} · ${q.questionType || ''}`);
      row.appendChild(cb);
      row.appendChild(el('span', {}, `Câu ${q.displayNumber}`));
      row.appendChild(meta);
      row.appendChild(addOne);
      if (!q.composeSupported) {
        row.appendChild(el('span', { className: 'badge badge-gray' }, 'Không hỗ trợ'));
      }
      qWrap.appendChild(row);
    }
    previewHost.appendChild(qWrap);

    for (const g of sourceData?.groups || []) {
      const gBtn = el('button', {
        type: 'button',
        className: 'btn btn-secondary btn-sm',
        style: 'margin:0.35rem 0.35rem 0.35rem 0',
      }, `Thêm nhóm (${g.questionIds?.length || 0} câu)`);
      gBtn.addEventListener('click', () => openTargetDialog(g.questionIds || []).catch((e) => ctx.toastErr(e.message)));
      previewHost.appendChild(gBtn);
    }

    const takeHost = el('div', { className: 'exam-source-student-preview', style: 'margin-top:1rem' });
    mountExamTakeQuestionUi(takeHost, previewExam, { answers: {}, readOnly: true });
    previewHost.appendChild(takeHost);
  }

  async function loadSource() {
    const gen = ++loadGeneration;
    const filters = parseExamMetadataFilters(activeFilters);
    const data = await fetchExamComposeSource(versionId, filters);
    if (disposed || gen !== loadGeneration) return;
    sourceData = data.source;
    const qual = data.filterQualification;
    const counts = computeExamMetadataFilterCounts(data.source?.questions || sourceData?.questions || []);
    chipHost.replaceChildren();
    if (qual) {
      chipHost.appendChild(document.createTextNode(
        `Khớp ${qual.matchingQuestionCount}/${qual.totalQuestionCount} câu`,
      ));
      if (counts.unclassified > 0) {
        chipHost.appendChild(el('span', { className: 'badge badge-gray', style: 'margin-left:0.35rem' },
          `${counts.unclassified} chưa phân loại`));
      }
    }
    const prev = await fetchTeacherExamVersionStudentPreview(versionId);
    if (disposed || gen !== loadGeneration) return;
    previewExam = prev?.exam || null;
    selectedIds.clear();
    refreshBulkCount();
    renderQuickAddChrome();
  }

  async function openTargetDialog(questionIds) {
    if (!questionIds?.length) {
      ctx.toastErr('Chưa chọn câu.');
      return;
    }
    const overlay = el('div', { className: 'modal-overlay exam-quick-add-dialog', role: 'presentation' });
    activeDialog = overlay;
    const panel = el('div', {
      className: 'card modal-panel exam-quick-add-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'exam-quick-add-title',
    });
    const search = el('input', { type: 'search', className: 'input', placeholder: 'Tìm bản nháp của bạn…' });
    const list = el('div', { className: 'exam-quick-add-targets' });
    const newTitle = el('input', { type: 'text', className: 'input', placeholder: 'Tiêu đề bản nháp mới (tùy chọn)' });
    const createBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Tạo bản nháp mới');
    panel.appendChild(el('h2', { id: 'exam-quick-add-title' }, 'Chọn bản nháp đích'));
    panel.appendChild(search);
    panel.appendChild(list);
    panel.appendChild(el('p', { className: 'form-hint' }, 'Hoặc tạo bản nháp trống:'));
    panel.appendChild(newTitle);
    panel.appendChild(createBtn);
    const closeBtn = el('button', { type: 'button', className: 'btn btn-ghost' }, 'Đóng');
    panel.appendChild(closeBtn);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    let disposeA11y = null;
    const dispose = () => {
      disposeA11y?.();
      disposeA11y = null;
      overlay.remove();
      if (activeDialog === overlay) activeDialog = null;
    };
    disposeA11y = wireDialogA11y({
      backdrop: overlay,
      dialog: panel,
      titleId: 'exam-quick-add-title',
      onRequestClose: dispose,
      initialFocus: search,
    });

    let targetGen = 0;

    async function renderTargets() {
      const gen = ++targetGen;
      list.replaceChildren(el('p', {}, 'Đang tải…'));
      const rows = await fetchEditableExamDrafts(search.value.trim());
      if (disposed || gen !== targetGen) return;
      list.replaceChildren();
      for (const d of rows.drafts || []) {
        const pick = el('button', {
          type: 'button',
          className: 'btn btn-ghost',
          style: 'display:block;width:100%;text-align:left',
        }, `${d.title || d.id} (${d.questionCount} câu)`);
        pick.addEventListener('click', () => withBusyButton(pick, 'Đang thêm…', async () => {
          const res = await appendComposedQuestionsToDraft(d.id, {
            sourceVersionId: versionId,
            questionIds,
          });
          lastUndo = { draftId: d.id, baseRevision: res.revision, addedCount: res.addedCount };
          const dup = res.skippedDuplicateSourceQuestions || 0;
          dispose();
          ctx.toastOk(`Đã thêm ${res.addedCount} câu${dup ? ` (bỏ qua ${dup} trùng)` : ''}.`);
          if (lastUndo?.addedCount) {
            const undoBar = el('div', { className: 'toast-actions btn-row' });
            const openDraft = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Mở bản nháp');
            openDraft.addEventListener('click', () => ctx.navigate(`#/exams/draft/${d.id}`));
            const undo = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Hoàn tác');
            undo.addEventListener('click', () => undoComposeAppend(d.id, lastUndo.baseRevision)
              .then(() => ctx.toastOk('Đã hoàn tác lần thêm câu.'))
              .catch((e) => ctx.toastErr(e.message)));
            undoBar.appendChild(openDraft);
            undoBar.appendChild(undo);
            host.appendChild(undoBar);
            setTimeout(() => { if (!disposed) undoBar.remove(); }, 15000);
          }
        }).catch((e) => ctx.toastErr(e.message)));
        list.appendChild(pick);
      }
      if (!rows.drafts?.length) list.appendChild(el('p', { className: 'empty-state' }, 'Không có bản nháp phù hợp.'));
    }

    search.addEventListener('input', () => renderTargets().catch(() => {}));
    createBtn.addEventListener('click', () => withBusyButton(createBtn, 'Đang tạo…', async () => {
      const created = await createExamDraft({
        blank: true,
        title: newTitle.value.trim() || undefined,
      });
      const res = await appendComposedQuestionsToDraft(created.draftId, {
        sourceVersionId: versionId,
        questionIds,
      });
      dispose();
      ctx.toastOk(`Đã tạo và thêm ${res.addedCount} câu.`);
      ctx.navigate(`#/exams/draft/${created.draftId}`);
    }).catch((e) => ctx.toastErr(e.message)));
    closeBtn.addEventListener('click', dispose);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) dispose(); });
    await renderTargets();
  }

  addBtn.addEventListener('click', () => openTargetDialog([...selectedIds]).catch((e) => ctx.toastErr(e.message)));

  loadSource().catch((e) => {
    if (disposed) return;
    host.appendChild(el('p', { className: 'demo-banner' }, e.message || 'Không tải được nguồn.'));
    ctx.toastErr(e.message);
  });
}
