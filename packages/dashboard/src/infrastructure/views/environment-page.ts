import type { EnvironmentView, SnapshotMetadata } from '../../application/browse-environment.js';
import { filterFlags } from '../../application/filter-flags.js';
import type { PublishedSegmentsView } from '../../application/list-published-segments.js';
import { NO_URL_STATE, withUrlState, type DashboardUrlState } from '../url-state.js';
import { environmentPath, escapeHtml } from './escape.js';
import type { EditDraft } from './feature-edit-form.js';
import { renderPage, renderRawJson, renderTimestamp, type Notice } from './layout.js';
import { renderNewFlagForm, type CreateDraft } from './new-flag-form.js';
import { CURRENT_SECTION, FLAGS_SECTION, VERSIONS_SECTION, renderSectionNav, type SectionLink } from './section-nav.js';
import { segmentListPath } from './segment-list-page.js';
import { renderSnapshotContents } from './snapshot-contents.js';
import { stateInputs } from './state-fields.js';
import { renderVersionItem, versionsPath } from './version-list-page.js';

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

const renderMetadata = (metadata: SnapshotMetadata): string => `<dl class="meta">
<div><dt>Created by</dt><dd>${escapeHtml(metadata.createdBy)}</dd></div>
<div><dt>Created</dt><dd>${renderTimestamp(metadata.createdAt)}</dd></div>
<div><dt>Reason</dt><dd>${metadata.reason === '' ? '<span class="muted">—</span>' : escapeHtml(metadata.reason)}</dd></div>
</dl>`;

const renderCurrentCard = (view: PublishedView): string => {
  const { current } = view;
  const heading = `<h2 id="current-heading">Current snapshot · v${String(view.currentVersion)}</h2>`;
  if (current.status !== 'available') {
    return `<section class="card card-current" aria-labelledby="current-heading">
<div class="card-head">${heading}</div>
<p>The current version’s snapshot file is not available.</p>
</section>`;
  }
  const { contents } = current;
  const summary =
    contents.status === 'valid'
      ? `<span class="badge">${String(contents.flags.length)} ${contents.flags.length === 1 ? 'flag' : 'flags'}</span>`
      : '<span class="badge">invalid</span>';
  const details =
    contents.status === 'valid'
      ? `${renderMetadata(contents.metadata)}\n${renderRawJson('current-json', contents.raw)}`
      : '<p>The current snapshot is not valid, so its flags can’t be edited here. Publish a fixed version below.</p>';
  return `<section class="card card-current" aria-labelledby="current-heading">
<div class="card-head">${heading}${summary}</div>
${details}
</section>`;
};

// The filter itself is the input's own value, so only the rest of the state is carried in hidden fields.
const renderFilterForm = (environment: string, urlState: DashboardUrlState): string =>
  `<form class="flag-filter-form" method="get" action="${escapeHtml(environmentPath(environment))}">${stateInputs({ ...urlState, filter: '' })}<input type="search" class="flag-filter" data-filter="flag-list" name="filter" value="${escapeHtml(urlState.filter)}" placeholder="Filter flags…" aria-label="Filter flags by key, type or on/off"><button type="submit" class="button-secondary">Filter</button></form>`;

const renderFlags = (view: PublishedView, state: EnvironmentPageState): string => {
  const { current } = view;
  if (current.status !== 'available') return '';
  const { editDraft, createDraft } = state;
  const urlState = state.urlState ?? NO_URL_STATE;
  const { contents } = current;
  const context = {
    environment: view.environment,
    baseVersion: view.currentVersion,
    urlState,
    publishedSegments: state.publishedSegments ?? { status: 'unavailable' as const },
  };
  // The filter is applied here rather than inside the shared renderer, which the single-version page reuses unfiltered.
  const matching = contents.status === 'valid' ? filterFlags(contents.flags, urlState.filter) : [];
  const noMatch = contents.status === 'valid' && contents.flags.length > 0 && matching.length === 0;
  const editable = { ...context, ...(editDraft === undefined ? {} : { draft: editDraft }) };
  const flags = noMatch
    ? '<ul class="flag-list"></ul>'
    : renderSnapshotContents(contents.status === 'valid' ? { ...contents, flags: matching } : contents, editable, urlState);
  const newFlag = contents.status === 'valid' ? `\n${renderNewFlagForm({ ...context, ...(createDraft === undefined ? {} : { draft: createDraft }) })}` : '';
  const filterable = contents.status === 'valid' && contents.flags.length > 0;
  const filter = filterable ? renderFilterForm(view.environment, urlState) : '';
  // The message stays in the markup while rows match, because the in-browser instant filter reveals it without a reload.
  const noMatchMessage = filterable ? `\n<p class="muted" data-filter-empty${noMatch ? '' : ' hidden'}>No flags match.</p>` : '';
  return `<section class="section" aria-labelledby="flags-heading">
<div class="section-head"><h2 id="flags-heading">Flags</h2>${filter}</div>
<div class="stack">
${flags}${noMatchMessage}${newFlag}
</div>
</section>`;
};

