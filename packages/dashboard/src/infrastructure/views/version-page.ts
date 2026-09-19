import type { SnapshotVersionView } from '../../application/browse-environment.js';
import { environmentPath, escapeHtml } from './escape.js';
import { renderPage } from './layout.js';
import { renderSnapshotContents } from './snapshot-contents.js';

export const renderVersionPage = (view: SnapshotVersionView): string => {
  const heading = `${view.environment} · version ${String(view.version)}`;
  const contents =
    view.status === 'available'
      ? renderSnapshotContents(view.contents)
      : '<p>This version is not available in this environment.</p>';
  return renderPage(
    heading,
    `<p><a href="${escapeHtml(environmentPath(view.environment))}">Back to ${escapeHtml(view.environment)}</a></p>
<h1>${escapeHtml(heading)}</h1>
${contents}`,
  );
};
