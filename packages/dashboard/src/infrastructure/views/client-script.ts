import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The pages' progressive-enhancement script, served as a file rather than inlined so it stays readable. */
export const CLIENT_SCRIPT = readFileSync(new URL('./scripts/app.js', import.meta.url), 'utf8');

export const CLIENT_SCRIPT_PATH = '/assets/app.js';

/** Content-hashed like the stylesheet, so it can be cached for good and still update with a release. */
export const CLIENT_SCRIPT_HREF = `${CLIENT_SCRIPT_PATH}?v=${createHash('sha256').update(CLIENT_SCRIPT).digest('hex').slice(0, 12)}`;
