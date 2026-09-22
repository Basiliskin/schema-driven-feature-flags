import type { EnvironmentView } from '../../application/browse-environment.js';
import { filterFlags } from '../../application/filter-flags.js';
import type { PublishedSegmentsView } from '../../application/list-published-segments.js';
import type { PendingReview } from '../../application/review-pending-change-set.js';
import type { PendingChangeSet } from '../../domain/pending-change-set.js';
import { NO_URL_STATE, withUrlState, type DashboardUrlState } from '../url-state.js';
import { environmentPath, escapeHtml } from './escape.js';
import type { EditDraft } from './feature-edit-form.js';
import { renderPage, type Notice } from './layout.js';
import { NEW_FLAG_DIALOG_ID, NEW_FLAG_TITLE, renderNewFlagForm, type CreateDraft } from './new-flag-form.js';
import { renderDialogTrigger, renderModalDialog } from './modal-dialog.js';
import { renderReviewDialog, renderReviewTrigger } from './review-dialog.js';
import { renderSideMenu } from './side-menu.js';
import { renderUpdateWatch } from './update-watch.js';
import { renderSnapshotContents } from './snapshot-contents.js';
import { pendingInputs, stateInputs } from './state-fields.js';

export interface EnvironmentPageState {
  readonly notices?: readonly Notice[];
  readonly draft?: string;
  readonly editDraft?: EditDraft;
  readonly createDraft?: CreateDraft;
  /** Loaded by the route so the attach form can offer a picker; absent renders it as unreadable. */
  readonly publishedSegments?: PublishedSegmentsView;
  /** An edit was rejected because someone published first; the page offers to review what changed since. */
  /** `key` names the flag whose edit was rejected; absent when the rejected change was a pasted snapshot. */
  readonly conflict?: { readonly since: number; readonly key?: string };
  /** The query string this page was asked for; absent renders the page as if no query state were set. */
  readonly urlState?: DashboardUrlState;
  /** Edits staged but not yet published; every form on the page hands them back on submit. */
  readonly pending?: PendingChangeSet | undefined;
  /** How the staged edits differ from the version they started from; the Review Dialog is only offered with both this and `pending`. */
  readonly review?: PendingReview | undefined;
  /** Opens the Review Dialog on load, so the operator lands on what they just staged. */
  readonly reviewOpen?: boolean;
}

type PublishedView = Extract<EnvironmentView, { status: 'published' }>;

/** The publisher stamps these on every write, so the publish box leaves them out. */
const STAMPED_FIELDS: ReadonlySet<string> = new Set(['version', 'previousVersion', 'createdAt']);

const publishTemplate = (raw: Readonly<Record<string, unknown>>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(raw).filter(([field]) => !STAMPED_FIELDS.has(field))), null, 2);

/** New environments start on the newest schema so their first rules may already target segments. */
const FIRST_VERSION_SCHEMA_VERSION = 2;

const firstVersionTemplate = (environment: string): string =>
  publishTemplate({ schemaVersion: FIRST_VERSION_SCHEMA_VERSION, environment, createdBy: 'dashboard', reason: 'First version', features: {} });

const prefill = (view: EnvironmentView): string => {
  if (view.status === 'empty') return firstVersionTemplate(view.environment);
  const { current } = view;
  return current.status === 'available' && current.contents.status === 'valid' ? publishTemplate(current.contents.raw) : '';
};

// The filter itself is the input's own value, so only the rest of the state is carried in hidden fields.
const renderFilterForm = (environment: string, urlState: DashboardUrlState, pending: PendingChangeSet | undefined): string =>
  `<form class="flag-filter-form" method="get" action="${escapeHtml(environmentPath(environment))}">${stateInputs({ ...urlState, filter: '' })}${pendingInputs(pending)}<input type="search" class="flag-filter" data-filter="flag-list" name="filter" value="${escapeHtml(urlState.filter)}" placeholder="Filter flags…" aria-label="Filter flags by key, type or on/off"><button type="submit" class="button-secondary">Filter</button></form>`;

// A single shared overlay: the page script moves the clicked flag's own `.flag-panel` node in here (and back
// out on close), rather than re-rendering it, so the confirmation dialogs and rollout forms nested inside
// keep their one set of ids instead of existing twice on the page. Without JS the flag-name link falls back
// to its href and opens the full flag page instead.
const renderFlagDialog = (): string =>
  renderModalDialog({
    id: 'flag-dialog',
    headingId: 'flag-dialog-heading',
    title: 'Flag',
    body: '<div id="flag-dialog-body"></div>',
  });

