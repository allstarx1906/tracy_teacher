import { baPutParent, baPutParentLink } from './ba-api.js';
import { el, contactLabel, isoToLocalInput, localInputToIso } from './ba-ui-dom.js';
import { registerBaViewDirty, runBaScopedSubmit } from './ba-ui-scoped.js';

function parentMatchesQuery(p, q) {
  if (!q) return true;
  const hay = `${p.name} ${p.code || ''} ${p.phone || ''} ${p.email || ''} ${p.notes || ''}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

function linksForParent(data, parentId) {
  return (data.parentStudentLinks || []).filter((l) => l.parentId === parentId);
}

function linksForStudent(data, studentId) {
  return (data.parentStudentLinks || []).filter((l) => l.studentId === studentId);
}

export function renderParentsView(ctx, root, scope) {
  const data = ctx.state.data;
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    style: 'margin-bottom:0.5rem',
    onClick: () => ctx.navigate('#/tutor'),
  }, '← Quay lại'));
  root.appendChild(el('h1', { className: 'page-title' }, 'Phụ huynh & liên kết'));

  const searchIn = el('input', {
    type: 'search',
    'aria-label': 'Tìm phụ huynh',
    placeholder: 'Tìm theo tên, mã, SĐT…',
    style: 'margin-bottom:0.75rem;max-width:100%',
  });
  root.appendChild(searchIn);

  let selectedParentId = null;
  let editingParentId = null;
  let editingLinkId = null;

  const listCard = el('div', { className: 'card' });
  listCard.appendChild(el('h2', {}, 'Danh sách phụ huynh'));
  const listHost = el('div', {});
  listCard.appendChild(listHost);
  root.appendChild(listCard);

  const detailCard = el('div', { className: 'card', style: 'margin-top:0.75rem' });
  const detailHost = el('div', {});
  detailCard.appendChild(detailHost);
  root.appendChild(detailCard);

  const parentFormCard = el('div', { className: 'card', style: 'margin-top:0.75rem' });
  const formTitle = el('h2', { id: 'ba-parent-form-title' }, 'Thêm phụ huynh');
  parentFormCard.appendChild(formTitle);
  const codeIn = el('input', { type: 'text', 'aria-label': 'Mã phụ huynh' });
  const nameIn = el('input', { type: 'text', 'aria-label': 'Họ tên phụ huynh' });
  const phoneIn = el('input', { type: 'text', 'aria-label': 'Số điện thoại' });
  const emailIn = el('input', { type: 'email', 'aria-label': 'Email' });
  const notesIn = el('input', { type: 'text', 'aria-label': 'Ghi chú phụ huynh' });
  const statusSel = el('select', { 'aria-label': 'Trạng thái phụ huynh' });
  statusSel.appendChild(el('option', { value: 'active' }, 'Đang hoạt động'));
  statusSel.appendChild(el('option', { value: 'inactive' }, 'Ngừng hoạt động'));
  const saveParentBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Lưu phụ huynh');
  const resetParentBtn = el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    style: 'margin-left:0.5rem',
  }, 'Hủy sửa');

  for (const [label, input] of [
    ['Mã (tùy chọn) ', codeIn],
    ['Họ tên ', nameIn],
    ['Điện thoại ', phoneIn],
    ['Email ', emailIn],
    ['Ghi chú ', notesIn],
    ['Trạng thái ', statusSel],
  ]) {
    parentFormCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, label, input));
  }
  parentFormCard.appendChild(saveParentBtn);
  parentFormCard.appendChild(resetParentBtn);
  root.appendChild(parentFormCard);

  const parentDirty = registerBaViewDirty(scope, [codeIn, nameIn, phoneIn, emailIn, notesIn, statusSel]);

  function resetParentForm() {
    editingParentId = null;
    codeIn.value = '';
    nameIn.value = '';
    phoneIn.value = '';
    emailIn.value = '';
    notesIn.value = '';
    statusSel.value = 'active';
    formTitle.textContent = 'Thêm phụ huynh';
    parentDirty.markClean?.();
  }

  resetParentBtn.addEventListener('click', resetParentForm);

  function loadParentIntoForm(p) {
    editingParentId = p.id;
    codeIn.value = p.code || '';
    nameIn.value = p.name || '';
    phoneIn.value = p.phone || '';
    emailIn.value = p.email || '';
    notesIn.value = p.notes || '';
    statusSel.value = p.status === 'inactive' ? 'inactive' : 'active';
    formTitle.textContent = 'Sửa phụ huynh';
    parentDirty.markClean?.();
  }

  function renderList() {
    const data = ctx.state.data;
    const q = searchIn.value.trim();
    listHost.textContent = '';
    const parents = (data.parents || []).filter((p) => parentMatchesQuery(p, q));
    if (!parents.length) {
      listHost.appendChild(el('p', { className: 'empty-state' }, 'Không có phụ huynh phù hợp.'));
      return;
    }
    for (const p of parents) {
      const row = el('div', { className: 'list-row', style: 'flex-wrap:wrap;gap:0.35rem' });
      row.appendChild(el('strong', {}, p.name));
      row.appendChild(el('span', { style: 'font-size:0.85rem;color:var(--muted)' }, contactLabel(p)));
      if (p.status === 'inactive') row.appendChild(el('span', { className: 'badge badge-gray' }, 'Ngừng HĐ'));
      const editBtn = el('button', { type: 'button', className: 'btn btn-ghost' }, 'Sửa');
      editBtn.addEventListener('click', () => {
        selectedParentId = p.id;
        loadParentIntoForm(p);
        renderDetail();
      });
      row.appendChild(editBtn);
      listHost.appendChild(row);
    }
  }

  function renderDetail() {
    const data = ctx.state.data;
    detailHost.textContent = '';
    if (!selectedParentId) {
      detailHost.appendChild(el('p', { className: 'empty-state' }, 'Chọn «Sửa» trên một phụ huynh để xem liên kết học sinh.'));
      return;
    }
    const p = (data.parents || []).find((x) => x.id === selectedParentId);
    if (!p) return;
    detailHost.appendChild(el('h3', {}, p.name));
    detailHost.appendChild(el('p', {}, contactLabel(p)));
    detailHost.appendChild(el('p', { style: 'font-size:0.85rem' }, `Mã: ${p.code || '—'} · ${p.status === 'inactive' ? 'Ngừng hoạt động' : 'Đang hoạt động'}`));
    detailHost.appendChild(el('h4', {}, 'Học sinh liên kết'));
    for (const link of linksForParent(data, p.id)) {
      const st = data.students.find((s) => s.id === link.studentId);
      detailHost.appendChild(el('div', { className: 'list-row' },
        el('span', {}, st?.name || link.studentId),
        el('span', { style: 'font-size:0.85rem' }, link.relationship || '—'),
        el('span', { style: 'font-size:0.85rem' }, `${link.effectiveFrom} → ${link.effectiveTo || '∞'}`),
        el('button', {
          type: 'button',
          className: 'btn btn-ghost',
          onClick: () => { editingLinkId = link.id; renderLinkForm(link); },
        }, 'Sửa liên kết'),
      ));
    }
  }

  const linkCard = el('div', { className: 'card', style: 'margin-top:0.75rem' });
  const linkFormTitle = el('h2', { id: 'ba-link-form-title' }, 'Thêm liên kết phụ huynh — học sinh');
  linkCard.appendChild(linkFormTitle);
  const parentSel = el('select', { 'aria-label': 'Phụ huynh liên kết' });
  const studentSel = el('select', { 'aria-label': 'Học sinh liên kết' });
  const relIn = el('input', { type: 'text', 'aria-label': 'Quan hệ' });
  const linkFrom = el('input', { type: 'datetime-local', 'aria-label': 'Hiệu lực từ' });
  const linkTo = el('input', { type: 'datetime-local', 'aria-label': 'Hiệu lực đến' });
  const saveLinkBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Lưu liên kết');
  linkCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Phụ huynh ', parentSel));
  linkCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Học sinh ', studentSel));
  linkCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Quan hệ ', relIn));
  linkCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Từ ', linkFrom));
  linkCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Đến (để trống = mở) ', linkTo));
  linkCard.appendChild(saveLinkBtn);
  root.appendChild(linkCard);

  const reverseCard = el('div', { className: 'card', style: 'margin-top:0.75rem' });
  reverseCard.appendChild(el('h2', {}, 'Phụ huynh theo học sinh'));
  const reverseStudentSel = el('select', { 'aria-label': 'Chọn học sinh xem phụ huynh' });
  const reverseHost = el('div', {});
  reverseCard.appendChild(el('label', {}, 'Học sinh ', reverseStudentSel));
  reverseCard.appendChild(reverseHost);
  root.appendChild(reverseCard);

  let linkDirty;

  function refreshSelectors() {
    parentSel.textContent = '';
    reverseStudentSel.textContent = '';
    studentSel.textContent = '';
    for (const p of data.parents || []) {
      parentSel.appendChild(el('option', { value: p.id }, p.name));
    }
    for (const s of data.students || []) {
      studentSel.appendChild(el('option', { value: s.id }, s.name));
      reverseStudentSel.appendChild(el('option', { value: s.id }, s.name));
    }
    if (selectedParentId) parentSel.value = selectedParentId;
  }

  function renderLinkForm(link) {
    if (link) {
      editingLinkId = link.id;
      parentSel.value = link.parentId;
      studentSel.value = link.studentId;
      relIn.value = link.relationship || '';
      linkFrom.value = isoToLocalInput(link.effectiveFrom);
      linkTo.value = isoToLocalInput(link.effectiveTo);
      linkFormTitle.textContent = 'Sửa liên kết';
    } else {
      editingLinkId = null;
      linkFormTitle.textContent = 'Thêm liên kết phụ huynh — học sinh';
    }
    linkDirty.markClean?.();
  }

  function renderReverse() {
    reverseHost.textContent = '';
    const sid = reverseStudentSel.value;
    if (!sid) return;
    for (const link of linksForStudent(data, sid)) {
      const p = data.parents.find((x) => x.id === link.parentId);
      reverseHost.appendChild(el('div', { className: 'list-row' },
        el('span', {}, p?.name || link.parentId),
        el('span', {}, link.relationship || '—'),
        el('span', { style: 'font-size:0.85rem' }, contactLabel(p || {})),
      ));
    }
    if (!reverseHost.childNodes.length) {
      reverseHost.appendChild(el('p', { className: 'empty-state' }, 'Chưa có phụ huynh liên kết.'));
    }
  }

  reverseStudentSel.addEventListener('change', renderReverse);
  searchIn.addEventListener('input', renderList);

  saveParentBtn.addEventListener('click', async () => {
    if (!nameIn.value.trim()) {
      ctx.toastErr('Nhập họ tên phụ huynh.');
      return;
    }
    const wasEdit = editingParentId;
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-parent-${editingParentId || 'new'}`,
      btn: saveParentBtn,
      busyLabel: 'Đang lưu…',
      fields: [codeIn, nameIn, phoneIn, emailIn, notesIn, statusSel],
      buttons: [saveParentBtn, resetParentBtn],
      dirtyProbe: parentDirty,
      readPayload: () => ({
        id: editingParentId || undefined,
        code: codeIn.value.trim(),
        name: nameIn.value.trim(),
        phone: phoneIn.value.trim(),
        email: emailIn.value.trim(),
        notes: notesIn.value.trim(),
        status: statusSel.value === 'inactive' ? 'inactive' : 'active',
      }),
      write: async (body) => { await baPutParent(body); },
      successMessage: wasEdit ? 'Đã cập nhật phụ huynh.' : 'Đã thêm phụ huynh.',
      skipFullRender: true,
      onSuccess: ({ matchesSnapshot, safeToReset }) => {
        renderList();
        refreshSelectors();
        if (matchesSnapshot) {
          if (wasEdit) selectedParentId = wasEdit;
          resetParentForm();
        }
        linkDirty?.markClean?.();
        if (safeToReset) ctx.renderApp();
      },
    });
  });

  saveLinkBtn.addEventListener('click', async () => {
    const fromIso = localInputToIso(linkFrom.value) || new Date().toISOString();
    const toIso = localInputToIso(linkTo.value);
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-link-${editingLinkId || 'new'}`,
      btn: saveLinkBtn,
      busyLabel: 'Đang lưu…',
      fields: [parentSel, studentSel, relIn, linkFrom, linkTo],
      buttons: [saveLinkBtn],
      dirtyProbe: linkDirty,
      readPayload: () => ({
        id: editingLinkId || undefined,
        parentId: parentSel.value,
        studentId: studentSel.value,
        relationship: relIn.value.trim(),
        effectiveFrom: fromIso,
        effectiveTo: toIso,
      }),
      write: async (body) => { await baPutParentLink(body); },
      successMessage: 'Đã lưu liên kết.',
      skipFullRender: true,
      onSuccess: ({ matchesSnapshot, safeToReset }) => {
        renderList();
        renderDetail();
        if (matchesSnapshot) {
          editingLinkId = null;
          renderLinkForm(null);
        }
        linkDirty?.markClean?.();
        if (safeToReset) ctx.renderApp();
      },
    });
  });

  refreshSelectors();
  linkDirty = registerBaViewDirty(scope, [parentSel, studentSel, relIn, linkFrom, linkTo]);
  linkDirty.markClean?.();
  renderList();
  renderDetail();
  renderReverse();
}
