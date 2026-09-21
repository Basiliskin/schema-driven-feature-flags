import { parseSnapshot } from '@featuresync/core';
import { describe, expect, it } from 'vitest';
import {
  browseEnvironment,
  ENVIRONMENT_VERSION_WINDOW,
  type BrowsePorts,
  type EnvironmentView,
  type FlagDefinitionView,
} from '../../application/browse-environment.js';
import { parseUrlState, serialiseUrlState } from '../url-state.js';
import { renderEnvironmentPage } from './environment-page.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

const prefilledSnapshot = (html: string): Record<string, unknown> => {
  const textarea = /<textarea id="snapshot"[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
  if (textarea === null) throw new Error('the page rendered no snapshot textarea');
  const text = (textarea[1] as string).replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ENTITIES[entity] as string);
  return JSON.parse(text) as Record<string, unknown>;
};

const publishedView = (schemaVersion: number): Extract<EnvironmentView, { status: 'published' }> => {
  const raw = {
    schemaVersion,
    environment: 'production',
    version: 7,
    previousVersion: 6,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'someone',
    reason: 'A reason',
    features: {},
  };
  return {
    environment: 'production',
    status: 'published',
    currentVersion: 7,
    versions: [{ version: 7 }],
    current: {
      environment: 'production',
      version: 7,
      status: 'available',
      contents: { status: 'valid', flags: [], metadata: { createdAt: raw.createdAt, createdBy: raw.createdBy, reason: raw.reason }, segmentKeys: [], raw },
    },
  };
};

describe('the first version template', () => {
  it('prefills schemaVersion 2 so a new environment can hold segment rules', () => {
    const template = prefilledSnapshot(renderEnvironmentPage({ environment: 'production', status: 'empty' }));

    expect(template['schemaVersion']).toBe(2);
  });

  it('is a snapshot core accepts once the publisher stamps it', () => {
    const template = prefilledSnapshot(renderEnvironmentPage({ environment: 'production', status: 'empty' }));

    const result = parseSnapshot({ ...template, version: 1, previousVersion: null, createdAt: '2026-01-01T00:00:00.000Z' });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.schemaVersion).toBe(2);
  });

  it('leaves an existing schemaVersion 1 environment on version 1', () => {
    const template = prefilledSnapshot(renderEnvironmentPage(publishedView(1)));

    expect(template['schemaVersion']).toBe(1);
  });
});

describe('the version history section', () => {
  const portsOver = (totalVersions: number): BrowsePorts => ({
    readCurrentVersion: () => Promise.resolve(totalVersions),
    fetchSnapshotText: (environment, version) =>
      Promise.resolve(
        JSON.stringify({
          schemaVersion: 2,
          environment,
          version,
          previousVersion: version - 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          createdBy: 'someone',
          reason: 'A reason',
          features: {},
        }),
      ),
  });

  it('stays bounded to the newest window on a long history and links to the full list', async () => {
    const html = renderEnvironmentPage(await browseEnvironment(portsOver(40), 'production'));

    expect(html.match(/Restore version /g)).toHaveLength(ENVIRONMENT_VERSION_WINDOW - 1);
    expect(html).toContain('<a href="/env/production/versions">View all versions</a>');
  });
});

describe('the flag filter form', () => {
  const FLAGS: readonly FlagDefinitionView[] = [
    { key: 'new-dashboard', type: 'boolean', enabled: true, defaultValue: true, ruleCount: 0, rules: [] },
    { key: 'checkout-limits', type: 'config', enabled: false, defaultValue: { max: 3 }, ruleCount: 0, rules: [] },
  ];

  const viewWithFlags = (): EnvironmentView => {
    const view = publishedView(2);
    const current = view.current as Extract<typeof view.current, { status: 'available' }>;
    const contents = current.contents as Extract<typeof current.contents, { status: 'valid' }>;
    return { ...view, current: { ...current, contents: { ...contents, flags: FLAGS } } };
  };

  const render = (query: string): string =>
    renderEnvironmentPage(viewWithFlags(), { urlState: parseUrlState(new URLSearchParams(query)) });

  it('is a visible GET form whose value echoes the filter', () => {
    const html = render('filter=checkout');

    expect(html).toContain('<form class="flag-filter-form" method="get" action="/env/production">');
    expect(html).toContain('name="filter" value="checkout"');
    expect(/<input type="search"[^>]*\bhidden\b/.test(html)).toBe(false);
  });

  it('renders the filter form and a hidden no-match message when every flag matches', () => {
    const html = render('');

    expect(html).toContain('name="filter" value=""');
    expect(html).toContain('<p class="muted" data-filter-empty hidden>No flags match.</p>');
  });

  it('shows the no-match message and an empty list when nothing matches', () => {
    const html = render('filter=zzz');

    expect(html).toContain('<ul class="flag-list"></ul>');
    expect(html).toContain('<p class="muted" data-filter-empty>No flags match.</p>');
    expect(html).not.toContain('data-flag=');
  });

  it('omits the filter form entirely when the snapshot defines no flags', () => {
    const html = renderEnvironmentPage(publishedView(2));

    expect(html).not.toContain('flag-filter-form');
    expect(html).toContain('This snapshot defines no flags.');
  });

  it('escapes an ampersand in the attribute and percent-encodes it in a carried value', () => {
    const html = render(`filter=${encodeURIComponent('a & b')}&open=${encodeURIComponent('a&b')}`);

    expect(html).toContain('name="filter" value="a &amp; b"');
    expect(html).toContain('<input type="hidden" name="open" value="a&amp;b">');
    expect(serialiseUrlState({ filter: 'a & b' })).toBe('filter=a%20%26%20b');
  });

  describe('rows opened by the URL', () => {
    it('renders the row named in the open list expanded and the others collapsed', () => {
      const html = render('open=checkout-limits');

      expect(html).toContain('<li class="card flag" data-flag="checkout-limits"');
      expect(html.slice(html.indexOf('data-flag="checkout-limits"'))).toContain('<details class="flag-row" open>');
      expect(html.slice(html.indexOf('data-flag="new-dashboard"'))).toContain('<details class="flag-row">');
    });

    it('gives each row a toggle link that keeps the filter and the other open keys', () => {
      const html = render('filter=e&open=checkout-limits');

      expect(html).toContain('data-open-toggle href="/env/production?filter=e"');
      expect(html).toContain('data-open-toggle href="/env/production?filter=e&amp;open=checkout-limits%2Cnew-dashboard"');
    });

    it('renders every row collapsed with an add-only toggle link when the page is asked for with no query', () => {
      const html = renderEnvironmentPage(viewWithFlags());

      expect(html).not.toContain('<details class="flag-row" open>');
      expect(html).toContain('data-open-toggle href="/env/production?open=new-dashboard"');
      expect(html).toContain('data-open-toggle href="/env/production?open=checkout-limits"');
    });
  });
});

