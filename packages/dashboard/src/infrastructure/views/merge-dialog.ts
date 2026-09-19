import type { DraftMerge } from '../../application/merge-draft.js';
import type { FieldMergeEntry, FieldStatus, MergeEntry, MergeStatus } from '../../domain/snapshot-merge.js';
import { escapeHtml } from './escape.js';

type Ready = Extract<DraftMerge, { status: 'ready' }>;

const STATUS_LABEL: Record<MergeStatus, string> = {
  theirs: 'changed in latest',
  mine: 'changed in your draft',
  same: 'same change on both sides',
  combined: 'combined field by field',
  conflict: 'conflict',
};

const FIELD_LABEL: Record<FieldStatus, string> = {
  theirs: 'changed in latest',
  mine: 'changed in your draft',
  same: 'same on both sides',
  conflict: 'conflict',
};

const renderValue = (label: string, value: unknown, className: string): string =>
  `<div class="merge-side ${className}"><p class="merge-label">${label}</p>${
    value === undefined
      ? '<p class="muted merge-absent">not present</p>'
      : `<pre><code>${escapeHtml(JSON.stringify(value, null, 2))}</code></pre>`
  }</div>`;

// Preselects the side a plain three-way merge would take; a conflict has no default, so it must be chosen.
const renderChoice = (name: string, status: FieldStatus, to: number, mineLabel: string): string => {
  if (status === 'same') return '';
  const option = (value: 'mine' | 'theirs', label: string) =>
    `<label class="check"><input type="radio" name="${escapeHtml(name)}" value="${value}"${status === value ? ' checked' : ''}> ${label}</label>`;
  return `<div class="form-row merge-choice">${option('mine', mineLabel)}${option('theirs', `Take version ${String(to)}`)}</div>`;
};

const renderSides = (entry: { base: unknown; mine: unknown; theirs: unknown }, merge: Ready): string => `<div class="merge-sides">
${renderValue(`Version ${String(merge.from)}`, entry.base, 'merge-base')}
${renderValue('Your draft', entry.mine, 'merge-mine')}
${renderValue(`Version ${String(merge.to)}`, entry.theirs, 'merge-theirs')}
</div>`;

const renderField = (key: string, field: FieldMergeEntry, merge: Ready): string => `<div class="merge-field merge-${field.status}" data-merge-field="${escapeHtml(field.field)}">
<div class="card-head"><code>${escapeHtml(field.field)}</code><span class="badge merge-badge-${field.status}">${FIELD_LABEL[field.status]}</span></div>
${renderSides(field, merge)}
${renderChoice(`pick:${key}:${field.field}`, field.status, merge.to, 'Keep mine')}
</div>`;

// Both sides kept the flag and changed it: one choice per changed field; unchanged fields stay as they are.
const renderEntry = (entry: MergeEntry, merge: Ready): string => {
  const head = `<div class="card-head"><span class="flag-key">${escapeHtml(entry.key)}</span><span class="badge merge-badge-${entry.status}">${STATUS_LABEL[entry.status]}</span></div>`;
  const body =
    // Only field-by-field entries can be 'combined', so a whole-flag entry's status is a FieldStatus.
    entry.fields === undefined
      ? `${renderSides(entry, merge)}\n${renderChoice(`pick:${entry.key}`, entry.status as FieldStatus, merge.to, 'Keep my draft')}`
      : entry.fields.map((field) => renderField(entry.key, field, merge)).join('\n');
  return `<li data-merge-key="${escapeHtml(entry.key)}"${entry.fields === undefined ? '' : ' data-by-field'} class="merge-${entry.status}">
${head}
${body}
</li>`;
};

/** The body of the merge dialog for a pasted snapshot draft; the server applies the choices (`/merge/apply`). */
export const renderMergeFragment = (merge: DraftMerge): string => {
  if (merge.status === 'invalid-draft') {
    return '<p class="notice error">Your draft isn’t JSON with a <code>features</code> object, so it can’t be merged. Fix it in the Publish dialog, or discard it.</p>\n<div class="actions merge-actions"><button type="button" class="button-secondary" data-merge="discard">Discard my draft</button><button type="button" data-merge="keep">Back to my draft</button></div>';
  }
  if (merge.status === 'unavailable') {
    return '<p class="notice error">The published snapshots couldn’t be read, so the draft can’t be merged.</p>\n<div class="actions merge-actions"><button type="button" class="button-secondary" data-merge="discard">Discard my draft</button><button type="button" data-merge="keep">Back to my draft</button></div>';
  }
  const conflicts = merge.entries.filter((entry) => entry.status === 'conflict').length;
  const summary =
    merge.entries.length === 0
      ? `<p>Nothing in your draft’s flags overlaps with what changed; it can be published on top of version ${String(merge.to)} as is.</p>`
      : `<p>Your draft started from version ${String(merge.from)}; the latest is version ${String(merge.to)}. ${
          conflicts === 0
            ? 'Changes on only one side are already picked.'
            : `<strong>${String(conflicts)} ${conflicts === 1 ? 'flag was' : 'flags were'} changed on both sides</strong> — choose which to keep. Changes on only one side are already picked.`
        }</p>`;
  return `<form data-merge-form data-to="${String(merge.to)}">
${summary}
<ul class="merge-list">
${merge.entries.map((entry) => renderEntry(entry, merge)).join('\n')}
</ul>
<p class="notice error" data-merge-missing hidden>Choose a side for every conflict first.</p>
<div class="actions merge-actions">
<button type="button" class="button-secondary" data-merge="discard">Discard my draft</button>
<button type="button" data-merge="apply">Apply to my draft</button>
</div>
</form>`;
};
