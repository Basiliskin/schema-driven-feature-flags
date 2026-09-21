import { describe, expect, it } from 'vitest';
import { STYLESHEET, STYLE_FILES } from './stylesheet.js';

describe('STYLE_FILES', () => {
  it('registers side-menu.css after shell.css, so the menu rules cascade over the shell grid', () => {
    expect(STYLE_FILES.indexOf('side-menu.css')).toBe(STYLE_FILES.indexOf('shell.css') + 1);
  });

  it('registers shell.css right after layout.css, so the shell grid cascades over the base frame', () => {
    expect(STYLE_FILES.indexOf('shell.css')).toBe(STYLE_FILES.indexOf('layout.css') + 1);
  });

  it('serves the side menu rules as part of the one sheet', () => {
    expect(STYLESHEET).toContain('.side-menu {');
  });

  it('no longer registers or serves the replaced section nav', () => {
    expect(STYLE_FILES).not.toContain('section-nav.css');
    expect(STYLESHEET).not.toContain('.section-nav');
  });

  it('registers dialog.css after components.css, so the dialog beats the generic card rules', () => {
    expect(STYLE_FILES.indexOf('dialog.css')).toBe(STYLE_FILES.indexOf('components.css') + 1);
  });

  it('keeps the dialog rules in dialog.css alone, with nothing left under the old publish-only name', () => {
    expect(STYLESHEET).toContain('.modal-dialog {');
    expect(STYLESHEET).not.toContain('.publish-dialog');
  });

  it('serves the page shell rules as part of the one sheet', () => {
    expect(STYLESHEET).toContain('.page-shell {');
  });
});
