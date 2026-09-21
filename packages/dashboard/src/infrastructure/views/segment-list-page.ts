import type { PublishedSegmentRow, PublishedSegmentsView } from '../../application/list-published-segments.js';
import { environmentPath, escapeHtml } from './escape.js';
import { renderPage, type Notice } from './layout.js';
import { segmentPath } from './segment-page.js';

export interface SegmentListPageView {
  readonly environment: string;
  readonly listing: PublishedSegmentsView;
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

const renderAttribute = (row: PublishedSegmentRow): string =>
  row.attribute.status === 'known'
    ? escapeHtml(row.attribute.memberAttribute)
    : '<span class="segment-unknown">unknown (published before attributes were recorded)</span>';

const renderUsage = (row: PublishedSegmentRow): string =>
  row.usage.status === 'used'
    ? row.usage.flagKeys.map((flagKey) => `<span class="segment-user">${escapeHtml(flagKey)}</span>`).join(', ')
    : '<span class="segment-unused">used by no flag</span>';

const renderRow = (environment: string, row: PublishedSegmentRow): string => `<tr>
<td data-label="Segment"><a href="${escapeHtml(segmentPath(environment, row.segmentKey))}">${escapeHtml(row.segmentKey)}</a></td>
<td data-label="Current pointer">version ${escapeHtml(row.version)}</td>
<td data-label="Member attribute">${renderAttribute(row)}</td>
<td data-label="Used by flags">${renderUsage(row)}</td>
</tr>`;

const renderRows = (environment: string, rows: readonly PublishedSegmentRow[]): string => `<div class="table-wrap">
<table class="flag-table">
<thead><tr><th scope="col">Segment</th><th scope="col">Current pointer</th><th scope="col">Member attribute</th><th scope="col">Used by flags</th></tr></thead>
<tbody>
${rows.map((row) => renderRow(environment, row)).join('\n')}
</tbody>
</table>
</div>`;

const renderTable = (view: SegmentListPageView): string => {
  if (view.listing.status === 'unavailable') {
    return '<p class="segment-unavailable">The segment catalogue could not be read, so this list is incomplete. Segments may well be published; try again.</p>';
  }
  return view.listing.rows.length === 0
    ? '<p class="muted">No segments published yet in this environment.</p>'
    : renderRows(view.environment, view.listing.rows);
};

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
<p class="muted">A new segment appears in the table above as soon as it is published, before any flag uses it.</p>
</section>`;

export const renderSegmentListPage = (view: SegmentListPageView, state: SegmentListPageState = {}): string => {
  const heading = `${view.environment} · segments`;
  return renderPage(
    heading,
    `<p><a class="back-link" href="${escapeHtml(environmentPath(view.environment))}">Back to ${escapeHtml(view.environment)}</a></p>
<div class="page-head"><h1>${escapeHtml(heading)}</h1></div>
<p class="muted">Every segment published in this environment, with the version its Segment Pointer names, the Member attribute its rows are matched on, and the flags whose rules use it. Members are never listed here.</p>
${renderTable(view)}
${renderCreateForm(view.environment, state.draft)}`,
    state.notices ?? [],
  );
};
