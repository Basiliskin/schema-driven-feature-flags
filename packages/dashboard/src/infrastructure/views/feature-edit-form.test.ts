import { describe, expect, it } from 'vitest';
import type { EnvironmentView, FlagDefinitionView, SnapshotContents, SnapshotVersionView } from '../../application/browse-environment.js';
import { renderEnvironmentPage } from './environment-page.js';
import { renderFeatureEditForm, type EditContext } from './feature-edit-form.js';
import { renderSnapshotContents } from './snapshot-contents.js';
import { renderVersionPage } from './version-page.js';

const BOOLEAN: FlagDefinitionView = { key: 'new-dashboard', type: 'boolean', enabled: true, defaultValue: true, ruleCount: 0, rules: [] };
const CONFIG: FlagDefinitionView = {
  key: 'checkout-limits',
  type: 'config',
  enabled: false,
  defaultValue: { max: 3 },
  ruleCount: 1,
  rules: [{ when: { plan: 'pro' }, value: { max: 9 } }],
};
const CONTEXT: EditContext = {
  environment: 'production',
  baseVersion: 7,
  publishedSegments: {
    status: 'listed',
    rows: [{ segmentKey: 'beta-testers', version: 2, attribute: { status: 'known', memberAttribute: 'userId' }, usage: { status: 'unused' } }],
  },
};
const METADATA = { createdAt: '2026-09-19T06:00:00.000Z', createdBy: 'ops', reason: 'Launch' };
const RAW = {
  schemaVersion: 1,
  environment: 'production',
  version: 7,
  createdAt: METADATA.createdAt,
  createdBy: 'ops',
  previousVersion: 6,
  reason: 'Launch',
  features: { 'new-dashboard': { type: 'boolean', enabled: true } },
};
const CONTENTS: SnapshotContents = { status: 'valid', flags: [BOOLEAN, CONFIG], metadata: METADATA, segmentKeys: [], raw: RAW };

