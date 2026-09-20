import type { SegmentListRow } from '../../application/list-referenced-segments.js';
import { environmentPath, escapeHtml } from './escape.js';
import { renderPage, type Notice } from './layout.js';
import { segmentPath } from './segment-page.js';

export interface SegmentListPageView {
  readonly environment: string;
  readonly rows: readonly SegmentListRow[];
}

/** What the operator typed into the Create Segment form, echoed back when the submit was rejected. */
export interface SegmentDraft {
  readonly key: string;
  readonly memberAttribute: string;
}

export interface SegmentListPageState {
  readonly notices?: readonly Notice[];
  readonly draft?: SegmentDraft;
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

const DEFAULT_MEMBER_ATTRIBUTE = 'userId';

const renderCreateForm = (environment: string, draft: SegmentDraft | undefined): string => `<section class="card segment-create">
<h2>Create a segment</h2>
<p class="muted">A CSV with one row per person. The file is read in your browser and published as the first Segment Version; its rows are never shown back to you.</p>
<form method="post" action="${escapeHtml(segmentListPath(environment))}" class="stack" data-segment-upload>
<input type="hidden" name="csv" value="">
<label>Segment Key <input type="text" name="key" value="${escapeHtml(draft?.key ?? '')}" required autocomplete="off" autocapitalize="none" spellcheck="false"></label>
<label>Member attribute <input type="text" name="memberAttribute" value="${escapeHtml(draft?.memberAttribute ?? DEFAULT_MEMBER_ATTRIBUTE)}" required autocomplete="off" autocapitalize="none" spellcheck="false"></label>
<label>CSV file <input type="file" name="file" accept=".csv,text/csv" required data-segment-file></label>
<div class="actions"><button type="submit">Create segment</button></div>
</form>
<p class="muted">A new Segment Key stays out of the table above until some flag rule references it, so note the key down after creating it.</p>
</section>`;

export const renderSegmentListPage = (view: SegmentListPageView, state: SegmentListPageState = {}): string => {
  const heading = `${view.environment} · segments`;
  return renderPage(
    heading,
    `<p><a class="back-link" href="${escapeHtml(environmentPath(view.environment))}">Back to ${escapeHtml(view.environment)}</a></p>
<div class="page-head"><h1>${escapeHtml(heading)}</h1></div>
<p class="muted">Every Segment Key the current snapshot’s rules reference, with the version its Segment Pointer names. Members are never listed here.</p>
${renderTable(view)}
${renderCreateForm(view.environment, state.draft)}`,
    state.notices ?? [],
  );
};
