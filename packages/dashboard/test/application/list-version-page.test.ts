import { describe, expect, it, vi } from 'vitest';
import type { BrowsePorts } from '../../src/application/browse-environment.js';
import {
  listVersionPage,
  MAX_VERSION_PAGE_SIZE,
  DEFAULT_VERSION_PAGE_SIZE,
} from '../../src/application/list-version-page.js';

const snapshotText = (version: number) =>
  JSON.stringify({
    schemaVersion: 1,
    environment: 'production',
    version,
    createdAt: '2026-09-21T06:00:00.000Z',
    createdBy: 'test',
    previousVersion: version === 1 ? null : version - 1,
    reason: `reason ${String(version)}`,
    features: {},
  });

const portsWith = (
  current: number | undefined,
  fetchSnapshotText: BrowsePorts['fetchSnapshotText'] = (_environment, version) => Promise.resolve(snapshotText(version)),
) => ({
  readCurrentVersion: vi.fn(() => Promise.resolve(current)),
  fetchSnapshotText: vi.fn(fetchSnapshotText),
});

const fetchedVersions = (ports: ReturnType<typeof portsWith>): number[] =>
  ports.fetchSnapshotText.mock.calls.map(([, version]) => version);

const fetchCount = (ports: ReturnType<typeof portsWith>): number => ports.fetchSnapshotText.mock.calls.length;

const versionsOf = (page: { entries: readonly { version: number }[] }): number[] =>
  page.entries.map((entry) => entry.version);

describe('listVersionPage', () => {
  it('returns the newest page first, one fetch per returned entry', async () => {
    const ports = portsWith(23);

    const page = await listVersionPage(ports, 'production', 1, 10);

    expect(versionsOf(page)).toEqual([23, 22, 21, 20, 19, 18, 17, 16, 15, 14]);
    expect(fetchedVersions(ports)).toEqual([23, 22, 21, 20, 19, 18, 17, 16, 15, 14]);
    expect(page).toMatchObject({ environment: 'production', page: 1, pageSize: 10, totalVersions: 23, hasNewer: false, hasOlder: true });
  });

  it('continues from where the previous page stopped, with no version repeated or skipped', async () => {
    const ports = portsWith(23);

    const page = await listVersionPage(ports, 'production', 2, 10);

    expect(versionsOf(page)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
    expect(page).toMatchObject({ page: 2, hasNewer: true, hasOlder: true });
  });

  it('returns a partly full last page without asking for version 0 or below', async () => {
    const ports = portsWith(23);

    const page = await listVersionPage(ports, 'production', 3, 10);

    expect(versionsOf(page)).toEqual([3, 2, 1]);
    expect(fetchedVersions(ports)).toEqual([3, 2, 1]);
    expect(page).toMatchObject({ page: 3, totalVersions: 23, hasNewer: true, hasOlder: false });
  });

  it('reports both directions absent when the whole history fits on one page', async () => {
    const ports = portsWith(3);

    const page = await listVersionPage(ports, 'production', 1, 10);

    expect(versionsOf(page)).toEqual([3, 2, 1]);
    expect(page).toMatchObject({ totalVersions: 3, hasNewer: false, hasOlder: false });
  });

  it('does not advertise an older page when the history is an exact multiple of the page size', async () => {
    const ports = portsWith(20);

    const page = await listVersionPage(ports, 'production', 2, 10);

    expect(versionsOf(page)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(page).toMatchObject({ hasNewer: true, hasOlder: false });
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1.7],
    ['not a number', Number.NaN],
  ])('treats a %s page as page 1', async (_label, requested) => {
    const ports = portsWith(23);

    const page = await listVersionPage(ports, 'production', requested, 10);

    expect(page.page).toBe(1);
    expect(versionsOf(page)).toEqual([23, 22, 21, 20, 19, 18, 17, 16, 15, 14]);
  });

  it('returns nothing and fetches nothing for a page past the end', async () => {
    const ports = portsWith(23);

    const page = await listVersionPage(ports, 'production', 99, 10);

    expect(page).toMatchObject({ page: 99, totalVersions: 23, entries: [], hasNewer: true, hasOlder: false });
    expect(fetchCount(ports)).toBe(0);
  });

  it('caps an oversized pageSize at the maximum instead of fanning out', async () => {
    const ports = portsWith(1000);

    const page = await listVersionPage(ports, 'production', 1, 100_000);

    expect(page.pageSize).toBe(MAX_VERSION_PAGE_SIZE);
    expect(page.entries).toHaveLength(MAX_VERSION_PAGE_SIZE);
    expect(fetchCount(ports)).toBe(MAX_VERSION_PAGE_SIZE);
  });

  it.each([
    ['zero', 0],
    ['negative', -10],
  ])('treats a %s pageSize as a single entry', async (_label, requested) => {
    const ports = portsWith(23);

    const page = await listVersionPage(ports, 'production', 2, requested);

    expect(page.pageSize).toBe(1);
    expect(versionsOf(page)).toEqual([22]);
  });

  it('falls back to the default pageSize when it is not a number', async () => {
    const ports = portsWith(23);

    const page = await listVersionPage(ports, 'production', 1, Number.NaN);

    expect(page.pageSize).toBe(DEFAULT_VERSION_PAGE_SIZE);
    expect(page.entries).toHaveLength(DEFAULT_VERSION_PAGE_SIZE);
  });

  it('reports an Environment with no published version as empty without fetching', async () => {
    const ports = portsWith(undefined);

    const page = await listVersionPage(ports, 'production', 1, 10);

    expect(page).toMatchObject({ totalVersions: 0, entries: [], hasNewer: false, hasOlder: false });
    expect(fetchCount(ports)).toBe(0);
  });

  it('lists a version whose snapshot is missing without metadata, keeping the page intact', async () => {
    const ports = portsWith(3, (_environment, version) =>
      version === 2
        ? Promise.reject(Object.assign(new Error('SNAPSHOT_NOT_FOUND'), { reason: 'SNAPSHOT_NOT_FOUND' }))
        : Promise.resolve(snapshotText(version)),
    );

    const page = await listVersionPage(ports, 'production', 1, 10);

    expect(page.entries).toEqual([
      { version: 3, metadata: { createdAt: '2026-09-21T06:00:00.000Z', createdBy: 'test', reason: 'reason 3' } },
      { version: 2 },
      { version: 1, metadata: { createdAt: '2026-09-21T06:00:00.000Z', createdBy: 'test', reason: 'reason 1' } },
    ]);
  });
});
