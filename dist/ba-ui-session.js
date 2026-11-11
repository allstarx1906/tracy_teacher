import {
  SESSION_STATUS,
  formatSessionLocal,
  localDateTimeToUtcIso,
  resolveSessionReminderConfig,
  computeClassArchiveImpact,
  computeInheritedReminderSessionCount,
  CLASS_STATUS,
  BA_WEEKDAY_LABELS,
  formatBaSessionStatus,
  validateHttpMeetingUrl,
  validateSessionTimes,
} from './ba-domain.js';
import {
  baAdhocSession,
  baPutClassMeta,
  baSessionAction,
  baPreviewSchedule,
  baApplySchedule,
} from './ba-api.js';
import { attendanceCalendarNavigateHash } from './ba-attendance-calendar.js';
import { el } from './ba-ui-dom.js';
import { registerBaViewDirty, runBaScopedSubmit } from './ba-ui-scoped.js';
import { newBaOperationId } from './ba-ui-helpers.js';

async function sessionActionWithOverlapConfirm(sessionId, action, payload, operationId) {
  try {
    await baSessionAction(sessionId, action, { ...payload, operationId, confirmOverlap: false });
  } catch (e) {
    if (e.status !== 409) throw e;
    if (typeof window !== 'undefined' && !window.confirm(`${e.message}\nVẫn tiếp tục?`)) throw e;
    await baSessionAction(sessionId, action, {
      ...payload,
      operationId: newBaOperationId(),
      confirmOverlap: true,
    });
  }
}

function formatHistoryEntry(h, data) {
  const parts = [`${h.at} · ${h.action}`];
  if (h.operator) parts.push(`(${h.operator})`);
  if (h.reason) parts.push(`— ${h.reason}`);
  if (h.oldStart && h.newStart) {
    parts.push(`· ${formatSessionLocal(h.oldStart)}–${formatSessionLocal(h.oldEnd)} → ${formatSessionLocal(h.newStart)}–${formatSessionLocal(h.newEnd)}`);
  }
  if (h.oldStatus && h.newStatus) parts.push(`· ${h.oldStatus} → ${h.newStatus}`);
  if (h.oldReminderEnabled != null) {
    parts.push(`· Nhắc: ${h.oldReminderEnabled ? 'bật' : 'tắt'} offset ${h.oldReminderOffsetMinutes ?? 0}`);
  }
  return parts.join(' ');
}

