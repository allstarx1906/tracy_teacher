import {
  MOCK_PROVIDER_LABEL,
  REMINDER_TYPE,
  BATCH_RECIPIENT_STATUS,
  MANUAL_SEND_OUTCOME,
  formatSessionLocal,
  buildPreviewCaptureKey,
} from './ba-domain.js';
import {
  baNotifyPreview,
  baNotifySendMock,
  baNotifyRetry,
  baManualConfirm,
} from './ba-api.js';
import { el, localInputToIso } from './ba-ui-dom.js';
import {
  registerBaViewDirty,
  runBaScopedSubmit,
} from './ba-ui-scoped.js';

const TYPE_LABELS = [
  [REMINDER_TYPE.SESSION_REMINDER, 'Nhắc lịch'],
  [REMINDER_TYPE.SESSION_CHANGE, 'Đổi lịch'],
  [REMINDER_TYPE.SESSION_CANCEL, 'Hủy buổi'],
];

async function copyText(ctx, text, okMsg) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ctx.toastOk(okMsg);
      return;
    }
    throw new Error('no-clipboard');
  } catch {
    ctx.toastErr('Không sao chép được — hãy chọn và copy thủ công.');
  }
}

export function renderNotificationsView(ctx, root, scope) {
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/tutor'),
  }, '← Quay lại'));
  root.appendChild(el('h1', { className: 'page-title' }, 'Thông báo (mock)'));
  root.appendChild(el('p', {
    className: 'demo-banner',
    role: 'status',
    style: 'font-size:0.85rem',
  }, `${MOCK_PROVIDER_LABEL} — Gửi thành công chỉ là mô phỏng.`));

  const data = ctx.state.data;
  let capturedPreview = null;

  const sessionSel = el('select', { 'aria-label': 'Chọn buổi' });
  for (const s of data.classSessions || []) {
    sessionSel.appendChild(el('option', { value: s.id }, `${formatSessionLocal(s.startAt)} (${s.status})`));
  }
  const typeSel = el('select', { 'aria-label': 'Loại thông báo' });
  for (const [val, label] of TYPE_LABELS) {
    typeSel.appendChild(el('option', { value: val }, label));
  }
  root.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Buổi ', sessionSel));
  root.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Loại ', typeSel));

  const previewBox = el('pre', {
    className: 'card',
    style: 'white-space:pre-wrap;font-size:0.85rem;max-height:16rem;overflow:auto',
    'aria-live': 'polite',
  }, 'Chưa có xem trước.');
  root.appendChild(previewBox);

  const perRecipientHost = el('div', { className: 'card', style: 'margin-top:0.5rem' });
  root.appendChild(perRecipientHost);

  const scenSel = el('select', { 'aria-label': 'Kịch bản mock' });
  for (const [val, label] of [
    ['all-success', 'Tất cả OK'],
    ['all-fail', 'Tất cả lỗi'],
    ['per-recipient', 'Từng người'],
  ]) {
    scenSel.appendChild(el('option', { value: val }, label));
  }

  const previewBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Xem trước chi tiết');
  const copyContentBtn = el('button', { type: 'button', className: 'btn btn-ghost', style: 'margin-left:0.35rem' }, 'Copy nội dung');
  const copyContactsBtn = el('button', { type: 'button', className: 'btn btn-ghost', style: 'margin-left:0.35rem' }, 'Copy danh sách liên hệ');
  const sendBtn = el('button', { type: 'button', className: 'btn btn-primary', style: 'margin-left:0.35rem' }, 'Gửi mock');
  root.appendChild(el('div', { style: 'margin:0.5rem 0;display:flex;flex-wrap:wrap;gap:0.35rem' },
    previewBtn, copyContentBtn, copyContactsBtn, el('label', {}, 'Kịch bản ', scenSel), sendBtn));

  const dirty = registerBaViewDirty(scope, [sessionSel, typeSel, scenSel]);

  function invalidatePreview() {
    capturedPreview = null;
    previewBox.textContent = 'Xem trước đã hết hạn — bấm «Xem trước chi tiết» lại.';
    perRecipientHost.replaceChildren();
  }

  sessionSel.addEventListener('change', invalidatePreview);
  typeSel.addEventListener('change', invalidatePreview);

  scenSel.addEventListener('change', () => {
    if (capturedPreview?.recipients?.length) {
      renderPerRecipientControls(capturedPreview.recipients);
    }
    refreshManualRecipients();
  });

  function renderPerRecipientControls(recipients) {
    perRecipientHost.replaceChildren();
    if (scenSel.value !== 'per-recipient') return;
    perRecipientHost.appendChild(el('h3', {}, 'Kết quả mock từng người nhận'));
    for (let i = 0; i < recipients.length; i += 1) {
      const r = recipients[i];
      const defaultOk = i > 0;
      const row = el('label', { style: 'display:block;margin:0.25rem 0' });
      const cb = el('input', {
        type: 'checkbox',
        checked: defaultOk,
        'data-recipient-key': r.canonicalKey,
      });
      row.appendChild(cb);
      row.appendChild(document.createTextNode(
        ` ${r.displayName} (${r.canonicalKey}) — ${defaultOk ? 'OK' : 'Lỗi mock'}`,
      ));
      perRecipientHost.appendChild(row);
    }
  }

  function formatPreviewLines(p) {
    return [
      p.content,
      '',
      '--- Người nhận ---',
      ...(p.recipients || []).map((r) => `${r.displayName} · ${r.role} · ${r.canonicalKey} · ${r.phone || r.email || ''} · HS: ${(r.relatedStudentIds || []).join(',')}`),
      '',
      '--- Bỏ qua (thiếu liên hệ) ---',
      ...(p.skipped || []).map((s) => `${s.displayName}: ${s.skipReason}`),
    ].join('\n');
  }

  function readPerRecipientMap(recipients) {
    const map = {};
    if (scenSel.value !== 'per-recipient') return map;
    for (const input of perRecipientHost.querySelectorAll('input[data-recipient-key]')) {
      map[input.getAttribute('data-recipient-key')] = input.checked;
    }
    for (const r of recipients) {
      if (!Object.prototype.hasOwnProperty.call(map, r.canonicalKey)) map[r.canonicalKey] = true;
    }
    return map;
  }

  previewBtn.addEventListener('click', async () => {
    try {
      const p = await baNotifyPreview({ sessionId: sessionSel.value, type: typeSel.value });
      capturedPreview = {
        ...p,
        sessionId: sessionSel.value,
        type: typeSel.value,
        previewCaptureKey: p.previewCaptureKey
          || buildPreviewCaptureKey({
            sessionId: sessionSel.value,
            type: typeSel.value,
            content: p.content,
            recipients: p.recipients,
            skipped: p.skipped,
          }),
      };
      previewBox.textContent = formatPreviewLines(p);
      renderPerRecipientControls(p.recipients || []);
      refreshManualRecipients();
      manualDirty?.markClean?.();
      dirty.markClean?.();
    } catch (e) {
      ctx.toastErr(e.message || 'Không tải xem trước.');
    }
  });

  copyContentBtn.addEventListener('click', () => {
    if (!capturedPreview?.content) {
      ctx.toastErr('Chưa có nội dung — xem trước trước.');
      return;
    }
    copyText(ctx, capturedPreview.content, 'Đã copy nội dung (mock).');
  });

  copyContactsBtn.addEventListener('click', () => {
    if (!capturedPreview) {
      ctx.toastErr('Chưa có danh sách — xem trước trước.');
      return;
    }
    const lines = (capturedPreview.recipients || []).map(
      (r) => `${r.displayName}\t${r.phone || ''}\t${r.email || ''}\t${r.canonicalKey}`,
    );
    copyText(ctx, lines.join('\n'), 'Đã copy danh sách liên hệ.');
  });

  sendBtn.addEventListener('click', async () => {
    if (!capturedPreview
      || capturedPreview.sessionId !== sessionSel.value
      || capturedPreview.type !== typeSel.value) {
      ctx.toastErr('Xem trước không khớp lựa chọn — tải lại xem trước.');
      return;
    }
    const payloadBase = {
      sessionId: sessionSel.value,
      type: typeSel.value,
      scenario: scenSel.value,
      perRecipient: readPerRecipientMap(capturedPreview.recipients || []),
      previewCaptureKey: capturedPreview.previewCaptureKey,
    };
    const readPayload = () => payloadBase;
    const guardKey = 'ba-notify-send';
    await runBaScopedSubmit(ctx, scope, {
      guardKey,
      btn: sendBtn,
      buttons: [previewBtn, copyContentBtn, copyContactsBtn, sendBtn],
      dirtyProbe: dirty,
      readPayload,
      write: async (body) => {
        await baNotifySendMock(body);
      },
      successMessage: 'Đã gửi mock (mô phỏng).',
      onSuccess: () => {
        capturedPreview = null;
        ctx.renderApp();
      },
    });
  });

  const filterSession = el('select', { 'aria-label': 'Lọc batch theo buổi' });
  filterSession.appendChild(el('option', { value: '' }, 'Mọi buổi'));
  for (const s of data.classSessions || []) {
    filterSession.appendChild(el('option', { value: s.id }, formatSessionLocal(s.startAt)));
  }
  const filterType = el('select', { 'aria-label': 'Lọc batch theo loại' });
  filterType.appendChild(el('option', { value: '' }, 'Mọi loại'));
  for (const [val, label] of TYPE_LABELS) {
    filterType.appendChild(el('option', { value: val }, label));
  }
  const filterResult = el('select', { 'aria-label': 'Lọc batch theo kết quả' });
  for (const [val, label] of [
    ['', 'Mọi kết quả'],
    ['has-fail', 'Có lỗi mock'],
    ['all-ok', 'Tất cả OK (mock)'],
  ]) {
    filterResult.appendChild(el('option', { value: val }, label));
  }

  const histCard = el('div', { className: 'card', style: 'margin-top:1rem' });
  histCard.appendChild(el('h2', {}, 'Lịch sử batch'));
  histCard.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.5rem' },
    el('label', {}, 'Buổi ', filterSession),
    el('label', {}, 'Loại ', filterType),
    el('label', {}, 'Kết quả ', filterResult)));
  const batchListHost = el('div', {});
  const batchDetailHost = el('div', { style: 'margin-top:0.75rem' });
  histCard.appendChild(batchListHost);
  histCard.appendChild(batchDetailHost);
  root.appendChild(histCard);

  function batchSummary(b, attempts) {
    const fails = attempts.filter((a) => a.status === BATCH_RECIPIENT_STATUS.MOCK_FAIL).length;
    const ok = attempts.filter((a) => a.status === BATCH_RECIPIENT_STATUS.MOCK_SUCCESS).length;
    const skipped = attempts.filter((a) => a.status === BATCH_RECIPIENT_STATUS.SKIPPED).length;
    return { fails, ok, skipped, total: attempts.length };
  }

  function renderBatchHistory() {
    batchListHost.replaceChildren();
    batchDetailHost.replaceChildren();
    const attemptsAll = data.notificationAttempts || [];
    let batches = [...(data.notificationBatches || [])].reverse();
    if (filterSession.value) batches = batches.filter((b) => b.sessionId === filterSession.value);
    if (filterType.value) batches = batches.filter((b) => b.type === filterType.value);
    if (filterResult.value === 'has-fail') {
      batches = batches.filter((b) => attemptsAll.some(
        (a) => a.batchId === b.id && a.status === BATCH_RECIPIENT_STATUS.MOCK_FAIL,
      ));
    }
    if (filterResult.value === 'all-ok') {
      batches = batches.filter((b) => {
        const at = attemptsAll.filter((a) => a.batchId === b.id);
        return at.length > 0 && !at.some((a) => a.status === BATCH_RECIPIENT_STATUS.MOCK_FAIL);
      });
    }
    for (const b of batches) {
      const attempts = attemptsAll.filter((a) => a.batchId === b.id);
      const sum = batchSummary(b, attempts);
      const btn = el('button', {
        type: 'button',
        className: 'btn btn-ghost',
        style: 'display:block;width:100%;text-align:left;margin:0.25rem 0',
      }, `${formatSessionLocal(b.createdAt)} · ${b.type || 'reminder'} · ${sum.ok} OK / ${sum.fails} lỗi / ${sum.skipped} bỏ qua`);
      btn.addEventListener('click', () => renderBatchDetail(b, attempts));
      batchListHost.appendChild(btn);
    }
  }

  function renderBatchDetail(batch, attempts) {
    batchDetailHost.replaceChildren();
    batchDetailHost.appendChild(el('h3', {}, 'Chi tiết batch'));
    batchDetailHost.appendChild(el('pre', {
      className: 'card',
      style: 'white-space:pre-wrap;font-size:0.8rem;max-height:10rem;overflow:auto',
    }, [
      `Nội dung (đóng băng):\n${batch.contentSnapshot || ''}`,
      `\nMode: ${batch.mode} · Provider: ${batch.provider} · Initiator: ${batch.initiator || '—'}`,
      `\nCapture: ${batch.previewCaptureKey || '—'}`,
    ].join('\n')));

    const keys = [...new Set((batch.recipientsSnapshot || []).map((r) => r.canonicalKey))];
    const table = el('div', { style: 'overflow-x:auto' });
    for (const key of keys) {
      const snap = batch.recipientsSnapshot.find((r) => r.canonicalKey === key);
      const chain = attempts.filter((a) => a.canonicalKey === key).sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const latest = chain[chain.length - 1];
      const row = el('div', { className: 'list-row', style: 'flex-wrap:wrap;gap:0.35rem;padding:0.35rem 0;border-bottom:1px solid #eee' });
      row.appendChild(el('span', {}, `${snap?.displayName || key} · ${snap?.skipped ? 'bỏ qua' : 'hợp lệ'}`));
      row.appendChild(el('span', { style: 'font-size:0.8rem' }, `Mới nhất: ${latest?.status || '—'} ${latest?.error || ''}`));
      if (!snap?.skipped && latest && (latest.status === BATCH_RECIPIENT_STATUS.MOCK_FAIL
        || latest.status === BATCH_RECIPIENT_STATUS.MOCK_SUCCESS)) {
        const retryBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, `Thử lại ${snap.displayName || key}`);
        retryBtn.addEventListener('click', async () => {
          const confirmOk = latest.status === BATCH_RECIPIENT_STATUS.MOCK_SUCCESS
            ? window.confirm('Lần mock trước đã thành công. Gửi lại?')
            : true;
          if (!confirmOk) return;
          const guardKey = `ba-retry-${latest.id}`;
          const readPayload = () => ({
            attemptId: latest.id,
            scenario: 'all-success',
            confirmSuccessRetry: latest.status === BATCH_RECIPIENT_STATUS.MOCK_SUCCESS || undefined,
          });
          await runBaScopedSubmit(ctx, scope, {
            guardKey,
            btn: retryBtn,
            readPayload,
            write: async (body) => {
              await baNotifyRetry(body);
            },
            successMessage: 'Đã thử lại (mock).',
            onSuccess: () => {
              ctx.renderApp();
            },
          });
        });
        row.appendChild(retryBtn);
      }
      table.appendChild(row);
      for (const a of chain) {
        table.appendChild(el('div', { style: 'font-size:0.75rem;padding-left:0.75rem;color:#555' },
          `↳ ${a.at} · ${a.status}${a.error ? ` · ${a.error}` : ''}${a.priorAttemptId ? ` · sau ${a.priorAttemptId.slice(0, 8)}` : ''}`));
      }
    }
    batchDetailHost.appendChild(table);
  }

  filterSession.addEventListener('change', renderBatchHistory);
  filterType.addEventListener('change', renderBatchHistory);
  filterResult.addEventListener('change', renderBatchHistory);
  renderBatchHistory();

  const manualCard = el('div', { className: 'card', style: 'margin-top:1rem' });
  manualCard.appendChild(el('h2', {}, 'Ghi nhận gửi thủ công'));
  const manualBatchSel = el('select', { 'aria-label': 'Batch (tuỳ chọn)' });
  manualBatchSel.appendChild(el('option', { value: '' }, 'Theo xem trước hiện tại'));
  for (const b of [...(data.notificationBatches || [])].reverse().slice(0, 30)) {
    manualBatchSel.appendChild(el('option', { value: b.id }, `${formatSessionLocal(b.createdAt)} · ${b.id.slice(0, 8)}`));
  }
  const manualRecipientSel = el('select', { 'aria-label': 'Người nhận từ snapshot' });
  const manualChannel = el('input', { type: 'text', 'aria-label': 'Kênh gửi' });
  const manualExtChannel = el('input', { type: 'text', 'aria-label': 'Kênh giáo viên cung cấp (thiếu liên hệ)' });
  const manualTime = el('input', { type: 'datetime-local', 'aria-label': 'Thời gian gửi thực tế' });
  const manualOutcome = el('select', { 'aria-label': 'Kết quả ghi nhận' });
  for (const [val, label] of [
    [MANUAL_SEND_OUTCOME.UNPROCESSED, 'Chưa xử lý'],
    [MANUAL_SEND_OUTCOME.TEACHER_CONFIRMED_SUCCESS, 'GV xác nhận đã gửi'],
    [MANUAL_SEND_OUTCOME.FAILED, 'Gửi thất bại'],
  ]) {
    manualOutcome.appendChild(el('option', { value: val }, label));
  }
  const manualNotes = el('textarea', { 'aria-label': 'Ghi chú', rows: '2', style: 'width:100%;max-width:32rem' });
  const manualSave = el('button', { type: 'button', className: 'btn btn-primary' }, 'Ghi nhận thủ công');

  function refreshManualRecipients() {
    manualRecipientSel.replaceChildren();
    const batchId = manualBatchSel.value;
    let snaps = [];
    if (batchId) {
      const b = (data.notificationBatches || []).find((x) => x.id === batchId);
      snaps = b?.recipientsSnapshot || [];
    } else if (capturedPreview) {
      snaps = [...(capturedPreview.recipients || []), ...(capturedPreview.skipped || [])];
    }
    for (const s of snaps) {
      manualRecipientSel.appendChild(el('option', { value: s.canonicalKey },
        `${s.displayName} (${s.skipped ? 'thiếu LH' : s.canonicalKey})`));
    }
  }

  manualBatchSel.addEventListener('change', () => {
    refreshManualRecipients();
    manualDirty?.markClean?.();
  });

  manualCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Batch ', manualBatchSel));
  manualCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Người nhận ', manualRecipientSel));
  manualCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Kênh ', manualChannel));
  manualCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Kênh GV (thiếu liên hệ) ', manualExtChannel));
  manualCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Thời gian ', manualTime));
  manualCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Kết quả ', manualOutcome));
  manualCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, 'Ghi chú ', manualNotes));
  manualCard.appendChild(manualSave);
  root.appendChild(manualCard);

  const manualHist = el('div', { className: 'card', style: 'margin-top:0.75rem' });
  manualHist.appendChild(el('h3', {}, 'Lịch sử gửi thủ công'));
  for (const ev of [...(data.manualSendEvents || [])].reverse()) {
    manualHist.appendChild(el('div', { style: 'font-size:0.8rem;margin:0.25rem 0' },
      `${ev.recordedAt || ev.at} · ${ev.outcome} · ${ev.canonicalKey} · ${ev.channel || ''} · ${ev.note || ev.notes || ''}`));
  }
  root.appendChild(manualHist);

  const pendingJobs = (data.reminderJobs || []).filter((j) => j.status === 'pending' || j.status === 'overdue');
  if (pendingJobs.length) {
    const pend = el('div', { className: 'card', style: 'margin-top:0.75rem' });
    pend.appendChild(el('h3', {}, 'Nhắc lịch đang chờ (mock worker)'));
    for (const j of pendingJobs.slice(0, 10)) {
      pend.appendChild(el('div', { style: 'font-size:0.8rem' }, `${j.sessionId.slice(0, 8)} · ${j.status} · due ${j.dueAt}`));
    }
    root.appendChild(pend);
  }

  const manualDirty = registerBaViewDirty(scope, [manualBatchSel, manualRecipientSel, manualChannel, manualExtChannel, manualTime, manualOutcome, manualNotes]);
  refreshManualRecipients();
  manualDirty.markClean?.();

  manualSave.addEventListener('click', async () => {
    const guardKey = 'ba-manual-confirm';
    const readPayload = () => ({
      sessionId: sessionSel.value,
      batchId: manualBatchSel.value || undefined,
      type: typeSel.value,
      canonicalKey: manualRecipientSel.value,
      channel: manualChannel.value,
      teacherProvidedChannel: manualExtChannel.value || undefined,
      declaredSentAt: manualTime.value ? localInputToIso(manualTime.value) : undefined,
      outcome: manualOutcome.value,
      note: manualNotes.value,
    });
    await runBaScopedSubmit(ctx, scope, {
      guardKey,
      btn: manualSave,
      buttons: [manualSave],
      readPayload,
      write: async (body) => {
        await baManualConfirm(body);
      },
      successMessage: 'Đã ghi nhận (không xác minh giao hàng thật).',
      onSuccess: () => {
        ctx.renderApp();
      },
    });
  });
}
