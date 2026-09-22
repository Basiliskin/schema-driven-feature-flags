import type { FlagDefinitionView, SnapshotContents } from '../../application/browse-environment.js';
import { escapeHtml, flagPath } from './escape.js';
import { renderFeatureEditForm, type EditContext } from './feature-edit-form.js';

const rulesLabel = (count: number): string => `${String(count)} ${count === 1 ? 'rule' : 'rules'}`;

const renderFlagBadges = (flag: FlagDefinitionView): string =>
  `<span class="badge">${flag.type}</span><span class="badge${flag.enabled ? ' badge-on' : ''}">${flag.enabled ? 'On' : 'Off'}</span>`;

// data-label feeds the stacked-card layout that tables.css switches to on narrow screens.
const renderTableRow = (flag: FlagDefinitionView): string =>
  `<tr><td data-label="Flag"><code>${escapeHtml(flag.key)}</code></td><td data-label="Type">${flag.type}</td><td data-label="Enabled">${String(flag.enabled)}</td><td data-label="Default"><code>${escapeHtml(JSON.stringify(flag.defaultValue))}</code></td><td data-label="Rules">${String(flag.ruleCount)}</td></tr>`;

// Each flag is a one-line row; clicking its key navigates to the flag's own page, or — where the page script
// runs — opens the same editor in a shared overlay instead (see app.js). The editor panel stays in the row's
// markup either way, just hidden, so a rejected draft still has somewhere to render next to its input.
const renderFlagCard = (flag: FlagDefinitionView, editable: EditContext): string => {
  const open = editable.draft?.key === flag.key;
  return `<li class="card flag" data-flag="${escapeHtml(flag.key)}" data-search="${escapeHtml(`${flag.key} ${flag.type} ${flag.enabled ? 'on' : 'off'}`.toLowerCase())}">
<div class="flag-row">
<div class="flag-row-summary"><span class="flag-key"><a href="${escapeHtml(flagPath(editable.environment, flag.key))}" data-open-flag="${escapeHtml(flag.key)}">${escapeHtml(flag.key)}</a></span>${renderFlagBadges(flag)}<span class="flag-summary muted">${rulesLabel(flag.ruleCount)}</span></div>
<div class="flag-panel"${open ? '' : ' hidden'}>
<p class="muted">Default <code>${escapeHtml(JSON.stringify(flag.defaultValue))}</code> · ${rulesLabel(flag.ruleCount)}</p>
${renderFeatureEditForm(flag, editable)}
</div>
</div>
</li>`;
};

export const renderSnapshotContents = (contents: SnapshotContents, editable?: EditContext): string => {
  if (contents.status === 'invalid') {
    const issues = contents.issues
      .map((issue) => `<li>${escapeHtml(issue.path)}: ${escapeHtml(issue.message)}</li>`)
      .join('');
    return `<div class="notice error"><p>This snapshot is not valid:</p><ul>${issues}</ul></div>`;
  }
  if (contents.flags.length === 0) return '<p class="muted">This snapshot defines no flags.</p>';
  if (editable !== undefined) {
    return `<ul class="flag-list">
${contents.flags.map((flag) => renderFlagCard(flag, editable)).join('\n')}
</ul>`;
  }
  return `<div class="table-wrap"><table class="flag-table">
<thead><tr><th>Flag</th><th>Type</th><th>Enabled</th><th>Default</th><th>Rules</th></tr></thead>
<tbody>
${contents.flags.map(renderTableRow).join('\n')}
</tbody>
</table></div>`;
};