export function renderSessionDetailView(ctx, root, scope, sessionId) {
  const session = (ctx.state.data.classSessions || []).find((s) => s.id === sessionId);
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/tutor/schedule'),
  }, '← Lịch'));
  if (!session) {
    root.appendChild(el('p', {}, 'Không tìm thấy buổi.'));
    return;
  }
  const cls = ctx.state.data.classes.find((c) => c.id === session.classId);
  root.appendChild(el('h1', { className: 'page-title' }, formatSessionLocal(session.startAt)));
  root.appendChild(el('p', {}, `Lớp: ${cls?.name || session.classId} · Trạng thái: ${formatBaSessionStatus(session.status)}`));

  const hist = (ctx.state.data.sessionHistory || []).filter((h) => h.sessionId === sessionId);
  if (hist.length) {
    root.appendChild(el('h2', {}, 'Lịch sử buổi'));
    const list = el('ul', { className: 'card', style: 'font-size:0.9rem' });
    for (const h of [...hist].sort((a, b) => String(b.at).localeCompare(String(a.at)))) {
      list.appendChild(el('li', {}, formatHistoryEntry(h, ctx.state.data)));
    }
    root.appendChild(list);
  }

  root.appendChild(el('p', { style: 'font-size:0.9rem' },
    'Thông báo đổi/hủy: chọn loại trên màn ',
    el('button', {
      type: 'button',
      className: 'btn btn-ghost',
      onClick: () => ctx.navigate(`#/tutor/notifications?sessionId=${encodeURIComponent(sessionId)}`),
    }, 'Thông báo mock'),
    ' (không tự gửi).',
  ));

  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-primary',
    style: 'margin:0.5rem 0',
    onClick: () => ctx.navigate(`#/tutor/attendance/${sessionId}`),
  }, session.status === SESSION_STATUS.CANCELLED ? 'Xem điểm danh' : 'Điểm danh'));

  if (session.status === SESSION_STATUS.CANCELLED || session.status === SESSION_STATUS.COMPLETED) {
    return;
  }

  const resolved = resolveSessionReminderConfig(session, cls);
  const inheritNote = session.reminderEnabled == null && session.reminderOffsetMinutes == null
    ? ` (kế thừa lớp: ${cls?.defaultReminderEnabled ? 'bật' : 'tắt'}, ${cls?.defaultReminderOffsetMinutes ?? 60} phút)`
    : '';
  root.appendChild(el('h2', {}, 'Nhắc buổi'));
  root.appendChild(el('p', { style: 'font-size:0.85rem' }, `Hiện tại${inheritNote}`));

  const remEn = el('input', {
    type: 'checkbox',
    id: 'ba-sess-rem',
    checked: session.reminderEnabled != null ? !!session.reminderEnabled : !!resolved.enabled,
    'aria-label': 'Bật nhắc buổi',
  });
  const remOff = el('input', {
    type: 'number',
    min: '0',
    value: String(
      session.reminderOffsetMinutes != null
        ? session.reminderOffsetMinutes
        : (session.reminderEnabled != null ? resolved.offsetMinutes : ''),
    ),
    placeholder: String(resolved.offsetMinutes ?? 60),
    'aria-label': 'Phút trước buổi',
  });
  const resetInheritBtn = el('button', { type: 'button', className: 'btn btn-ghost' }, 'Kế thừa mặc định lớp');
  const saveRemBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Lưu cấu hình nhắc');
  registerBaViewDirty(scope, [remEn, remOff]);

  resetInheritBtn.addEventListener('click', async () => {
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-session-rem-reset:${sessionId}`,
      btn: resetInheritBtn,
      busyLabel: 'Đang lưu…',
      readPayload: () => ({
        id: sessionId,
        classId: session.classId,
        startAt: session.startAt,
        endAt: session.endAt,
        reminderEnabled: null,
        reminderOffsetMinutes: null,
      }),
      write: async (body) => { await baAdhocSession(body); },
      successMessage: 'Đã đặt kế thừa nhắc lớp.',
      skipFullRender: false,
    });
  });

  saveRemBtn.addEventListener('click', async () => {
    const offRaw = String(remOff.value ?? '').trim();
    if (offRaw !== '') {
      const off = Number(offRaw);
      if (!Number.isFinite(off) || off < 0 || !Number.isInteger(off)) {
        ctx.toastErr('Phút trước buổi phải là số nguyên ≥ 0.');
        return;
      }
    }
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-session-rem:${sessionId}`,
      btn: saveRemBtn,
      busyLabel: 'Đang lưu…',
      fields: [remEn, remOff],
      readPayload: () => {
        const offRaw = String(remOff.value ?? '').trim();
        const off = offRaw === ''
          ? Math.max(0, Number(resolved.offsetMinutes) || 0)
          : Math.max(0, Math.floor(Number(offRaw) || 0));
        return {
          id: sessionId,
          classId: session.classId,
          startAt: session.startAt,
          endAt: session.endAt,
          reminderEnabled: remEn.checked,
          reminderOffsetMinutes: off,
        };
      },
      write: async (body) => { await baAdhocSession(body); },
      successMessage: 'Đã cập nhật nhắc buổi.',
    });
  });

  root.appendChild(el('label', { htmlFor: 'ba-sess-rem' }, 'Bật nhắc ', remEn));
  root.appendChild(el('label', {}, 'Phút trước buổi ', remOff));
  root.appendChild(saveRemBtn);
  root.appendChild(resetInheritBtn);

  if (session.status !== SESSION_STATUS.SCHEDULED) return;

  const rsDate = el('input', { type: 'date', 'aria-label': 'Ngày dời lịch' });
  const rsStart = el('input', { type: 'time', 'aria-label': 'Giờ bắt đầu mới' });
  const rsEnd = el('input', { type: 'time', 'aria-label': 'Giờ kết thúc mới' });
  const rsReason = el('input', { type: 'text', 'aria-label': 'Lý do dời lịch' });
  registerBaViewDirty(scope, [rsDate, rsStart, rsEnd, rsReason]);

  root.appendChild(el('h2', {}, 'Dời lịch'));
  root.appendChild(el('label', {}, 'Ngày ', rsDate));
  root.appendChild(el('label', {}, 'Bắt đầu ', rsStart));
  root.appendChild(el('label', {}, 'Kết thúc ', rsEnd));
  root.appendChild(el('label', {}, 'Lý do (bắt buộc) ', rsReason));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-secondary',
    onClick: async () => {
      if (!rsDate.value) { ctx.toastErr('Chọn ngày.'); return; }
      if (!rsReason.value.trim()) { ctx.toastErr('Nhập lý do dời lịch.'); return; }
      try {
        await runBaScopedSubmit(ctx, scope, {
          guardKey: `ba-session-reschedule:${sessionId}`,
          readPayload: () => ({
            startAt: localDateTimeToUtcIso(rsDate.value, rsStart.value || '19:00'),
            endAt: localDateTimeToUtcIso(rsDate.value, rsEnd.value || '20:00'),
            reason: rsReason.value.trim(),
          }),
          write: async (body) => {
            await sessionActionWithOverlapConfirm(sessionId, 'reschedule', {
              startAt: body.startAt,
              endAt: body.endAt,
              reason: body.reason,
            }, body.operationId);
          },
          successMessage: 'Đã dời lịch.',
        });
      } catch (e) { ctx.toastErr(e.message); }
    },
  }, 'Dời lịch'));

  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-secondary',
    style: 'margin-left:0.5rem',
    onClick: async () => {
      await runBaScopedSubmit(ctx, scope, {
        guardKey: `ba-session-complete:${sessionId}`,
        write: async (body) => {
          await baSessionAction(sessionId, 'complete', { operationId: body.operationId });
        },
        readPayload: () => ({}),
        successMessage: 'Đã hoàn thành buổi.',
      });
    },
  }, 'Hoàn thành'));

  const cancelReason = el('input', { type: 'text', 'aria-label': 'Lý do hủy buổi' });
  registerBaViewDirty(scope, [cancelReason]);
  root.appendChild(el('h2', {}, 'Hủy buổi'));
  root.appendChild(el('label', {}, 'Lý do (bắt buộc) ', cancelReason));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-secondary',
    onClick: async () => {
      if (!cancelReason.value.trim()) { ctx.toastErr('Nhập lý do hủy buổi.'); return; }
      await runBaScopedSubmit(ctx, scope, {
        guardKey: `ba-session-cancel:${sessionId}`,
        readPayload: () => ({ reason: cancelReason.value.trim() }),
        write: async (body) => {
          await baSessionAction(sessionId, 'cancel', { reason: body.reason, operationId: body.operationId });
        },
        successMessage: 'Đã hủy buổi.',
      });
    },
  }, 'Hủy buổi'));
}

