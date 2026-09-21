import { parseSnapshot } from '@featuresync/core';
import { describe, expect, it } from 'vitest';
import type { EnvironmentView, FlagDefinitionView } from '../../application/browse-environment.js';
import type { PendingChangeSet } from '../../domain/pending-change-set.js';
import { parseUrlState, serialiseUrlState } from '../url-state.js';
import { renderEnvironmentPage } from './environment-page.js';
import { pendingInputs } from './state-fields.js';

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
    const body = html.slice(html.indexOf('<dialog id="new-flag-dialog"'));

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

describe('side menu', () => {
  it('renders the Views menu in the shell nav slot with Flags marked current', () => {
    const html = renderEnvironmentPage(publishedView(2), { urlState: { ...parseUrlState(new URLSearchParams()), filter: 'dark' } });
    expect(html).toContain('<aside class="page-shell-nav"><nav class="side-menu" aria-label="Views">');
    expect(html).toContain('<a href="/env/production?filter=dark" class="side-menu-item is-current" aria-current="page">Flags</a>');
    expect(html).toContain('<a href="/env/production/versions?filter=dark" class="side-menu-item">Versions</a>');
    expect(html).toContain('<a href="/env/production/segments?filter=dark" class="side-menu-item">Segments</a>');
  });

  it('marks only the Flags item, and renders the menu outside main', () => {
    const html = renderEnvironmentPage(publishedView(2));
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html.indexOf('class="side-menu"')).toBeLessThan(html.indexOf('<main class="container">'));
  });

  it('no longer renders the replaced in-page section anchors', () => {
    const html = renderEnvironmentPage(publishedView(2));
    expect(html).not.toContain('section-nav');
    expect(html).not.toContain('#current-heading');
    expect(html).not.toContain('#flags-heading');
    expect(html).not.toContain('#versions-heading');
  });
});

describe('the staged draft the page hands back on every submit', () => {
  const FLAGS: readonly FlagDefinitionView[] = [
    { key: 'new-dashboard', type: 'boolean', enabled: true, defaultValue: true, ruleCount: 0, rules: [] },
    { key: 'checkout-limits', type: 'config', enabled: false, defaultValue: { max: 3 }, ruleCount: 0, rules: [] },
  ];
  const PENDING: PendingChangeSet = { baseVersion: 5, snapshot: { features: {} } };
  const FIELD = pendingInputs(PENDING);

  const viewWithFlags = (): EnvironmentView => {
    const view = publishedView(2);
    const current = view.current as Extract<typeof view.current, { status: 'available' }>;
    const contents = current.contents as Extract<typeof current.contents, { status: 'valid' }>;
    return { ...view, current: { ...current, contents: { ...contents, flags: FLAGS } } };
  };

  const render = (pending?: PendingChangeSet): string => renderEnvironmentPage(viewWithFlags(), { pending });
  const from = (html: string, marker: string): string => html.slice(html.indexOf(marker));
  const baseVersions = (html: string): string[] =>
    [...html.matchAll(/name="baseVersion" value="(\d+)"/g)].map((match) => match[1] as string);

  it('puts the hidden field in every form that submits, whichever way it builds its inputs', () => {
    const html = render(PENDING);
    const submitting = html.match(/<form\b(?![^>]*method="dialog")/g) ?? [];

    expect(submitting.length).toBeGreaterThanOrEqual(6);
    expect(html.match(/name="pending"/g)).toHaveLength(submitting.length);
  });

  it('puts it in the filter form, the new-flag form and the publish form each', () => {
    const html = render(PENDING);
    const formAt = (marker: string): string => {
      const rest = from(html, marker);
      return rest.slice(0, rest.indexOf('</form>'));
    };

    expect(formAt('<form class="flag-filter-form"')).toContain(FIELD);
    expect(formAt('<form method="post" action="/env/production/features"')).toContain(FIELD);
    expect(formAt('<form method="post" action="/env/production/publish"')).toContain(FIELD);
  });

  it('renders no pending field at all when nothing is staged', () => {
    expect(render()).not.toContain('name="pending"');
  });

  it('keeps the edit forms on the version the draft started from once the environment has moved ahead', () => {
    const versions = baseVersions(render(PENDING));

    expect(versions.slice(0, -1).every((version) => version === '5')).toBe(true);
    expect(versions.slice(0, -1).length).toBeGreaterThan(1);
    expect(versions.at(-1)).toBe('7');
  });

  it('builds the forms from the current version when nothing is staged', () => {
    expect(new Set(baseVersions(render()))).toEqual(new Set(['7']));
  });
});

describe('the Review Dialog on the environment page', () => {
  const FLAGS: readonly FlagDefinitionView[] = [
    { key: 'new-dashboard', type: 'boolean', enabled: true, defaultValue: true, ruleCount: 0, rules: [] },
  ];
  const PENDING: PendingChangeSet = { baseVersion: 5, snapshot: { features: {} } };
  const REVIEW = { baseFlags: FLAGS, stagedFlags: [{ ...FLAGS[0], enabled: false }] as never, drifted: false };
  const TRIGGER = '<button type="button" data-open-dialog="review-dialog" hidden>Review pending changes</button>';

  const view = (): EnvironmentView => {
    const published = publishedView(2);
    const current = published.current as Extract<typeof published.current, { status: 'available' }>;
    const contents = current.contents as Extract<typeof current.contents, { status: 'valid' }>;
    return { ...published, current: { ...current, contents: { ...contents, flags: FLAGS } } };
  };

  it('offers the dialog and its trigger in the flags header, before the new-flag trigger', () => {
    const html = renderEnvironmentPage(view(), { pending: PENDING, review: REVIEW });

    expect(html).toContain(`${TRIGGER}<button type="button" data-open-dialog="new-flag-dialog" hidden>New flag</button></div>`);
    expect(html).toContain('<dialog id="review-dialog" class="modal-dialog" aria-labelledby="review-heading">');
    expect(html).toContain('<span class="badge diff-changed">changed</span>');
  });

  it('opens on load only when the route says the operator just staged something', () => {
    expect(renderEnvironmentPage(view(), { pending: PENDING, review: REVIEW, reviewOpen: true })).toContain(
      'aria-labelledby="review-heading" data-open-on-load>',
    );
    expect(renderEnvironmentPage(view(), { pending: PENDING, review: REVIEW })).not.toContain('data-open-on-load');
  });

  it.each([
    ['nothing is staged', { review: REVIEW }],
    ['no review was loaded for the draft', { pending: PENDING }],
    ['neither exists', {}],
  ] as const)('leaves the dialog and its trigger out when %s', (_case, state) => {
    const html = renderEnvironmentPage(view(), state);

    expect(html).not.toContain('review-dialog');
  });
});
