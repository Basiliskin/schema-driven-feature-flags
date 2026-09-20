import { describe, expect, it } from 'vitest';
import type { EnvironmentView } from '../../application/browse-environment.js';
import { renderEnvironmentPage } from './environment-page.js';
import { renderSegmentListPage, segmentListPath } from './segment-list-page.js';
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
    expect(html).not.toContain('member');
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
  });
});
