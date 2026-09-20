import { describe, expect, it } from 'vitest';
import type { EnvironmentView } from '../../application/browse-environment.js';
import { renderEnvironmentPage } from './environment-page.js';
import { renderSegmentListPage, segmentListPath, type SegmentListPageView } from './segment-list-page.js';
import { STYLESHEET } from './stylesheet.js';

const MEMBER = 'bob@x.io';

describe('the segment list page', () => {
  it('renders one row per state, each key linking to its segment page', () => {
    const html = renderSegmentListPage({
      environment: 'production',
      rows: [
        { key: 'beta', state: 'published', version: 4 },
        { key: 'staff', state: 'not-published' },
        { key: 'eu', state: 'unavailable' },
      ],
    });

    expect(html).toContain('<a href="/env/production/segments/beta">beta</a>');
    expect(html).toContain('version 4');
    expect(html).toContain('<a href="/env/production/segments/staff">staff</a>');
    expect(html).toContain('>not published<');
    expect(html).toContain('<a href="/env/production/segments/eu">eu</a>');
    expect(html).toContain('>unavailable<');
  });

  it('renders version 0 as a published version rather than an empty cell', () => {
    const html = renderSegmentListPage({ environment: 'production', rows: [{ key: 'beta', state: 'published', version: 0 }] });

    expect(html).toContain('version 0');
    expect(html).not.toContain('not published');
  });

  it('shows no member data, member count or timestamp', () => {
    const html = renderSegmentListPage({ environment: 'production', rows: [{ key: 'beta', state: 'published', version: 4 }] });

    expect(html).not.toContain(MEMBER);
    expect(html).not.toMatch(/\d+ members/);
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('explains itself instead of rendering an empty table when no rule references a segment', () => {
    const html = renderSegmentListPage({ environment: 'production', rows: [] });

    expect(html).not.toContain('<table');
    expect(html).toContain('No flag rule in the current snapshot references a segment.');
  });

  it('escapes the key in the cell and encodes it in the link', () => {
    const html = renderSegmentListPage({ environment: 'production', rows: [{ key: 'a"<b', state: 'not-published' }] });

    expect(html).toContain('>a&quot;&lt;b<');
    expect(html).toContain('href="/env/production/segments/a%22%3Cb"');
  });

  it('builds the list path from the environment', () => {
    expect(segmentListPath('pro d')).toBe('/env/pro%20d/segments');
  });

  it('is linked from the environment page', () => {
    const view: EnvironmentView = { environment: 'production', status: 'empty' };

    expect(renderEnvironmentPage(view)).toContain('<a href="/env/production/segments">Segments</a>');
  });

  it('has its styles served in the stylesheet', () => {
    expect(STYLESHEET).toContain('.segment-unavailable');
    expect(STYLESHEET).toContain('.segment-create');
  });
});

describe('the create segment form', () => {
  const LIST: SegmentListPageView = { environment: 'pro d', rows: [] };

  it('posts the key, attribute and file to the environment it was rendered for', () => {
    const html = renderSegmentListPage(LIST);

    expect(html).toContain('<form method="post" action="/env/pro%20d/segments" class="stack" data-segment-upload>');
    expect(html).toContain('<input type="text" name="key" value=""');
    expect(html).toContain('<input type="text" name="memberAttribute" value="userId"');
    expect(html).toContain('<input type="file" name="file" accept=".csv,text/csv" required data-segment-file>');
  });

  it('carries the three markers the shared upload script looks for, and adds no script of its own', () => {
    const html = renderSegmentListPage(LIST);

    expect(html).toContain('data-segment-upload');
    expect(html).toContain('data-segment-file');
    expect(html).toContain('<input type="hidden" name="csv" value="">');
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('shows the published version after a successful create', () => {
    const html = renderSegmentListPage(LIST, { notices: [{ kind: 'success', message: 'Created as version 1.' }] });

    expect(html).toContain('Created as version 1.');
  });

  it('shows the failure notice and puts the typed values back in the inputs', () => {
    const html = renderSegmentListPage(LIST, {
      notices: [{ kind: 'error', message: 'That Segment Key is already in use.' }],
      draft: { key: 'beta', memberAttribute: 'accountId' },
    });

    expect(html).toContain('That Segment Key is already in use.');
    expect(html).toContain('<input type="text" name="key" value="beta"');
    expect(html).toContain('<input type="text" name="memberAttribute" value="accountId"');
  });

  it('escapes a draft that contains markup', () => {
    const html = renderSegmentListPage(LIST, { draft: { key: 'a"<b', memberAttribute: MEMBER } });

    expect(html).toContain('name="key" value="a&quot;&lt;b"');
    expect(html).not.toContain('value="a"<b"');
  });

  it('says a segment no rule references yet stays out of the table', () => {
    expect(renderSegmentListPage(LIST)).toContain('stays out of the table above until some flag rule references it');
  });

  it('never echoes CSV contents back into the page', () => {
    const html = renderSegmentListPage(LIST, { draft: { key: 'beta', memberAttribute: 'userId' } });

    expect(html).not.toContain(MEMBER);
    expect(html).toContain('<input type="hidden" name="csv" value="">');
  });
});
