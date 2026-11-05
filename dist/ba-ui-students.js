import { putRecord } from './api-client.js';
import { validateStudentInput } from './model.js';
import { el, contactLabel } from './ba-ui-dom.js';
import { registerBaViewDirty, runBaScopedSubmit } from './ba-ui-scoped.js';

export function renderStudentsView(ctx, root, scope) {
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/tutor'),
  }, '← Quay lại'));
  root.appendChild(el('h1', { className: 'page-title' }, 'Hồ sơ học sinh'));
  root.appendChild(el('p', { style: 'font-size:0.85rem;margin-bottom:0.75rem' },
    'Ngừng hoạt động không tự kết thúc khoảng tham gia — hãy kết thúc thành viên trên màn «Khoảng tham gia lớp» nếu cần.',
  ));

  const data = ctx.state.data;
  let editingId = null;

  const listHost = el('div', { className: 'card' });
  listHost.appendChild(el('h2', {}, 'Danh sách'));
  const rowsHost = el('div', {});
  listHost.appendChild(rowsHost);
  root.appendChild(listHost);

  const formCard = el('div', { className: 'card', style: 'margin-top:0.75rem' });
  const formTitle = el('h2', { id: 'ba-student-form-title' }, 'Thêm học sinh');
  formCard.appendChild(formTitle);

  const nameIn = el('input', { type: 'text', 'aria-label': 'Tên học sinh' });
  const codeIn = el('input', { type: 'text', 'aria-label': 'Mã học sinh (tùy chọn)' });
  const classSel = el('select', { 'aria-label': 'Lớp chính' });
  for (const c of data.classes || []) {
    classSel.appendChild(el('option', { value: c.id }, c.name));
  }
  const phoneIn = el('input', { type: 'text', 'aria-label': 'SĐT thông báo học sinh' });
  const emailIn = el('input', { type: 'email', 'aria-label': 'Email thông báo học sinh' });
  const notesIn = el('input', { type: 'text', 'aria-label': 'Ghi chú học sinh' });
  const statusSel = el('select', { 'aria-label': 'Trạng thái học sinh' });
  statusSel.appendChild(el('option', { value: 'active' }, 'Đang hoạt động'));
  statusSel.appendChild(el('option', { value: 'inactive' }, 'Ngừng hoạt động'));

  const saveBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Lưu học sinh');
  const resetBtn = el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    style: 'margin-left:0.5rem',
  }, 'Hủy sửa');

  for (const [label, input] of [
    ['Tên * ', nameIn],
    ['Mã (tùy chọn) ', codeIn],
    ['Lớp chính * ', classSel],
    ['SĐT (mock thông báo) ', phoneIn],
    ['Email (mock thông báo) ', emailIn],
    ['Ghi chú ', notesIn],
    ['Trạng thái ', statusSel],
  ]) {
    formCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, label, input));
  }
  formCard.appendChild(saveBtn);
  formCard.appendChild(resetBtn);
  root.appendChild(formCard);

  const studentDirty = registerBaViewDirty(scope, [nameIn, codeIn, classSel, phoneIn, emailIn, notesIn, statusSel]);

  function resetForm() {
    editingId = null;
    nameIn.value = '';
    codeIn.value = '';
    phoneIn.value = '';
    emailIn.value = '';
    notesIn.value = '';
    statusSel.value = 'active';
    if (classSel.options.length) classSel.value = classSel.options[0].value;
    formTitle.textContent = 'Thêm học sinh';
    studentDirty.markClean?.();
  }

  function loadStudent(st) {
    editingId = st.id;
    nameIn.value = st.name || '';
    codeIn.value = st.code || '';
    classSel.value = st.classId || classSel.value;
    phoneIn.value = st.phone || '';
    emailIn.value = st.email || '';
    notesIn.value = st.notes || '';
    statusSel.value = st.status === 'inactive' ? 'inactive' : 'active';
    formTitle.textContent = `Sửa: ${st.name}`;
    studentDirty.markClean?.();
  }

  function renderList() {
    rowsHost.textContent = '';
    const students = [...(ctx.state.data.students || [])].sort((a, b) => a.name.localeCompare(b.name));
    if (!students.length) {
      rowsHost.appendChild(el('p', { className: 'empty-state' }, 'Chưa có học sinh.'));
      return;
    }
    for (const st of students) {
      const cls = ctx.state.data.classes.find((c) => c.id === st.classId);
      const row = el('div', { className: 'list-row', style: 'flex-wrap:wrap;gap:0.35rem' });
      row.appendChild(el('strong', {}, st.name));
      row.appendChild(el('span', { style: 'font-size:0.85rem;color:var(--muted)' },
        `${cls?.name || st.classId}${st.code ? ` · ${st.code}` : ''} · ${contactLabel(st)}`,
      ));
      if (st.status === 'inactive') row.appendChild(el('span', { className: 'badge badge-gray' }, 'Ngừng HĐ'));
      const editBtn = el('button', { type: 'button', className: 'btn btn-ghost' }, 'Sửa');
      editBtn.addEventListener('click', () => loadStudent(st));
      row.appendChild(editBtn);
      rowsHost.appendChild(row);
    }
  }

  resetBtn.addEventListener('click', resetForm);

  saveBtn.addEventListener('click', async () => {
    const v = validateStudentInput({ name: nameIn.value, classId: classSel.value });
    if (!v.ok) {
      ctx.toastErr(v.error);
      return;
    }
    const wasEdit = editingId;
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-student-${editingId || 'new'}`,
      btn: saveBtn,
      busyLabel: 'Đang lưu…',
      fields: [nameIn, codeIn, classSel, phoneIn, emailIn, notesIn, statusSel],
      buttons: [saveBtn, resetBtn],
      dirtyProbe: studentDirty,
      readPayload: () => ({
        id: editingId || undefined,
        name: nameIn.value.trim(),
        code: codeIn.value.trim(),
        classId: classSel.value,
        phone: phoneIn.value.trim(),
        email: emailIn.value.trim(),
        notes: notesIn.value.trim(),
        status: statusSel.value === 'inactive' ? 'inactive' : 'active',
      }),
      write: async (body) => { await putRecord('students', body); },
      successMessage: wasEdit ? 'Đã cập nhật học sinh.' : 'Đã thêm học sinh.',
      skipFullRender: true,
      onSuccess: ({ matchesSnapshot, safeToReset }) => {
        renderList();
        if (matchesSnapshot) {
          if (wasEdit) editingId = wasEdit;
          resetForm();
        }
        if (safeToReset) ctx.renderApp();
      },
    });
  });

  renderList();
}
