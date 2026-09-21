import { describe, expect, it } from 'vitest';
import { NO_URL_STATE } from '../url-state.js';
import type { VersionPage } from '../../application/list-version-page.js';
import { renderEnvironmentPage } from './environment-page.js';
import { renderVersionItem, renderVersionListPage, versionsPath } from './version-list-page.js';

const metadata = { createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'someone', reason: 'A reason' };

const page = (overrides: Partial<VersionPage> = {}): VersionPage => ({
  environment: 'production',
  page: 1,
  pageSize: 20,
  totalVersions: 3,
  entries: [{ version: 3, metadata }, { version: 2, metadata }, { version: 1 }],
  hasNewer: false,
  hasOlder: false,
  ...overrides,
});

describe('versionsPath', () => {
  it('leaves the query string off page 1 and encodes the environment', () => {
    expect(versionsPath('production')).toBe('/env/production/versions');
    expect(versionsPath('a/b')).toBe('/env/a%2Fb/versions');
  });

  it('carries the page number for every later page', () => {
    expect(versionsPath('production', 4)).toBe('/env/production/versions?page=4');
  });
});

describe('the version history page', () => {
  it('lists the page newest first, badging the current version and offering to restore the others', () => {
    const html = renderVersionListPage(page());

    expect(html).toContain('<h1>production · version history</h1>');
    expect(html.indexOf('Version 3')).toBeLessThan(html.indexOf('Version 1'));
    expect(html).toContain('<a href="/env/production/versions/3">Version 3</a><span class="badge badge-accent">current</span>');
    expect(html).toContain('<button type="submit" class="button-secondary">Restore version 2</button>');
    expect(html).toContain('<p class="muted">Details unavailable.</p>');
  });

  it('renders an Older link and no Newer link on the first page', () => {
    const html = renderVersionListPage(page({ hasOlder: true }));

    expect(html).toContain('<a href="/env/production/versions?page=2">Older versions</a>');
    expect(html).not.toContain('Newer versions');
  });

  it('renders a Newer link and no Older link on the last page', () => {
    const html = renderVersionListPage(page({ page: 3, hasNewer: true }));

    expect(html).toContain('<a href="/env/production/versions?page=2">Newer versions</a>');
    expect(html).not.toContain('Older versions');
  });

  it('renders no pager at all when the whole history fits on one page', () => {
    expect(renderVersionListPage(page())).not.toContain('More version history');
  });

  it('shows an empty-state message rather than an empty list past the end of the history', () => {
    const html = renderVersionListPage(page({ page: 99, entries: [], hasNewer: true }));

    expect(html).toContain('There is no version history on this page. This environment has 3 versions.');
    expect(html).not.toContain('<ol class="timeline"');
  });

  it('counts a single-version environment in the singular', () => {
    const html = renderVersionListPage(page({ page: 2, entries: [], totalVersions: 1, hasNewer: true }));

    expect(html).toContain('This environment has 1 version.');
  });

  it('escapes the environment name in every link it renders', () => {
    const html = renderVersionListPage(page({ environment: '<script>"', hasOlder: true }));

    expect(html).toContain('href="/env/%3Cscript%3E%22/versions?page=2"');
    expect(html).not.toContain('<script>"');
  });
});

describe('the shared version item', () => {
  it('renders the same rollback form the environment page uses', () => {
    const item = renderVersionItem({ environment: 'production', currentVersion: 3, urlState: NO_URL_STATE }, { version: 2, metadata });

    const environmentPage = renderEnvironmentPage({
      environment: 'production',
      status: 'published',
      currentVersion: 3,
      versions: [{ version: 2, metadata }, { version: 3, metadata }],
      current: { environment: 'production', version: 3, status: 'not-available' },
    });

    expect(environmentPage).toContain(item);
    expect(renderVersionListPage(page({ totalVersions: 3 }))).toContain(item);
  });

  it('leaves out an empty reason', () => {
    const item = renderVersionItem(
      { environment: 'production', currentVersion: 3, urlState: NO_URL_STATE },
      { version: 2, metadata: { ...metadata, reason: '' } },
    );

    expect(item).not.toContain('A reason');
    expect(item).toContain('someone ·');
  });
});

describe('the URL state the rollback form carries', () => {
  it('sends it with the restore, in the form and in its action', () => {
    const item = renderVersionItem(
      { environment: 'production', currentVersion: 3, urlState: { filter: 'dark', openFlags: ['a&b'], page: 1, pageSize: 20 } },
      { version: 2, metadata },
    );

    expect(item).toContain('action="/env/production/rollback?filter=dark&amp;open=a%26b"');
    expect(item).toContain('<input type="hidden" name="filter" value="dark">');
    expect(item).toContain('<input type="hidden" name="open" value="a&amp;b">');
  });

  it('carries the page being viewed, so restoring from page 2 of the history comes back to page 2', () => {
    const html = renderVersionListPage(page({ page: 2, pageSize: 5, hasNewer: true }));

    expect(html).toContain('action="/env/production/rollback?page=2&amp;pageSize=5"');
    expect(html).toContain('<input type="hidden" name="page" value="2">');
  });

  it('leaves the form free of hidden state on the first page of the default size', () => {
    const html = renderVersionListPage(page());

    expect(html).toContain('action="/env/production/rollback"');
    expect(html).not.toContain('name="page" value=');
  });
});

describe('the side menu and the update watch on the version history', () => {
  it('marks Versions as the current view and watches the newest version', () => {
    const html = renderVersionListPage(page());

    expect(html).toContain('<a href="/env/production/versions" class="side-menu-item is-current" aria-current="page">Versions</a>');
    expect(html).toContain('data-watch-version="3"');
  });

  it('renders no update watch for an environment that has never published', () => {
    const html = renderVersionListPage(page({ totalVersions: 0, entries: [] }));

    expect(html).toContain('aria-current="page">Versions</a>');
    expect(html).not.toContain('data-watch-version');
  });
});
