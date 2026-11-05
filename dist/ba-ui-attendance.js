import {
  SESSION_STATUS,
  formatSessionLocal,
  getActiveAttendanceStatuses,
  getCurrentAttendance,
  attendanceDisplayStudentIds,
  formatAttendanceAuditLine,
} from './ba-domain.js';
import { baPutAttendanceRecord } from './ba-api.js';
import { el } from './ba-ui-dom.js';
import { registerBaViewDirty, runBaScopedSubmit } from './ba-ui-scoped.js';
import { runMutationGuard, captureAcknowledgedFormSnapshot } from './ux-forms.js';

/** @type {Set<string>} */
const rowBusyKeys = new Set();
let bulkSaveActive = false;

function statusOptionsForRow(catalog, rec) {
  const active = getActiveAttendanceStatuses(catalog);
  const opts = [{ value: '', label: 'Chưa điểm danh' }];
  for (const st of active) opts.push({ value: st.id, label: st.label });
  if (rec?.statusId && !active.some((s) => s.id === rec.statusId)) {
    opts.push({
      value: rec.statusId,
      label: rec.statusLabelAtSave || rec.statusId,
    });
  }
  return opts;
}

function readEditableRowValues(fields) {
  const statusId = fields.statusSel.value;
  const note = fields.noteIn.value;
  const minutesRaw = fields.minutesIn.value.trim();
  const minutesLate = minutesRaw === '' ? null : Math.max(0, Number(minutesRaw) || 0);
  return { statusId, note, minutesLate };
}

function readRowPayload(sessionId, studentId, fields, rec) {
  const { statusId, note, minutesLate } = readEditableRowValues(fields);
  const correctionReason = rec && fields.corrIn
    ? fields.corrIn.value.trim()
    : undefined;
  return {
    sessionId,
    studentId,
    statusId,
    note,
    minutesLate,
    expectedRevision: rec?.revision,
    correctionReason,
  };
}

function rowHasSaveableChanges(fields, rec, sessionId, studentId) {
  const payload = readRowPayload(sessionId, studentId, fields, rec);
  if (!payload.statusId) return false;
  if (!rec) return true;
  const sameStatus = payload.statusId === rec.statusId;
  const sameNote = (payload.note || '') === (rec.note || '');
  const sameMins = (payload.minutesLate ?? null) === (rec.minutesLate ?? null);
  return !(sameStatus && sameNote && sameMins);
}

function isLateStatusId(statusId, catalog) {
  if (!statusId) return false;
  if (statusId === 'late') return true;
  const row = (catalog || []).find((s) => s.id === statusId);
  return /muộn|late/i.test(String(row?.label || ''));
}

function renderAuditBlock(audits, data) {
  const box = el('div', { className: 'ba-audit-list' });
  if (!audits.length) {
    box.appendChild(el('p', { className: 'empty-state' }, 'Chưa có lịch sử điểm danh.'));
    return box;
  }
  const list = el('ul', { className: 'ba-audit-list-ul' });
  for (const a of [...audits].sort((x, y) => String(y.at).localeCompare(String(x.at)))) {
    list.appendChild(el('li', {}, formatAttendanceAuditLine(a, data)));
  }
  box.appendChild(el('strong', {}, 'Lịch sử điểm danh'));
  box.appendChild(list);
  return box;
}

function statusIdFromToggleButton(btn) {
  const fromAttr = btn.getAttribute?.('data-status-id');
  if (fromAttr != null && fromAttr !== '') return fromAttr;
  return btn.dataset?.statusId ?? '';
}

function syncStatusToggleButtons(rowState, catalog) {
  const selected = rowState.fields.statusSel.value;
  for (const btn of rowState.statusButtons) {
    const on = statusIdFromToggleButton(btn) === selected;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-selected', on);
  }
}

function syncMinutesVisibility(rowState, catalog) {
  const show = isLateStatusId(rowState.fields.statusSel.value, catalog);
  rowState.minutesWrap.hidden = !show;
  rowState.minutesWrap.setAttribute('aria-hidden', show ? 'false' : 'true');
}

