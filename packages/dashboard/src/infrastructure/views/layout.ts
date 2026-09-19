import { escapeHtml } from './escape.js';
import { CLIENT_SCRIPT_HREF } from './client-script.js';
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
<script src="${escapeHtml(CLIENT_SCRIPT_HREF)}" defer></script>
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
