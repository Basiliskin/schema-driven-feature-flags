import { describe, expect, it } from 'vitest';
import { NO_URL_STATE } from '../url-state.js';
import { CURRENT_SECTION, FLAGS_SECTION, VERSIONS_SECTION, renderSectionNav } from './section-nav.js';

const ALL = [CURRENT_SECTION, FLAGS_SECTION, VERSIONS_SECTION];

describe('renderSectionNav', () => {
  it('labels the nav and links every section by its heading id', () => {
    expect(renderSectionNav('production', NO_URL_STATE, ALL)).toBe(
      '<nav class="section-nav" aria-label="Sections">' +
        '<a href="/env/production#current-heading">Current snapshot</a>' +
        '<a href="/env/production#flags-heading">Flags</a>' +
        '<a href="/env/production#versions-heading">Version history</a>' +
        '</nav>',
    );
  });

  it('carries the current filter and open rows, with the fragment after the query', () => {
    expect(renderSectionNav('production', { ...NO_URL_STATE, filter: 'dark', openFlags: ['a', 'b'] }, [FLAGS_SECTION])).toBe(
      '<nav class="section-nav" aria-label="Sections">' +
        '<a href="/env/production?filter=dark&amp;open=a%2Cb#flags-heading">Flags</a>' +
        '</nav>',
    );
  });

  it('escapes a filter that would otherwise break out of the href attribute', () => {
    expect(renderSectionNav('production', { ...NO_URL_STATE, filter: '" x & y' }, [FLAGS_SECTION])).toContain(
      'href="/env/production?filter=%22%20x%20%26%20y#flags-heading"',
    );
  });

  it('renders an empty nav when the page has no sections to offer', () => {
    expect(renderSectionNav('production', NO_URL_STATE, [])).toBe('<nav class="section-nav" aria-label="Sections"></nav>');
  });
});
