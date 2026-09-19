import { describe, expect, it } from 'vitest';
import type { EnvironmentView, FlagDefinitionView, SnapshotContents } from '../../application/browse-environment.js';
import { renderEnvironmentPage } from './environment-page.js';
import { renderFeatureEditForm, type EditContext } from './feature-edit-form.js';
import { renderSnapshotContents } from './snapshot-contents.js';

const BOOLEAN: FlagDefinitionView = { key: 'new-dashboard', type: 'boolean', enabled: true, defaultValue: true, ruleCount: 0 };
const CONFIG: FlagDefinitionView = {
  key: 'checkout-limits',
  type: 'config',
  enabled: false,
  defaultValue: { max: 3 },
  ruleCount: 1,
};
const CONTEXT: EditContext = { environment: 'production', baseVersion: 7 };
const CONTENTS: SnapshotContents = { status: 'valid', flags: [BOOLEAN, CONFIG] };

const rowOf = (html: string, key: string): string => {
  const start = html.indexOf(`<tr><td>${key}</td>`);
  const end = html.indexOf('</tr>', start);
  return html.slice(start, end);
};

describe('renderFeatureEditForm', () => {
  it('posts to the URL-encoded feature path with the exact base version', () => {
    const html = renderFeatureEditForm(BOOLEAN, CONTEXT);
    expect(html).toContain('<form method="post" action="/env/production/features/new-dashboard">');
    expect(html).toContain('<input type="hidden" name="baseVersion" value="7">');
  });

  it('URL-encodes slashes in the key and the environment', () => {
    const html = renderFeatureEditForm({ ...BOOLEAN, key: 'a/b' }, { ...CONTEXT, environment: 'eu/west' });
    expect(html).toContain('action="/env/eu%2Fwest/features/a%2Fb"');
  });

  it('escapes a hostile key in the action URL', () => {
    const html = renderFeatureEditForm({ ...BOOLEAN, key: 'a"><img src=x onerror=1>' }, CONTEXT);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('"><');
  });

  it('gives a boolean feature a checkbox and no default textarea', () => {
    const html = renderFeatureEditForm(BOOLEAN, CONTEXT);
    expect(html).toContain('<input type="checkbox" name="enabled" checked>');
    expect(html).toContain('<button type="submit" name="field" value="enabled">Save enabled</button>');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('value="default"');
  });

  it('gives a config feature an unchecked checkbox and a textarea prefilled with its default JSON', () => {
    const html = renderFeatureEditForm(CONFIG, CONTEXT);
    expect(html).toContain('<input type="checkbox" name="enabled">');
    expect(html).not.toContain(' checked');
    expect(html).toContain(`<textarea name="default" rows="4">{\n  &quot;max&quot;: 3\n}</textarea>`);
    expect(html).toContain('<button type="submit" name="field" value="default">Save default</button>');
  });

  it('escapes a stored default that tries to close the textarea', () => {
    const html = renderFeatureEditForm({ ...CONFIG, defaultValue: '</textarea><script>' }, CONTEXT);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&lt;/textarea&gt;&lt;script&gt;&quot;</textarea>');
  });

  it('keeps the draft text and checkbox state and shows the escaped error for the matching feature', () => {
    const html = renderFeatureEditForm(CONFIG, {
      ...CONTEXT,
      draft: {
        key: 'checkout-limits',
        enabled: true,
        defaultJson: '</textarea><script>',
        message: 'Bad <json>',
        issues: ['default: <broken>'],
      },
    });
    expect(html).toContain('<input type="checkbox" name="enabled" checked>');
    expect(html).toContain('<textarea name="default" rows="4">&lt;/textarea&gt;&lt;script&gt;</textarea>');
    expect(html).not.toContain('<script>');
    expect(html).toContain(
      '<div class="notice error" role="alert"><p>Bad &lt;json&gt;</p><ul><li>default: &lt;broken&gt;</li></ul></div>',
    );
  });

  it('shows a draft error without an issue list when there are no issues', () => {
    const html = renderFeatureEditForm(BOOLEAN, {
      ...CONTEXT,
      draft: { key: 'new-dashboard', message: 'Someone else published', issues: [] },
    });
    expect(html).toContain('<div class="notice error" role="alert"><p>Someone else published</p></div>');
    expect(html).toContain('<input type="checkbox" name="enabled" checked>');
  });

  it('ignores a draft that belongs to another feature', () => {
    const html = renderFeatureEditForm(CONFIG, {
      ...CONTEXT,
      draft: { key: 'new-dashboard', enabled: true, defaultJson: 'typed', message: 'Oops', issues: [] },
    });
    expect(html).not.toContain('Oops');
    expect(html).not.toContain('typed');
    expect(html).not.toContain(' checked');
  });
});

describe('renderSnapshotContents', () => {
  it('renders exactly the read-only table when editable is omitted', () => {
    expect(renderSnapshotContents(CONTENTS)).toBe(`<table>
<thead><tr><th>Flag</th><th>Type</th><th>Enabled</th><th>Default</th><th>Rules</th></tr></thead>
<tbody>
<tr><td>new-dashboard</td><td>boolean</td><td>true</td><td><code>true</code></td><td>0</td></tr>
<tr><td>checkout-limits</td><td>config</td><td>false</td><td><code>{&quot;max&quot;:3}</code></td><td>1</td></tr>
</tbody>
</table>`);
  });

  it('adds an Edit column with one form per feature when editable', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT);
    expect(html).toContain('<th>Edit</th>');
    expect(html.match(/<form /g)).toHaveLength(2);
  });

  it('shows the draft error only on the matching row', () => {
    const html = renderSnapshotContents(CONTENTS, {
      ...CONTEXT,
      draft: { key: 'checkout-limits', message: 'Edit failed here', issues: [] },
    });
    expect(rowOf(html, 'checkout-limits')).toContain('Edit failed here');
    expect(rowOf(html, 'new-dashboard')).not.toContain('Edit failed here');
  });
});

describe('renderEnvironmentPage edit forms', () => {
  const view: EnvironmentView = {
    environment: 'production',
    status: 'published',
    currentVersion: 7,
    versions: [6, 7],
    current: { environment: 'production', version: 7, status: 'available', contents: CONTENTS },
  };

  it('renders edit forms for the current version', () => {
    const html = renderEnvironmentPage(view);
    expect(html).toContain('action="/env/production/features/new-dashboard"');
    expect(html).toContain('<input type="hidden" name="baseVersion" value="7">');
  });

  it('passes an edit draft through to the matching feature', () => {
    const html = renderEnvironmentPage(view, {
      editDraft: { key: 'checkout-limits', defaultJson: '{"max": 9}', message: 'Conflict', issues: [] },
    });
    expect(rowOf(html, 'checkout-limits')).toContain('{&quot;max&quot;: 9}');
    expect(rowOf(html, 'checkout-limits')).toContain('Conflict');
  });
});
