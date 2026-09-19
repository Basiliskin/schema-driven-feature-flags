import { escapeHtml } from './escape.js';

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
<title>${escapeHtml(title)} · FeatureSync</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
table { border-collapse: collapse; }
th, td { border: 1px solid #ccc; padding: .25rem .5rem; text-align: left; }
textarea { width: 100%; font-family: monospace; }
.notice { border-left: 4px solid; padding: .25rem 1rem; margin: 1rem 0; }
.success { border-color: #2a7; } .warning { border-color: #d90; } .error { border-color: #c33; }
</style>
</head>
<body>
<p><a href="/">FeatureSync dashboard</a></p>
${notices.map(renderNotice).join('\n')}
${body}
</body>
</html>
`;
