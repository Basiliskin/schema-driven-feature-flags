import type { FlagDefinitionView, SnapshotContents } from '../../application/browse-environment.js';
import { withUrlState, type DashboardUrlState } from '../url-state.js';
import { environmentPath, escapeHtml, flagPath } from './escape.js';
import { renderFeatureEditForm, type EditContext } from './feature-edit-form.js';

const rulesLabel = (count: number): string => `${String(count)} ${count === 1 ? 'rule' : 'rules'}`;

const renderFlagBadges = (flag: FlagDefinitionView): string =>
  `<span class="badge">${flag.type}</span><span class="badge${flag.enabled ? ' badge-on' : ''}">${flag.enabled ? 'On' : 'Off'}</span>`;

// data-label feeds the stacked-card layout that tables.css switches to on narrow screens.
const renderTableRow = (flag: FlagDefinitionView): string =>
  `<tr><td data-label="Flag"><code>${escapeHtml(flag.key)}</code></td><td data-label="Type">${flag.type}</td><td data-label="Enabled">${String(flag.enabled)}</td><td data-label="Default"><code>${escapeHtml(JSON.stringify(flag.defaultValue))}</code></td><td data-label="Rules">${String(flag.ruleCount)}</td></tr>`;

// A plain link, not a button: it is what makes an expanded row bookmarkable and survive a write POST.
// The native <details> widget is left in place, so a row still toggles instantly with JavaScript.
const renderOpenToggle = (
  flag: FlagDefinitionView,
  environment: string,
  urlState: DashboardUrlState | undefined,
  inUrl: boolean,
): string => {
  if (urlState === undefined) return '';
  const openFlags = inUrl ? urlState.openFlags.filter((key) => key !== flag.key) : [...urlState.openFlags, flag.key];
  const href = withUrlState(environmentPath(environment), { ...urlState, openFlags });
  return `<a class="muted" data-open-toggle href="${escapeHtml(href)}">${inUrl ? 'Collapse' : 'Expand'}</a>`;
};

// Each flag is a one-line row that expands to its editor, so a long list stays scannable.
// A row opens by itself when it holds a rejected draft, so the error sits next to the input.
// The URL's open list is the other way a row opens; the draft rule is OR-ed with it and never replaced,
// so a rejected draft is visible even when the URL says the row is closed.
// Only the flag rows themselves are in the URL contract. The nested Rollout / Attach a segment /
// Edit rules / Delete panels deliberately stay out of it: end-to-end specs click those summaries open,
// and a state link inside them would reload the page out from under the click.
const renderFlagCard = (flag: FlagDefinitionView, editable: EditContext, urlState: DashboardUrlState | undefined): string => {
  const inUrl = urlState?.openFlags.includes(flag.key) ?? false;
  const open = editable.draft?.key === flag.key || inUrl ? ' open' : '';
  return `<li class="card flag" data-flag="${escapeHtml(flag.key)}" data-search="${escapeHtml(`${flag.key} ${flag.type} ${flag.enabled ? 'on' : 'off'}`.toLowerCase())}">
<details class="flag-row"${open}>
<summary><span class="flag-key"><a href="${escapeHtml(flagPath(editable.environment, flag.key))}">${escapeHtml(flag.key)}</a></span>${renderFlagBadges(flag)}<span class="flag-summary muted">${rulesLabel(flag.ruleCount)}</span>${renderOpenToggle(flag, editable.environment, urlState, inUrl)}</summary>
<p class="muted">Default <code>${escapeHtml(JSON.stringify(flag.defaultValue))}</code> · ${rulesLabel(flag.ruleCount)}</p>
${renderFeatureEditForm(flag, editable)}
</details>
</li>`;
};

export const renderSnapshotContents = (
  contents: SnapshotContents,
  editable?: EditContext,
  urlState?: DashboardUrlState,
): string => {
  if (contents.status === 'invalid') {
    const issues = contents.issues
      .map((issue) => `<li>${escapeHtml(issue.path)}: ${escapeHtml(issue.message)}</li>`)
      .join('');
    return `<div class="notice error"><p>This snapshot is not valid:</p><ul>${issues}</ul></div>`;
  }
  if (contents.flags.length === 0) return '<p class="muted">This snapshot defines no flags.</p>';
  if (editable !== undefined) {
    return `<ul class="flag-list">
${contents.flags.map((flag) => renderFlagCard(flag, editable, urlState)).join('\n')}
</ul>`;
  }
  return `<div class="table-wrap"><table class="flag-table">
<thead><tr><th>Flag</th><th>Type</th><th>Enabled</th><th>Default</th><th>Rules</th></tr></thead>
<tbody>
${contents.flags.map(renderTableRow).join('\n')}
</tbody>
</table></div>`;
};
