import { describe, expect, it } from 'vitest';
import type { EnvironmentView } from '../../application/browse-environment.js';
import type { PublishedSegmentRow } from '../../application/list-published-segments.js';
import { renderEnvironmentPage } from './environment-page.js';
import { renderSegmentListPage, segmentListPath, type SegmentListPageView } from './segment-list-page.js';
import { STYLESHEET } from './stylesheet.js';

const MEMBER = 'bob@x.io';

const row = (overrides: Partial<PublishedSegmentRow> = {}): PublishedSegmentRow => ({
  segmentKey: 'beta',
  version: 4,
  attribute: { status: 'known', memberAttribute: 'userId' },
  usage: { status: 'used', flagKeys: ['checkout'] },
  ...overrides,
});

const listed = (...rows: readonly PublishedSegmentRow[]): SegmentListPageView => ({
  environment: 'production',
  listing: { status: 'listed', rows },
});

describe('the segment list page', () => {
  it('renders a row for every published segment, including one no flag references', () => {
    const html = renderSegmentListPage(
      listed(row(), row({ segmentKey: 'staff', version: 2, usage: { status: 'unused' } })),
    );

    expect(html).toContain('<a href="/env/production/segments/beta">beta</a>');
    expect(html).toContain('version 4');
    expect(html).toContain('<a href="/env/production/segments/staff">staff</a>');
    expect(html).toContain('version 2');
  });

  it('renders version 0 as a published version rather than an empty cell', () => {
    expect(renderSegmentListPage(listed(row({ version: 0 })))).toContain('version 0');
  });

  it('shows the stored member attribute under its own column', () => {
    const html = renderSegmentListPage(listed(row({ attribute: { status: 'known', memberAttribute: 'accountId' } })));

    expect(html).toContain('<th scope="col">Member attribute</th>');
    expect(html).toContain('<td data-label="Member attribute">accountId</td>');
  });

  it('says an absent member attribute is unrecorded rather than leaving the cell blank or guessing one', () => {
    const html = renderSegmentListPage(listed(row({ attribute: { status: 'unknown' } })));

    expect(html).toContain('unknown (published before attributes were recorded)');
    expect(html).not.toContain('<td data-label="Member attribute"></td>');
    expect(html).not.toContain('>userId<');
  });

  it('lists every flag using a segment, separated so the keys stay distinguishable', () => {
    const html = renderSegmentListPage(listed(row({ usage: { status: 'used', flagKeys: ['checkout', 'search'] } })));

    expect(html).toContain('<th scope="col">Used by flags</th>');
    expect(html).toContain('<span class="segment-user">checkout</span>, <span class="segment-user">search</span>');
  });

  it('marks an unattached segment in words that a flag key cannot be confused with', () => {
    const html = renderSegmentListPage(listed(row({ usage: { status: 'unused' } })));

    expect(html).toContain('<span class="segment-unused">used by no flag</span>');
    expect(html).not.toContain('<td data-label="Used by flags"></td>');
  });

  it('escapes a flag key that contains markup', () => {
    const html = renderSegmentListPage(listed(row({ usage: { status: 'used', flagKeys: ['a"<b'] } })));

    expect(html).toContain('<span class="segment-user">a&quot;&lt;b</span>');
  });

  it('shows no member data, member count or timestamp', () => {
    const html = renderSegmentListPage(listed(row()));

    expect(html).not.toContain(MEMBER);
    expect(html).not.toMatch(/\d+ members/);
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('describes the table as the published set, not the keys the snapshot happens to reference', () => {
    const html = renderSegmentListPage(listed(row()));

    expect(html).toContain('Every segment published in this environment');
    expect(html).not.toContain('snapshot’s rules reference');
  });

  it('says nothing is published yet when the listing succeeded and was empty', () => {
    const html = renderSegmentListPage(listed());

    expect(html).not.toContain('<table');
    expect(html).toContain('No segments published yet in this environment.');
  });

  it('renders an unreadable catalogue as its own state rather than as an empty one', () => {
    const html = renderSegmentListPage({ environment: 'production', listing: { status: 'unavailable' } });

    expect(html).toContain('The segment catalogue could not be read');
    expect(html).not.toContain('No segments published yet');
    expect(html).not.toContain('<table');
  });

  it('escapes the key in the cell and encodes it in the link', () => {
    const html = renderSegmentListPage(listed(row({ segmentKey: 'a"<b' })));

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
    expect(STYLESHEET).toContain('.segment-unknown');
    expect(STYLESHEET).toContain('.segment-unused');
    expect(STYLESHEET).toContain('.segment-create');
  });
});

describe('the create segment form', () => {
  const LIST: SegmentListPageView = { environment: 'pro d', listing: { status: 'listed', rows: [] } };

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

  it('says a newly created segment shows up in the table straight away', () => {
    expect(renderSegmentListPage(LIST)).toContain('appears in the table above as soon as it is published');
  });

  it('never echoes CSV contents back into the page', () => {
    const html = renderSegmentListPage(LIST, { draft: { key: 'beta', memberAttribute: 'userId' } });

    expect(html).not.toContain(MEMBER);
    expect(html).toContain('<input type="hidden" name="csv" value="">');
  });
});
