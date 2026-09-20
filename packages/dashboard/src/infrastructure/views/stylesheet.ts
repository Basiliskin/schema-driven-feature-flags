import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Order matters: tokens first, then layout, then the components that use both.
const STYLE_FILES = ['base.css', 'layout.css', 'forms.css', 'components.css', 'tables.css', 'rollout.css', 'segments.css', 'segment-list.css'] as const;

/** All style files joined into one sheet; plain concatenation, so there is no build tool. */
export const STYLESHEET = STYLE_FILES.map((file) =>
  readFileSync(new URL(`./styles/${file}`, import.meta.url), 'utf8'),
).join('\n');

export const STYLESHEET_PATH = '/assets/app.css';

/** The content hash in the query lets browsers cache the sheet for good and still pick up a new release. */
export const STYLESHEET_HREF = `${STYLESHEET_PATH}?v=${createHash('sha256').update(STYLESHEET).digest('hex').slice(0, 12)}`;
