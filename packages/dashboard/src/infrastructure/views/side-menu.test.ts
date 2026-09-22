import { describe, expect, it } from 'vitest';
import { NO_URL_STATE } from '../url-state.js';
import { renderSideMenu, type SideMenuView } from './side-menu.js';

const VIEWS: readonly SideMenuView[] = ['flags', 'versions', 'segments'];

describe('renderSideMenu', () => {
  it('links the three environment views by route, with the current one marked', () => {
    expect(renderSideMenu('production', 'flags', NO_URL_STATE)).toBe(
      '<nav class="side-menu" aria-label="Views">' +
        '<a href="/env/production" class="side-menu-item is-current" aria-current="page">Flags</a>' +
        '<a href="/env/production/versions" class="side-menu-item">Versions</a>' +
        '<a href="/env/production/segments" class="side-menu-item">Segments</a>' +
        '</nav>',
    );
  });

  it.each(VIEWS)('marks exactly the %s item when that view is current', (current) => {
    const html = renderSideMenu('production', current, NO_URL_STATE);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html.match(/is-current/g)).toHaveLength(1);
    const marked = /<a href="([^"]*)" class="side-menu-item is-current"/.exec(html);
    expect(marked).not.toBeNull();
    const expectedPath = { flags: '/env/production', versions: '/env/production/versions', segments: '/env/production/segments' }[current];
    expect((marked as RegExpExecArray)[1]).toBe(expectedPath);
  });

  it('carries the filter and paging onto every link, so navigating back keeps the view', () => {
    const html = renderSideMenu('production', 'versions', { ...NO_URL_STATE, filter: 'dark', page: 2 });
    expect(html).toContain('<a href="/env/production?filter=dark&amp;page=2" class="side-menu-item">Flags</a>');
    expect(html).toContain('href="/env/production/versions?filter=dark&amp;page=2"');
    expect(html).toContain('href="/env/production/segments?filter=dark&amp;page=2"');
  });

  it('encodes the environment and a filter containing reserved characters', () => {
    const html = renderSideMenu('pro d', 'flags', { ...NO_URL_STATE, filter: 'a&b c' });
    expect(html).toContain('/env/pro%20d?filter=a%26b%20c');
    expect(html).not.toContain('filter=a&b');
  });
});