export function renderScheduleView(ctx, root, scope, classId) {
  root.appendChild(el('button', { type: 'button', className: 'btn btn-ghost', onClick: () => ctx.navigate('#/tutor') }, '← Quay lại'));
  root.appendChild(el('h1', { className: 'page-title' }, 'Điểm danh lớp học'));
  const data = ctx.state.data;
  const classSel = el('select', {
    className: 'ba-schedule-class-select',
    'aria-label': 'Chọn lớp',
    required: true,
  });
  const effectiveClassId = classId || '';
  if (!effectiveClassId) {
    classSel.appendChild(el('option', { value: '' }, '— Chọn lớp * —'));
  }
  for (const c of data.classes || []) {
    classSel.appendChild(el('option', { value: c.id, selected: c.id === effectiveClassId }, c.name));
  }
  classSel.addEventListener('change', () => {
    if (classSel.value) ctx.navigate(`#/tutor/schedule/${classSel.value}`);
  });
  root.appendChild(classSel);
  root.appendChild(el('p', { className: 'ba-schedule-calendar-link-row' },
    el('button', {
      type: 'button',
      className: 'btn btn-secondary ba-schedule-calendar-link',
      onClick: () => ctx.navigate(attendanceCalendarNavigateHash({ classId: classSel.value || undefined })),
    }, 'Lịch điểm danh học sinh'),
  ));

  const sessionsCard = el('div', { className: 'card ba-schedule-sessions' });
  sessionsCard.appendChild(el('h2', {}, 'Buổi học'));
  const sessionsListHost = el('div', { className: 'ba-schedule-session-list' });
  sessionsCard.appendChild(sessionsListHost);
  function refreshSessionsList() {
    sessionsListHost.textContent = '';
    const list = [...(ctx.state.data.classSessions || [])]
      .filter((s) => !classSel.value || s.classId === classSel.value)
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    if (!list.length) {
      sessionsListHost.appendChild(el('p', { className: 'empty-state ba-schedule-empty' },
        'Chưa có buổi học. Tạo buổi mới bên dưới hoặc mở ',
        el('strong', {}, 'Thiết lập lớp & lịch học'),
        ' để lặp lịch.',
      ));
      return;
    }
    for (const s of list) {
      const clsName = ctx.state.data.classes.find((c) => c.id === s.classId)?.name || s.classId;
      sessionsListHost.appendChild(el('div', { className: 'ba-schedule-session-row list-row' },
        el('div', { className: 'ba-schedule-session-info' },
          el('span', { className: 'ba-schedule-session-class' }, clsName),
          el('time', { className: 'ba-schedule-session-date', dateTime: s.startAt }, formatSessionLocal(s.startAt)),
          el('span', { className: 'badge badge-gray ba-schedule-session-status' }, formatBaSessionStatus(s.status)),
        ),
        el('div', { className: 'ba-schedule-session-actions' },
          el('button', {
            type: 'button',
            className: 'btn btn-primary ba-schedule-attendance-btn',
            onClick: () => ctx.navigate(`#/tutor/attendance/${s.id}`),
          }, s.status === SESSION_STATUS.CANCELLED ? 'Xem điểm danh' : 'Điểm danh'),
          el('button', {
            type: 'button',
            className: 'btn btn-ghost ba-schedule-session-detail-btn',
            onClick: () => ctx.navigate(`#/tutor/sessions/${s.id}`),
          }, 'Chi tiết buổi'),
        ),
      ));
    }
  }
  refreshSessionsList();

  const adhocCard = el('div', { className: 'card ba-schedule-adhoc' });
  adhocCard.appendChild(el('h2', {}, 'Tạo buổi học'));
  const adDate = el('input', { type: 'date', required: true, 'aria-label': 'Ngày buổi' });
  const adStart = el('input', { type: 'time', value: '19:00', required: true, 'aria-label': 'Giờ bắt đầu buổi phát sinh' });
  const adEnd = el('input', { type: 'time', value: '20:00', required: true, 'aria-label': 'Giờ kết thúc buổi phát sinh' });
  const adNotes = el('input', { type: 'text', 'aria-label': 'Ghi chú buổi phát sinh' });
  const adMeeting = el('input', { type: 'url', 'aria-label': 'URL học buổi phát sinh' });
  const adRem = el('input', { type: 'checkbox', id: 'ba-adhoc-rem', 'aria-label': 'Nhắc buổi phát sinh' });
  const adOff = el('input', { type: 'number', min: '0', value: '0', 'aria-label': 'Phút trước buổi' });
  const adhocDirty = registerBaViewDirty(scope, [adDate, adStart, adEnd, adNotes, adMeeting, adRem, adOff]);
  const adhocBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Tạo buổi');
  adhocBtn.addEventListener('click', async () => {
    if (!classSel.value) { ctx.toastErr('Chọn lớp.'); classSel.focus(); return; }
    if (!adDate.value) { ctx.toastErr('Chọn ngày buổi.'); adDate.focus(); return; }
    const mv = validateHttpMeetingUrl(adMeeting.value);
    if (!mv.ok) { ctx.toastErr(mv.error); return; }
    const startAt = localDateTimeToUtcIso(adDate.value, adStart.value);
    const endAt = localDateTimeToUtcIso(adDate.value, adEnd.value);
    const tv = validateSessionTimes(startAt, endAt);
    if (!tv.ok) { ctx.toastErr(tv.error); return; }
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-adhoc:${classSel.value}`,
      btn: adhocBtn,
      fields: [adDate, adStart, adEnd, adNotes, adMeeting, adRem, adOff],
      dirtyProbe: adhocDirty,
      readPayload: () => ({
        classId: classSel.value,
        startAt,
        endAt,
        notes: adNotes.value.trim(),
        meetingUrl: adMeeting.value.trim(),
        reminderEnabled: adRem.checked,
        reminderOffsetMinutes: Number(adOff.value) || 0,
      }),
      write: async (body) => {
        try {
          await baAdhocSession({ ...body, confirmOverlap: false });
        } catch (e) {
          if (e.status !== 409) throw e;
          if (!window.confirm(`${e.message}\nVẫn tạo buổi?`)) throw e;
          await baAdhocSession({ ...body, operationId: newBaOperationId(), confirmOverlap: true });
        }
      },
      successMessage: 'Đã tạo buổi.',
      skipFullRender: true,
      onSuccess: ({ matchesSnapshot, safeToReset }) => {
        refreshSessionsList();
        if (matchesSnapshot) {
          adDate.value = '';
          adNotes.value = '';
          adMeeting.value = '';
          adRem.checked = false;
          adOff.value = '0';
          adhocDirty.markClean?.();
        }
        if (safeToReset) ctx.renderApp();
      },
    });
  });
  adhocCard.appendChild(el('p', { className: 'form-hint' }, 'Lớp: dùng danh sách phía trên. Lịch lặp nâng cao nằm bên dưới.'));
  adhocCard.appendChild(el('label', {}, 'Ngày * ', adDate));
  adhocCard.appendChild(el('label', {}, 'Bắt đầu * ', adStart));
  adhocCard.appendChild(el('label', {}, 'Kết thúc * ', adEnd));
  adhocCard.appendChild(el('label', {}, 'Ghi chú ', adNotes));
  adhocCard.appendChild(el('label', {}, 'URL học ', adMeeting));
  adhocCard.appendChild(el('label', { htmlFor: 'ba-adhoc-rem' }, 'Nhắc ', adRem));
  adhocCard.appendChild(el('label', {}, 'Phút trước buổi ', adOff));
  adhocCard.appendChild(adhocBtn);
  root.appendChild(adhocCard);
  root.appendChild(sessionsCard);

  const setupDetails = el('details', { className: 'ba-schedule-setup card' });
  setupDetails.appendChild(el('summary', { className: 'ba-schedule-setup-summary' }, 'Thiết lập lớp & lịch học'));
  const setupInner = el('div', { className: 'ba-schedule-setup-inner' });
  setupDetails.appendChild(setupInner);

  const metaCard = el('div', { className: 'card' });
  metaCard.appendChild(el('h2', {}, 'Thông tin lớp'));
  const metaCode = el('input', { type: 'text', 'aria-label': 'Mã lớp' });
  const metaSubject = el('input', { type: 'text', 'aria-label': 'Môn / chủ đề' });
  const metaNotes = el('input', { type: 'text', 'aria-label': 'Ghi chú lớp' });
  const metaMeeting = el('input', { type: 'url', 'aria-label': 'URL học mặc định' });
  const saveMetaBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Lưu thông tin lớp');
  for (const [label, input] of [
    ['Mã (tùy chọn) ', metaCode],
    ['Môn/chủ đề ', metaSubject],
    ['Ghi chú ', metaNotes],
    ['URL học mặc định (http/https) ', metaMeeting],
  ]) {
    metaCard.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, label, input));
  }
  metaCard.appendChild(saveMetaBtn);
  setupInner.appendChild(metaCard);

  function selectedClassRow() {
    return ctx.state.data.classes.find((c) => c.id === classSel.value);
  }

  function hydrateClassMetaFields(markClean = true) {
    const c = selectedClassRow();
    if (!c) return;
    metaCode.value = c.code || '';
    metaSubject.value = c.subject || '';
    metaNotes.value = c.notes || '';
    metaMeeting.value = c.meetingUrl || '';
    if (markClean) metaDirty?.markClean?.();
  }

  const metaDirty = registerBaViewDirty(scope, [metaCode, metaSubject, metaNotes, metaMeeting]);
  hydrateClassMetaFields(true);

  saveMetaBtn.addEventListener('click', async () => {
    const mv = validateHttpMeetingUrl(metaMeeting.value);
    if (!mv.ok) { ctx.toastErr(mv.error); return; }
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-class-meta:${classSel.value}`,
      btn: saveMetaBtn,
      fields: [metaCode, metaSubject, metaNotes, metaMeeting],
      dirtyProbe: metaDirty,
      readPayload: () => ({
        classId: classSel.value,
        code: metaCode.value.trim(),
        subject: metaSubject.value.trim(),
        notes: metaNotes.value.trim(),
        meetingUrl: metaMeeting.value.trim(),
      }),
      write: async (body) => { await baPutClassMeta(body); },
      successMessage: 'Đã lưu thông tin lớp.',
      skipFullRender: true,
      onSuccess: ({ matchesSnapshot, safeToReset }) => {
        hydrateClassMetaFields(matchesSnapshot);
        if (safeToReset) ctx.renderApp();
      },
    });
  });

  const kindRow = el('div', { className: 'card' });
  kindRow.appendChild(el('h2', {}, 'Loại lớp (1:1 / nhóm)'));
  const kindBtn1 = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Đặt 1:1');
  const kindBtnG = el('button', { type: 'button', className: 'btn btn-ghost', style: 'margin-left:0.5rem' }, 'Đặt nhóm');
  kindBtn1.addEventListener('click', async () => {
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-class-kind:${classSel.value}`,
      btn: kindBtn1,
      readPayload: () => ({ classId: classSel.value, kind: 'one-to-one' }),
      write: async (body) => { await baPutClassMeta(body); },
      successMessage: 'Đã đặt lớp 1:1.',
    });
  });
  kindBtnG.addEventListener('click', async () => {
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-class-kind:${classSel.value}`,
      btn: kindBtnG,
      readPayload: () => ({ classId: classSel.value, kind: 'group' }),
      write: async (body) => { await baPutClassMeta(body); },
      successMessage: 'Đã đặt lớp nhóm.',
    });
  });
  kindRow.appendChild(kindBtn1);
  kindRow.appendChild(kindBtnG);
  setupInner.appendChild(kindRow);

  const defaultsCard = el('div', { className: 'card' });
  defaultsCard.appendChild(el('h2', {}, 'Nhắc lịch mặc định & lưu trữ'));
  const defEn = el('input', { type: 'checkbox', id: 'ba-def-rem-en', 'aria-label': 'Bật nhắc mặc định' });
  const defOff = el('input', { type: 'number', min: '0', value: '60', 'aria-label': 'Phút trước buổi' });
  const defaultsDirty = registerBaViewDirty(scope, [defEn, defOff]);
  function hydrateClassDefaults(markClean = true) {
    const c = selectedClassRow();
    if (!c) return;
    defEn.checked = !!c.defaultReminderEnabled;
    defOff.value = String(c.defaultReminderOffsetMinutes ?? 60);
    if (markClean) defaultsDirty.markClean?.();
  }
  hydrateClassDefaults(true);
  defaultsCard.appendChild(el('label', { htmlFor: 'ba-def-rem-en' }, 'Bật nhắc ', defEn));
  defaultsCard.appendChild(el('label', {}, 'Phút trước buổi ', defOff));
  const saveDefBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Lưu mặc định lớp');
  saveDefBtn.addEventListener('click', async () => {
    const inheritCount = computeInheritedReminderSessionCount(ctx.state.data, classSel.value);
    const msg = `Cập nhật nhắc mặc định áp ${inheritCount} buổi đang kế thừa (không ghi đè buổi đã chỉnh). Tiếp tục?`;
    if (!window.confirm(msg)) return;
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-class-defaults:${classSel.value}`,
      btn: saveDefBtn,
      fields: [defEn, defOff],
      readPayload: () => ({
        classId: classSel.value,
        defaultReminderEnabled: defEn.checked,
        defaultReminderOffsetMinutes: Number(defOff.value) || 0,
        confirmDefaultReminderImpact: true,
      }),
      write: async (body) => { await baPutClassMeta(body); },
      successMessage: 'Đã cập nhật mặc định.',
    });
  });
  defaultsCard.appendChild(saveDefBtn);

  const archBtn = el('button', { type: 'button', className: 'btn btn-ghost', style: 'margin-left:0.5rem' }, 'Lưu trữ lớp');
  const reactivateBtn = el('button', { type: 'button', className: 'btn btn-ghost', style: 'margin-left:0.5rem' }, 'Kích hoạt lại lớp');
  archBtn.addEventListener('click', async () => {
    const impact = computeClassArchiveImpact(ctx.state.data, classSel.value, new Date().toISOString());
    const msg = `Lưu trữ sẽ hủy ${impact.pendingReminderJobs} job nhắc đang chờ và ảnh hưởng ${impact.futureScheduledSessions} buổi tương lai (vẫn giữ lịch sử). Tiếp tục?`;
    if (!window.confirm(msg)) return;
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-class-archive:${classSel.value}`,
      btn: archBtn,
      readPayload: () => ({
        classId: classSel.value,
        status: CLASS_STATUS.ARCHIVED,
        confirmArchiveImpact: true,
      }),
      write: async (body) => { await baPutClassMeta(body); },
      successMessage: 'Đã lưu trữ lớp.',
    });
  });
  reactivateBtn.addEventListener('click', async () => {
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-class-reactivate:${classSel.value}`,
      btn: reactivateBtn,
      readPayload: () => ({ classId: classSel.value, status: CLASS_STATUS.ACTIVE }),
      write: async (body) => { await baPutClassMeta(body); },
      successMessage: 'Đã kích hoạt lại lớp.',
    });
  });
  defaultsCard.appendChild(archBtn);
  defaultsCard.appendChild(reactivateBtn);
  setupInner.appendChild(defaultsCard);

  const recurCard = el('div', { className: 'card' });
  recurCard.appendChild(el('h2', {}, 'Lịch lặp (xem trước → lưu)'));
  const rangeFrom = el('input', { type: 'date', 'aria-label': 'Từ ngày' });
  const rangeTo = el('input', { type: 'date', 'aria-label': 'Đến ngày' });
  const startTime = el('input', { type: 'time', value: '19:00', 'aria-label': 'Giờ bắt đầu' });
  const endTime = el('input', { type: 'time', value: '20:00', 'aria-label': 'Giờ kết thúc' });
  const weekdayBox = el('div', { className: 'checkbox-row' });
  const weekdayInputs = [];
  for (let d = 0; d <= 6; d += 1) {
    const cb = el('input', { type: 'checkbox', value: String(d), id: `ba-wd-${d}` });
    weekdayInputs.push(cb);
    weekdayBox.appendChild(el('label', { htmlFor: `ba-wd-${d}`, style: 'margin-right:0.5rem' }, `${BA_WEEKDAY_LABELS[d]} `, cb));
  }
  const recurNotes = el('input', { type: 'text', 'aria-label': 'Ghi chú buổi lặp' });
  const recurMeeting = el('input', { type: 'url', 'aria-label': 'URL học ghi đè lặp' });
  const previewPre = el('pre', { className: 'card', style: 'white-space:pre-wrap;font-size:0.85rem' }, 'Chưa xem trước.');
  let capturedPreviewFingerprint = null;
  let capturedHasConflict = false;
  registerBaViewDirty(scope, [rangeFrom, rangeTo, startTime, endTime, recurNotes, recurMeeting, ...weekdayInputs]);
  const markPreviewStale = () => {
    capturedPreviewFingerprint = null;
    previewPre.textContent = 'Chưa xem trước — đã đổi đầu vào.';
  };
  for (const inp of [rangeFrom, rangeTo, startTime, endTime, recurNotes, recurMeeting, ...weekdayInputs]) {
    inp.addEventListener('input', markPreviewStale);
    inp.addEventListener('change', markPreviewStale);
  }

  const previewBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Xem trước');
  previewBtn.addEventListener('click', async () => {
    const weekdays = weekdayInputs.filter((c) => c.checked).map((c) => Number(c.value));
    try {
      const p = await baPreviewSchedule({
        classId: classSel.value,
        weekdays,
        startTime: startTime.value,
        endTime: endTime.value,
        rangeFromDate: rangeFrom.value,
        rangeToDate: rangeTo.value,
      });
      capturedPreviewFingerprint = p.previewFingerprint;
      capturedHasConflict = (p.conflicts || []).length > 0;
      const conflictSet = new Set((p.conflicts || []).map((c) => c.session?.startAt));
      previewPre.textContent = (p.sessions || []).map((s) => {
        const mark = conflictSet.has(s.startAt) ? ' [CHỒNG]' : (s.duplicateOfExisting ? ' [TRÙNG]' : '');
        return `${formatSessionLocal(s.startAt)} → ${formatSessionLocal(s.endAt)}${mark}`;
      }).join('\n') || 'Không có buổi.';
    } catch (e) { ctx.toastErr(e.message); }
  });

  const applyBtn = el('button', { type: 'button', className: 'btn btn-primary', style: 'margin-left:0.5rem' }, 'Lưu buổi lặp');
  applyBtn.addEventListener('click', async () => {
    if (!capturedPreviewFingerprint) {
      ctx.toastErr('Xem trước lịch lặp trước khi lưu.');
      return;
    }
    const weekdays = weekdayInputs.filter((c) => c.checked).map((c) => Number(c.value));
    let confirmOverlap = false;
    if (capturedHasConflict && !window.confirm('Có buổi chồng giờ. Vẫn lưu?')) return;
    if (capturedHasConflict) confirmOverlap = true;
    const mv = validateHttpMeetingUrl(recurMeeting.value);
    if (!mv.ok) { ctx.toastErr(mv.error); return; }
    await runBaScopedSubmit(ctx, scope, {
      guardKey: `ba-apply-schedule:${classSel.value}`,
      btn: applyBtn,
      readPayload: () => ({
        classId: classSel.value,
        weekdays,
        startTime: startTime.value,
        endTime: endTime.value,
        rangeFromDate: rangeFrom.value,
        rangeToDate: rangeTo.value,
        notes: recurNotes.value.trim(),
        meetingUrl: recurMeeting.value.trim(),
        confirmOverlap,
        previewFingerprint: capturedPreviewFingerprint,
      }),
      write: async (body) => {
        await baApplySchedule(body);
      },
      successMessage: 'Đã lưu lịch lặp.',
    });
  });

  recurCard.appendChild(el('label', {}, 'Từ ', rangeFrom));
  recurCard.appendChild(el('label', {}, 'Đến ', rangeTo));
  recurCard.appendChild(el('label', {}, 'Bắt đầu ', startTime));
  recurCard.appendChild(el('label', {}, 'Kết thúc ', endTime));
  recurCard.appendChild(el('label', {}, 'Ghi chú buổi ', recurNotes));
  recurCard.appendChild(el('label', {}, 'URL học (để trống = mặc định lớp) ', recurMeeting));
  recurCard.appendChild(weekdayBox);
  recurCard.appendChild(previewBtn);
  recurCard.appendChild(applyBtn);
  recurCard.appendChild(previewPre);
  setupInner.appendChild(recurCard);

  root.appendChild(setupDetails);
}
