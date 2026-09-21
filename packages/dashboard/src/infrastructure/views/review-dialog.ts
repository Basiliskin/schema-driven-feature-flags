import type { PendingReview } from '../../application/review-pending-change-set.js';
import type { PendingChangeSet } from '../../domain/pending-change-set.js';
import { diffFlags, type FieldChange, type FlagChange } from '../../domain/snapshot-diff.js';
import { withUrlState, type DashboardUrlState } from '../url-state.js';
import { environmentPath, escapeHtml } from './escape.js';
import { renderDialogTrigger, renderModalDialog } from './modal-dialog.js';
import { pendingInputs, stateInputs } from './state-fields.js';

export const REVIEW_DIALOG_ID = 'review-dialog';
export const REVIEW_TITLE = 'Review pending changes';

export const REVIEW_ACTIONS = { update: 'update', publishAnyway: 'publishAnyway', discard: 'discard' } as const;

export interface ReviewContext {
  readonly environment: string;
  readonly urlState: DashboardUrlState;
  readonly pending: PendingChangeSet;
  readonly review: PendingReview;
  readonly openOnLoad: boolean;
}

const json = (value: unknown): string =>
  value === undefined ? '<span class="muted">—</span>' : `<code>${escapeHtml(JSON.stringify(value))}</code>`;

const renderField = (change: FieldChange): string =>
  `<tr><th scope="row">${change.field}</th><td class="diff-before">${json(change.before)}</td><td class="diff-after">${json(change.after)}</td></tr>`;

const renderChange = (change: FlagChange): string => {
  const head = `<div class="card-head"><span class="flag-key">${escapeHtml(change.key)}</span><span class="badge diff-${change.kind}">${change.kind}</span></div>`;
  if (change.kind !== 'changed') return `<li>${head}</li>`;
  return `<li>${head}
<div class="table-wrap"><table class="diff-table"><thead><tr><th>Field</th><th>Published</th><th>Staged</th></tr></thead><tbody>${change.fields.map(renderField).join('')}</tbody></table></div></li>`;
};

const renderChanges = (review: PendingReview, baseVersion: number): string => {
  if (review.baseFlags === undefined || review.stagedFlags === undefined) {
    return `<p>Your staged snapshot or version ${String(baseVersion)} can’t be read, so the flags can’t be compared one by one.</p>`;
  }
  const changes = diffFlags(review.baseFlags, review.stagedFlags);
  if (changes.length === 0) return `<p class="muted">Your staged changes leave every flag as it was in version ${String(baseVersion)}.</p>`;
  return `<ul class="change-list">\n${changes.map(renderChange).join('\n')}\n</ul>`;
};

const renderDrift = (drifted: boolean, baseVersion: number): string =>
  drifted
    ? `<p class="notice warning" data-version-drift>This environment has moved on since version ${String(baseVersion)}, where your changes started. Publishing anyway replaces whatever was published since with your snapshot.</p>\n`
    : '';

const renderPublish = (drifted: boolean): string =>
  drifted
    ? `<button type="submit" name="field" value="${REVIEW_ACTIONS.publishAnyway}">Publish anyway</button>`
    : `<button type="submit" name="field" value="${REVIEW_ACTIONS.update}">Update</button>`;

/**
 * The staged edits as a net diff against the version they started from, with Update and Discard as plain
 * form submits, so the dialog is an ordinary inline card when scripting is unavailable. Drift is a warning
 * beside a still-working publish button, never a block.
 */
export const renderReviewDialog = ({ environment, urlState, pending, review, openOnLoad }: ReviewContext): string => {
  const action = withUrlState(`${environmentPath(environment)}/pending`, urlState);
  return renderModalDialog({
    id: REVIEW_DIALOG_ID,
    headingId: 'review-heading',
    title: REVIEW_TITLE,
    openOnLoad,
    body: `${renderDrift(review.drifted, pending.baseVersion)}<form method="post" action="${escapeHtml(action)}" class="stack">
${stateInputs(urlState)}${pendingInputs(pending)}
${renderChanges(review, pending.baseVersion)}
<div class="actions">${renderPublish(review.drifted)}<button type="submit" class="button-secondary" name="field" value="${REVIEW_ACTIONS.discard}">Discard</button></div>
</form>`,
  });
};

export const renderReviewTrigger = (): string => renderDialogTrigger({ dialogId: REVIEW_DIALOG_ID, label: REVIEW_TITLE });