export function renderAttendanceView(ctx, root, scope, sessionId) {
  const data = ctx.state.data;
  const session = (data.classSessions || []).find((s) => s.id === sessionId);
  const cls = session ? data.classes.find((c) => c.id === session.classId) : null;
  const scheduleHref = session ? `#/tutor/schedule/${session.classId}` : '#/tutor/schedule';

  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost ba-attendance-back',
    onClick: () => ctx.navigate(scheduleHref),
  }, '← Lịch lớp'));

  if (!session) {
    root.appendChild(el('p', {}, 'Không tìm thấy buổi.'));
    return;
  }

  const readonly = session.status === SESSION_STATUS.CANCELLED;
  root.appendChild(el('h1', { className: 'page-title ba-attendance-title' },
    readonly ? 'Điểm danh (đã hủy — chỉ xem)' : 'Điểm danh',
  ));
  root.appendChild(el('p', { className: 'ba-attendance-context' },
    `Lớp: ${cls?.name || session.classId} · Buổi: ${formatSessionLocal(session.startAt)} · ${session.status}`,
  ));
  if (readonly) {
    root.appendChild(el('p', { className: 'ba-attendance-readonly-note', role: 'status' },
      'Buổi đã hủy — giữ lại điểm danh và lịch sử, không chỉnh sửa.',
    ));
  }

  const headerStats = el('p', { className: 'ba-attendance-stats' }, '…');
  root.appendChild(headerStats);

  const catalog = ctx.state.data.attendanceStatusCatalog || [];

  function presentStatusId() {
    const active = getActiveAttendanceStatuses(catalog);
    return active.find((s) => s.id === 'present')?.id ?? null;
  }

  function studentDisplayName(studentId) {
    return ctx.state.data.students.find((s) => s.id === studentId)?.name || studentId;
  }

  const toolbar = el('div', { className: 'ba-attendance-toolbar' });
  const markAllBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary ba-attendance-mark-all',
    'aria-label': 'Đặt tất cả học sinh chưa điểm danh là có mặt',
  }, 'Tất cả có mặt');
  const bulkBtn = el('button', {
    type: 'button',
    className: 'btn btn-primary ba-attendance-save-all',
    'aria-label': 'Lưu điểm danh các dòng đã thay đổi',
  }, 'Lưu điểm danh');
  if (!readonly) {
    toolbar.appendChild(markAllBtn);
    toolbar.appendChild(bulkBtn);
    const presentId = presentStatusId();
    if (!presentId) {
      markAllBtn.disabled = true;
      markAllBtn.setAttribute('aria-disabled', 'true');
      markAllBtn.title = 'Không có trạng thái có mặt đang bật';
    }
  }
  root.appendChild(toolbar);

  const rowHost = el('div', { className: 'ba-attendance-rows' });
  root.appendChild(rowHost);

  const bulkResult = el('div', { className: 'card ba-attendance-bulk-result', role: 'status' });
  root.appendChild(bulkResult);

  /** @type {Map<string, object>} */
  const rowStates = new Map();
  const viewGen = scope.generation;

  function currentRec(studentId) {
    return getCurrentAttendance(ctx.state.data, sessionId, studentId);
  }

  function refreshHeader() {
    const ids = attendanceDisplayStudentIds(ctx.state.data, session);
    let marked = 0;
    let dirty = 0;
    for (const id of ids) {
      const rec = currentRec(id);
      if (rec?.statusId) marked += 1;
      const st = rowStates.get(id);
      if (st?.dirtyProbe?.()) dirty += 1;
    }
    headerStats.textContent = `Đã điểm danh: ${marked}/${ids.length} · Dòng chưa lưu: ${dirty}`;
  }

  function replaceAuditHost(rowState) {
    const audits = (ctx.state.data.attendanceAudit || []).filter(
      (a) => a.sessionId === sessionId && a.studentId === rowState.studentId,
    );
    const next = renderAuditBlock(audits, ctx.state.data);
    const parent = rowState.auditHost.parentNode;
    if (parent) {
      parent.removeChild(rowState.auditHost);
      parent.appendChild(next);
    }
    rowState.auditHost = next;
  }

  function syncRowMeta(rowState) {
    const rec = currentRec(rowState.studentId);
    rowState.rec = rec;
    const label = rec
      ? (rec.statusLabelAtSave || rec.statusId)
      : 'Chưa điểm danh';
    rowState.statusLine.textContent = rec ? `Đã lưu · ${label}` : 'Chưa điểm danh';
    if (rec) {
      rowState.revisionMeta.textContent = `rev ${rec.revision}`;
    } else {
      rowState.revisionMeta.textContent = '';
    }
    rowState.errLine.textContent = '';
    replaceAuditHost(rowState);
    refreshHeader();
  }

  function setRowStatus(rowState, statusId, { markDirty = true } = {}) {
    if (readonly) return;
    rowState.fields.statusSel.value = statusId;
    syncStatusToggleButtons(rowState, catalog);
    syncMinutesVisibility(rowState, catalog);
    if (markDirty) refreshHeader();
  }

  function buildRow(studentId) {
    const st = ctx.state.data.students.find((s) => s.id === studentId);
    const rec = currentRec(studentId);
    const rowEl = el('article', {
      className: 'card ba-attendance-row',
      'data-student-id': studentId,
    });
    rowEl.appendChild(el('h3', { className: 'ba-attendance-row-name' }, st?.name || studentId));

    const statusSel = el('select', {
      className: 'visually-hidden ba-attendance-status-select',
      'aria-label': `Trạng thái ${st?.name || studentId}`,
    });
    for (const opt of statusOptionsForRow(catalog, rec)) {
      statusSel.appendChild(el('option', {
        value: opt.value,
        selected: (rec?.statusId || '') === opt.value,
      }, opt.label));
    }
    statusSel.value = rec?.statusId || '';

    const toggleGroup = el('div', {
      className: 'ba-attendance-status-toggles',
      role: 'group',
      'aria-label': `Trạng thái điểm danh ${st?.name || studentId}`,
    });
    const statusButtons = [];
    const activeStatuses = getActiveAttendanceStatuses(catalog);
    const buttonStatuses = [...activeStatuses];
    if (rec?.statusId && !activeStatuses.some((s) => s.id === rec.statusId)) {
      buttonStatuses.push({
        id: rec.statusId,
        label: rec.statusLabelAtSave || rec.statusId,
      });
    }
    for (const stRow of buttonStatuses) {
      const btn = el('button', {
        type: 'button',
        className: 'btn btn-secondary ba-attendance-status-btn',
        'data-status-id': stRow.id,
        'aria-pressed': (rec?.statusId || '') === stRow.id ? 'true' : 'false',
      }, stRow.label);
      btn.addEventListener('click', () => {
        if (readonly || rowBusyKeys.has(studentId) || bulkSaveActive) return;
        setRowStatus(rowState, stRow.id);
        refreshCorrectionUiForEdit();
        refreshHeader();
      });
      statusButtons.push(btn);
      toggleGroup.appendChild(btn);
    }

    const noteIn = el('input', {
      type: 'text',
      className: 'ba-attendance-note-input',
      value: rec?.note || '',
      'aria-label': `Ghi chú ${st?.name || studentId}`,
    });
    const minutesIn = el('input', {
      type: 'number',
      min: '0',
      className: 'ba-attendance-minutes-input',
      value: rec?.minutesLate != null ? String(rec.minutesLate) : '',
      'aria-label': `Số phút trễ ${st?.name || studentId}`,
      placeholder: 'Phút trễ (tùy chọn)',
    });
    const minutesWrap = el('label', { className: 'ba-attendance-minutes-wrap form-field' }, 'Phút trễ ', minutesIn);
    const corrMount = el('div', { className: 'ba-attendance-corr-mount' });

    const errLine = el('p', { className: 'ba-attendance-row-error', role: 'alert' }, '');
    const statusLine = el('p', { className: 'ba-attendance-row-status' },
      rec ? `Đã lưu · ${rec.statusLabelAtSave || rec.statusId}` : 'Chưa điểm danh',
    );
    const revisionMeta = el('span', { className: 'visually-hidden ba-attendance-revision-meta' },
      rec ? `rev ${rec.revision}` : '',
    );

    const fields = [statusSel, noteIn, minutesIn];
    const fieldRefs = { statusSel, noteIn, minutesIn, corrIn: null, corrWrap: null };

    function mountCorrectionFields() {
      if (fieldRefs.corrIn) return fieldRefs.corrIn;
      const corrIn = el('input', {
        type: 'text',
        className: 'ba-attendance-corr-input',
        value: '',
        'aria-label': `Lý do sửa ${st?.name || studentId}`,
      });
      const corrWrap = el('label', { className: 'ba-attendance-corr-wrap form-field' },
        'Lý do sửa (bắt buộc khi đã lưu) ', corrIn);
      fieldRefs.corrIn = corrIn;
      fieldRefs.corrWrap = corrWrap;
      corrMount.appendChild(corrWrap);
      fields.push(corrIn);
      if (readonly) {
        corrIn.disabled = true;
        corrIn.setAttribute?.('aria-disabled', 'true');
      }
      return corrIn;
    }

    function setStatusButtonsDisabled(disabled) {
      if (readonly) return;
      for (const btn of statusButtons) {
        btn.disabled = disabled;
      }
    }

    function refreshCorrectionUiForEdit() {
      const liveRec = currentRec(studentId);
      if (!liveRec || readonly) return;
      if (!rowHasSaveableChanges(fieldRefs, liveRec, sessionId, studentId)) return;
      mountCorrectionFields();
      fieldRefs.corrWrap.hidden = false;
    }

    function rowPersistFields() {
      const list = [statusSel, noteIn, minutesIn];
      if (fieldRefs.corrIn) list.push(fieldRefs.corrIn);
      return list;
    }

    if (rec) {
      mountCorrectionFields();
    }

    const saveBtn = el('button', { type: 'button', className: 'btn btn-primary ba-attendance-row-save' }, 'Lưu dòng');
    const reloadBtn = el('button', { type: 'button', className: 'btn btn-ghost ba-attendance-row-reload' }, 'Tải lại dòng');

    const auditHost = renderAuditBlock(
      (ctx.state.data.attendanceAudit || []).filter(
        (a) => a.sessionId === sessionId && a.studentId === studentId,
      ),
      ctx.state.data,
    );

    const details = el('details', { className: 'ba-attendance-row-details' });
    details.appendChild(el('summary', {}, 'Ghi chú, sửa & lịch sử'));
    details.appendChild(el('label', { className: 'form-field' }, 'Ghi chú ', noteIn));
    details.appendChild(minutesWrap);
    details.appendChild(corrMount);
    if (!readonly) {
      const detailActions = el('div', { className: 'ba-attendance-row-detail-actions' });
      detailActions.appendChild(saveBtn);
      detailActions.appendChild(reloadBtn);
      details.appendChild(detailActions);
    }
    details.appendChild(auditHost);

    const head = el('div', { className: 'ba-attendance-row-head' });
    head.appendChild(toggleGroup);
    rowEl.appendChild(head);
    rowEl.appendChild(statusSel);
    rowEl.appendChild(statusLine);
    rowEl.appendChild(revisionMeta);
    rowEl.appendChild(details);
    rowEl.appendChild(errLine);

    if (readonly) {
      for (const f of fields) {
        f.disabled = true;
        f.setAttribute?.('aria-disabled', 'true');
      }
      for (const btn of statusButtons) {
        btn.disabled = true;
      }
    }

    const dirtyProbe = registerBaViewDirty(scope, fields);

    const rowState = {
      studentId,
      rowEl,
      details,
      fields: fieldRefs,
      statusButtons,
      saveBtn,
      reloadBtn,
      errLine,
      statusLine,
      revisionMeta,
      auditHost,
      minutesWrap,
      dirtyProbe,
      rec,
    };
    rowStates.set(studentId, rowState);
    syncStatusToggleButtons(rowState, catalog);
    syncMinutesVisibility(rowState, catalog);

    noteIn.addEventListener('input', () => {
      refreshCorrectionUiForEdit();
      refreshHeader();
    });
    minutesIn.addEventListener('input', () => {
      refreshCorrectionUiForEdit();
      refreshHeader();
    });

    statusSel.addEventListener('change', () => {
      syncStatusToggleButtons(rowState, catalog);
      syncMinutesVisibility(rowState, catalog);
      refreshCorrectionUiForEdit();
      refreshHeader();
    });

    reloadBtn.addEventListener('click', () => {
      if (!window.confirm('Bỏ thay đổi chưa lưu trên dòng này?')) return;
      const latest = currentRec(studentId);
      statusSel.value = latest?.statusId || '';
      noteIn.value = latest?.note || '';
      minutesIn.value = latest?.minutesLate != null ? String(latest.minutesLate) : '';
      if (fieldRefs.corrIn) fieldRefs.corrIn.value = '';
      syncStatusToggleButtons(rowState, catalog);
      syncMinutesVisibility(rowState, catalog);
      dirtyProbe.markClean?.();
      refreshHeader();
    });

    async function saveThisRow({ fromBulk = false } = {}) {
      if (readonly || bulkSaveActive && !fromBulk) return { skipped: true };
      if (rowBusyKeys.has(studentId) && !fromBulk) return { skipped: true };
      const liveRec = currentRec(studentId);
      rowState.rec = liveRec;
      if (!rowHasSaveableChanges(rowState.fields, liveRec, sessionId, studentId)) {
        errLine.textContent = 'Không có thay đổi để lưu.';
        return { skipped: true, unchanged: true };
      }
      const payload = readRowPayload(sessionId, studentId, rowState.fields, liveRec);
      if (!payload.statusId) {
        errLine.textContent = 'Chọn trạng thái điểm danh.';
        return { ok: false };
      }
      if (liveRec && !payload.correctionReason) {
        errLine.textContent = 'Nhập lý do sửa.';
        rowState.details.open = true;
        mountCorrectionFields();
        fieldRefs.corrWrap.hidden = false;
        fieldRefs.corrIn.focus?.();
        return { ok: false };
      }

      rowBusyKeys.add(studentId);
      setStatusButtonsDisabled(true);
      const guardKey = `ba-attendance-row:${sessionId}:${studentId}`;
      try {
        const result = await runBaScopedSubmit(ctx, scope, {
          guardKey,
          btn: saveBtn,
          busyLabel: 'Đang lưu…',
          fields: rowPersistFields(),
          buttons: [saveBtn, reloadBtn, bulkBtn, markAllBtn, ...statusButtons],
          readPayload: () => readRowPayload(sessionId, studentId, rowState.fields, currentRec(studentId)),
          matchesAck: captureAcknowledgedFormSnapshot(() => readEditableRowValues(rowState.fields)),
          write: async (body) => {
            await baPutAttendanceRecord(body);
          },
          dirtyProbe,
          skipFullRender: true,
          successMessage: 'Đã lưu điểm danh.',
          onSuccess: ({ matchesSnapshot }) => {
            if (scope.generation !== viewGen) return;
            syncRowMeta(rowState);
            if (!liveRec && currentRec(studentId)) {
              mountCorrectionFields();
            }
            if (matchesSnapshot && fieldRefs.corrIn) {
              fieldRefs.corrIn.value = '';
              dirtyProbe.markClean?.();
            }
          },
        });
        if (result.error) {
          errLine.textContent = result.error.message || 'Lỗi lưu.';
        }
        return result;
      } finally {
        rowBusyKeys.delete(studentId);
        setStatusButtonsDisabled(false);
        refreshHeader();
      }
    }

    saveBtn.addEventListener('click', () => { saveThisRow(); });
    rowState.saveThisRow = saveThisRow;
    return rowEl;
  }

  for (const studentId of attendanceDisplayStudentIds(data, session)) {
    rowHost.appendChild(buildRow(studentId));
  }
  refreshHeader();

  markAllBtn.addEventListener('click', () => {
    if (readonly || bulkSaveActive) return;
    const pid = presentStatusId();
    if (!pid) {
      ctx.toastErr('Không tìm thấy trạng thái có mặt.');
      return;
    }
    for (const rowState of rowStates.values()) {
      if (rowBusyKeys.has(rowState.studentId)) continue;
      const saved = currentRec(rowState.studentId);
      if (saved?.statusId) continue;
      if (rowState.fields.statusSel.value) continue;
      setRowStatus(rowState, pid);
    }
    refreshHeader();
  });

  bulkBtn.addEventListener('click', async () => {
    bulkResult.textContent = '';
    await runMutationGuard('ba-attendance-bulk', async () => {
      bulkSaveActive = true;
      bulkBtn.disabled = true;
      markAllBtn.disabled = true;
      try {
        const lines = [];
        for (const rowState of rowStates.values()) {
          const out = await rowState.saveThisRow({ fromBulk: true });
          if (out?.unchanged || out?.skipped) continue;
          if (out?.ok) lines.push(`✓ ${studentDisplayName(rowState.studentId)}: đã lưu`);
          else lines.push(`✗ ${studentDisplayName(rowState.studentId)}: ${rowState.errLine.textContent || 'lỗi'}`);
        }
        bulkResult.textContent = lines.length ? lines.join('\n') : 'Không có dòng thay đổi.';
      } finally {
        bulkSaveActive = false;
        bulkBtn.disabled = false;
        if (presentStatusId()) {
          markAllBtn.disabled = false;
          markAllBtn.removeAttribute?.('aria-disabled');
        }
        refreshHeader();
      }
    });
  });
}