const renderVersions = (view: PublishedView, urlState: DashboardUrlState): string => `<section class="section" aria-labelledby="versions-heading">
<div class="section-head"><h2 id="versions-heading">Version history</h2><a href="${escapeHtml(versionsPath(view.environment))}">View all versions</a></div>
<ol class="timeline" reversed>
${[...view.versions]
  .reverse()
  .map((entry) => renderVersionItem({ ...view, urlState }, entry))
  .join('\n')}
</ol>
</section>`;

// A modal dialog keeps the raw-JSON editor out of the way until it is asked for. It opens on load when
// a publish was rejected, so the operator lands back on their draft; without JavaScript it renders inline.
// On a conflict the review dialog opens first, and offers to return to this draft from there.
const renderPublishDialog = (view: EnvironmentView, state: EnvironmentPageState, urlState: DashboardUrlState): string => `<dialog id="publish-dialog" class="publish-dialog" aria-labelledby="publish-heading"${state.draft === undefined || state.conflict !== undefined ? '' : ' data-open-on-load'}>
<div class="dialog-head"><h2 id="publish-heading">Publish a new version</h2>
<form method="dialog"><button type="submit" class="button-secondary" aria-label="Close">Close</button></form></div>
<p class="muted">Starts from the current snapshot. <code>version</code>, <code>previousVersion</code> and <code>createdAt</code> are set when you publish.</p>
<form method="post" action="${escapeHtml(withUrlState(`${environmentPath(view.environment)}/publish`, urlState))}" class="stack">
${stateInputs(urlState)}${view.status === 'published' ? `<input type="hidden" name="baseVersion" value="${String(view.currentVersion)}">\n` : ''}<label for="snapshot">Snapshot JSON</label>
<textarea id="snapshot" name="snapshot" rows="16" required spellcheck="false">${escapeHtml(state.draft ?? prefill(view))}</textarea>
<div class="actions"><button type="submit">Publish</button></div>
</form>
</dialog>`;

// Filled in by the page script when a newer version shows up; hidden until then and without JavaScript.
const renderUpdateWatch = (view: PublishedView, conflict: EnvironmentPageState['conflict']): string => {
  const review =
    conflict === undefined
      ? ''
      : ` data-review-since="${String(conflict.since)}"${conflict.key === undefined ? '' : ` data-review-key="${escapeHtml(conflict.key)}"`}`;
  const message =
    conflict === undefined
      ? 'Someone published version <strong data-latest-version></strong> after you opened this page.'
      : `${conflict.key === undefined ? 'Your snapshot draft was based on' : `Your edit to <code>${escapeHtml(conflict.key)}</code> was made on`} version ${String(conflict.since)}; the page now shows version <strong data-latest-version>${String(view.currentVersion)}</strong>.`;
  return `<div data-watch-version="${String(view.currentVersion)}" data-watch-path="${escapeHtml(environmentPath(view.environment))}"${review} hidden></div>
<div id="update-banner" class="update-banner" role="status"${conflict === undefined ? ' hidden' : ''}>
<p>${message}</p>
<button type="button" data-review-changes>Review changes</button>
</div>
<div id="merge-notice" class="notice warning" role="status" hidden><p></p></div>
<dialog id="changes-dialog" class="publish-dialog" aria-labelledby="changes-heading">
<div class="dialog-head"><h2 id="changes-heading">What changed</h2>
<form method="dialog"><button type="submit" class="button-secondary">Close</button></form></div>
<div id="changes-body"></div>
</dialog>`;
};

// The nav only offers sections the page actually rendered, so a link never points at a missing anchor.
const renderPublished = (view: PublishedView, state: EnvironmentPageState, urlState: DashboardUrlState): string => {
  const flags = renderFlags(view, state);
  const sections: SectionLink[] = [CURRENT_SECTION, ...(flags === '' ? [] : [FLAGS_SECTION]), VERSIONS_SECTION];
  return `${renderUpdateWatch(view, state.conflict)}
${renderSectionNav(view.environment, urlState, sections)}
${renderCurrentCard(view)}
${flags}
${renderVersions(view, urlState)}`;
};

export const renderEnvironmentPage = (view: EnvironmentView, state: EnvironmentPageState = {}): string => {
  const urlState = state.urlState ?? NO_URL_STATE;
  const summary =
    view.status === 'empty'
      ? '<section class="card card-current"><p>Nothing has been published to this environment yet.</p></section>'
      : renderPublished(view, state, urlState);
  return renderPage(
    view.environment,
    `<div class="page-head page-head-actions"><div><p class="eyebrow">Environment</p><h1>Environment ${escapeHtml(view.environment)}</h1></div>
<a href="${escapeHtml(segmentListPath(view.environment))}">Segments</a>
<button type="button" data-open-dialog="publish-dialog" hidden>Publish new version</button></div>
${summary}
${renderPublishDialog(view, state, urlState)}`,
    state.notices,
  );
};