const rowOf = (html: string, key: string): string => {
  const start = html.indexOf(`<li class="card flag" data-flag="${key}"`);
  const end = html.indexOf('</li>', start);
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
    expect(html).not.toContain('a"><');
  });

  it('gives a boolean feature a checkbox and no default textarea', () => {
    const html = renderFeatureEditForm(BOOLEAN, CONTEXT);
    expect(html).toContain('<input type="checkbox" name="enabled" checked>');
    expect(html).toContain('<button type="submit" name="field" value="enabled">Save enabled</button>');
    expect(html).not.toContain('name="default"');
    expect(html).not.toContain('value="default"');
  });

  it('gives a config feature an unchecked checkbox and a textarea prefilled with its default JSON', () => {
    const html = renderFeatureEditForm(CONFIG, CONTEXT);
    expect(html).toContain('<input type="checkbox" name="enabled">');
    expect(html).not.toContain(' checked');
    expect(html).toContain(`<textarea name="default" rows="4">{\n  &quot;max&quot;: 3\n}</textarea>`);
    expect(html).toContain('<button type="submit" class="button-secondary" name="field" value="default">Save default</button>');
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

  it('prefills the rules textarea with the stored rules, escaped', () => {
    const html = renderFeatureEditForm({ ...CONFIG, rules: [{ when: { plan: '</textarea>' }, value: 1 }] }, CONTEXT);
    expect(html).toContain('<textarea name="rules" rows="4">[\n  {\n    &quot;when&quot;: {\n      &quot;plan&quot;: &quot;&lt;/textarea&gt;&quot;');
    expect(html).toContain('<button type="submit" class="button-secondary" name="field" value="rules">Save rules</button>');
    expect(html).not.toContain('</textarea>&quot;');
  });

  it('keeps the rules draft text for the matching feature', () => {
    const html = renderFeatureEditForm(BOOLEAN, {
      ...CONTEXT,
      draft: { key: 'new-dashboard', rulesJson: '[{"when"', message: 'Bad rules', issues: [] },
    });
    expect(html).toContain('<textarea name="rules" rows="4">[{&quot;when&quot;</textarea>');
  });

  it('puts delete in a separate form behind a <details> confirmation, with no inline script', () => {
    const html = renderFeatureEditForm({ ...BOOLEAN, key: '<b>' }, CONTEXT);
    const deleteSection = html.slice(html.indexOf('<details class="danger-zone">'));
    expect(deleteSection).toMatch(/^<details class="danger-zone"><summary>Delete<\/summary>\n<form method="post" action="\/env\/production\/features\/%3Cb%3E">/);
    expect(deleteSection).toContain('<input type="hidden" name="baseVersion" value="7">');
    expect(deleteSection).toContain('<button type="submit" class="button-danger" name="field" value="delete">Delete &lt;b&gt;</button>');
    expect(html).not.toMatch(/onclick|confirm\(|<script/);
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
  it('renders exactly the read-only table, labelled for stacking on phones, when editable is omitted', () => {
    expect(renderSnapshotContents(CONTENTS)).toBe(`<div class="table-wrap"><table class="flag-table">
<thead><tr><th>Flag</th><th>Type</th><th>Enabled</th><th>Default</th><th>Rules</th></tr></thead>
<tbody>
<tr><td data-label="Flag"><code>new-dashboard</code></td><td data-label="Type">boolean</td><td data-label="Enabled">true</td><td data-label="Default"><code>true</code></td><td data-label="Rules">0</td></tr>
<tr><td data-label="Flag"><code>checkout-limits</code></td><td data-label="Type">config</td><td data-label="Enabled">false</td><td data-label="Default"><code>{&quot;max&quot;:3}</code></td><td data-label="Rules">1</td></tr>
</tbody>
</table></div>`);
  });

  it('renders one card per feature with its badges and controls when editable', () => {
    const html = renderSnapshotContents(CONTENTS, CONTEXT);
    expect(html).not.toContain('<table');
    expect(rowOf(html, 'new-dashboard')).toContain('<span class="badge">boolean</span><span class="badge badge-on">On</span>');
    expect(rowOf(html, 'new-dashboard')).toContain('Default <code>true</code> · 0 rules');
    expect(rowOf(html, 'checkout-limits')).toContain('<span class="badge">config</span><span class="badge">Off</span>');
    expect(rowOf(html, 'checkout-limits')).toContain('· 1 rule</p>');
    // Per feature: the edit form, the attach form and the delete-confirmation form, plus one rollout form per rule.
    expect(html.match(/<form /g)).toHaveLength(7);
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
  const view: Extract<EnvironmentView, { status: 'published' }> = {
    environment: 'production',
    status: 'published',
    currentVersion: 7,
    versions: [{ version: 6 }, { version: 7, metadata: METADATA }],
    current: { environment: 'production', version: 7, status: 'available', contents: CONTENTS },
  };

  it('collapses every flag row unless it holds a rejected draft', () => {
    const closed = renderEnvironmentPage(view);
    expect(rowOf(closed, 'checkout-limits')).toContain('<details class="flag-row">');
    const html = renderEnvironmentPage(view, {
      editDraft: { key: 'checkout-limits', defaultJson: '{}', message: 'Bad', issues: [] },
    });
    expect(rowOf(html, 'checkout-limits')).toContain('<details class="flag-row" open>');
    expect(rowOf(html, 'new-dashboard')).toContain('<details class="flag-row">');
  });

  it('indexes each flag for the filter by key, type and on/off state', () => {
    const html = renderEnvironmentPage(view);
    expect(html).toContain('data-filter="flag-list"');
    expect(html).toMatch(/data-flag="new-dashboard" data-search="new-dashboard boolean (on|off)"/);
  });

  it('puts the publish form in a dialog opened from the page header', () => {
    const html = renderEnvironmentPage(view);
    expect(html).toContain('data-open-dialog="publish-dialog"');
    expect(html).toContain('<dialog id="publish-dialog" class="publish-dialog" aria-labelledby="publish-heading">');
    const rejected = renderEnvironmentPage(view, { draft: '{}' });
    expect(rejected).toContain('aria-labelledby="publish-heading" data-open-on-load>');
  });

  it('renders edit forms for the current version', () => {
    const html = renderEnvironmentPage(view);
    expect(html).toContain('action="/env/production/features/new-dashboard"');
    expect(html).toContain('<input type="hidden" name="baseVersion" value="7">');
  });

  it('renders the new-flag form against the current version', () => {
    const html = renderEnvironmentPage(view);
    expect(html).toContain('<details class="card">\n<summary>New flag</summary>\n<form method="post" action="/env/production/features" class="stack">');
    expect(html).toContain('<option value="boolean" selected>boolean</option><option value="config">config</option>');
    expect(html).toContain('<textarea name="default" rows="3">null</textarea>');
  });

  it('passes a create draft through to the new-flag form, escaped', () => {
    const html = renderEnvironmentPage(view, {
      createDraft: {
        key: '"><x',
        type: 'config',
        enabled: true,
        defaultJson: '{',
        message: 'Bad <key>',
        issues: ['why'],
      },
    });
    const newFlag = html.slice(html.indexOf('<summary>New flag</summary>'));
    expect(html).toContain('<details class="card" open>\n<summary>New flag</summary>');
    expect(newFlag).toContain('name="key" required value="&quot;&gt;&lt;x"');
    expect(newFlag).toContain('<option value="config" selected>config</option>');
    expect(newFlag).toContain('<input type="checkbox" name="enabled" checked> Enabled');
    expect(newFlag).toContain('<textarea name="default" rows="3">{</textarea>');
    expect(newFlag).toContain('<p>Bad &lt;key&gt;</p><ul><li>why</li></ul>');
  });

  it.each<[string, EnvironmentView]>([
    ['empty', { environment: 'production', status: 'empty' }],
    [
      'unavailable',
      { ...view, current: { environment: 'production', version: 7, status: 'not-available' } },
    ],
    [
      'invalid',
      {
        ...view,
        current: {
          environment: 'production',
          version: 7,
          status: 'available',
          contents: { status: 'invalid', issues: [] },
        },
      },
    ],
  ])('offers no new-flag form when the current snapshot is %s', (_, state) => {
    expect(renderEnvironmentPage(state)).not.toContain('New flag');
  });

  it('passes an edit draft through to the matching feature', () => {
    const html = renderEnvironmentPage(view, {
      editDraft: { key: 'checkout-limits', defaultJson: '{"max": 9}', message: 'Conflict', issues: [] },
    });
    expect(rowOf(html, 'checkout-limits')).toContain('{&quot;max&quot;: 9}');
    expect(rowOf(html, 'checkout-limits')).toContain('Conflict');
  });
});

describe('renderEnvironmentPage layout', () => {
  const published = (current: SnapshotVersionView) =>
    renderEnvironmentPage({
      environment: 'production',
      status: 'published',
      currentVersion: 7,
      versions: [{ version: 5 }, { version: 6, metadata: { ...METADATA, reason: '' } }, { version: 7, metadata: METADATA }],
      current,
    });
  const available = { environment: 'production', version: 7, status: 'available', contents: CONTENTS } as const;

  it('opens with the current snapshot card naming the version and its metadata', () => {
    const html = published(available);
    const main = html.slice(html.indexOf('<main'));
    const firstCard = main.slice(main.indexOf('<section'), main.indexOf('</section>'));
    expect(firstCard).toContain('<section class="card card-current" aria-labelledby="current-heading">');
    expect(firstCard).toContain('Current snapshot · v7</h2><span class="badge">2 flags</span>');
    expect(firstCard).toContain('<dt>Created by</dt><dd>ops</dd>');
    expect(firstCard).toContain('<time datetime="2026-09-19T06:00:00.000Z">2026-09-19 06:00 UTC</time>');
    expect(firstCard).toContain('<dt>Reason</dt><dd>Launch</dd>');
    expect(firstCard).toContain('<summary>Raw JSON</summary>');
    expect(firstCard).toContain('data-copy="current-json" hidden>Copy JSON</button>');
    expect(firstCard).toContain('<pre id="current-json"><code>{\n  &quot;schemaVersion&quot;: 1,');
  });

  it('shows a dash for an empty reason and the singular flag count', () => {
    const one = { ...available, contents: { ...CONTENTS, flags: [BOOLEAN], metadata: { ...METADATA, reason: '' } } };
    const html = published(one);
    expect(html).toContain('<span class="badge">1 flag</span>');
    expect(html).toContain('<dt>Reason</dt><dd><span class="muted">—</span></dd>');
  });

  it('lists versions newest first with who, when, why and a restore button on every non-current one', () => {
    const html = published(available);
    const timeline = html.slice(html.indexOf('<ol class="timeline" reversed>'), html.indexOf('</ol>'));
    expect(timeline.indexOf('Version 7')).toBeLessThan(timeline.indexOf('Version 6'));
    expect(timeline.indexOf('Version 6')).toBeLessThan(timeline.indexOf('Version 5'));
    expect(timeline).toContain(
      '<li class="is-current">\n<div class="timeline-head"><a href="/env/production/versions/7">Version 7</a><span class="badge badge-accent">current</span></div>\n<p class="muted">ops · <time datetime="2026-09-19T06:00:00.000Z">2026-09-19 06:00 UTC</time></p>\n<p>Launch</p>\n</li>',
    );
    expect(timeline).toContain('<button type="submit" class="button-secondary">Restore version 6</button>');
    expect(timeline).toContain('06:00 UTC</time></p>\n</li>');
    expect(timeline).toContain('<p class="muted">Details unavailable.</p>');
    expect(timeline).not.toContain('Restore version 7');
  });

  it('pre-fills the publish box with the current snapshot minus the fields the publisher stamps', () => {
    const html = published(available);
    const box = html.slice(html.indexOf('<textarea id="snapshot"'), html.indexOf('</textarea>', html.indexOf('<textarea id="snapshot"')));
    const text = box.slice(box.indexOf('>') + 1).replaceAll('&quot;', '"');
    expect(JSON.parse(text)).toEqual({
      schemaVersion: 1,
      environment: 'production',
      createdBy: 'ops',
      reason: 'Launch',
      features: RAW.features,
    });
  });

  it('pre-fills a first-version template for an empty environment', () => {
    const html = renderEnvironmentPage({ environment: 'qa', status: 'empty' });
    expect(html).toContain('Nothing has been published to this environment yet.');
    expect(html).toContain('&quot;environment&quot;: &quot;qa&quot;');
    expect(html).toContain('&quot;features&quot;: {}');
  });

  it('leaves the publish box empty and explains when the current snapshot is invalid or missing', () => {
    const invalid = published({ ...available, contents: { status: 'invalid', issues: [] } });
    expect(invalid).toContain('<span class="badge">invalid</span>');
    expect(invalid).toContain('Publish a fixed version below.');
    expect(invalid).toContain('required spellcheck="false"></textarea>');
    const missing = published({ environment: 'production', version: 7, status: 'not-available' });
    expect(missing).toContain('snapshot file is not available');
    expect(missing).not.toContain('flags-heading');
    expect(missing).toContain('required spellcheck="false"></textarea>');
  });

  it('keeps a rejected publish draft instead of the pre-fill', () => {
    expect(renderEnvironmentPage({ environment: 'qa', status: 'empty' }, { draft: '{oops' })).toContain('>{oops</textarea>');
  });

  it('is a responsive page: viewport meta, external stylesheet, no inline styles or event handlers', () => {
    const html = published(available);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/app\.css\?v=[0-9a-f]{12}">/);
    expect(html).not.toMatch(/<style|style="| on[a-z]+="/);
  });
});

describe('renderVersionPage', () => {
  it('shows the version metadata, its raw JSON and the flag table', () => {
    const html = renderVersionPage({ environment: 'production', version: 7, status: 'available', contents: CONTENTS });
    expect(html).toContain('<p class="muted">ops · <time');
    expect(html).toContain('<p>Launch</p>');
    expect(html).toContain('<pre id="version-json">');
    expect(html).toContain('<table class="flag-table">');
  });

  it('omits an empty reason and renders an invalid version as its issues', () => {
    const quiet = { ...CONTENTS, metadata: { ...METADATA, reason: '' } };
    expect(renderVersionPage({ environment: 'p', version: 1, status: 'available', contents: quiet })).not.toContain('<p></p>');
    const invalid = renderVersionPage({
      environment: 'p',
      version: 1,
      status: 'available',
      contents: { status: 'invalid', issues: [{ path: 'features', message: 'bad' }] },
    });
    expect(invalid).toContain('<li>features: bad</li>');
    expect(invalid).not.toContain('version-json');
  });
});
