/**
 * Assignment dialog save-close orchestration (save lock vs close guard).
 */

/**
 * After a successful persist, release the save lock before skip-dirty close so
 * onBeforeClose guards that veto while saving do not block closeAfterSave().
 *
 * @param {object} ctx
 * @param {() => boolean} ctx.isDialogActive
 * @param {(value: boolean) => void} ctx.setAssignmentSaving
 * @param {() => void} ctx.onAcknowledged
 * @param {() => void} ctx.closeAfterSave
 * @param {() => boolean} [ctx.formMatchesAcknowledgedSnapshot]
 * @param {() => void} [ctx.onFormChangedSinceAcknowledged]
 * @returns {boolean} whether close was requested
 */
export function closeAssignmentDialogAfterSuccessfulSave(ctx) {
  const {
    isDialogActive,
    setAssignmentSaving,
    onAcknowledged,
    closeAfterSave,
    formMatchesAcknowledgedSnapshot,
    onFormChangedSinceAcknowledged,
  } = ctx;
  if (!isDialogActive()) return false;
  if (
    typeof formMatchesAcknowledgedSnapshot === 'function'
    && !formMatchesAcknowledgedSnapshot()
  ) {
    onFormChangedSinceAcknowledged?.();
    return false;
  }
  onAcknowledged();
  setAssignmentSaving(false);
  closeAfterSave();
  return true;
}

/**
 * Default class for a new assignment: active class filter, then route class detail, else first class.
 * When editing, keep the assignment's existing class when still valid.
 *
 * @param {Array<{ id: string }>} classes
 * @param {{ editing: boolean, existingClassId?: string, classFilterId?: string, routeClassId?: string }} ctx
 */
export function resolveNewAssignmentClassId(classes, ctx) {
  const { editing, existingClassId, classFilterId, routeClassId } = ctx;
  const hasClass = (id) => !!(id && classes.some((c) => c.id === id));
  if (editing) {
    if (hasClass(existingClassId)) return existingClassId;
    return classes[0]?.id ?? '';
  }
  if (hasClass(classFilterId)) return classFilterId;
  if (hasClass(routeClassId)) return routeClassId;
  return classes[0]?.id ?? '';
}
