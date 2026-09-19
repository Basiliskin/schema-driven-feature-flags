import { defineConfig } from '@playwright/test';

// Uses the locally installed Google Chrome by default, so no browser download is needed.
// Set PLAYWRIGHT_CHANNEL= (empty) to use Playwright's bundled Chromium instead, e.g. in CI.
const channel = process.env.PLAYWRIGHT_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: process.env.CI === undefined ? 'list' : 'github',
  use: {
    ...(channel === '' ? {} : { channel }),
    trace: 'retain-on-failure',
  },
});
