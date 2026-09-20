import type { SegmentListRow } from '../../application/list-referenced-segments.js';
import { environmentPath, escapeHtml } from './escape.js';
import { renderPage } from './layout.js';
import { segmentPath } from './segment-page.js';

export interface SegmentListPageView {
  readonly environment: string;
  readonly rows: readonly SegmentListRow[];
}

export const segmentListPath = (environment: string): string => `${environmentPath(environment)}/segments`;

const renderState = (row: SegmentListRow): string => {
  switch (row.state) {
    case 'published':
      return `version ${String(row.version)}`;
    case 'not-published':
      return '<span class="muted">not published</span>';
    default:
      return '<span class="segment-unavailable">unavailable</span>';
  }
};

const renderRow = (environment: string, row: SegmentListRow): string => `<tr>
<td data-label="Segment"><a href="${escapeHtml(segmentPath(environment, row.key))}">${escapeHtml(row.key)}</a></td>
<td data-label="Current pointer">${renderState(row)}</td>
</tr>`;

const renderTable = (view: SegmentListPageView): string =>
  view.rows.length === 0
    ? '<p class="muted">No flag rule in the current snapshot references a segment.</p>'
    : `<div class="table-wrap">
<table class="flag-table">
<thead><tr><th scope="col">Segment</th><th scope="col">Current pointer</th></tr></thead>
<tbody>
${view.rows.map((row) => renderRow(view.environment, row)).join('\n')}
</tbody>
</table>
</div>`;

export const renderSegmentListPage = (view: SegmentListPageView): string => {
  const heading = `${view.environment} · segments`;
  return renderPage(
    heading,
    `<p><a class="back-link" href="${escapeHtml(environmentPath(view.environment))}">Back to ${escapeHtml(view.environment)}</a></p>
<div class="page-head"><h1>${escapeHtml(heading)}</h1></div>
<p class="muted">Every Segment Key the current snapshot’s rules reference, with the version its Segment Pointer names. Members are never listed here.</p>
${renderTable(view)}`,
  );
};
