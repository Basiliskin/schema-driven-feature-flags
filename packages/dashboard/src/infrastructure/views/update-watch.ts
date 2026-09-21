import { environmentPath, escapeHtml } from './escape.js';
import { renderModalDialog } from './modal-dialog.js';

/** What the operator's page was based on when a write was rejected, so the banner can name the drift. */
export interface UpdateConflict {
  readonly since: number;
  readonly key?: string;
}

/**
 * Filled in by the page script when a newer version shows up; hidden until then and without JavaScript.
 * Rendered on every environment-scoped view so navigating away from the flag list does not stop the
 * operator from learning that someone else published.
 */
export const renderUpdateWatch = (environment: string, currentVersion: number, conflict?: UpdateConflict): string => {
  const review =
    conflict === undefined
      ? ''
      : ` data-review-since="${String(conflict.since)}"${conflict.key === undefined ? '' : ` data-review-key="${escapeHtml(conflict.key)}"`}`;
  const message =
    conflict === undefined
      ? 'Someone published version <strong data-latest-version></strong> after you opened this page.'
      : `${conflict.key === undefined ? 'Your snapshot draft was based on' : `Your edit to <code>${escapeHtml(conflict.key)}</code> was made on`} version ${String(conflict.since)}; the page now shows version <strong data-latest-version>${String(currentVersion)}</strong>.`;
  return `<div data-watch-version="${String(currentVersion)}" data-watch-path="${escapeHtml(environmentPath(environment))}"${review} hidden></div>
<div id="update-banner" class="update-banner" role="status"${conflict === undefined ? ' hidden' : ''}>
<p>${message}</p>
<button type="button" data-review-changes>Review changes</button>
</div>
<div id="merge-notice" class="notice warning" role="status" hidden><p></p></div>
${renderModalDialog({
    id: 'changes-dialog',
    headingId: 'changes-heading',
    title: 'What changed',
    body: '<div id="changes-body"></div>',
  })}`;
};
