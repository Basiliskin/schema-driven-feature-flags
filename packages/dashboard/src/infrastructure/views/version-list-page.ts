import type { VersionEntry } from '../../application/browse-environment.js';
import type { VersionPage } from '../../application/list-version-page.js';
import { environmentPath, escapeHtml } from './escape.js';
import { renderPage, renderTimestamp } from './layout.js';

/** What a version entry needs to know about the environment it belongs to, so both pages render the same item. */
export interface VersionListContext {
  readonly environment: string;
  readonly currentVersion: number;
}

export const versionsPath = (environment: string, page = 1): string =>
  `${environmentPath(environment)}/versions${page > 1 ? `?page=${String(page)}` : ''}`;

export const renderVersionItem = (context: VersionListContext, entry: VersionEntry): string => {
  const base = environmentPath(context.environment);
  const label = String(entry.version);
  const isCurrent = entry.version === context.currentVersion;
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

const renderPager = (view: VersionPage): string => {
  const links = [
    ...(view.hasNewer
      ? [`<a href="${escapeHtml(versionsPath(view.environment, view.page - 1))}">Newer versions</a>`]
      : []),
    ...(view.hasOlder
      ? [`<a href="${escapeHtml(versionsPath(view.environment, view.page + 1))}">Older versions</a>`]
      : []),
  ];
  return links.length === 0 ? '' : `\n<nav class="actions" aria-label="More version history">${links.join('')}</nav>`;
};

const renderEntries = (view: VersionPage): string => {
  if (view.entries.length === 0) {
    return `<p class="muted">There is no version history on this page. This environment has ${String(view.totalVersions)} ${view.totalVersions === 1 ? 'version' : 'versions'}.</p>`;
  }
  const context = { environment: view.environment, currentVersion: view.totalVersions };
  return `<ol class="timeline" reversed>
${view.entries.map((entry) => renderVersionItem(context, entry)).join('\n')}
</ol>`;
};

export const renderVersionListPage = (view: VersionPage): string => {
  const heading = `${view.environment} · version history`;
  return renderPage(
    heading,
    `<p><a class="back-link" href="${escapeHtml(environmentPath(view.environment))}">Back to ${escapeHtml(view.environment)}</a></p>
<div class="page-head"><h1>${escapeHtml(heading)}</h1></div>
<p class="muted">Newest first, ${String(view.pageSize)} per page. Restoring a version publishes its contents as a new version.</p>
${renderEntries(view)}${renderPager(view)}`,
  );
};
