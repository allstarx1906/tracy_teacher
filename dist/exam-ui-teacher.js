import { el, localInputToIso } from './ba-ui-dom.js';
import { uploadTeacherAttachment } from './api-client.js';
import {
  fetchExamTeacherSummary,
  startExamImport,
  fetchExamImportJob,
  fetchExamDraft,
  saveExamDraft,
  publishExamDraft,
  createExamAssignment,
  fetchExamAssignmentSummary,
  examDraftSourceUrl,
  pdfJsModuleUrl,
  pdfJsWorkerUrl,
} from './exam-api.js';
import { withBusyButton } from './ux-forms.js';
import {
  validateDraftForPublish,
  newExamQuestionId,
  defaultOptionIds,
} from './exam-domain.js';

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollImportJob(jobId, onUpdate, isCancelled) {
  for (let i = 0; i < 120; i++) {
    if (isCancelled?.()) return null;
    const data = await fetchExamImportJob(jobId);
    if (isCancelled?.()) return null;
    onUpdate(data.job);
    if (['ready', 'needs-review', 'failed', 'cancelled'].includes(data.job.status)) {
      return data.job;
    }
    await wait(500);
    if (isCancelled?.()) return null;
  }
  return null;
}

/** Textarea value must be set on the IDL property — el() only sets a value attribute. */
function initTextarea(ta, text, onInput) {
  ta.value = text ?? '';
  ta.addEventListener('input', (e) => onInput(e.target.value));
}

async function mountPdfPreview(host, draftId, draftState, ctx) {
  const wrap = el('div', { className: 'exam-pdf-preview' });
  wrap.appendChild(el('strong', {}, 'PDF gốc (chỉ giáo viên)'));
  const canvas = el('canvas', { style: 'max-width:100%;border:1px solid #eee' });
  const pageSel = el('select', { className: 'input' });
  const status = el('p', { 'aria-live': 'polite' }, 'Đang tải PDF…');
  wrap.appendChild(pageSel);
  wrap.appendChild(canvas);
  wrap.appendChild(status);
  host.appendChild(wrap);

  let disposed = false;
  wrap.__dispose = () => { disposed = true; };

  try {
    const pdfjs = await import(/* webpackIgnore: true */ pdfJsModuleUrl());
    const lib = pdfjs.default || pdfjs;
    if (lib.GlobalWorkerOptions) {
      lib.GlobalWorkerOptions.workerSrc = pdfJsWorkerUrl();
    }
    const res = await fetch(examDraftSourceUrl(draftId), { credentials: 'include' });
    if (!res.ok) throw new Error('Không tải được PDF gốc.');
    const data = await res.arrayBuffer();
    if (disposed) return;
    const pdf = await lib.getDocument({ data }).promise;
    for (let p = 1; p <= pdf.numPages; p++) {
      pageSel.appendChild(el('option', { value: String(p) }, `Trang ${p}`));
    }
    async function renderPage(num) {
      if (disposed) return;
      const page = await pdf.getPage(num);
      const viewport = page.getViewport({ scale: 1.2 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      page.cleanup?.();
      const qOnPage = (draftState.questions || []).filter((q) => q.sourcePage === num);
      if (qOnPage.length) {
        status.textContent = `Trang ${num}: ${qOnPage.map((q) => `Câu ${q.displayNumber}`).join(', ')}`;
      } else {
        status.textContent = `Trang ${num}`;
      }
    }
    pageSel.addEventListener('change', () => {
      renderPage(Number(pageSel.value)).catch((e) => ctx.toastErr(e.message));
    });
    pageSel.value = '1';
    await renderPage(1);
  } catch (e) {
    status.textContent = e.message || 'Không xem được PDF.';
  }
}

export function renderExamTeacherHub(ctx, root) {
  root.appendChild(el('h1', { className: 'page-title' }, 'Bài thi online'));
  root.appendChild(el('p', {}, 'Nhập PDF kỹ thuật số, rà soát câu hỏi, xuất bản và giao lớp.'));
  const actions = el('div', { className: 'btn-row', style: 'gap:0.5rem;margin:1rem 0' });
  actions.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-primary',
    onClick: () => ctx.navigate('#/exams/import'),
  }, 'Nhập PDF mới'));
  root.appendChild(actions);

  const listHost = el('div', { id: 'exam-teacher-list' });
  root.appendChild(listHost);

  fetchExamTeacherSummary().then((data) => {
    listHost.appendChild(el('h2', {}, 'Bản nháp'));
    if (!data.drafts?.length) {
      listHost.appendChild(el('p', {}, 'Chưa có bản nháp.'));
    } else {
      const ul = el('ul');
      for (const d of data.drafts) {
        ul.appendChild(el('li', {}, [
          el('button', {
            type: 'button',
            className: 'btn btn-ghost',
            onClick: () => ctx.navigate(`#/exams/draft/${d.id}`),
          }, d.title || 'Bản nháp'),
          ` — ${d.questionCount} câu`,
          d.needsOcr ? ' (cần OCR)' : '',
        ]));
      }
      listHost.appendChild(ul);
    }
    listHost.appendChild(el('h2', {}, 'Đã xuất bản'));
    if (!data.versions?.length) {
      listHost.appendChild(el('p', {}, 'Chưa có phiên bản xuất bản.'));
    } else {
      const ul2 = el('ul');
      for (const v of data.versions) {
        const row = el('li', { style: 'margin:0.5rem 0' }, [
          el('span', {}, `${v.title} (${v.questionCount} câu) `),
          el('button', {
            type: 'button',
            className: 'btn btn-secondary',
            onClick: () => ctx.navigate(`#/exams/assign/${v.id}`),
          }, 'Giao lớp'),
        ]);
        const linked = (data.assignments || []).filter((a) => a.versionId === v.id);
        if (linked.length) {
          row.appendChild(el('span', {}, ` — ${linked.length} lớp đã giao`));
          for (const a of linked) {
            row.appendChild(el('button', {
              type: 'button',
              className: 'btn btn-ghost',
              onClick: () => ctx.navigate(`#/exams/assign/${v.id}?assignment=${a.id}`),
            }, 'Xem kết quả'));
          }
        }
        ul2.appendChild(row);
      }
      listHost.appendChild(ul2);
    }
  }).catch((e) => ctx.toastErr(e.message));
}

