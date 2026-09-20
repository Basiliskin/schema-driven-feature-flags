import type { EnvironmentView, SnapshotMetadata, VersionEntry } from '../../application/browse-environment.js';
import { environmentPath, escapeHtml } from './escape.js';
import type { EditDraft } from './feature-edit-form.js';
import { renderPage, renderRawJson, renderTimestamp, type Notice } from './layout.js';
import { renderNewFlagForm, type CreateDraft } from './new-flag-form.js';
import { segmentListPath } from './segment-list-page.js';
import { renderSnapshotContents } from './snapshot-contents.js';

export interface EnvironmentPageState {
  readonly notices?: readonly Notice[];
  readonly draft?: string;
  readonly editDraft?: EditDraft;
  readonly createDraft?: CreateDraft;
  /** An edit was rejected because someone published first; the page offers to review what changed since. */
  /** `key` names the flag whose edit was rejected; absent when the rejected change was a pasted snapshot. */
  readonly conflict?: { readonly since: number; readonly key?: string };
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

const renderFlags = (view: PublishedView, state: EnvironmentPageState): string => {
  const { current } = view;
  if (current.status !== 'available') return '';
  const { editDraft, createDraft } = state;
  const context = {
    environment: view.environment,
    baseVersion: view.currentVersion,
    segmentKeys: current.contents.status === 'valid' ? current.contents.segmentKeys : [],
  };
  const flags = renderSnapshotContents(current.contents, {
    ...context,
    ...(editDraft === undefined ? {} : { draft: editDraft }),
  });
  const newFlag =
    current.contents.status === 'valid'
      ? `\n${renderNewFlagForm({ ...context, ...(createDraft === undefined ? {} : { draft: createDraft }) })}`
      : '';
  // Revealed by the page script; without JavaScript every flag simply stays listed.
  const filter =
    current.contents.status === 'valid' && current.contents.flags.length > 0
      ? `<input type="search" class="flag-filter" data-filter="flag-list" placeholder="Filter flags…" aria-label="Filter flags by key, type or on/off" hidden>`
      : '';
  return `<section class="section" aria-labelledby="flags-heading">
<div class="section-head"><h2 id="flags-heading">Flags</h2>${filter}</div>
<div class="stack">
${flags}
<p class="muted" data-filter-empty hidden>No flags match.</p>${newFlag}
</div>
</section>`;
};

const renderVersionItem = (view: PublishedView, entry: VersionEntry): string => {
  const base = environmentPath(view.environment);
  const label = String(entry.version);
  const isCurrent = entry.version === view.currentVersion;
  const link = `<a href="${escapeHtml(`${base}/versions/${label}`)}">Version ${label}</a>`;
  const action = isCurrent
    ? '<span class="badge badge-accent">current</span>'
    : `<form method="post" action="${escapeHtml(`${base}/rollback`)}">
<input type="hidden" name="version" value="${label}">
<button type="submit" class="button-secondary">Restore version ${label}</button>
</form>`;
  const about =
    entry.metadata === undefined
      ? '<p class="muted">Details unavailable.</p>'
      : `<p class="muted">${escapeHtml(entry.metadata.createdBy)} · ${renderTimestamp(entry.metadata.createdAt)}</p>${
          entry.metadata.reason === '' ? '' : `\n<p>${escapeHtml(entry.metadata.reason)}</p>`
        }`;
  return `<li${isCurrent ? ' class="is-current"' : ''}>
<div class="timeline-head">${link}${action}</div>
${about}
</li>`;
};

const renderVersions = (view: PublishedView): string => `<section class="section" aria-labelledby="versions-heading">
<div class="section-head"><h2 id="versions-heading">Version history</h2></div>
<ol class="timeline" reversed>
${[...view.versions]
  .reverse()
  .map((entry) => renderVersionItem(view, entry))
  .join('\n')}
</ol>
</section>`;

// A modal dialog keeps the raw-JSON editor out of the way until it is asked for. It opens on load when
// a publish was rejected, so the operator lands back on their draft; without JavaScript it renders inline.
// On a conflict the review dialog opens first, and offers to return to this draft from there.
const renderPublishDialog = (view: EnvironmentView, state: EnvironmentPageState): string => `<dialog id="publish-dialog" class="publish-dialog" aria-labelledby="publish-heading"${state.draft === undefined || state.conflict !== undefined ? '' : ' data-open-on-load'}>
<div class="dialog-head"><h2 id="publish-heading">Publish a new version</h2>
<form method="dialog"><button type="submit" class="button-secondary" aria-label="Close">Close</button></form></div>
<p class="muted">Starts from the current snapshot. <code>version</code>, <code>previousVersion</code> and <code>createdAt</code> are set when you publish.</p>
<form method="post" action="${escapeHtml(`${environmentPath(view.environment)}/publish`)}" class="stack">
${view.status === 'published' ? `<input type="hidden" name="baseVersion" value="${String(view.currentVersion)}">\n` : ''}<label for="snapshot">Snapshot JSON</label>
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

export const renderEnvironmentPage = (view: EnvironmentView, state: EnvironmentPageState = {}): string => {
  const summary =
    view.status === 'empty'
      ? '<section class="card card-current"><p>Nothing has been published to this environment yet.</p></section>'
      : `${renderUpdateWatch(view, state.conflict)}\n${renderCurrentCard(view)}\n${renderFlags(view, state)}\n${renderVersions(view)}`;
  return renderPage(
    view.environment,
    `<div class="page-head page-head-actions"><div><p class="eyebrow">Environment</p><h1>Environment ${escapeHtml(view.environment)}</h1></div>
<a href="${escapeHtml(segmentListPath(view.environment))}">Segments</a>
<button type="button" data-open-dialog="publish-dialog" hidden>Publish new version</button></div>
${summary}
${renderPublishDialog(view, state)}`,
    state.notices,
  );
};
