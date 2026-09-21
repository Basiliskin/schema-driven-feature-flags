import { escapeHtml } from './escape.js';
import { renderDialogTrigger, renderModalDialog } from './modal-dialog.js';
import type { WriteFormContext } from './state-fields.js';

export interface Confirmation {
  readonly id: string;
  /** Names the exact subject, e.g. the flag and the segment being detached. */
  readonly title: string;
  /** Already-escaped HTML, so the sentence can mark the subject up with <code>; callers escape what they interpolate. */
  readonly prompt: string;
  readonly triggerLabel: string;
  readonly confirmLabel: string;
  /** The `field` value the destructive POST carries: delete, detachSegment or removeRollout. */
  readonly field: string;
  readonly hiddenInputs?: string;
}

/**
 * A destructive action behind a confirmation: the trigger replaces the old one-click button and the dialog
 * holds the real submit. Without scripting the trigger stays hidden and the dialog is an ordinary inline
 * card, so the action is still one submit away and no control is stranded behind a dialog that never opens.
 */
export const renderConfirmation = (
  { id, title, prompt, triggerLabel, confirmLabel, field, hiddenInputs = '' }: Confirmation,
  form: WriteFormContext,
): string => {
  const body = `<form method="post" action="${escapeHtml(form.action)}">${form.baseVersionInput}${form.stateInputs}${hiddenInputs}
<p>${prompt}</p>
<button type="submit" class="button-danger" name="field" value="${escapeHtml(field)}">${escapeHtml(confirmLabel)}</button>
</form>`;
  return `${renderDialogTrigger({ dialogId: id, label: triggerLabel })}
${renderModalDialog({ id, headingId: `${id}-heading`, title, body })}`;
};