export function renderExamImportView(ctx, root) {
  let disposed = false;
  root.__examDispose = () => { disposed = true; };

  root.appendChild(el('h1', { className: 'page-title' }, 'Nhập PDF bài thi'));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/exams'),
  }, '← Quay lại'));

  const fileInput = el('input', { type: 'file', accept: 'application/pdf,.pdf' });
  const statusEl = el('p', { 'aria-live': 'polite' });
  const keyPagesInput = el('input', {
    type: 'text',
    placeholder: 'Trang khóa (vd: 2)',
    className: 'input',
  });
  const btn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Tải lên và quét');
  root.appendChild(el('div', { className: 'card' },
    el('div', { className: 'form-field file-upload-field' },
      el('label', {}, 'Tệp PDF'),
      el('div', { className: 'file-upload-control' }, fileInput),
    ),
    el('div', { className: 'form-field' },
      el('label', {}, 'Trang đáp án'),
      keyPagesInput,
    ),
    statusEl,
    btn,
  ));

  btn.addEventListener('click', () => withBusyButton(btn, 'Đang quét…', async () => {
    try {
      const file = fileInput.files?.[0];
      if (!file) {
        ctx.toastErr('Chọn tệp PDF.');
        return;
      }
      statusEl.textContent = 'Đang tải tệp…';
      const uploaded = await uploadTeacherAttachment(file);
      statusEl.textContent = 'Đang quét PDF…';
      const keyPages = keyPagesInput.value.trim()
        ? keyPagesInput.value.split(/[,;\s]+/).map((x) => Number(x)).filter(Boolean)
        : [];
      const started = await startExamImport({
        sourceAttachmentId: uploaded.id,
        keyPages,
        title: file.name.replace(/\.pdf$/i, ''),
      });
      const job = await pollImportJob(started.jobId, (j) => {
        statusEl.textContent = `Trạng thái: ${j.status} (${Math.round((j.progress || 0) * 100)}%)`;
        if (j.needsOcr) statusEl.textContent += ' — cần OCR';
      }, () => disposed);
      if (disposed) return;
      if (!job?.draftId) {
        ctx.toastErr(job?.error || 'Quét thất bại.');
        return;
      }
      ctx.toastOk('Đã quét xong — mở bản nháp.');
      ctx.navigate(`#/exams/draft/${job.draftId}`);
    } catch (e) {
      ctx.toastErr(e.message || 'Lỗi nhập PDF.');
    }
  }));
}