describe('the URL state the new-flag and publish forms carry', () => {
  const FLAGS: readonly FlagDefinitionView[] = [
    { key: 'new-dashboard', type: 'boolean', enabled: true, defaultValue: true, ruleCount: 0, rules: [] },
  ];

  const viewWithFlags = (): EnvironmentView => {
    const view = publishedView(2);
    const current = view.current as Extract<typeof view.current, { status: 'available' }>;
    const contents = current.contents as Extract<typeof current.contents, { status: 'valid' }>;
    return { ...view, current: { ...current, contents: { ...contents, flags: FLAGS } } };
  };

  const render = (query: string): string =>
    renderEnvironmentPage(viewWithFlags(), { urlState: parseUrlState(new URLSearchParams(query)) });

  it('sends it with a new flag, in the form and in its action', () => {
    const html = render('filter=new&open=new-dashboard');
    const body = html.slice(html.indexOf('<summary>New flag</summary>'));

    expect(body).toContain('action="/env/production/features?filter=new&amp;open=new-dashboard"');
    expect(body).toContain('<input type="hidden" name="filter" value="new">');
    expect(body).toContain('<input type="hidden" name="open" value="new-dashboard">');
  });

  it('sends it with a published snapshot, so a rejected publish comes back to the same view', () => {
    const html = render('filter=new');
    const dialog = html.slice(html.indexOf('<dialog id="publish-dialog"'));

    expect(dialog).toContain('action="/env/production/publish?filter=new"');
    expect(dialog).toContain('<input type="hidden" name="filter" value="new">');
  });

  it('leaves both forms free of hidden state when the page was asked for with no query', () => {
    const html = renderEnvironmentPage(viewWithFlags());

    expect(html).toContain('action="/env/production/features"');
    expect(html).toContain('action="/env/production/publish"');
    expect(html).not.toContain('name="filter" value="new"');
  });
});

describe('section nav', () => {
  it('renders above the current snapshot card with links to the sections the page rendered', () => {
    const html = renderEnvironmentPage(publishedView(2), { urlState: { ...parseUrlState(new URLSearchParams()), filter: 'dark' } });
    const nav = /<nav class="section-nav" aria-label="Sections">([\s\S]*?)<\/nav>/.exec(html);
    expect(nav).not.toBeNull();
    expect((nav as RegExpExecArray)[1]).toBe(
      '<a href="/env/production?filter=dark#current-heading">Current snapshot</a>' +
        '<a href="/env/production?filter=dark#flags-heading">Flags</a>' +
        '<a href="/env/production?filter=dark#versions-heading">Version history</a>',
    );
    expect(html.indexOf('class="section-nav"')).toBeLessThan(html.indexOf('id="current-heading"'));
  });

  it('links only the anchors the page actually renders, so no link points at a missing section', () => {
    const view = publishedView(2);
    const html = renderEnvironmentPage(view);
    for (const id of ['current-heading', 'flags-heading', 'versions-heading']) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`#${id}"`);
    }
  });

  it('drops the flags link when the current snapshot file is unavailable', () => {
    const view = publishedView(2);
    const html = renderEnvironmentPage({ ...view, current: { environment: 'production', version: 7, status: 'not-available' } });
    expect(html).not.toContain('#flags-heading');
    expect(html).toContain('#current-heading');
    expect(html).toContain('#versions-heading');
  });
});
