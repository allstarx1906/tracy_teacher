import { formatSessionLocal } from './ba-domain.js';
import { baAttendanceReport } from './ba-api.js';
import { el } from './ba-ui-dom.js';
import { getRequestEpoch, captureAuthPrincipal, isInitiatingAuthStale } from './api-client.js';
import { getActiveBaViewScope } from './ba-ui-scoped.js';
import { attendanceCalendarNavigateHash } from './ba-attendance-calendar.js';
import {
  aggregateAttendanceReport,
  cancelledDrilldownRows,
  defaultReportPeriod,
  describeAppliedReportFilters,
  drilldownRowsForStudent,
  filtersPayloadEqual,
  formatAttendanceRatePercent,
  resolveReportPeriodRange,
} from './ba-reports-aggregate.js';

const DETAIL_PAGE_SIZE = 25;
const RATE_HELP = 'Tỷ lệ = (Có mặt + Đi muộn) ÷ (Có mặt + Đi muộn + Vắng). Buổi chưa điểm danh và trạng thái khác không tính vào mẫu số.';

function studentSortKey(ctx, studentId) {
  const name = ctx.state.data.students?.find((s) => s.id === studentId)?.name;
  return name ? String(name).toLocaleLowerCase('vi') : String(studentId);
}

export function renderReportsView(ctx, root, scope) {
  const shell = el('div', { className: 'ba-reports' });
  root.appendChild(shell);

  shell.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost ba-reports-back',
    onClick: () => ctx.navigate('#/tutor'),
  }, '← Quay lại'));

  shell.appendChild(el('header', { className: 'ba-reports-header' },
    el('h1', { className: 'page-title ba-reports-title' }, 'Báo cáo điểm danh'),
    el('p', { className: 'ba-reports-subtitle' },
      'So sánh học sinh, phát hiện vắng và xem lịch sử điểm danh theo khoảng thời gian.'),
  ));

  shell.appendChild(el('p', { className: 'ba-reports-calendar-link-row' },
    el('button', {
      type: 'button',
      className: 'btn btn-secondary ba-reports-calendar-link',
      onClick: () => ctx.navigate('#/tutor/attendance-calendar'),
    }, 'Lịch điểm danh học sinh'),
  ));

  const data = ctx.state.data;
  const initialPeriod = defaultReportPeriod();

  const classSel = el('select', {
    className: 'ba-reports-class-select',
    'aria-label': 'Lớp',
  });
  classSel.appendChild(el('option', { value: '' }, 'Tất cả lớp'));
  for (const c of data.classes || []) {
    classSel.appendChild(el('option', { value: c.id }, c.name));
  }

  const studentSearch = el('input', {
    type: 'search',
    className: 'ba-reports-student-search',
    'aria-label': 'Tìm học sinh theo tên',
    placeholder: 'Tìm tên học sinh…',
    autocomplete: 'off',
  });

  const fromD = el('input', {
    type: 'date',
    className: 'ba-reports-from',
    'aria-label': 'Từ ngày',
  });
  const toD = el('input', {
    type: 'date',
    className: 'ba-reports-to',
    'aria-label': 'Đến ngày',
  });
  fromD.value = initialPeriod.fromDate;
  toD.value = initialPeriod.toDate;

  const inclFuture = el('input', {
    type: 'checkbox',
    id: 'ba-rep-future',
    className: 'ba-reports-include-future',
  });

  let periodPreset = initialPeriod.preset;

  const presetThisBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary ba-reports-preset',
    'data-preset': 'this-month',
  }, 'Tháng này');
  const presetLastBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary ba-reports-preset',
    'data-preset': 'last-month',
  }, 'Tháng trước');
  const presetCustomBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary ba-reports-preset',
    'data-preset': 'custom',
  }, 'Tùy chọn');

  const loadBtn = el('button', {
    type: 'button',
    className: 'btn btn-primary ba-reports-load',
    'data-action': 'load-report',
  }, 'Xem báo cáo');

  const filterCard = el('section', { className: 'card ba-reports-filters', 'aria-label': 'Bộ lọc báo cáo' });
  filterCard.appendChild(el('div', { className: 'ba-reports-filter-grid' },
    el('label', { className: 'ba-reports-filter-label' }, 'Lớp ', classSel),
    el('label', { className: 'ba-reports-filter-label' }, 'Học sinh ', studentSearch),
    el('div', { className: 'ba-reports-period-row', role: 'group', 'aria-label': 'Khoảng thời gian nhanh' },
      presetThisBtn, presetLastBtn, presetCustomBtn),
    el('label', { className: 'ba-reports-filter-label' }, 'Từ ngày ', fromD),
    el('label', { className: 'ba-reports-filter-label' }, 'Đến ngày ', toD),
    el('details', { className: 'ba-reports-advanced' },
      el('summary', {}, 'Tùy chọn nâng cao'),
      el('label', { className: 'ba-reports-filter-label', htmlFor: 'ba-rep-future' },
        inclFuture, ' Gồm buổi tương lai'),
    ),
    el('div', { className: 'ba-reports-filter-actions' }, loadBtn),
  ));
  shell.appendChild(filterCard);

  const draftBanner = el('p', {
    className: 'ba-reports-draft-banner',
    role: 'status',
    hidden: '',
    'data-state': 'clean',
  }, 'Bộ lọc đã thay đổi — bấm Xem báo cáo');

  const appliedSummary = el('p', {
    className: 'ba-reports-applied-summary',
    'data-test': 'applied-summary',
  }, '');

  const statusLive = el('p', {
    className: 'ba-reports-status',
    role: 'status',
    'aria-live': 'polite',
    'data-test': 'status',
  }, '');

  const retryBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary ba-reports-retry',
    hidden: '',
  }, 'Thử lại');

  shell.appendChild(draftBanner);
  shell.appendChild(appliedSummary);
  shell.appendChild(statusLive);
  shell.appendChild(retryBtn);

  const kpiHost = el('section', {
    className: 'ba-reports-kpis',
    'aria-label': 'Chỉ số tóm tắt',
    hidden: '',
  });
  const kpiNote = el('p', { className: 'ba-reports-kpi-note' }, '');
  const cancelledNote = el('p', { className: 'ba-reports-cancelled-note', hidden: '' }, '');
  shell.appendChild(kpiHost);
  shell.appendChild(kpiNote);
  shell.appendChild(cancelledNote);

  const filterAbsentBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary ba-reports-row-filter',
    'data-filter': 'absent',
  }, 'Có vắng');
  const filterUnmarkedBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary ba-reports-row-filter',
    'data-filter': 'unmarked',
  }, 'Chưa điểm danh');
  const rowFilterClearBtn = el('button', {
    type: 'button',
    className: 'btn btn-ghost ba-reports-row-filter-clear',
    hidden: '',
  }, 'Bỏ lọc bảng');
  const rowFilterBtns = [filterAbsentBtn, filterUnmarkedBtn];

  const tableToolbar = el('div', { className: 'ba-reports-table-toolbar', hidden: '' },
    el('h2', { className: 'ba-reports-section-title' }, 'Tổng hợp theo học sinh'),
    el('p', { className: 'ba-reports-rate-help' }, RATE_HELP),
    el('div', { className: 'ba-reports-table-filters', role: 'group', 'aria-label': 'Lọc bảng' },
      filterAbsentBtn,
      filterUnmarkedBtn,
      rowFilterClearBtn,
    ),
  );

  const tableWrap = el('div', { className: 'ba-reports-table-wrap', hidden: '' });
  const cardsHost = el('div', { className: 'ba-reports-cards', hidden: '', 'aria-label': 'Danh sách học sinh' });
  const emptyStudents = el('p', {
    className: 'empty-state ba-reports-empty-students',
    role: 'status',
    hidden: '',
  }, 'Không có học sinh trong báo cáo với bộ lọc đã chọn.');

  const detailHost = el('section', {
    className: 'card ba-reports-detail',
    hidden: '',
    'aria-label': 'Chi tiết học sinh',
  });

  const cancelledListEl = el('div', { className: 'ba-reports-cancelled-list' });
  const cancelledHost = el('details', {
    className: 'ba-reports-cancelled',
    hidden: '',
  },
    el('summary', {}, 'Buổi đã hủy'),
    cancelledListEl,
  );

  shell.appendChild(tableToolbar);
  shell.appendChild(tableWrap);
  shell.appendChild(cardsHost);
  shell.appendChild(emptyStudents);
  shell.appendChild(detailHost);
  shell.appendChild(cancelledHost);

  let loadSeq = 0;
  let loading = false;
  const viewGen = scope.generation;
  /** @type {object|null} */
  let lastReport = null;
  /** @type {object|null} */
  let appliedFilters = null;
  /** @type {object|null} */
  let lastAggregate = null;
  /** @type {string|null} */
  let selectedStudentId = null;
  let detailPage = 0;
  let detailStatusFilter = null;
  /** @type {null|'absent'|'unmarked'} */
  let tableRowFilter = null;
  let tableSort = { key: 'name', dir: 1 };

  function studentName(id) {
    return ctx.state.data.students.find((s) => s.id === id)?.name || id || '—';
  }

  function className(id) {
    return ctx.state.data.classes.find((c) => c.id === id)?.name || id || '—';
  }

  function statusLabel(statusId) {
    const cat = ctx.state.data.attendanceStatusCatalog || [];
    return cat.find((s) => s.id === statusId)?.label || statusId;
  }

  function readDraftFilters() {
    const search = studentSearch.value.trim().toLowerCase();
    let studentId;
    if (search) {
      const matches = (data.students || []).filter((s) => String(s.name).toLowerCase().includes(search));
      if (matches.length === 1) studentId = matches[0].id;
    }
    return {
      classId: classSel.value || undefined,
      studentId,
      fromDate: fromD.value || undefined,
      toDate: toD.value || undefined,
      includeFuture: inclFuture.checked,
      searchText: search,
    };
  }

  function syncPresetButtons() {
    for (const btn of [presetThisBtn, presetLastBtn, presetCustomBtn]) {
      const active = btn.getAttribute('data-preset') === periodPreset;
      btn.classList.toggle('ba-reports-preset--active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function applyPreset(preset) {
    periodPreset = preset;
    if (preset !== 'custom') {
      const range = resolveReportPeriodRange(preset);
      if (range.fromDate) fromD.value = range.fromDate;
      if (range.toDate) toD.value = range.toDate;
    }
    syncPresetButtons();
    onDraftChanged();
  }

  function onDraftChanged() {
    const draft = readDraftFilters();
    const dirty = appliedFilters && !filtersPayloadEqual(draft, appliedFilters);
    draftBanner.hidden = dirty ? '' : 'hidden';
    if (dirty) {
      kpiHost.hidden = 'hidden';
      tableToolbar.hidden = 'hidden';
      tableWrap.hidden = 'hidden';
      cardsHost.hidden = 'hidden';
      emptyStudents.hidden = 'hidden';
      detailHost.hidden = 'hidden';
      cancelledHost.hidden = 'hidden';
      kpiHost.textContent = '';
      kpiNote.textContent = '';
      cancelledNote.hidden = 'hidden';
    } else if (lastReport && lastAggregate) {
      renderReportBody();
    }
  }

  function setLoadingState(active, message) {
    loading = active;
    loadBtn.disabled = active;
    statusLive.textContent = message || (active ? 'Đang tải báo cáo…' : '');
  }

  function clearResults() {
    lastReport = null;
    lastAggregate = null;
    selectedStudentId = null;
    kpiHost.hidden = 'hidden';
    kpiHost.textContent = '';
    kpiNote.textContent = '';
    cancelledNote.hidden = 'hidden';
    tableToolbar.hidden = 'hidden';
    tableWrap.hidden = 'hidden';
    cardsHost.hidden = 'hidden';
    emptyStudents.hidden = 'hidden';
    detailHost.hidden = 'hidden';
    cancelledHost.hidden = 'hidden';
    appliedSummary.textContent = '';
  }

  function monthKeyFromApplied() {
    if (!appliedFilters?.fromDate) return undefined;
    return appliedFilters.fromDate.slice(0, 7);
  }

  function visibleStudentRows() {
    if (!lastAggregate) return [];
    let rows = [...lastAggregate.studentRows];
    rows.sort((a, b) => {
      let cmp = 0;
      if (tableSort.key === 'name') {
        cmp = studentSortKey(ctx, a.studentId).localeCompare(studentSortKey(ctx, b.studentId), 'vi');
      } else if (tableSort.key === 'absent') cmp = a.absent - b.absent;
      else if (tableSort.key === 'unmarked') cmp = a.unmarked - b.unmarked;
      else if (tableSort.key === 'rate') {
        const ra = a.attendanceRate ?? -1;
        const rb = b.attendanceRate ?? -1;
        cmp = ra - rb;
      }
      return cmp * tableSort.dir;
    });

    const search = appliedFilters?.searchText;
    if (search) {
      rows = rows.filter((r) => studentSortKey(ctx, r.studentId).includes(search)
        || String(r.studentId).toLowerCase().includes(search));
    }
    if (tableRowFilter === 'absent') rows = rows.filter((r) => r.absent > 0);
    if (tableRowFilter === 'unmarked') rows = rows.filter((r) => r.unmarked > 0);
    return rows;
  }

  function renderDetail() {
    detailHost.textContent = '';
    if (!selectedStudentId || !lastReport) {
      detailHost.hidden = 'hidden';
      return;
    }
    detailHost.hidden = '';
    const title = el('h3', { className: 'ba-reports-detail-title' },
      `Chi tiết · ${studentName(selectedStudentId)}`);
    const filterRow = el('div', { className: 'ba-reports-detail-filters' });
    const clearDetailFilter = el('button', {
      type: 'button',
      className: 'btn btn-ghost',
      hidden: detailStatusFilter ? '' : 'hidden',
      onClick: () => { detailStatusFilter = null; detailPage = 0; renderDetail(); },
    }, 'Xóa lọc chi tiết');
    filterRow.appendChild(clearDetailFilter);
    detailHost.appendChild(title);
    detailHost.appendChild(filterRow);

    let entries = drilldownRowsForStudent(lastReport.drilldown, selectedStudentId);
    if (detailStatusFilter === 'unmarked') {
      entries = entries.filter((e) => e.bucket === 'unmarked' || e.bucket === 'upcoming');
    } else if (detailStatusFilter === 'absent') {
      entries = entries.filter((e) => e.bucket === 'absent');
    }

    const total = entries.length;
    const pages = Math.max(1, Math.ceil(total / DETAIL_PAGE_SIZE));
    if (detailPage >= pages) detailPage = pages - 1;
    const slice = entries.slice(detailPage * DETAIL_PAGE_SIZE, (detailPage + 1) * DETAIL_PAGE_SIZE);

    const list = el('ul', { className: 'ba-reports-detail-list' });
    for (const { row, bucket, statusId } of slice) {
      const session = row.session;
      const cls = session ? className(session.classId) : '—';
      const time = session ? formatSessionLocal(session.startAt) : '—';
      let statusText = '—';
      if (bucket === 'upcoming') statusText = 'Sắp học';
      else if (bucket === 'unmarked') statusText = 'Chưa điểm danh';
      else if (bucket === 'present') statusText = 'Có mặt';
      else if (bucket === 'absent') statusText = 'Vắng';
      else if (bucket === 'late') statusText = 'Đi muộn';
      else statusText = statusLabel(statusId);

      const li = el('li', { className: 'ba-reports-detail-item' });
      li.appendChild(el('span', { className: 'ba-reports-detail-date' }, time));
      li.appendChild(el('span', { className: 'ba-reports-detail-class' }, cls));
      li.appendChild(el('span', { className: 'badge badge-gray' }, statusText));
      const sid = session?.id;
      if (sid && bucket !== 'upcoming') {
        li.appendChild(el('button', {
          type: 'button',
          className: 'btn btn-ghost ba-reports-attendance-link',
          'data-session-id': sid,
          onClick: () => ctx.navigate(`#/tutor/attendance/${sid}`),
        }, 'Điểm danh'));
      }
      list.appendChild(li);
    }
    detailHost.appendChild(list);

    if (pages > 1) {
      const pager = el('div', { className: 'ba-reports-detail-pager' });
      pager.appendChild(el('span', {}, `Trang ${detailPage + 1}/${pages} · ${total} buổi`));
      const prev = el('button', {
        type: 'button',
        className: 'btn btn-ghost',
        disabled: detailPage <= 0,
        onClick: () => { detailPage -= 1; renderDetail(); },
      }, '← Trước');
      const next = el('button', {
        type: 'button',
        className: 'btn btn-ghost',
        disabled: detailPage >= pages - 1,
        onClick: () => { detailPage += 1; renderDetail(); },
      }, 'Sau →');
      pager.appendChild(prev);
      pager.appendChild(next);
      detailHost.appendChild(pager);
    }
  }

  function renderStudentTable() {
    tableWrap.textContent = '';
    cardsHost.textContent = '';
    const rows = visibleStudentRows();
    const showAllClasses = !appliedFilters?.classId;
    const showOther = lastAggregate?.hasOtherStatuses;
    const showUpcoming = (lastAggregate?.studentRows || []).some((r) => r.upcoming > 0);

    if (!rows.length) {
      tableWrap.hidden = 'hidden';
      cardsHost.hidden = 'hidden';
      emptyStudents.hidden = '';
      return;
    }
    emptyStudents.hidden = 'hidden';
    tableWrap.hidden = '';
    cardsHost.hidden = '';

    const table = el('table', { className: 'ba-reports-table' });
    const thead = el('thead', {},
      el('tr', {},
        el('th', { scope: 'col' },
          el('button', {
            type: 'button',
            className: 'ba-reports-sort',
            'data-sort': 'name',
            onClick: () => {
              if (tableSort.key === 'name') tableSort.dir *= -1;
              else tableSort = { key: 'name', dir: 1 };
              renderStudentTable();
            },
          }, 'Học sinh')),
        el('th', { scope: 'col' }, 'Số buổi'),
        el('th', { scope: 'col' }, 'Có mặt'),
        el('th', { scope: 'col' },
          el('button', {
            type: 'button',
            className: 'ba-reports-sort',
            'data-sort': 'absent',
            onClick: () => {
              if (tableSort.key === 'absent') tableSort.dir *= -1;
              else tableSort = { key: 'absent', dir: -1 };
              renderStudentTable();
            },
          }, 'Vắng')),
        el('th', { scope: 'col' }, 'Đi muộn'),
        el('th', { scope: 'col' },
          el('button', {
            type: 'button',
            className: 'ba-reports-sort',
            'data-sort': 'unmarked',
            onClick: () => {
              if (tableSort.key === 'unmarked') tableSort.dir *= -1;
              else tableSort = { key: 'unmarked', dir: -1 };
              renderStudentTable();
            },
          }, 'Chưa điểm danh')),
        showUpcoming ? el('th', { scope: 'col' }, 'Sắp học') : null,
        showOther ? el('th', { scope: 'col' }, 'Khác') : null,
        el('th', { scope: 'col' },
          el('button', {
            type: 'button',
            className: 'ba-reports-sort',
            'data-sort': 'rate',
            onClick: () => {
              if (tableSort.key === 'rate') tableSort.dir *= -1;
              else tableSort = { key: 'rate', dir: -1 };
              renderStudentTable();
            },
          }, 'Tỷ lệ tham dự')),
        el('th', { scope: 'col' }, 'Thao tác'),
      ),
    );
    const tbody = el('tbody');
    for (const row of rows) {
      const classCtx = showAllClasses && row.classIds.length
        ? row.classIds.map((id) => className(id)).join(', ')
        : '';
      const nameCell = classCtx
        ? `${studentName(row.studentId)} (${classCtx})`
        : studentName(row.studentId);
      const tr = el('tr', { 'data-student-id': row.studentId });
      tr.appendChild(el('td', { 'data-label': 'Học sinh' }, nameCell));
      tr.appendChild(el('td', { 'data-label': 'Số buổi' }, String(row.sessions)));
      tr.appendChild(el('td', { 'data-label': 'Có mặt' }, String(row.present)));
      const absentTd = el('td', { 'data-label': 'Vắng' });
      if (row.absent > 0) {
        absentTd.appendChild(el('span', { className: 'ba-reports-absent-badge' }, String(row.absent)));
      } else {
        absentTd.textContent = '0';
      }
      tr.appendChild(absentTd);
      tr.appendChild(el('td', { 'data-label': 'Đi muộn' }, String(row.late)));
      tr.appendChild(el('td', { 'data-label': 'Chưa điểm danh' }, String(row.unmarked)));
      if (showUpcoming) {
        tr.appendChild(el('td', { 'data-label': 'Sắp học' }, String(row.upcoming)));
      }
      if (showOther) {
        tr.appendChild(el('td', { 'data-label': 'Khác' }, row.other ? String(row.other) : '—'));
      }
      tr.appendChild(el('td', { 'data-label': 'Tỷ lệ tham dự' }, formatAttendanceRatePercent(row.attendanceRate)));
      const actions = el('td', { 'data-label': 'Thao tác', className: 'ba-reports-actions' });
      actions.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-ghost ba-reports-calendar-student',
        'data-action': 'calendar',
        'data-student-id': row.studentId,
        onClick: () => {
          ctx.navigate(attendanceCalendarNavigateHash({
            classId: appliedFilters?.classId,
            studentId: row.studentId,
            monthKey: monthKeyFromApplied(),
          }));
        },
      }, 'Xem lịch'));
      actions.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-ghost ba-reports-detail-btn',
        'data-action': 'detail',
        'data-student-id': row.studentId,
        onClick: () => {
          selectedStudentId = row.studentId;
          detailPage = 0;
          detailStatusFilter = null;
          renderDetail();
          detailHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
      }, 'Chi tiết'));
      tr.appendChild(actions);
      tbody.appendChild(tr);

      const card = el('article', { className: 'ba-reports-student-card', 'data-student-id': row.studentId });
      card.appendChild(el('h3', { className: 'ba-reports-card-name' }, nameCell));
      const dl = el('dl', { className: 'ba-reports-card-stats' });
      const pairs = [
        ['Số buổi', row.sessions],
        ['Có mặt', row.present],
        ['Vắng', row.absent],
        ['Đi muộn', row.late],
        ['Chưa điểm danh', row.unmarked],
        ['Tỷ lệ tham dự', formatAttendanceRatePercent(row.attendanceRate)],
      ];
      if (showUpcoming) pairs.splice(5, 0, ['Sắp học', row.upcoming]);
      if (showOther && row.other) {
        const idx = pairs.findIndex(([label]) => label === 'Tỷ lệ tham dự');
        pairs.splice(idx, 0, ['Khác', row.other]);
      }
      for (const [label, val] of pairs) {
        dl.appendChild(el('dt', {}, label));
        dl.appendChild(el('dd', {}, String(val)));
      }
      card.appendChild(dl);
      const cardActions = el('div', { className: 'ba-reports-card-actions' });
      cardActions.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-secondary ba-reports-calendar-student',
        onClick: () => {
          ctx.navigate(attendanceCalendarNavigateHash({
            classId: appliedFilters?.classId,
            studentId: row.studentId,
            monthKey: monthKeyFromApplied(),
          }));
        },
      }, 'Xem lịch'));
      cardActions.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-secondary ba-reports-detail-btn',
        onClick: () => {
          selectedStudentId = row.studentId;
          detailPage = 0;
          renderDetail();
        },
      }, 'Chi tiết'));
      card.appendChild(cardActions);
      cardsHost.appendChild(card);
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  function renderKpis(aggregate) {
    kpiHost.textContent = '';
    kpiHost.hidden = '';
    const { kpis } = aggregate;
    const tiles = [
      { label: 'Buổi học', value: kpis.sessionsNonCancelled, hint: 'Buổi không hủy trong khoảng lọc' },
      { label: 'Học sinh', value: kpis.uniqueStudents, hint: 'Học sinh có buổi học trong kỳ' },
      { label: 'Lượt vắng', value: kpis.absentTotal, hint: 'Tổng số lần học sinh vắng học' },
      { label: 'Chưa điểm danh', value: kpis.pendingUnmarked, hint: 'Buổi đã qua nhưng chưa ghi trạng thái' },
    ];
    for (const t of tiles) {
      const tile = el('article', { className: 'ba-reports-kpi-tile' });
      tile.appendChild(el('p', { className: 'ba-reports-kpi-value' }, String(t.value)));
      tile.appendChild(el('p', { className: 'ba-reports-kpi-label' }, t.label));
      tile.appendChild(el('p', { className: 'ba-reports-kpi-hint' }, t.hint));
      kpiHost.appendChild(tile);
    }
    const noteParts = [];
    if (appliedFilters) {
      noteParts.push(describeAppliedReportFilters(appliedFilters, {
        className: appliedFilters.classId ? className(appliedFilters.classId) : null,
        studentLabel: appliedFilters.studentId ? studentName(appliedFilters.studentId) : null,
      }));
    }
    if (kpis.upcomingUnmarked > 0) {
      noteParts.push(`${kpis.upcomingUnmarked} buổi sắp học chưa điểm danh (không tính vào tỷ lệ vắng).`);
    }
    kpiNote.textContent = noteParts.join(' ');

    if (kpis.cancelledSessions > 0) {
      cancelledNote.hidden = '';
      cancelledNote.textContent = `${kpis.cancelledSessions} buổi đã hủy trong khoảng (không tính vào buổi học và tổng hợp học sinh).`;
    } else {
      cancelledNote.hidden = 'hidden';
    }
  }

  function renderCancelledSection() {
    cancelledListEl.textContent = '';
    const rows = cancelledDrilldownRows(lastReport?.drilldown);
    if (!rows.length) {
      cancelledHost.hidden = 'hidden';
      return;
    }
    cancelledHost.hidden = '';
    for (const row of rows.slice(0, 50)) {
      const session = row.session;
      const line = el('div', { className: 'ba-reports-cancelled-item' });
      line.appendChild(el('span', {}, className(session?.classId)));
      line.appendChild(el('span', {}, session ? formatSessionLocal(session.startAt) : '—'));
      cancelledListEl.appendChild(line);
    }
  }

  function renderReportBody() {
    if (!lastReport || !lastAggregate) return;
    draftBanner.hidden = 'hidden';
    renderKpis(lastAggregate);
    tableToolbar.hidden = '';
    rowFilterClearBtn.hidden = tableRowFilter ? '' : 'hidden';
    renderStudentTable();
    renderCancelledSection();
    if (selectedStudentId) renderDetail();
  }

  async function loadReport() {
    if (loading) return;
    if (fromD.value && toD.value && fromD.value > toD.value) {
      statusLive.textContent = 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.';
      retryBtn.hidden = 'hidden';
      return;
    }
    const draftAtRequest = readDraftFilters();
    const snapshotApplied = appliedFilters;
    const snapshotReport = lastReport;
    const snapshotAggregate = lastAggregate;
    const seq = loadSeq + 1;
    loadSeq = seq;
    const epoch = getRequestEpoch();
    const principal = captureAuthPrincipal();
    setLoadingState(true, 'Đang tải báo cáo…');
    retryBtn.hidden = 'hidden';
    try {
      const payload = {
        classId: draftAtRequest.classId,
        studentId: draftAtRequest.studentId,
        fromDate: draftAtRequest.fromDate,
        toDate: draftAtRequest.toDate,
        includeFuture: draftAtRequest.includeFuture ? '1' : undefined,
      };
      const r = await baAttendanceReport(payload);
      if (seq !== loadSeq) return;
      if (isInitiatingAuthStale(epoch, principal) || getActiveBaViewScope()?.generation !== viewGen) return;
      const draftNow = readDraftFilters();
      if (!filtersPayloadEqual(draftAtRequest, draftNow)) {
        appliedFilters = snapshotApplied;
        lastReport = snapshotReport;
        lastAggregate = snapshotAggregate;
        setLoadingState(false, snapshotApplied
          ? 'Bộ lọc đã thay đổi — bấm Xem báo cáo'
          : '');
        onDraftChanged();
        return;
      }
      lastReport = r.report;
      appliedFilters = { ...draftAtRequest };
      lastAggregate = aggregateAttendanceReport(lastReport, {
        includeFuture: draftAtRequest.includeFuture,
      });
      selectedStudentId = null;
      detailHost.hidden = 'hidden';
      appliedSummary.textContent = describeAppliedReportFilters(appliedFilters, {
        className: appliedFilters.classId ? className(appliedFilters.classId) : null,
        studentLabel: appliedFilters.studentId ? studentName(appliedFilters.studentId) : null,
      });
      setLoadingState(false, `Đã tải · ${lastAggregate.kpis.uniqueStudents} học sinh · ${lastAggregate.kpis.sessionsNonCancelled} buổi`);
      renderReportBody();
    } catch (e) {
      if (seq !== loadSeq) return;
      if (isInitiatingAuthStale(epoch, principal) || getActiveBaViewScope()?.generation !== viewGen) return;
      setLoadingState(false, e.message || 'Lỗi tải báo cáo.');
      retryBtn.hidden = '';
      clearResults();
    }
  }

  presetThisBtn.addEventListener('click', () => applyPreset('this-month'));
  presetLastBtn.addEventListener('click', () => applyPreset('last-month'));
  presetCustomBtn.addEventListener('click', () => applyPreset('custom'));
  for (const input of [classSel, studentSearch, fromD, toD, inclFuture]) {
    input.addEventListener('input', () => {
      if (input === fromD || input === toD) periodPreset = 'custom';
      syncPresetButtons();
      onDraftChanged();
    });
    input.addEventListener('change', onDraftChanged);
  }
  loadBtn.addEventListener('click', () => { loadReport(); });
  retryBtn.addEventListener('click', () => { loadReport(); });

  for (const btn of rowFilterBtns) {
    btn.addEventListener('click', () => {
      const f = btn.getAttribute('data-filter');
      tableRowFilter = tableRowFilter === f ? null : f;
      for (const b of rowFilterBtns) {
        b.classList.toggle('ba-reports-row-filter--active', b.getAttribute('data-filter') === tableRowFilter);
      }
      renderStudentTable();
      rowFilterClearBtn.hidden = tableRowFilter ? '' : 'hidden';
    });
  }
  rowFilterClearBtn.addEventListener('click', () => {
    tableRowFilter = null;
    for (const b of rowFilterBtns) {
      b.classList.remove('ba-reports-row-filter--active');
    }
    rowFilterClearBtn.hidden = 'hidden';
    renderStudentTable();
  });

  syncPresetButtons();
  queueMicrotask(() => {
    if (getActiveBaViewScope()?.generation !== viewGen) return;
    loadReport();
  });
}
