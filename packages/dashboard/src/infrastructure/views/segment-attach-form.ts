import type { PublishedSegmentRow, PublishedSegmentsView } from '../../application/list-published-segments.js';
import type { FlagDefinitionView } from '../../application/browse-environment.js';
import { escapeHtml } from './escape.js';

/** The attach fields of a rejected submission, echoed back so the operator keeps their choice. */
export interface AttachDraft {
  readonly segmentKey?: string;
  readonly segmentValue?: string;
}

export interface AttachContext {
  /** Every segment published in the Environment — the only keys the form offers. */
  readonly segments: PublishedSegmentsView;
  readonly draft?: AttachDraft;
}

export const UNKNOWN_ATTRIBUTE_LABEL = 'attribute unknown';

const wrap = (body: string): string => `<details class="segment-attach"><summary>Attach a segment</summary>\n${body}\n</details>`;

// Segments published before the attribute was recorded on the pointer stay listed but unselectable: the
// operator can see the segment exists and that re-uploading it is what makes it attachable.
const renderOption = (row: PublishedSegmentRow, chosen: string | undefined): string => {
  const unknown = row.attribute.status === 'unknown';
  const label = `${row.segmentKey} · ${row.attribute.status === 'known' ? row.attribute.memberAttribute : UNKNOWN_ATTRIBUTE_LABEL}`;
  const selected = !unknown && row.segmentKey === chosen ? ' selected' : '';
  return `<option value="${escapeHtml(row.segmentKey)}"${unknown ? ' disabled' : ''}${selected}>${escapeHtml(label)}</option>`;
};

const renderValueControl = (flag: FlagDefinitionView, draft: AttachDraft | undefined): string =>
  flag.type === 'config'
    ? `<label>Value for members <input type="text" name="value" value="${escapeHtml(draft?.segmentValue ?? '')}"></label>
<p class="muted">A plain word, a number or true/false is fine — you do not have to type JSON.</p>`
    : '';

/**
 * The fields of the "Attach a segment" block only — no `<form>`, no submit of its own. It is nested inside
 * the single flag-edit form (see feature-edit-form.ts) and staged, along with every other change on the
 * flag, when the operator clicks the one Save button. Leaving Segment on its placeholder submits nothing.
 */
export const renderSegmentAttachFields = (flag: FlagDefinitionView, context: AttachContext): string => {
  const { draft, segments } = context;
  if (segments.status === 'unavailable') {
    return wrap('<p class="muted">The list of published segments could not be read, so there is nothing to choose from right now.</p>');
  }
  if (segments.rows.length === 0) {
    return wrap('<p class="muted">No segments are published in this environment yet. Upload a segment first, then attach it here.</p>');
  }
  const options = segments.rows.map((row) => renderOption(row, draft?.segmentKey)).join('');
  return wrap(`<label>Segment <select name="segmentKey"><option value=""${segments.rows.some((row) => row.segmentKey === draft?.segmentKey) ? '' : ' selected'}>Choose a segment…</option>${options}</select></label>
<p class="muted">Each segment is listed with the member attribute it was published with; members are matched on it.</p>
${renderValueControl(flag, draft)}`);
};
