/**
 * Accounts view: refresh list without wiping create-account draft fields.
 */

/**
 * @param {{ value?: string, options?: Array<{ value?: string, disabled?: boolean, selected?: boolean, textContent?: string }> }} stSel
 * @param {Array<{ studentId: string, disabled?: boolean }>} accounts
 * @param {Array<{ id: string, name: string, classId: string }>} students
 * @param {(classId: string) => string} className
 */
export function rebuildStudentAccountSelect(stSel, accounts, students, className) {
  const prev = stSel.value;
  const useDom = typeof document !== 'undefined' && typeof document.createElement === 'function'
    && typeof stSel.appendChild === 'function';
  if (useDom) {
    while (stSel.options.length) stSel.remove(0);
    for (const st of students) {
      const has = accounts.some((a) => a.studentId === st.id && !a.disabled);
      const opt = document.createElement('option');
      opt.value = st.id;
      opt.disabled = has;
      opt.textContent = `${st.name} (${className(st.classId)})${has ? ' — đã có TK' : ''}`;
      stSel.appendChild(opt);
    }
  } else {
    stSel.options = [];
    for (const st of students) {
      const has = accounts.some((a) => a.studentId === st.id && !a.disabled);
      stSel.options.push({
        value: st.id,
        disabled: has,
        textContent: `${st.name} (${className(st.classId)})${has ? ' — đã có TK' : ''}`,
      });
    }
  }
  const optionValues = useDom
    ? [...stSel.options].map((o) => ({ value: o.value, disabled: o.disabled }))
    : stSel.options.map((o) => ({ value: o.value, disabled: o.disabled }));
  const stillValid = optionValues.some((o) => o.value === prev && !o.disabled);
  const fallback = optionValues.find((o) => !o.disabled)?.value ?? '';
  stSel.value = stillValid ? prev : fallback;
}

/**
 * @param {{ username?: string, tempPassword?: string, studentId?: string }} draft
 * @param {{ username: string, tempPassword: string, studentId: string }} fields
 */
export function restoreCreateAccountDraft(draft, fields) {
  fields.username = draft.username ?? fields.username;
  fields.tempPassword = draft.tempPassword ?? fields.tempPassword;
  fields.studentId = draft.studentId ?? fields.studentId;
}

/**
 * @param {{ username: string, tempPassword: string, studentId: string }} fields
 */
export function captureCreateAccountDraft(fields) {
  return {
    username: fields.username,
    tempPassword: fields.tempPassword,
    studentId: fields.studentId,
  };
}

/**
 * After unrelated account list refresh, create form values must match captured draft.
 * @param {object} before captureCreateAccountDraft output
 * @param {object} after current field values
 */
export function createAccountDraftUnchanged(before, after) {
  return before.username === after.username
    && before.tempPassword === after.tempPassword
    && before.studentId === after.studentId;
}

/**
 * Guard async accounts view work after await (leave/re-entry or overlapping render).
 * @param {number} capturedViewGeneration value captured at async entry
 * @param {number} currentViewGeneration live counter
 * @param {{ canRender?: () => boolean, loadEpoch?: number, isStaleEpoch?: (epoch: number) => boolean }} [opts]
 */
export function shouldApplyAccountsViewWork(capturedViewGeneration, currentViewGeneration, opts = {}) {
  if (capturedViewGeneration !== currentViewGeneration) return false;
  if (opts.loadEpoch != null && opts.isStaleEpoch?.(opts.loadEpoch)) return false;
  if (opts.canRender && !opts.canRender()) return false;
  return true;
}

/**
 * Queue one-time create credentials from async response — auth epoch only, not view generation.
 * @param {{ temporaryPassword?: string, username?: string, replay?: boolean, message?: string }} created
 * @param {{ actionEpoch: number, submittedUsername: string, isStaleEpoch: (epoch: number) => boolean, showCredentialDialog: (entry: object) => void }} ctx
 */
export function queueCreateAccountCredentialIfValid(created, ctx) {
  if (ctx.isStaleEpoch(ctx.actionEpoch)) return false;
  if (!created?.temporaryPassword) return false;
  ctx.showCredentialDialog({
    accountKey: `create:${created.username || ctx.submittedUsername}`,
    requestEpoch: ctx.actionEpoch,
    title: 'Tài khoản học sinh đã tạo',
    lines: [
      `Tên đăng nhập: ${created.username}`,
      'Mật khẩu tạm chỉ hiển thị một lần — hãy ghi lại hoặc sao chép.',
    ],
    copyValue: `Tài khoản: ${created.username}\nMật khẩu tạm: ${created.temporaryPassword}`,
  });
  return true;
}

/**
 * Successful create ack: clear only fields that still match submitted draft, then mark clean.
 * Call after list refresh so student selector baseline includes the next eligible student.
 * @param {{ username: { value: string }, tempPassword: { value: string }, studentId: string }} fields
 * @param {{ markClean: () => void }} dirtyProbe
 * @param {ReturnType<typeof captureCreateAccountDraft>} submittedDraft
 * @param {{ studentIdBeforeRefresh?: string }} [ackOpts] selection captured before programmatic list refresh; must match submitted when selector advances
 * @returns {boolean} whether ack was applied
 */
export function applyCreateAccountSuccessAck(fields, dirtyProbe, submittedDraft, ackOpts = {}) {
  const afterUsername = fields.username.value;
  const afterTemp = fields.tempPassword.value;
  const afterStudentId = fields.studentId;
  if (afterUsername !== submittedDraft.username) return false;
  if (afterTemp !== submittedDraft.tempPassword) return false;

  const studentMatchesSubmitted = afterStudentId === submittedDraft.studentId;
  const beforeRefresh = ackOpts.studentIdBeforeRefresh;
  const provenProgrammaticAdvance = beforeRefresh != null
    && beforeRefresh === submittedDraft.studentId
    && afterStudentId !== submittedDraft.studentId;
  if (beforeRefresh != null && beforeRefresh !== submittedDraft.studentId) return false;
  if (!studentMatchesSubmitted && !provenProgrammaticAdvance) return false;

  fields.username.value = '';
  fields.tempPassword.value = '';
  dirtyProbe.markClean();
  return true;
}

/**
 * After unrelated accounts list refresh, sync dirty baseline when form was clean and only
 * the student selector moved programmatically (username/password unchanged).
 * @param {ReturnType<typeof captureCreateAccountDraft>} draftBeforeRefresh
 * @param {ReturnType<typeof captureCreateAccountDraft>} draftAfterRefresh
 * @param {boolean} wasCleanBeforeRefresh
 * @param {{ markClean: () => void }} dirtyProbe
 */
export function syncCleanFormBaselineAfterProgrammaticSelectRefresh(
  draftBeforeRefresh,
  draftAfterRefresh,
  wasCleanBeforeRefresh,
  dirtyProbe,
) {
  if (!wasCleanBeforeRefresh) return false;
  if (draftBeforeRefresh.username !== draftAfterRefresh.username) return false;
  if (draftBeforeRefresh.tempPassword !== draftAfterRefresh.tempPassword) return false;
  dirtyProbe.markClean();
  return true;
}