export function renderExamAssignView(ctx, root, versionId) {
  root.appendChild(el('h1', { className: 'page-title' }, 'Giao bài thi cho lớp'));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/exams'),
  }, '← Danh sách'));

  const host = el('div');
  root.appendChild(host);
  const classes = ctx.state?.data?.classes || [];
  if (!classes.length) {
    host.appendChild(el('p', { className: 'demo-banner' }, 'Chưa có lớp — tạo lớp trước khi giao bài.'));
  }

  const classSel = el('select', { className: 'input' });
  for (const c of classes) {
    classSel.appendChild(el('option', { value: c.id }, c.name || c.id));
  }
  const titleInput = el('input', { type: 'text', className: 'input', placeholder: 'Tiêu đề giao bài' });
  const openInput = el('input', { type: 'datetime-local', className: 'input' });
  const dueInput = el('input', { type: 'datetime-local', className: 'input' });
  const durationInput = el('input', { type: 'number', className: 'input', value: '60', min: '1' });
  const attemptsInput = el('input', { type: 'number', className: 'input', value: '1', min: '1' });
  const showScoreCheck = el('input', { type: 'checkbox', checked: true, id: 'exam-show-score' });
  const releaseSel = el('select', { className: 'input' }, [
    el('option', { value: 'after-due' }, 'Sau hạn nộp'),
    el('option', { value: 'after-submit' }, 'Sau khi nộp'),
    el('option', { value: 'immediate' }, 'Ngay'),
  ]);

  host.appendChild(el('label', {}, 'Lớp ', classSel));
  host.appendChild(el('label', {}, 'Tiêu đề ', titleInput));
  host.appendChild(el('label', {}, `Mở (UTC+7) `, openInput));
  host.appendChild(el('label', {}, `Hạn nộp (UTC+7) `, dueInput));
  host.appendChild(el('label', {}, 'Thời gian làm (phút) ', durationInput));
  host.appendChild(el('label', {}, 'Số lần làm ', attemptsInput));
  host.appendChild(el('label', { htmlFor: 'exam-show-score' }, [showScoreCheck, ' Hiển thị điểm cho học sinh']));
  host.appendChild(el('label', {}, 'Công bố đáp án ', releaseSel));

  const resultHost = el('div', { className: 'exam-assign-results' });
  host.appendChild(resultHost);

  const assignBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Giao lớp');
  host.appendChild(assignBtn);

  assignBtn.addEventListener('click', () => withBusyButton(assignBtn, 'Đang giao…', async () => {
    try {
      const classId = classSel.value;
      if (!classId) {
        ctx.toastErr('Chọn lớp.');
        return;
      }
      const openAt = localInputToIso(openInput.value);
      const dueAt = localInputToIso(dueInput.value);
      if (!openAt || !dueAt) {
        ctx.toastErr('Nhập thời gian mở và hạn nộp.');
        return;
      }
      await createExamAssignment({
        versionId,
        classId,
        title: titleInput.value.trim() || 'Bài thi',
        openAt,
        dueAt,
        timeLimitMinutes: Number(durationInput.value) || 60,
        attemptLimit: Number(attemptsInput.value) || 1,
        showScore: showScoreCheck.checked,
        showAnswersAfter: releaseSel.value,
      });
      ctx.toastOk('Đã giao lớp.');
      ctx.navigate('#/exams');
    } catch (e) {
      ctx.toastErr(e.message || 'Không giao được lớp.');
    }
  }));

  const params = new URLSearchParams((typeof location !== 'undefined' && location.hash.includes('?'))
    ? location.hash.split('?')[1] : '');
  const assignmentId = params.get('assignment');
  if (assignmentId) {
    fetchExamAssignmentSummary(assignmentId).then((data) => {
      resultHost.appendChild(el('h3', {}, 'Kết quả học sinh'));
      if (!data.summary?.length) {
        resultHost.appendChild(el('p', {}, 'Chưa có lượt nộp.'));
        return;
      }
      const ul = el('ul');
      for (const row of data.summary) {
        ul.appendChild(el('li', {}, `${row.studentId}: ${row.status}${row.score10 != null ? ` — ${row.score10}/10` : ''}`));
      }
      resultHost.appendChild(ul);
    }).catch((e) => ctx.toastErr(e.message));
  }
}

