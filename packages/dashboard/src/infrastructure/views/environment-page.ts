import type { EnvironmentView } from '../../application/browse-environment.js';
import { environmentPath, escapeHtml } from './escape.js';
import type { EditDraft } from './feature-edit-form.js';
import { renderPage, type Notice } from './layout.js';
import { renderSnapshotContents } from './snapshot-contents.js';

export interface EnvironmentPageState {
  readonly notices?: readonly Notice[];
  readonly draft?: string;
  readonly editDraft?: EditDraft;
}

const ROLLBACK_NOTE = `<p><strong>About rollback:</strong> after a rollback, versions newer than the current one stay in the bucket but are hidden from this list, and the next publish fails with “version exists”. To publish again, delete or move those newer <code>snapshots/&lt;n&gt;.json</code> files in the bucket by hand, then publish.</p>`;

const renderVersions = (view: Extract<EnvironmentView, { status: 'published' }>): string => {
  const base = environmentPath(view.environment);
  const items = view.versions
    .map((version) => {
      const link = `<a href="${escapeHtml(`${base}/versions/${String(version)}`)}">Version ${String(version)}</a>`;
      if (version === view.currentVersion) return `<li>${link} (current)</li>`;
      return `<li>${link}
<form method="post" action="${escapeHtml(`${base}/rollback`)}" style="display:inline">
<input type="hidden" name="version" value="${String(version)}">
<button type="submit">Roll back to ${String(version)}</button>
</form></li>`;
    })
    .join('\n');
  return `<h2>Versions</h2>
<ul>
${items}
</ul>`;
};

const renderCurrent = (
  view: Extract<EnvironmentView, { status: 'published' }>,
  editDraft: EditDraft | undefined,
): string => {
  const contents =
    view.current.status === 'available'
      ? renderSnapshotContents(view.current.contents, {
          environment: view.environment,
          baseVersion: view.currentVersion,
          ...(editDraft === undefined ? {} : { draft: editDraft }),
        })
      : '<p>The current version’s snapshot file is not available.</p>';
  return `<h2>Current flags (version ${String(view.currentVersion)})</h2>
${contents}`;
};

export const renderEnvironmentPage = (view: EnvironmentView, state: EnvironmentPageState = {}): string => {
  const summary =
    view.status === 'empty'
      ? '<p>Nothing has been published to this environment yet.</p>'
      : `${renderCurrent(view, state.editDraft)}\n${renderVersions(view)}`;
  return renderPage(
    view.environment,
    `<h1>Environment ${escapeHtml(view.environment)}</h1>
${summary}
${ROLLBACK_NOTE}
<h2>Publish a new version</h2>
<form method="post" action="${escapeHtml(`${environmentPath(view.environment)}/publish`)}">
<label for="snapshot">Snapshot JSON</label>
<textarea id="snapshot" name="snapshot" rows="16" required>${escapeHtml(state.draft ?? '')}</textarea>
<button type="submit">Publish</button>
</form>`,
    state.notices,
  );
};
