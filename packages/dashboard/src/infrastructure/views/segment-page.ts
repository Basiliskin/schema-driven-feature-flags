import { environmentPath, escapeHtml } from './escape.js';
import { renderPage, type Notice } from './layout.js';

export interface SegmentPageView {
  readonly environment: string;
  readonly key: string;
  /** The Segment Version the form is built on, or `null` when the segment has never been published. */
  readonly currentVersion: number | null;
}

export interface SegmentPageState {
  readonly notices?: readonly Notice[];
}

export const segmentPath = (environment: string, key: string): string =>
  `${environmentPath(environment)}/segments/${encodeURIComponent(key)}`;

export const renderSegmentPage = (view: SegmentPageView, state: SegmentPageState = {}): string => {
  const { environment, key, currentVersion } = view;
  const heading = `${environment} · segment ${key}`;
  const version = currentVersion === null ? 'never published' : `version ${String(currentVersion)}`;
  return renderPage(
    heading,
    `<p><a class="back-link" href="${escapeHtml(environmentPath(environment))}">Back to ${escapeHtml(environment)}</a></p>
<div class="page-head"><h1>${escapeHtml(heading)}</h1></div>
<p class="muted">Current pointer: ${escapeHtml(version)}</p>
<section class="card segment-upload">
<h2>Upload members</h2>
<p class="muted">A CSV with one member per row. The file is read in your browser and uploaded as a new Segment Version; members are never shown back to you.</p>
<form method="post" action="${escapeHtml(segmentPath(environment, key))}" class="stack" data-segment-upload>
<input type="hidden" name="expectedCurrentVersion" value="${currentVersion === null ? '' : String(currentVersion)}">
<input type="hidden" name="csv" value="">
<label>Member attribute <input type="text" name="memberAttribute" value="userId" required autocomplete="off" autocapitalize="none" spellcheck="false"></label>
<label>CSV file <input type="file" name="file" accept=".csv,text/csv" required data-segment-file></label>
<div class="actions"><button type="submit">Upload members</button></div>
</form>
</section>`,
    state.notices ?? [],
  );
};
