import { escapeHtml } from './escape.js';
import { STYLESHEET_HREF } from './stylesheet.js';

export interface Notice {
  readonly kind: 'success' | 'warning' | 'error';
  readonly message: string;
  readonly details?: readonly string[];
}

const renderNotice = (notice: Notice): string => {
  const details =
    notice.details === undefined || notice.details.length === 0
      ? ''
      : `<ul>${notice.details.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
  return `<div class="notice ${notice.kind}" role="status"><p>${escapeHtml(notice.message)}</p>${details}</div>`;
};

// Progressive enhancement only: reveals the copy buttons, dialog triggers and list filters, wiring them with addEventListener,
// so the page adds no inline event handlers and works fully without JavaScript.
const COPY_SCRIPT = `<script>
document.querySelectorAll('[data-copy]').forEach(function (button) {
  var source = document.getElementById(button.getAttribute('data-copy'));
  if (!source || !navigator.clipboard) return;
  button.hidden = false;
  button.addEventListener('click', function () {
    navigator.clipboard.writeText(source.textContent).then(function () {
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy JSON'; }, 1500);
    });
  });
});
document.querySelectorAll('dialog').forEach(function (dialog) {
  if (typeof dialog.showModal !== 'function') return;
  dialog.classList.add('is-enhanced');
  if (dialog.hasAttribute('data-open-on-load')) dialog.showModal();
});
document.querySelectorAll('[data-open-dialog]').forEach(function (button) {
  var dialog = document.getElementById(button.getAttribute('data-open-dialog'));
  if (!dialog || !dialog.classList.contains('is-enhanced')) return;
  button.hidden = false;
  button.addEventListener('click', function () { dialog.showModal(); });
});
document.querySelectorAll('[data-filter]').forEach(function (input) {
  var list = document.querySelector('.' + input.getAttribute('data-filter'));
  if (!list) return;
  var empty = list.parentNode.querySelector('[data-filter-empty]');
  input.hidden = false;
  input.addEventListener('input', function () {
    var terms = input.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    var shown = 0;
    list.querySelectorAll('[data-search]').forEach(function (item) {
      var text = item.getAttribute('data-search');
      var match = terms.every(function (term) { return text.indexOf(term) !== -1; });
      item.hidden = !match;
      if (match) shown++;
    });
    if (empty) empty.hidden = shown !== 0;
  });
});
</script>`;

export const renderPage = (title: string, body: string, notices: readonly Notice[] = []): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · FeatureSync</title>
<link rel="stylesheet" href="${escapeHtml(STYLESHEET_HREF)}">
</head>
<body>
<header class="site-header"><div class="container"><a class="brand" href="/">FeatureSync dashboard</a></div></header>
<main class="container">
${notices.map(renderNotice).join('\n')}
${body}
</main>
${COPY_SCRIPT}
</body>
</html>
`;

/** A collapsible raw-JSON block with a copy button that only appears when scripting is available. */
export const renderRawJson = (id: string, value: unknown): string => `<details>
<summary>Raw JSON</summary>
<div class="stack">
<button type="button" class="button-secondary" data-copy="${escapeHtml(id)}" hidden>Copy JSON</button>
<pre id="${escapeHtml(id)}"><code>${escapeHtml(JSON.stringify(value, null, 2))}</code></pre>
</div>
</details>`;

/** Renders an ISO timestamp as `YYYY-MM-DD HH:MM UTC`, keeping the exact value in `datetime`. */
export const renderTimestamp = (iso: string): string =>
  `<time datetime="${escapeHtml(iso)}">${escapeHtml(new Date(iso).toISOString().slice(0, 16).replace('T', ' '))} UTC</time>`;
