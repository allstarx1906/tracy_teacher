import { formatSessionLocal } from './ba-domain.js';
import { el } from './ba-ui-dom.js';
import {
  attendanceCalendarNavigateHash,
  computeStudentAttendanceCalendarMonth,
  currentMonthKeyInBa,
  resolveCalendarStudentSelection,
  resolveCalendarMonthKey,
  shiftMonthKey,
  STANDARD_ATTENDANCE_KIND,
  studentsEligibleForCalendarFilter,
} from './ba-attendance-calendar.js';

const WEEKDAY_HEADERS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

function sessionTimeLabel(startIso) {
  const full = formatSessionLocal(startIso);
  const parts = full.split(' ');
  return parts.length > 1 ? parts[1] : full;
}

function kindCssClass(kind) {
  switch (kind) {
    case STANDARD_ATTENDANCE_KIND.PRESENT: return 'ba-acal-chip--present';
    case STANDARD_ATTENDANCE_KIND.ABSENT: return 'ba-acal-chip--absent';
    case STANDARD_ATTENDANCE_KIND.LATE: return 'ba-acal-chip--late';
    case STANDARD_ATTENDANCE_KIND.UNMARKED: return 'ba-acal-chip--unmarked';
    case STANDARD_ATTENDANCE_KIND.UPCOMING: return 'ba-acal-chip--upcoming';
    case STANDARD_ATTENDANCE_KIND.CANCELLED: return 'ba-acal-chip--cancelled';
    case STANDARD_ATTENDANCE_KIND.CUSTOM: return 'ba-acal-chip--custom';
    default: return 'ba-acal-chip--neutral';
  }
}

function kindIcon(kind) {
  switch (kind) {
    case STANDARD_ATTENDANCE_KIND.PRESENT: return '✓';
    case STANDARD_ATTENDANCE_KIND.ABSENT: return '✕';
    case STANDARD_ATTENDANCE_KIND.LATE: return '◷';
    case STANDARD_ATTENDANCE_KIND.UNMARKED: return '…';
    case STANDARD_ATTENDANCE_KIND.UPCOMING: return '→';
    case STANDARD_ATTENDANCE_KIND.CANCELLED: return '⊘';
    default: return '•';
  }
}

/** Short grid legend codes (mobile); full labels stay in aria-label and day detail. */
function kindShortCode(kind) {
  switch (kind) {
    case STANDARD_ATTENDANCE_KIND.PRESENT: return 'CM';
    case STANDARD_ATTENDANCE_KIND.ABSENT: return 'V';
    case STANDARD_ATTENDANCE_KIND.LATE: return 'Trễ';
    case STANDARD_ATTENDANCE_KIND.UNMARKED: return 'Chưa';
    case STANDARD_ATTENDANCE_KIND.UPCOMING: return 'Sắp';
    case STANDARD_ATTENDANCE_KIND.CANCELLED: return 'Hủy';
    default: return 'Khác';
  }
}

const LEGEND_ENTRIES = [
  [STANDARD_ATTENDANCE_KIND.PRESENT, 'CM', 'Có mặt'],
  [STANDARD_ATTENDANCE_KIND.ABSENT, 'V', 'Vắng'],
  [STANDARD_ATTENDANCE_KIND.LATE, 'Trễ', 'Đi muộn'],
  [STANDARD_ATTENDANCE_KIND.UNMARKED, 'Chưa', 'Chưa điểm danh'],
  [STANDARD_ATTENDANCE_KIND.UPCOMING, 'Sắp', 'Sắp học'],
  [STANDARD_ATTENDANCE_KIND.CANCELLED, 'Hủy', 'Hủy'],
];

function formatRate(rate) {
  if (rate == null) return '—';
  return `${Math.round(rate * 1000) / 10}%`;
}

function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-');
  return `Tháng ${Number(m)}/${y}`;
}

