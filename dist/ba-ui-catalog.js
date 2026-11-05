import { baPutAttendanceCatalog } from './ba-api.js';
import { el } from './ba-ui-dom.js';
import { registerBaViewDirty, runBaScopedSubmit, resolveBaOperationId } from './ba-ui-scoped.js';

export function renderCatalogView(ctx, root, scope) {
  const data = ctx.state.data;
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    style: 'margin-bottom:0.5rem',
    onClick: () => ctx.navigate('#/tutor'),
  }, '← Quay lại'));
  root.appendChild(el('h1', { className: 'page-title' }, 'Danh mục trạng thái điểm danh'));

  const listHost = el('div', { className: 'card' });
  root.appendChild(listHost);

  let editingId = null;
  const idIn = el('input', { type: 'text', 'aria-label': 'Mã trạng thái ổn định', readOnly: true });
  const labelIn = el('input', { type: 'text', 'aria-label': 'Tên hiển thị' });
  const orderIn = el('input', { type: 'number', 'aria-label': 'Thứ tự', value: '0' });
  const activeCb = el('input', { type: 'checkbox', id: 'ba-cat-active', checked: true });
  const saveBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Lưu');
  const newBtn = el('button', { type: 'button', className: 'btn btn-ghost', style: 'margin-left:0.5rem' }, 'Thêm mới');

  const formCard = el('div', { className: 'card', style: 'margin-top:0.75rem' });
  formCard.appendChild(el('h2', {}, 'Thêm / sửa'));
  formCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'ID ', idIn));
  formCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Tên ', labelIn));
  formCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Thứ tự ', orderIn));
  formCard.appendChild(el('label', { htmlFor: 'ba-cat-active', style: 'display:block;margin:0.35rem 0' }, 'Đang dùng ', activeCb));
  formCard.appendChild(saveBtn);
  formCard.appendChild(newBtn);
  root.appendChild(formCard);

  const dirty = registerBaViewDirty(scope, [labelIn, orderIn, activeCb]);

  function sortedCatalog() {
    return [...(data.attendanceStatusCatalog || [])].sort(
      (a, b) => (a.sortOrder - b.sortOrder) || a.id.localeCompare(b.id),
    );
  }

  async function swapCatalogSortOrder(item, other, btn) {
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `cat-swap-${item.id}-${other.id}`,
      btn,
      busyLabel: 'Đang đổi thứ tự…',
      fields: [labelIn, orderIn, activeCb],
      buttons: [saveBtn, newBtn],
      dirtyProbe: dirty,
      readPayload: () => ({
        aId: item.id,
        aOrder: other.sortOrder,
        bId: other.id,
        bOrder: item.sortOrder,
      }),
      write: async (payload) => {
        await baPutAttendanceCatalog({
          operationId: resolveBaOperationId(`cat-${payload.aId}`, {
            id: payload.aId,
            sortOrder: payload.aOrder,
          }),
          id: payload.aId,
          label: item.label,
          sortOrder: payload.aOrder,
          active: item.active !== false,
        });
        await baPutAttendanceCatalog({
          operationId: resolveBaOperationId(`cat-${payload.bId}`, {
            id: payload.bId,
            sortOrder: payload.bOrder,
          }),
          id: payload.bId,
          label: other.label,
          sortOrder: payload.bOrder,
          active: other.active !== false,
        });
      },
      successMessage: 'Đã đổi thứ tự.',
      onSuccess: ({ safeToReset } = {}) => {
        renderList();
        if (!safeToReset) return;
        ctx.renderApp();
      },
    });
  }

  function loadRow(row) {
    editingId = row?.id || null;
    idIn.value = row?.id || '';
    idIn.readOnly = !!row?.id;
    labelIn.value = row?.label || '';
    orderIn.value = String(row?.sortOrder ?? sortedCatalog().length);
    activeCb.checked = row?.active !== false;
    dirty.markClean?.();
  }

  function renderList() {
    const data = ctx.state.data;
    listHost.textContent = '';
    listHost.appendChild(el('h2', {}, 'Danh sách (ID ổn định)'));
    const items = sortedCatalog();
    for (let i = 0; i < items.length; i += 1) {
      const s = items[i];
      const row = el('div', { className: 'list-row', style: 'flex-wrap:wrap;gap:0.35rem' });
      row.appendChild(el('code', {}, s.id));
      row.appendChild(el('span', {}, s.label));
      row.appendChild(el('span', { style: 'font-size:0.85rem' }, `#${s.sortOrder}`));
      if (s.active === false) row.appendChild(el('span', { className: 'badge badge-gray' }, 'Ngừng'));
      const editBtn = el('button', { type: 'button', className: 'btn btn-ghost' }, 'Sửa');
      editBtn.addEventListener('click', () => loadRow(s));
      const upBtn = el('button', { type: 'button', className: 'btn btn-ghost' }, '↑');
      const downBtn = el('button', { type: 'button', className: 'btn btn-ghost' }, '↓');
      upBtn.addEventListener('click', async () => {
        if (i === 0) return;
        const prev = items[i - 1];
        await swapCatalogSortOrder(s, prev, upBtn);
      });
      downBtn.addEventListener('click', async () => {
        if (i >= items.length - 1) return;
        const next = items[i + 1];
        await swapCatalogSortOrder(s, next, downBtn);
      });
      row.appendChild(editBtn);
      row.appendChild(upBtn);
      row.appendChild(downBtn);
      listHost.appendChild(row);
    }
  }

  newBtn.addEventListener('click', () => {
    const slug = `st-${Date.now()}`;
    loadRow({ id: slug, label: '', sortOrder: sortedCatalog().length, active: true });
    idIn.readOnly = false;
    idIn.value = slug;
  });

  saveBtn.addEventListener('click', async () => {
    if (!labelIn.value.trim()) {
      ctx.toastErr('Nhập tên trạng thái.');
      return;
    }
    const id = editingId || idIn.value.trim();
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-cat-${id}`,
      btn: saveBtn,
      busyLabel: 'Đang lưu…',
      fields: [labelIn, orderIn, activeCb],
      buttons: [saveBtn, newBtn],
      dirtyProbe: dirty,
      readPayload: () => ({
        id,
        label: labelIn.value.trim(),
        sortOrder: Number(orderIn.value),
        active: activeCb.checked,
      }),
      write: async (body) => { await baPutAttendanceCatalog(body); },
      successMessage: 'Đã lưu danh mục.',
      onSuccess: ({ safeToReset } = {}) => {
        renderList();
        if (!safeToReset) return;
        loadRow(null);
        ctx.renderApp();
      },
    });
  });

  loadRow(null);
  idIn.readOnly = false;
  idIn.value = '';
  renderList();
}
