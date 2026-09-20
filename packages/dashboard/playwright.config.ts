import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { defineConfig } from '@playwright/test';

// Developers get AWS/LocalStack settings from the repo-root .env; CI sets them as job-level env.
// Assigning only the keys process.env leaves undefined keeps CI authoritative.
// Anchored to this file, not cwd: playwright may be invoked from the repo root, where a relative
// path would silently resolve to nothing and leave every AWS_* var unset.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
const dotenv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
for (const [key, value] of Object.entries(dotenv)) {
  if (key.startsWith('AWS_') && typeof value === 'string' && process.env[key] === undefined) {
    process.env[key] = value;
  }
}

// Uses the locally installed Google Chrome by default, so no browser download is needed.
// Set PLAYWRIGHT_CHANNEL= (empty) to use Playwright's bundled Chromium instead, e.g. in CI.
const channel = process.env.PLAYWRIGHT_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: process.env.CI === undefined ? 'list' : 'github',
  timeout: 30_000,
  expect: { timeout: 30_000 },
  use: {
    ...(channel === '' ? {} : { channel }),
    // Uploaded CSV rows are segment member ids (personal data). Traces, screenshots and video all
    // capture request bodies or rendered DOM, so no artifact is retained, including on failure.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
});