export function renderAttendanceCalendarView(ctx, root, scope, route) {
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost ba-acal-back',
    onClick: () => ctx.navigate('#/tutor'),
  }, '← Quay lại'));
  root.appendChild(el('h1', { className: 'page-title ba-acal-title' }, 'Lịch điểm danh học sinh'));

  const data = ctx.state.data;
  const classSel = el('select', {
    className: 'ba-acal-class-select',
    'aria-label': 'Lọc theo lớp (tùy chọn)',
  });
  classSel.appendChild(el('option', { value: '' }, 'Tất cả lớp'));
  for (const c of data.classes || []) {
    classSel.appendChild(el('option', { value: c.id }, c.name));
  }

  const studentSel = el('select', {
    className: 'ba-acal-student-select',
    'aria-label': 'Chọn học sinh',
  });

  const monthIn = el('input', {
    type: 'month',
    className: 'ba-acal-month-input',
    'aria-label': 'Chọn tháng',
  });

  const statsHost = el('section', {
    className: 'ba-acal-stats card',
    'aria-label': 'Thống kê tháng',
  });
  const legendHost = el('div', { className: 'ba-acal-legend-wrap', 'aria-label': 'Chú thích trạng thái' });
  const gridHost = el('section', { className: 'ba-acal-grid-wrap', 'aria-label': 'Lịch tháng' });
  const detailHost = el('section', {
    className: 'ba-acal-day-detail card',
    'aria-label': 'Chi tiết ngày',
    hidden: '',
  });
  const emptyHost = el('p', { className: 'empty-state ba-acal-empty', role: 'status' }, '');

  let classId = route.classId || '';
  let studentId = route.studentId || '';
  let monthKey = resolveCalendarMonthKey(route.month);
  let selectedDateKey = null;

  function syncRouteNavigate() {
    ctx.navigate(attendanceCalendarNavigateHash({
      classId: classId || undefined,
      studentId: studentId || undefined,
      monthKey,
    }));
  }

  function refreshStudentOptions() {
    const prev = studentId;
    const list = studentsEligibleForCalendarFilter(data, classId || null);
    studentSel.textContent = '';
    for (const s of list) {
      studentSel.appendChild(el('option', { value: s.id }, s.name || s.id));
    }
    studentId = resolveCalendarStudentSelection(data, { studentId: prev, classId: classId || null }) || '';
    if (studentId) studentSel.value = studentId;
  }

  function statTile(label, value, modClass) {
    const tile = el('div', {
      className: ['ba-acal-stat-tile', modClass].filter(Boolean).join(' '),
    });
    tile.appendChild(el('span', { className: 'ba-acal-stat-value' }, value));
    tile.appendChild(el('span', { className: 'ba-acal-stat-label' }, label));
    return tile;
  }

  function renderLegend() {
    legendHost.textContent = '';
    const legend = el('div', { className: 'ba-acal-legend', role: 'list' });
    for (const [kind, code, label] of LEGEND_ENTRIES) {
      const item = el('span', {
        className: `ba-acal-legend-item ${kindCssClass(kind)}`,
        role: 'listitem',
      });
      item.appendChild(el('span', { className: 'ba-acal-legend-icon', 'aria-hidden': 'true' }, kindIcon(kind)));
      item.appendChild(el('span', { className: 'ba-acal-legend-code' }, code));
      item.appendChild(el('span', { className: 'ba-acal-legend-label' }, label));
      legend.appendChild(item);
    }
    legendHost.appendChild(legend);
  }

  function renderStats(model) {
    statsHost.textContent = '';
    const { stats, attendanceRate } = model;
    statsHost.appendChild(el('h2', { className: 'ba-acal-stats-title' }, monthLabel(monthKey)));
    statsHost.appendChild(el('p', { className: 'ba-acal-stats-note' },
      'Có mặt, vắng, muộn là số buổi đã ghi điểm danh (kể cả ghi trước cho buổi chưa diễn ra). '
      + '"Buổi đã diễn ra" chỉ đếm buổi không hủy đã tới giờ.',
    ));
    const tiles = el('div', { className: 'ba-acal-stats-tiles' });
    tiles.appendChild(statTile('Buổi đã diễn ra (không hủy)', String(stats.occurredNonCancelled), 'ba-acal-stat-tile--neutral'));
    tiles.appendChild(statTile('Có mặt (đã ghi)', String(stats.present), 'ba-acal-stat-tile--present'));
    tiles.appendChild(statTile('Vắng (đã ghi)', String(stats.absent), 'ba-acal-stat-tile--absent'));
    tiles.appendChild(statTile('Muộn (đã ghi)', String(stats.late), 'ba-acal-stat-tile--late'));
    tiles.appendChild(statTile('Chưa điểm danh', String(stats.unmarked), 'ba-acal-stat-tile--unmarked'));
    tiles.appendChild(statTile('Sắp học', String(stats.upcoming), 'ba-acal-stat-tile--upcoming'));
    tiles.appendChild(statTile('Hủy', String(stats.cancelled), 'ba-acal-stat-tile--cancelled'));
    statsHost.appendChild(tiles);

    const rateBlock = el('div', { className: 'ba-acal-stat-rate' });
    rateBlock.appendChild(el('span', { className: 'ba-acal-stat-rate-value' }, formatRate(attendanceRate)));
    rateBlock.appendChild(el('span', { className: 'ba-acal-stat-rate-label' },
      'Tỷ lệ tham dự (buổi đã điểm danh chuẩn)',
    ));
    rateBlock.appendChild(el('p', { className: 'ba-acal-stat-rate-note' },
      'Công thức: (có mặt + muộn) ÷ (có mặt + muộn + vắng). '
      + 'Không tính hủy, chưa điểm danh, sắp học, trạng thái khác.',
    ));
    statsHost.appendChild(rateBlock);

    const customLines = Object.entries(stats.customByStatusId || {});
    if (customLines.length) {
      const customWrap = el('div', { className: 'ba-acal-stats-custom' });
      customWrap.appendChild(el('p', { className: 'ba-acal-stats-custom-title' }, 'Trạng thái khác (theo buổi)'));
      const customTiles = el('div', { className: 'ba-acal-stats-tiles ba-acal-stats-tiles--custom' });
      for (const [statusId, count] of customLines) {
        const cat = (data.attendanceStatusCatalog || []).find((s) => s.id === statusId);
        const lbl = cat?.label || statusId;
        customTiles.appendChild(statTile(lbl, String(count), 'ba-acal-stat-tile--custom'));
      }
      customWrap.appendChild(customTiles);
      statsHost.appendChild(customWrap);
    }
  }

  function renderDayDetail(dateKey, entries) {
    detailHost.textContent = '';
    if (!dateKey || !entries?.length) {
      detailHost.hidden = true;
      return;
    }
    detailHost.hidden = false;
    detailHost.appendChild(el('h2', { className: 'ba-acal-detail-title' }, `Ngày ${dateKey.split('-').reverse().join('/')}`));
    const ul = el('ul', { className: 'ba-acal-detail-list' });
    for (const entry of entries) {
      const li = el('li', { className: 'ba-acal-detail-item' });
      li.appendChild(el('span', {
        className: `ba-acal-detail-status ${kindCssClass(entry.kind)}`,
        'aria-label': entry.ariaLabel,
      }, `${kindIcon(entry.kind)} ${entry.label}`));
      li.appendChild(el('span', { className: 'ba-acal-detail-meta' },
        `${entry.className} · ${sessionTimeLabel(entry.startAt)}`,
      ));
      const attLabel = entry.kind === STANDARD_ATTENDANCE_KIND.CANCELLED ? 'Xem điểm danh' : 'Điểm danh';
      li.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-ghost ba-acal-detail-att-link',
        'data-session-id': entry.sessionId,
        onClick: () => ctx.navigate(`#/tutor/attendance/${entry.sessionId}`),
      }, attLabel));
      ul.appendChild(li);
    }
    detailHost.appendChild(ul);
  }

  function renderGrid(model) {
    gridHost.textContent = '';
    const table = el('div', { className: 'ba-acal-grid', role: 'grid', 'aria-label': monthLabel(monthKey) });
    const head = el('div', { className: 'ba-acal-grid-head', role: 'row' });
    for (const h of WEEKDAY_HEADERS) {
      head.appendChild(el('div', { className: 'ba-acal-grid-head-cell', role: 'columnheader' }, h));
    }
    table.appendChild(head);

    for (const week of model.grid) {
      const row = el('div', { className: 'ba-acal-grid-row', role: 'row' });
      for (const cell of week) {
        const dayNum = cell.dateKey.split('-')[2];
        const entries = model.byDate[cell.dateKey] || [];
        const cellEl = el('div', {
          className: [
            'ba-acal-day',
            cell.inMonth ? 'ba-acal-day--in-month' : 'ba-acal-day--pad',
            entries.length ? 'ba-acal-day--has-sessions' : '',
            selectedDateKey === cell.dateKey ? 'ba-acal-day--selected' : '',
          ].filter(Boolean).join(' '),
          role: 'gridcell',
          'data-date-key': cell.dateKey,
        });
        cellEl.appendChild(el('span', { className: 'ba-acal-day-num' }, String(Number(dayNum))));
        if (cell.inMonth && entries.length) {
          const chips = el('div', { className: 'ba-acal-chips' });
          for (const entry of entries) {
            const chip = el('button', {
              type: 'button',
              className: `ba-acal-chip ${kindCssClass(entry.kind)}`,
              'aria-label': `${entry.ariaLabel} · ${sessionTimeLabel(entry.startAt)}`,
              'data-session-id': entry.sessionId,
              onClick: () => {
                selectedDateKey = cell.dateKey;
                renderGrid(model);
                renderDayDetail(cell.dateKey, entries);
                requestAnimationFrame(() => {
                  if (!detailHost.hidden) {
                    detailHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  }
                });
              },
            },
            el('span', { className: 'ba-acal-chip-icon', 'aria-hidden': 'true' }, kindIcon(entry.kind)),
            el('span', { className: 'ba-acal-chip-code' }, kindShortCode(entry.kind)),
            el('span', { className: 'ba-acal-chip-time' }, sessionTimeLabel(entry.startAt)),
            el('span', { className: 'ba-acal-chip-class' }, entry.className),
            el('span', { className: 'ba-acal-chip-status' }, entry.label),
            );
            chips.appendChild(chip);
          }
          cellEl.appendChild(chips);
        }
        row.appendChild(cellEl);
      }
      table.appendChild(row);
    }
    gridHost.appendChild(table);
  }

  function renderAll() {
    classSel.value = classId;
    monthIn.value = monthKey;
    refreshStudentOptions();
    if (!studentId) {
      emptyHost.textContent = 'Chưa có học sinh phù hợp với bộ lọc.';
      statsHost.textContent = '';
      legendHost.textContent = '';
      gridHost.textContent = '';
      detailHost.hidden = true;
      return;
    }
    emptyHost.textContent = '';
    const model = computeStudentAttendanceCalendarMonth(data, {
      studentId,
      classId: classId || null,
      monthKey,
    });
    renderStats(model);
    renderLegend();
    renderGrid(model);
    if (selectedDateKey && model.byDate[selectedDateKey]) {
      renderDayDetail(selectedDateKey, model.byDate[selectedDateKey]);
    } else {
      selectedDateKey = null;
      detailHost.hidden = true;
    }
  }

  const navRow = el('div', { className: 'ba-acal-nav' });
  const prevBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary ba-acal-nav-btn',
    'aria-label': 'Tháng trước',
  }, '← Tháng trước');
  const thisBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary ba-acal-nav-btn',
    'aria-label': 'Tháng này',
  }, 'Tháng này');
  const nextBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary ba-acal-nav-btn',
    'aria-label': 'Tháng sau',
  }, 'Tháng sau →');

  prevBtn.addEventListener('click', () => {
    monthKey = shiftMonthKey(monthKey, -1);
    selectedDateKey = null;
    syncRouteNavigate();
  });
  nextBtn.addEventListener('click', () => {
    monthKey = shiftMonthKey(monthKey, 1);
    selectedDateKey = null;
    syncRouteNavigate();
  });
  thisBtn.addEventListener('click', () => {
    monthKey = currentMonthKeyInBa();
    selectedDateKey = null;
    syncRouteNavigate();
  });

  classSel.addEventListener('change', () => {
    classId = classSel.value;
    studentId = resolveCalendarStudentSelection(data, { studentId: null, classId: classId || null }) || '';
    selectedDateKey = null;
    syncRouteNavigate();
  });
  studentSel.addEventListener('change', () => {
    studentId = studentSel.value;
    selectedDateKey = null;
    syncRouteNavigate();
  });
  monthIn.addEventListener('change', () => {
    monthKey = resolveCalendarMonthKey(monthIn.value);
    monthIn.value = monthKey;
    selectedDateKey = null;
    syncRouteNavigate();
  });

  navRow.appendChild(prevBtn);
  navRow.appendChild(thisBtn);
  navRow.appendChild(nextBtn);

  const filters = el('div', { className: 'ba-acal-filters' });
  filters.appendChild(el('label', { className: 'ba-acal-filter-label' }, 'Lớp ', classSel));
  filters.appendChild(el('label', { className: 'ba-acal-filter-label' }, 'Học sinh ', studentSel));
  filters.appendChild(el('label', { className: 'ba-acal-filter-label' }, 'Tháng ', monthIn));
  filters.appendChild(navRow);

  root.appendChild(filters);
  root.appendChild(emptyHost);
  root.appendChild(statsHost);
  root.appendChild(legendHost);
  root.appendChild(gridHost);
  root.appendChild(detailHost);

  classId = route.classId || '';
  studentId = route.studentId || '';
  monthKey = resolveCalendarMonthKey(route.month);
  renderAll();
}
