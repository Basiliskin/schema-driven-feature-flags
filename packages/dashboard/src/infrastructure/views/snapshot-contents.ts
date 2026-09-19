import type { SnapshotContents } from '../../application/browse-environment.js';
import { escapeHtml } from './escape.js';

export const renderSnapshotContents = (contents: SnapshotContents): string => {
  if (contents.status === 'invalid') {
    const issues = contents.issues
      .map((issue) => `<li>${escapeHtml(issue.path)}: ${escapeHtml(issue.message)}</li>`)
      .join('');
    return `<p>This snapshot is not valid:</p><ul>${issues}</ul>`;
  }
  if (contents.flags.length === 0) return '<p>This snapshot defines no flags.</p>';
  const rows = contents.flags
    .map(
      (flag) =>
        `<tr><td>${escapeHtml(flag.key)}</td><td>${flag.type}</td><td>${String(flag.enabled)}</td><td><code>${escapeHtml(JSON.stringify(flag.defaultValue))}</code></td><td>${String(flag.ruleCount)}</td></tr>`,
    )
    .join('\n');
  return `<table>
<thead><tr><th>Flag</th><th>Type</th><th>Enabled</th><th>Default</th><th>Rules</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
};
