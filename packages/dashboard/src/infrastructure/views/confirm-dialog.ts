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

export interface ConfirmationParts {
  readonly trigger: string;
  readonly dialog: string;
}

/**
 * The trigger and the dialog it opens, built separately so a caller that needs the trigger somewhere other
 * than right next to the dialog markup — e.g. a header row that gathers several rows' actions together —
 * can place each half where it belongs. `renderConfirmation` below is the common case, which just joins them.
 */
export const renderConfirmationParts = (
  { id, title, prompt, triggerLabel, confirmLabel, field, hiddenInputs = '' }: Confirmation,
  form: WriteFormContext,
): ConfirmationParts => {
  const body = `<form method="post" action="${escapeHtml(form.action)}">${form.baseVersionInput}${form.stateInputs}${form.pendingInputs}${hiddenInputs}
<p>${prompt}</p>
<button type="submit" class="button-danger" name="field" value="${escapeHtml(field)}">${escapeHtml(confirmLabel)}</button>
</form>`;
  return {
    trigger: renderDialogTrigger({ dialogId: id, label: triggerLabel }),
    dialog: renderModalDialog({ id, headingId: `${id}-heading`, title, body }),
  };
};

/**
 * A destructive action behind a confirmation: the trigger replaces the old one-click button and the dialog
 * holds the real submit. Without scripting the trigger stays hidden and the dialog is an ordinary inline
 * card, so the action is still one submit away and no control is stranded behind a dialog that never opens.
 */
export const renderConfirmation = (confirmation: Confirmation, form: WriteFormContext): string => {
  const { trigger, dialog } = renderConfirmationParts(confirmation, form);
  return `${trigger}\n${dialog}`;
};
