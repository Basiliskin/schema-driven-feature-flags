import { escapeHtml } from './escape.js';

export interface ModalDialog {
  readonly id: string;
  readonly headingId: string;
  readonly title: string;
  readonly body: string;
  /** Emitted as a bare attribute the page script tests for presence, so `false` must omit it entirely. */
  readonly openOnLoad?: boolean;
}

export interface DialogTrigger {
  readonly dialogId: string;
  readonly label: string;
}

/**
 * A <dialog> that renders as an ordinary inline card without JavaScript and as an overlay once the page
 * script marks it enhanced. The close control is only useful in the overlay, so the stylesheet hides it
 * until then.
 */
export const renderModalDialog = ({ id, headingId, title, body, openOnLoad = false }: ModalDialog): string =>
  `<dialog id="${escapeHtml(id)}" class="modal-dialog" aria-labelledby="${escapeHtml(headingId)}"${openOnLoad ? ' data-open-on-load' : ''}>
<div class="dialog-head"><h2 id="${escapeHtml(headingId)}">${escapeHtml(title)}</h2>
<form method="dialog"><button type="submit" class="button-secondary" aria-label="Close">Close</button></form></div>
${body}
</dialog>`;

/** Hidden until the page script confirms the dialog can be opened; without it the dialog is already inline. */
export const renderDialogTrigger = ({ dialogId, label }: DialogTrigger): string =>
  `<button type="button" data-open-dialog="${escapeHtml(dialogId)}" hidden>${escapeHtml(label)}</button>`;

const UNSAFE_IN_ID = /[^A-Za-z0-9-]/g;

/**
 * Builds a dialog id from the subject it confirms. The escape is injective and the `_` separator cannot
 * occur inside an escaped part, so two different subjects — flag keys with dots or slashes included —
 * can never collide on one id.
 */
export const dialogId = (...parts: readonly (string | number)[]): string =>
  parts
    .map((part) =>
      String(part).replace(UNSAFE_IN_ID, (char) => `_${char.charCodeAt(0).toString(16).padStart(4, '0')}`),
    )
    .join('_');
