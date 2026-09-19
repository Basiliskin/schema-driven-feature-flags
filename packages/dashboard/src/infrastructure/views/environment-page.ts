import type { EnvironmentView, SnapshotMetadata, VersionEntry } from '../../application/browse-environment.js';
import { environmentPath, escapeHtml } from './escape.js';
import type { EditDraft } from './feature-edit-form.js';
import { renderPage, renderRawJson, renderTimestamp, type Notice } from './layout.js';
import { renderNewFlagForm, type CreateDraft } from './new-flag-form.js';
import { renderSnapshotContents } from './snapshot-contents.js';

export interface EnvironmentPageState {
  readonly notices?: readonly Notice[];
  readonly draft?: string;
  readonly editDraft?: EditDraft;
  readonly createDraft?: CreateDraft;
}

type PublishedView = Extract<EnvironmentView, { status: 'published' }>;

/** The publisher stamps these on every write, so the publish box leaves them out. */
const STAMPED_FIELDS: ReadonlySet<string> = new Set(['version', 'previousVersion', 'createdAt']);

const publishTemplate = (raw: Readonly<Record<string, unknown>>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(raw).filter(([field]) => !STAMPED_FIELDS.has(field))), null, 2);

const firstVersionTemplate = (environment: string): string =>
  publishTemplate({ schemaVersion: 1, environment, createdBy: 'dashboard', reason: 'First version', features: {} });

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
  const context = { environment: view.environment, baseVersion: view.currentVersion };
  const flags = renderSnapshotContents(current.contents, {
    ...context,
    ...(editDraft === undefined ? {} : { draft: editDraft }),
  });
  const newFlag =
    current.contents.status === 'valid'
      ? `\n${renderNewFlagForm({ ...context, ...(createDraft === undefined ? {} : { draft: createDraft }) })}`
      : '';
  return `<section class="section" aria-labelledby="flags-heading">
<div class="section-head"><h2 id="flags-heading">Flags</h2></div>
<div class="stack">
${flags}${newFlag}
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

const renderPublishForm = (view: EnvironmentView, draft: string | undefined): string => `<section class="section card" aria-labelledby="publish-heading">
<h2 id="publish-heading">Publish a new version</h2>
<p class="muted">Starts from the current snapshot. <code>version</code>, <code>previousVersion</code> and <code>createdAt</code> are set when you publish.</p>
<form method="post" action="${escapeHtml(`${environmentPath(view.environment)}/publish`)}" class="stack">
<label for="snapshot">Snapshot JSON</label>
<textarea id="snapshot" name="snapshot" rows="16" required spellcheck="false">${escapeHtml(draft ?? prefill(view))}</textarea>
<div class="actions"><button type="submit">Publish</button></div>
</form>
</section>`;

export const renderEnvironmentPage = (view: EnvironmentView, state: EnvironmentPageState = {}): string => {
  const summary =
    view.status === 'empty'
      ? '<section class="card card-current"><p>Nothing has been published to this environment yet.</p></section>'
      : `${renderCurrentCard(view)}\n${renderFlags(view, state)}\n${renderVersions(view)}`;
  return renderPage(
    view.environment,
    `<div class="page-head"><p class="eyebrow">Environment</p><h1>Environment ${escapeHtml(view.environment)}</h1></div>
${summary}
${renderPublishForm(view, state.draft)}`,
    state.notices,
  );
};
