import { describe, expect, it, vi } from 'vitest';
import {
  listReferencedSegments,
  type ListReferencedSegmentsPorts,
} from '../../src/application/list-referenced-segments.js';

const inSegment = (key: string) => ({ when: { plan: { inSegment: key } }, enabled: true });

const snapshotText = (keys: readonly string[]) =>
  JSON.stringify({
    schemaVersion: keys.length === 0 ? 1 : 2,
    environment: 'production',
    version: 1,
    createdAt: '2026-09-19T06:00:00.000Z',
    createdBy: 'test',
    previousVersion: null,
    reason: 'segments',
    features: {
      'new-dashboard': { type: 'boolean', enabled: true, rules: keys.map(inSegment) },
    },
  });

const portsFor = (
  keys: readonly string[],
  readSegmentVersion: ListReferencedSegmentsPorts['readSegmentVersion'],
): ListReferencedSegmentsPorts => ({
  readCurrentVersion: () => Promise.resolve(1),
  fetchSnapshotText: () => Promise.resolve(snapshotText(keys)),
  readSegmentVersion: vi.fn(readSegmentVersion),
});

const fetchError = (reason: string) => Object.assign(new Error(reason), { reason });

describe('listReferencedSegments', () => {
  it('reports the current published version of each referenced Segment Key', async () => {
    const ports = portsFor(['beta'], () => Promise.resolve(7));

    await expect(listReferencedSegments(ports, 'production')).resolves.toEqual([
      { key: 'beta', state: 'published', version: 7 },
    ]);
    expect(ports.readSegmentVersion).toHaveBeenCalledExactlyOnceWith('production', 'beta');
  });

  it('reports a Segment Key that has never been published as not published', async () => {
    const ports = portsFor(['beta'], () => Promise.resolve(null));

    await expect(listReferencedSegments(ports, 'production')).resolves.toEqual([
      { key: 'beta', state: 'not-published' },
    ]);
  });

  it('keeps version 0 a published version rather than folding it into not published', async () => {
    const ports = portsFor(['beta'], () => Promise.resolve(0));

    await expect(listReferencedSegments(ports, 'production')).resolves.toEqual([
      { key: 'beta', state: 'published', version: 0 },
    ]);
  });

  it('turns one failing read into a single unavailable row, leaving the other keys intact', async () => {
    const ports = portsFor(['alpha', 'beta', 'gamma'], (_environment, key) =>
      key === 'beta' ? Promise.reject(fetchError('REQUEST_FAILED')) : Promise.resolve(key === 'alpha' ? 2 : 5),
    );

    await expect(listReferencedSegments(ports, 'production')).resolves.toEqual([
      { key: 'alpha', state: 'published', version: 2 },
      { key: 'beta', state: 'unavailable' },
      { key: 'gamma', state: 'published', version: 5 },
    ]);
  });

  it('returns no rows when the snapshot references no segments', async () => {
    const ports = portsFor([], () => Promise.resolve(7));

    await expect(listReferencedSegments(ports, 'production')).resolves.toEqual([]);
    expect(ports.readSegmentVersion).not.toHaveBeenCalled();
  });

  it('returns no rows for an Environment with nothing published', async () => {
    const ports: ListReferencedSegmentsPorts = {
      readCurrentVersion: () => Promise.resolve(undefined),
      fetchSnapshotText: vi.fn(),
      readSegmentVersion: vi.fn(),
    };

    await expect(listReferencedSegments(ports, 'production')).resolves.toEqual([]);
    expect(ports.readSegmentVersion).not.toHaveBeenCalled();
  });

  it('returns no rows when the current Snapshot Version is missing', async () => {
    const ports: ListReferencedSegmentsPorts = {
      readCurrentVersion: () => Promise.resolve(1),
      fetchSnapshotText: () => Promise.reject(fetchError('SNAPSHOT_NOT_FOUND')),
      readSegmentVersion: vi.fn(),
    };

    await expect(listReferencedSegments(ports, 'production')).resolves.toEqual([]);
    expect(ports.readSegmentVersion).not.toHaveBeenCalled();
  });

  it('returns no rows when the current snapshot does not parse', async () => {
    const ports: ListReferencedSegmentsPorts = {
      readCurrentVersion: () => Promise.resolve(1),
      fetchSnapshotText: () => Promise.resolve('{ not json'),
      readSegmentVersion: vi.fn(),
    };

    await expect(listReferencedSegments(ports, 'production')).resolves.toEqual([]);
    expect(ports.readSegmentVersion).not.toHaveBeenCalled();
  });
});
