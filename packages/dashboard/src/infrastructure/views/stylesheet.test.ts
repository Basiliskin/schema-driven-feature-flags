import { describe, expect, it } from 'vitest';
import { STYLESHEET, STYLE_FILES } from './stylesheet.js';

describe('STYLE_FILES', () => {
  it('registers section-nav.css after components.css, so its rules win over the shared ones', () => {
    expect(STYLE_FILES.indexOf('section-nav.css')).toBeGreaterThan(STYLE_FILES.indexOf('components.css'));
  });

  it('serves the section nav rules as part of the one sheet', () => {
    expect(STYLESHEET).toContain('.section-nav {');
  });
});
