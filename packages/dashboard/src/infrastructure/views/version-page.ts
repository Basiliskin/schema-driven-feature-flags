import type { SnapshotVersionView } from '../../application/browse-environment.js';
import { environmentPath, escapeHtml } from './escape.js';
import { renderPage, renderRawJson, renderTimestamp } from './layout.js';
import { renderSnapshotContents } from './snapshot-contents.js';

const renderAvailable = (view: Extract<SnapshotVersionView, { status: 'available' }>): string => {
  const { contents } = view;
  if (contents.status === 'invalid') return renderSnapshotContents(contents);
  const { metadata } = contents;
  return `<section class="card">
<p class="muted">${escapeHtml(metadata.createdBy)} · ${renderTimestamp(metadata.createdAt)}</p>
${metadata.reason === '' ? '' : `<p>${escapeHtml(metadata.reason)}</p>\n`}${renderRawJson('version-json', contents.raw)}
</section>
<section class="section">
${renderSnapshotContents(contents)}
</section>`;
};

export const renderVersionPage = (view: SnapshotVersionView): string => {
  const heading = `${view.environment} · version ${String(view.version)}`;
  const contents =
    view.status === 'available'
      ? renderAvailable(view)
      : '<p>This version is not available in this environment.</p>';
  return renderPage(
    heading,
    `<p><a class="back-link" href="${escapeHtml(environmentPath(view.environment))}">Back to ${escapeHtml(view.environment)}</a></p>
<div class="page-head"><h1>${escapeHtml(heading)}</h1></div>
${contents}`,
  );
};
