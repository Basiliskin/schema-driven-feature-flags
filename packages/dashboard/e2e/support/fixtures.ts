import { test as base, type Page } from '@playwright/test';
import { startDashboardServer, type DashboardPorts, type RunningDashboard } from '../../src/infrastructure/http-server.js';

type Features = Record<string, unknown>;

/**
 * An Environment kept in memory, with the same compare-and-swap rule as the S3 publisher: a publish that
 * names an `expectedCurrentVersion` fails with CONFLICT once someone else has moved the pointer.
 */
class InMemoryEnvironment {
  private readonly snapshots: string[] = [];

  constructor(private readonly environment: string) {}

  get currentVersion(): number {
    return this.snapshots.length;
  }

  publish(snapshot: Record<string, unknown>, expectedCurrentVersion?: number): number {
    if (expectedCurrentVersion !== undefined && expectedCurrentVersion !== this.currentVersion) {
      throw Object.assign(new Error('The current pointer moved.'), { name: 'S3PublishError', reason: 'CONFLICT' });
    }
    const version = this.currentVersion + 1;
    this.snapshots.push(
      JSON.stringify({
        ...snapshot,
        environment: this.environment,
        version,
        previousVersion: version === 1 ? null : version - 1,
        createdAt: new Date(Date.UTC(2026, 8, 19, 12, version)).toISOString(),
      }),
    );
    return version;
  }

  /** Publishes as somebody else, the way a second operator in another tab would. */
  publishAs(createdBy: string, features: Features, reason = 'Other change'): number {
    return this.publish({ schemaVersion: 1, createdBy, reason, features });
  }

  features(version = this.currentVersion): Features {
    const text = this.snapshots[version - 1];
    if (text === undefined) throw new Error(`No version ${String(version)}`);
    return (JSON.parse(text) as { features: Features }).features;
  }

  ports(): DashboardPorts {
    return {
      readCurrentVersion: () => Promise.resolve(this.currentVersion === 0 ? undefined : this.currentVersion),
      fetchSnapshotText: (_environment, version) => {
        const text = this.snapshots[version - 1];
        return text === undefined
          ? Promise.reject(Object.assign(new Error('missing'), { reason: 'SNAPSHOT_NOT_FOUND' }))
          : Promise.resolve(text);
      },
      publishSegment: () => Promise.reject(new Error('Segment upload is not used in these tests.')),
      readSegmentVersion: () => Promise.resolve(null),
      openWriter: () => ({
        publish: (_environment, snapshot, options) =>
          Promise.resolve().then(() => this.publish(snapshot as Record<string, unknown>, options?.expectedCurrentVersion)),
        rollback: () => Promise.reject(new Error('Rollback is not used in these tests.')),
      }),
    };
  }
}

export const SEED: Features = {
  'new-dashboard': { type: 'boolean', enabled: true },
  'checkout-limits': { type: 'config', enabled: false, default: { max: 3 } },
  'dark-mode': { type: 'boolean', enabled: false },
};

interface Fixtures {
  readonly env: InMemoryEnvironment;
  readonly dashboard: RunningDashboard;
  /** Opens the production environment page. */
  readonly openEnvironment: () => Promise<void>;
}

export const test = base.extend<Fixtures>({
  // Playwright reads a fixture's dependencies from its destructuring pattern; this one needs none.
  // eslint-disable-next-line no-empty-pattern
  env: async ({}, use) => {
    const env = new InMemoryEnvironment('production');
    env.publishAs('alice', SEED, 'Seed');
    await use(env);
  },
  dashboard: async ({ env }, use) => {
    const dashboard = await startDashboardServer({ ports: env.ports(), port: 0, logError: () => undefined });
    await use(dashboard);
    await dashboard.close();
  },
  openEnvironment: async ({ page, dashboard }, use) => {
    await use(async () => {
      await page.goto(`${dashboard.url}/env/production`);
    });
  },
});

/** The page polls on an interval; a focus event makes it check right away. */
export const checkForUpdates = (page: Page): Promise<void> =>
  // A string runs in the page, where `window` exists; this file is typed for Node.
  page.evaluate("window.dispatchEvent(new Event('focus'))");

/** Opens a flag's row and returns it; the row's own summary, not the nested rules/delete disclosures. */
export const expandFlag = async (page: Page, key: string) => {
  const row = page.locator(`[data-flag="${key}"]`);
  await row.locator('.flag-row > summary').click();
  return row;
};

export { expect } from '@playwright/test';
