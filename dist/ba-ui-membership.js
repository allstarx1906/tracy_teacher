import { baPutMembership } from './ba-api.js';
import { formatSessionLocal } from './ba-domain.js';
import { el, isoToLocalInput, localInputToIso } from './ba-ui-dom.js';
import { registerBaViewDirty, runBaScopedSubmit } from './ba-ui-scoped.js';

function filterMemberships(data, classId, studentId) {
  return (data.memberships || []).filter((m) => {
    if (classId && m.classId !== classId) return false;
    if (studentId && m.studentId !== studentId) return false;
    return true;
  }).sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)));
}

export function renderMembershipsView(ctx, root, scope) {
  const data = ctx.state.data;
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    style: 'margin-bottom:0.5rem',
    onClick: () => ctx.navigate('#/tutor'),
  }, '← Quay lại'));
  root.appendChild(el('h1', { className: 'page-title' }, 'Khoảng tham gia lớp'));

  const classFilter = el('select', { 'aria-label': 'Lọc lớp' });
  classFilter.appendChild(el('option', { value: '' }, 'Tất cả lớp'));
  for (const c of data.classes || []) {
    classFilter.appendChild(el('option', { value: c.id }, c.name));
  }
  const studentFilter = el('select', { 'aria-label': 'Lọc học sinh' });
  studentFilter.appendChild(el('option', { value: '' }, 'Tất cả học sinh'));
  for (const s of data.students || []) {
    studentFilter.appendChild(el('option', { value: s.id }, s.name));
  }
  root.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Lớp ', classFilter));
  root.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Học sinh ', studentFilter));

  const listHost = el('div', { className: 'card', style: 'margin-top:0.75rem' });
  root.appendChild(listHost);

  const auditHost = el('div', { className: 'card', style: 'margin-top:0.75rem' });
  auditHost.appendChild(el('h2', {}, 'Lịch sử thay đổi'));
  const auditBody = el('div', {});
  auditHost.appendChild(auditBody);
  root.appendChild(auditHost);

  let editingId = null;
  const formCard = el('div', { className: 'card', style: 'margin-top:0.75rem' });
  const formTitle = el('h2', {}, 'Thêm khoảng tham gia');
  formCard.appendChild(formTitle);
  const mClass = el('select', { 'aria-label': 'Lớp membership' });
  const mStu = el('select', { 'aria-label': 'Học sinh membership' });
  for (const c of data.classes || []) mClass.appendChild(el('option', { value: c.id }, c.name));
  for (const s of data.students || []) mStu.appendChild(el('option', { value: s.id }, s.name));
  const mFrom = el('input', { type: 'datetime-local', 'aria-label': 'Bắt đầu tham gia' });
  const mTo = el('input', { type: 'datetime-local', 'aria-label': 'Kết thúc tham gia' });
  const reasonIn = el('input', { type: 'text', 'aria-label': 'Lý do thay đổi hồi tố' });
  const impactBox = el('pre', {
    className: 'card',
    style: 'white-space:pre-wrap;font-size:0.85rem;display:none',
    role: 'status',
  });
  const saveBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Lưu');
  const endBtn = el('button', { type: 'button', className: 'btn btn-secondary', style: 'margin-left:0.5rem' }, 'Kết thúc mở');
  const rejoinBtn = el('button', { type: 'button', className: 'btn btn-ghost', style: 'margin-left:0.5rem' }, 'Tái tham gia (khoảng mới)');
  formCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Lớp ', mClass));
  formCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Học sinh ', mStu));
  formCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Từ ', mFrom));
  formCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Đến (trống = mở) ', mTo));
  formCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Lý do (bắt buộc nếu có tác động hồi tố) ', reasonIn));
  formCard.appendChild(impactBox);
  formCard.appendChild(saveBtn);
  formCard.appendChild(endBtn);
  formCard.appendChild(rejoinBtn);
  root.appendChild(formCard);

  const formDirty = registerBaViewDirty(scope, [mClass, mStu, mFrom, mTo, reasonIn]);

  function readMembershipPayload(extra = {}) {
    return {
      id: editingId || undefined,
      classId: mClass.value,
      studentId: mStu.value,
      effectiveFrom: localInputToIso(mFrom.value) || new Date().toISOString(),
      effectiveTo: localInputToIso(mTo.value),
      reason: reasonIn.value.trim(),
      ...extra,
    };
  }

  async function writeMembership(extra = {}) {
    const payload = readMembershipPayload(extra);
    try {
      await baPutMembership(payload);
      impactBox.style.display = 'none';
    } catch (e) {
      if (e.status === 409 && e.data?.impact) {
        impactBox.style.display = 'block';
        impactBox.textContent = [
          'Thay đổi ảnh hưởng buổi/điểm danh:',
          `Buổi: ${(e.data.impact.sessionIds || []).join(', ') || '—'}`,
          `Điểm danh: ${(e.data.impact.attendanceRecordIds || []).join(', ') || '—'}`,
          'Nhập lý do và bấm Lưu lại để xác nhận.',
        ].join('\n');
        if (typeof window !== 'undefined' && window.confirm(`${e.message}\nXác nhận sau khi đã nhập lý do?`)) {
          if (!reasonIn.value.trim()) {
            ctx.toastErr('Nhập lý do trước khi xác nhận tác động.');
            throw e;
          }
          await baPutMembership({ ...payload, confirmImpact: true });
          impactBox.style.display = 'none';
          return;
        }
      }
      throw e;
    }
  }

  function renderList() {
    const data = ctx.state.data;
    listHost.textContent = '';
    listHost.appendChild(el('h2', {}, 'Các khoảng'));
    const rows = filterMemberships(data, classFilter.value, studentFilter.value);
    if (!rows.length) {
      listHost.appendChild(el('p', { className: 'empty-state' }, 'Không có khoảng phù hợp.'));
      return;
    }
    for (const m of rows) {
      const st = data.students.find((s) => s.id === m.studentId);
      const cl = data.classes.find((c) => c.id === m.classId);
      const editBtn = el('button', { type: 'button', className: 'btn btn-ghost' }, 'Sửa');
      editBtn.addEventListener('click', () => {
        editingId = m.id;
        mClass.value = m.classId;
        mStu.value = m.studentId;
        mClass.disabled = true;
        mStu.disabled = true;
        mFrom.value = isoToLocalInput(m.effectiveFrom);
        mTo.value = isoToLocalInput(m.effectiveTo);
        formTitle.textContent = 'Sửa khoảng tham gia';
        formDirty.markClean?.();
      });
      listHost.appendChild(el('div', { className: 'list-row', style: 'flex-wrap:wrap' },
        el('span', {}, st?.name || m.studentId),
        el('span', {}, cl?.name || m.classId),
        el('span', { style: 'font-size:0.85rem' }, `${m.effectiveFrom} → ${m.effectiveTo || '∞'}`),
        editBtn,
      ));
    }
  }

  function renderAudit() {
    const data = ctx.state.data;
    auditBody.textContent = '';
    const audits = [...(data.membershipAudit || [])].reverse().slice(0, 20);
    for (const a of audits) {
      const links = (a.impactSessionIds || []).map((id) => {
        const sess = data.classSessions.find((s) => s.id === id);
        return sess ? formatSessionLocal(sess.startAt) : id;
      });
      auditBody.appendChild(el('div', { className: 'list-row', style: 'flex-direction:column;align-items:flex-start' },
        el('span', {}, `${a.action} · ${a.at}`),
        el('span', { style: 'font-size:0.85rem' }, a.reason || ''),
        links.length ? el('span', { style: 'font-size:0.85rem' }, `Buổi: ${links.join(', ')}`) : null,
      ));
    }
    if (!audits.length) auditBody.appendChild(el('p', { className: 'empty-state' }, 'Chưa có lịch sử.'));
  }

  classFilter.addEventListener('change', renderList);
  studentFilter.addEventListener('change', renderList);

  saveBtn.addEventListener('click', async () => {
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-mem-${editingId || 'new'}`,
      btn: saveBtn,
      busyLabel: 'Đang lưu…',
      fields: [mFrom, mTo, reasonIn],
      buttons: [saveBtn, endBtn, rejoinBtn],
      dirtyProbe: formDirty,
      readPayload: () => readMembershipPayload(),
      write: async () => { await writeMembership(); },
      successMessage: 'Đã lưu khoảng tham gia.',
      onSuccess: ({ safeToReset } = {}) => {
        renderList();
        renderAudit();
        if (!safeToReset) return;
        editingId = null;
        mClass.disabled = false;
        mStu.disabled = false;
        formTitle.textContent = 'Thêm khoảng tham gia';
        ctx.renderApp();
      },
    });
  });

  endBtn.addEventListener('click', async () => {
    if (!editingId) {
      ctx.toastErr('Chọn khoảng đang mở để kết thúc.');
      return;
    }
    mTo.value = isoToLocalInput(new Date().toISOString());
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-mem-end-${editingId}`,
      btn: saveBtn,
      busyLabel: 'Đang lưu…',
      fields: [mTo, reasonIn],
      buttons: [saveBtn, endBtn, rejoinBtn],
      dirtyProbe: formDirty,
      readPayload: () => readMembershipPayload(),
      write: async () => { await writeMembership(); },
      successMessage: 'Đã kết thúc khoảng tham gia.',
      onSuccess: ({ safeToReset } = {}) => {
        renderList();
        renderAudit();
        if (!safeToReset) return;
        editingId = null;
        mClass.disabled = false;
        mStu.disabled = false;
        ctx.renderApp();
      },
    });
  });

  rejoinBtn.addEventListener('click', async () => {
    const priorClass = mClass.value;
    const priorStu = mStu.value;
    editingId = null;
    mClass.disabled = false;
    mStu.disabled = false;
    mClass.value = priorClass;
    mStu.value = priorStu;
    mFrom.value = isoToLocalInput(new Date().toISOString());
    mTo.value = '';
    formTitle.textContent = 'Tái tham gia (khoảng mới)';
    formDirty.markClean?.();
    ctx.toastOk('Nhập khoảng mới rồi bấm Lưu.');
  });

  renderList();
  renderAudit();
}