export function renderExamDraftEditor(ctx, root, draftId) {
  let disposed = false;
  let previewDispose = null;
  const priorDispose = root.__examDispose;
  root.__examDispose = () => {
    disposed = true;
    if (previewDispose) previewDispose();
    previewDispose = null;
    if (typeof priorDispose === 'function') priorDispose();
  };

  root.appendChild(el('h1', { className: 'page-title' }, 'Soạn bài thi'));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/exams'),
  }, '← Danh sách'));

  const host = el('div', { className: 'exam-draft-editor' });
  root.appendChild(host);

  let draftState = null;
  let viewEpoch = 0;

  async function reload() {
    const data = await fetchExamDraft(draftId);
    if (disposed) return;
    draftState = data.draft;
    renderDraftBody();
  }

  function renderDraftBody() {
    viewEpoch += 1;
    const epoch = viewEpoch;
    if (previewDispose) previewDispose();
    previewDispose = null;
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!draftState) return;

    if (draftState.needsOcr) {
      host.appendChild(el('p', { className: 'demo-banner' }, 'PDF cần OCR — không thể xuất bản ở giai đoạn 1.'));
    }
    for (const w of draftState.warnings || []) {
      host.appendChild(el('p', { className: 'demo-banner' }, w));
    }

    const layout = el('div', { className: 'exam-draft-layout' });
    const editorCol = el('div', { className: 'exam-draft-editor-col' });
    const previewCol = el('div', { className: 'exam-draft-preview-col' });
    layout.appendChild(editorCol);
    layout.appendChild(previewCol);
    host.appendChild(layout);

    const titleInput = el('input', {
      type: 'text',
      className: 'input',
      value: draftState.title || '',
      onInput: (e) => { draftState.title = e.target.value; },
    });
    editorCol.appendChild(el('label', {}, 'Tiêu đề ', titleInput));

    for (const p of draftState.passages || []) {
      const pBlock = el('div', { className: 'card', style: 'margin:0.5rem 0;padding:0.75rem' });
      pBlock.appendChild(el('strong', {}, 'Đoạn đọc'));
      const titleTa = el('textarea', { className: 'input', rows: '1' });
      initTextarea(titleTa, p.title || '', (v) => {
        p.title = v;
        draftState.manuallyEdited = true;
      });
      const bodyTa = el('textarea', { className: 'input', rows: '4' });
      initTextarea(bodyTa, p.bodyText || '', (v) => {
        p.bodyText = v;
        draftState.manuallyEdited = true;
      });
      pBlock.appendChild(el('label', {}, 'Tiêu đề đoạn ', titleTa));
      pBlock.appendChild(el('label', {}, 'Nội dung ', bodyTa));
      editorCol.appendChild(pBlock);
    }

    const qHost = el('div');
    const sectionId = draftState.sections?.[0]?.id || 'sec1';

    function addQuestion() {
      const ordinal = (draftState.questions?.length || 0) + 1;
      const qid = newExamQuestionId(sectionId, ordinal);
      const opts = defaultOptionIds(4).map((id) => ({ id, label: id, text: '' }));
      draftState.questions.push({
        id: qid,
        sectionId,
        displayNumber: String(ordinal),
        stemText: '',
        options: opts,
        correctOptionId: null,
        points: 1,
        order: ordinal,
      });
      draftState.manuallyEdited = true;
      renderDraftBody();
    }

    function renderQuestionBlock(q, idx) {
      const block = el('div', { className: 'card', style: 'margin:0.5rem 0;padding:0.75rem' });
      block.appendChild(el('strong', {}, `Câu ${q.displayNumber}`));
      const stem = el('textarea', { className: 'input', rows: '2' });
      initTextarea(stem, q.stemText || '', (v) => {
        q.stemText = v;
        draftState.manuallyEdited = true;
      });
      block.appendChild(stem);
      const optHost = el('div');
      for (const o of q.options || []) {
        optHost.appendChild(el('label', { style: 'display:block' }, [
          el('input', {
            type: 'radio',
            name: `key-${q.id}`,
            checked: q.correctOptionId === o.id,
            onChange: () => { q.correctOptionId = o.id; draftState.manuallyEdited = true; },
          }),
          ` ${o.label}. `,
          el('input', {
            type: 'text',
            className: 'input',
            value: o.text || '',
            onInput: (e) => { o.text = e.target.value; draftState.manuallyEdited = true; },
          }),
        ]));
      }
      block.appendChild(optHost);
      const rm = el('button', {
        type: 'button',
        className: 'btn btn-ghost',
        onClick: () => {
          if (!globalThis.confirm('Xóa câu này?')) return;
          draftState.questions.splice(idx, 1);
          draftState.manuallyEdited = true;
          renderDraftBody();
        },
      }, 'Xóa câu');
      block.appendChild(rm);
      block.dataset.questionId = q.id;
      qHost.appendChild(block);
    }

    for (let i = 0; i < (draftState.questions || []).length; i++) {
      renderQuestionBlock(draftState.questions[i], i);
    }
    editorCol.appendChild(qHost);

    const addBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Thêm câu');
    addBtn.addEventListener('click', () => addQuestion());
    editorCol.appendChild(addBtn);

    const reviewCheck = el('input', { type: 'checkbox', id: 'exam-review-ok' });
    reviewCheck.checked = !!draftState.teacherConfirmedReview;
    reviewCheck.addEventListener('change', () => {
      draftState.teacherConfirmedReview = reviewCheck.checked;
    });
    editorCol.appendChild(el('label', { htmlFor: 'exam-review-ok' }, [reviewCheck, ' Tôi đã rà soát bản nháp']));

    const saveBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Lưu nháp');
    const pubBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Xuất bản');
    editorCol.appendChild(el('div', { className: 'btn-row' }, [saveBtn, pubBtn]));

    saveBtn.addEventListener('click', () => withBusyButton(saveBtn, 'Đang lưu…', async () => {
      try {
        draftState.teacherConfirmedReview = reviewCheck.checked;
        draftState.manuallyEdited = true;
        const res = await saveExamDraft(draftId, {
          title: draftState.title,
          questions: draftState.questions,
          passages: draftState.passages,
          sections: draftState.sections,
          teacherConfirmedReview: draftState.teacherConfirmedReview,
          baseRevision: draftState.revision,
        });
        if (epoch !== viewEpoch) return;
        draftState.revision = res.revision;
        ctx.toastOk('Đã lưu nháp.');
      } catch (e) {
        ctx.toastErr(e.message || 'Lỗi lưu.');
      }
    }));

    pubBtn.addEventListener('click', () => withBusyButton(pubBtn, 'Đang xuất bản…', async () => {
      try {
        draftState.title = titleInput.value;
        draftState.teacherConfirmedReview = reviewCheck.checked;
        const check = validateDraftForPublish(draftState);
        if (!check.ok) {
          ctx.toastErr(check.errors[0]);
          return;
        }
        await saveExamDraft(draftId, {
          title: draftState.title,
          questions: draftState.questions,
          passages: draftState.passages,
          sections: draftState.sections,
          teacherConfirmedReview: true,
          baseRevision: draftState.revision,
        });
        const pub = await publishExamDraft(draftId);
        ctx.toastOk(`Đã xuất bản — chọn lớp để giao.`);
        ctx.navigate(`#/exams/assign/${pub.versionId}`);
      } catch (e) {
        ctx.toastErr(e.message || 'Không xuất bản được.');
      }
    }));

    if (draftState.sourceAttachmentId) {
      mountPdfPreview(previewCol, draftId, draftState, ctx).then(() => {
        previewDispose = previewCol.firstChild?.__dispose || null;
      });
    }
  }

  reload().catch((e) => ctx.toastErr(e.message));
}