const renderFlags = (view: PublishedView, state: EnvironmentPageState): string => {
  const { current } = view;
  if (current.status !== 'available') return '';
  const { editDraft, createDraft } = state;
  const urlState = state.urlState ?? NO_URL_STATE;
  const { contents } = current;
  const context = {
    environment: view.environment,
    baseVersion: state.pending?.baseVersion ?? view.currentVersion,
    urlState,
    pending: state.pending,
    publishedSegments: state.publishedSegments ?? { status: 'unavailable' as const },
  };
  // The filter is applied here rather than inside the shared renderer, which the single-version page reuses unfiltered.
  const matching = contents.status === 'valid' ? filterFlags(contents.flags, urlState.filter) : [];
  const noMatch = contents.status === 'valid' && contents.flags.length > 0 && matching.length === 0;
  const editable = { ...context, ...(editDraft === undefined ? {} : { draft: editDraft }) };
  const flags = noMatch
    ? '<ul class="flag-list"></ul>'
    : renderSnapshotContents(contents.status === 'valid' ? { ...contents, flags: matching } : contents, editable);
  const creatable = contents.status === 'valid';
  const newFlag = creatable ? `\n${renderNewFlagForm({ ...context, ...(createDraft === undefined ? {} : { draft: createDraft }) })}` : '';
  const newFlagTrigger = creatable ? renderDialogTrigger({ dialogId: NEW_FLAG_DIALOG_ID, label: NEW_FLAG_TITLE }) : '';
  const reviewable = state.pending !== undefined && state.review !== undefined;
  const reviewTrigger = reviewable ? renderReviewTrigger() : '';
  const reviewDialog = reviewable
    ? `\n${renderReviewDialog({ environment: view.environment, urlState, pending: state.pending, review: state.review, openOnLoad: state.reviewOpen === true })}`
    : '';
  const filterable = contents.status === 'valid' && contents.flags.length > 0;
  const filter = filterable ? renderFilterForm(view.environment, urlState, state.pending) : '';
  // The message stays in the markup while rows match, because the in-browser instant filter reveals it without a reload.
  const noMatchMessage = filterable ? `\n<p class="muted" data-filter-empty${noMatch ? '' : ' hidden'}>No flags match.</p>` : '';
  const flagDialog = filterable ? `\n${renderFlagDialog()}` : '';
  return `<section class="section" aria-labelledby="flags-heading">
<div class="section-head"><h2 id="flags-heading">Flags</h2>${filter}${reviewTrigger}${newFlagTrigger}</div>
<div class="stack">
${flags}${noMatchMessage}${newFlag}${reviewDialog}${flagDialog}
</div>
</section>`;
};

// Opens on load when a publish was rejected, so the operator lands back on their draft; on a conflict
// the review dialog opens first and offers to return to this draft from there.
const renderPublishDialog = (view: EnvironmentView, state: EnvironmentPageState, urlState: DashboardUrlState): string =>
  renderModalDialog({
    id: 'publish-dialog',
    headingId: 'publish-heading',
    title: 'Publish a new version',
    openOnLoad: state.draft !== undefined && state.conflict === undefined,
    body: `<p class="muted">Starts from the current snapshot. <code>version</code>, <code>previousVersion</code> and <code>createdAt</code> are set when you publish.</p>
<form method="post" action="${escapeHtml(withUrlState(`${environmentPath(view.environment)}/publish`, urlState))}" class="stack">
${stateInputs(urlState)}${pendingInputs(state.pending)}${view.status === 'published' ? `<input type="hidden" name="baseVersion" value="${String(view.currentVersion)}">\n` : ''}<label for="snapshot">Snapshot JSON</label>
<textarea id="snapshot" name="snapshot" rows="16" required spellcheck="false">${escapeHtml(state.draft ?? prefill(view))}</textarea>
<div class="actions"><button type="submit">Publish</button></div>
</form>`,
  });

const renderPublished = (view: PublishedView, state: EnvironmentPageState): string =>
  `${renderUpdateWatch(view.environment, view.currentVersion, state.conflict)}
${renderFlags(view, state)}`;

export const renderEnvironmentPage = (view: EnvironmentView, state: EnvironmentPageState = {}): string => {
  const urlState = state.urlState ?? NO_URL_STATE;
  const summary =
    view.status === 'empty'
      ? '<section class="card card-current"><p>Nothing has been published to this environment yet.</p></section>'
      : renderPublished(view, state);
  return renderPage(
    view.environment,
    `${summary}
${renderPublishDialog(view, state, urlState)}`,
    state.notices,
    renderSideMenu(view.environment, 'flags', urlState),
    renderDialogTrigger({ dialogId: 'publish-dialog', label: 'Publish new version' }),
  );
};
