import { describe, expect, it } from 'vitest';
import { renderPage } from './layout.js';

describe('renderPage', () => {
  it('renders a single centred main with no shell when no nav is given', () => {
    const html = renderPage('Flags', '<h1>Flags</h1>');

    expect(html).toContain('</header>\n<main class="container">\n\n<h1>Flags</h1>\n</main>\n<script');
    expect(html).not.toContain('page-shell');
    expect(html).not.toContain('<aside');
  });

  it('keeps notices inside main when no nav is given', () => {
    const html = renderPage('Flags', '<h1>Flags</h1>', [{ kind: 'error', message: 'Nope' }]);

    expect(html).toContain('<main class="container">\n<div class="notice error" role="status"><p>Nope</p></div>\n<h1>Flags</h1>\n</main>');
    expect(html).not.toContain('page-shell');
  });

  it('wraps the nav and main in the shell grid when a nav is given', () => {
    const html = renderPage('Flags', '<h1>Flags</h1>', [], '<nav>menu</nav>');

    expect(html).toContain(
      '<div class="page-shell">\n<aside class="page-shell-nav"><nav>menu</nav></aside>\n<main class="container">\n\n<h1>Flags</h1>\n</main>\n</div>',
    );
  });

  it('still renders notices inside main when a nav is given', () => {
    const html = renderPage('Flags', '<h1>Flags</h1>', [{ kind: 'success', message: 'Saved' }], '<nav>menu</nav>');

    expect(html).toContain('<aside class="page-shell-nav"><nav>menu</nav></aside>');
    expect(html).toContain('<div class="notice success" role="status"><p>Saved</p></div>');
  });
});
