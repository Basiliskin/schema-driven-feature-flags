import type { VersionComparison } from '../../application/compare-versions.js';
import type { FieldChange, FlagChange, FlagState } from '../../domain/snapshot-diff.js';
import { escapeHtml } from './escape.js';
import { renderTimestamp } from './layout.js';

type Changed = Extract<VersionComparison, { status: 'changed' }>;

const json = (value: unknown): string =>
  value === undefined ? '<span class="muted">—</span>' : `<code>${escapeHtml(JSON.stringify(value))}</code>`;

const describeFlag = (flag: FlagState): string =>
  `${flag.type} · ${flag.enabled ? 'On' : 'Off'}${flag.type === 'config' ? ` · default ${json(flag.defaultValue)}` : ''}`;

const renderField = (change: FieldChange): string =>
  `<tr><th scope="row">${change.field}</th><td class="diff-before">${json(change.before)}</td><td class="diff-after">${json(change.after)}</td></tr>`;

const conflictNote = (change: FlagChange): string =>
  change.kind === 'removed'
    ? 'This flag was deleted, so your edit to it can’t be applied.'
    : 'Your edit to this flag is kept in its form — check it against these changes before saving again.';

const renderChange = (change: FlagChange, edited: string | undefined): string => {
  const head = `<span class="flag-key">${escapeHtml(change.key)}</span><span class="badge diff-${change.kind}">${change.kind}</span>`;
  const body =
    change.kind === 'added'
      ? `<p class="muted">${describeFlag(change.after)}</p>`
      : change.kind === 'removed'
        ? `<p class="muted">Was ${describeFlag(change.before)}</p>`
        : `<div class="table-wrap"><table class="diff-table"><thead><tr><th>Field</th><th>Your version</th><th>Latest</th></tr></thead><tbody>${change.fields.map(renderField).join('')}</tbody></table></div>`;
  const note =
    change.key === edited
      ? `<p class="notice warning" data-conflict-note data-rejected-edit>${conflictNote(change)}</p>`
      : '<p class="notice warning" data-conflict-note hidden>You have unsaved edits to this flag.</p>';
  return `<li data-changed-key="${escapeHtml(change.key)}"${change.key === edited ? ' class="has-conflict"' : ''}><div class="card-head">${head}</div>
${body}
${note}</li>`;
};

const renderChanges = (changes: readonly FlagChange[] | undefined, edited: string | undefined): string => {
  if (changes === undefined) return '<p>One of the snapshots is missing or invalid, so the flags can’t be compared one by one.</p>';
  if (changes.length === 0) return '<p class="muted">No flag changed; only the snapshot’s details did.</p>';
  return `<ul class="change-list">\n${changes.map((change) => renderChange(change, edited)).join('\n')}\n</ul>`;
};

/**
 * The body of the "Review changes" dialog, fetched by the page script. The merge buttons are wired by
 * that script, which knows which of the operator's unsaved edits it can carry onto the latest version.
 */
export const renderChangesFragment = (comparison: Changed, edited?: string): string => {
  const { latest } = comparison;
  const by =
    latest === undefined
      ? ''
      : ` by ${escapeHtml(latest.createdBy)} · ${renderTimestamp(latest.createdAt)}${latest.reason === '' ? '' : ` — ${escapeHtml(latest.reason)}`}`;
  return `<div data-changes data-to="${String(comparison.to)}">
<p>From version ${String(comparison.from)} to version ${String(comparison.to)}, published${by}.</p>
${renderChanges(comparison.changes, edited)}
<div class="actions merge-actions">
<button type="button" class="button-secondary" data-merge="discard">Load latest, drop my edits</button>
<button type="button" data-merge="keep">Load latest, keep my edits</button>
</div>
<p class="muted" data-merge-hint>Your unsaved edits are reapplied on top of the latest version so you can review them before saving.</p>
</div>`;
};
