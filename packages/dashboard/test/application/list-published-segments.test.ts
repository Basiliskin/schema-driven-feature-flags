import { describe, expect, it, vi } from 'vitest';
import {
  listPublishedSegments,
  type ListPublishedSegmentsPorts,
  type PublishedSegment,
} from '../../src/application/list-published-segments.js';

type Rule = Readonly<Record<string, unknown>>;

const inSegment = (key: string): Rule => ({ when: { plan: { inSegment: key } }, enabled: true });

const snapshotText = (features: Readonly<Record<string, readonly Rule[]>>) =>
  JSON.stringify({
    schemaVersion: 2,
    environment: 'production',
    version: 1,
    createdAt: '2026-09-21T06:00:00.000Z',
    createdBy: 'test',
    previousVersion: null,
    reason: 'segments',
    features: Object.fromEntries(
      Object.entries(features).map(([key, rules]) => [key, { type: 'boolean', enabled: true, rules }]),
    ),
  });

const portsFor = (
  segments: readonly PublishedSegment[],
  features: Readonly<Record<string, readonly Rule[]>> = {},
): ListPublishedSegmentsPorts => ({
  readCurrentVersion: () => Promise.resolve(1),
  fetchSnapshotText: () => Promise.resolve(snapshotText(features)),
  listPublishedSegments: () => Promise.resolve({ status: 'listed', segments }),
});

const published = (segmentKey: string, version = 1, memberAttribute = 'plan'): PublishedSegment => ({
  segmentKey,
  version,
  memberAttribute,
});

const publishedWithoutAttribute = (segmentKey: string, version: number): PublishedSegment => ({
  segmentKey,
  version,
});

const fetchError = (reason: string) => Object.assign(new Error(reason), { reason });

describe('listPublishedSegments', () => {
  it('lists every flag that references a segment, deduplicated and ordered by flag key', async () => {
    const listing = vi.fn(() => Promise.resolve({ status: 'listed' as const, segments: [published('beta', 7)] }));
    const ports: ListPublishedSegmentsPorts = {
      ...portsFor([]),
      fetchSnapshotText: () =>
        Promise.resolve(
          snapshotText({
            'new-dashboard': [inSegment('beta'), inSegment('beta')],
            'alpha-copy': [{ when: { tier: 'gold' }, enabled: true }, inSegment('beta')],
          }),
        ),
      listPublishedSegments: listing,
    };

    await expect(listPublishedSegments(ports, 'production')).resolves.toEqual({
      status: 'listed',
      rows: [
        {
          segmentKey: 'beta',
          version: 7,
          attribute: { status: 'known', memberAttribute: 'plan' },
          usage: { status: 'used', flagKeys: ['alpha-copy', 'new-dashboard'] },
        },
      ],
    });
    expect(listing).toHaveBeenCalledExactlyOnceWith('production');
  });

  it('reports a published segment no flag references as unused rather than omitting it', async () => {
    const ports = portsFor([published('beta'), published('unattached', 3)], { 'new-dashboard': [inSegment('beta')] });

    await expect(listPublishedSegments(ports, 'production')).resolves.toEqual({
      status: 'listed',
      rows: [
        {
          segmentKey: 'beta',
          version: 1,
          attribute: { status: 'known', memberAttribute: 'plan' },
          usage: { status: 'used', flagKeys: ['new-dashboard'] },
        },
        {
          segmentKey: 'unattached',
          version: 3,
          attribute: { status: 'known', memberAttribute: 'plan' },
          usage: { status: 'unused' },
        },
      ],
    });
  });

  it('credits one flag to both segments it references', async () => {
    const ports = portsFor([published('beta'), published('gamma')], {
      'new-dashboard': [inSegment('beta'), inSegment('gamma')],
    });

    const view = await listPublishedSegments(ports, 'production');

    expect(view).toEqual({
      status: 'listed',
      rows: [
        expect.objectContaining({ segmentKey: 'beta', usage: { status: 'used', flagKeys: ['new-dashboard'] } }),
        expect.objectContaining({ segmentKey: 'gamma', usage: { status: 'used', flagKeys: ['new-dashboard'] } }),
      ],
    });
  });

  it('ignores conditions that use an operator other than inSegment', async () => {
    const ports = portsFor([published('beta')], {
      'new-dashboard': [{ when: { plan: { equals: 'beta' } }, enabled: true }],
    });

    await expect(listPublishedSegments(ports, 'production')).resolves.toEqual({
      status: 'listed',
      rows: [expect.objectContaining({ segmentKey: 'beta', usage: { status: 'unused' } })],
    });
  });

  it('reports a segment published before the Member Attribute was stored as unknown', async () => {
    const ports = portsFor([publishedWithoutAttribute('legacy', 2)]);

    await expect(listPublishedSegments(ports, 'production')).resolves.toEqual({
      status: 'listed',
      rows: [
        { segmentKey: 'legacy', version: 2, attribute: { status: 'unknown' }, usage: { status: 'unused' } },
      ],
    });
  });

  it('sorts rows by Segment Key whatever order the listing returns them in', async () => {
    const ports = portsFor([published('gamma'), published('alpha'), published('beta')]);

    const view = await listPublishedSegments(ports, 'production');

    expect(view.status === 'listed' && view.rows.map((row) => row.segmentKey)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('reports an Environment with no published segments as an empty listing, not unavailable', async () => {
    const ports = portsFor([]);

    await expect(listPublishedSegments(ports, 'production')).resolves.toEqual({ status: 'listed', rows: [] });
  });

  it('propagates an unavailable listing without reading the snapshot', async () => {
    const readCurrentVersion = vi.fn();
    const ports: ListPublishedSegmentsPorts = {
      readCurrentVersion,
      fetchSnapshotText: vi.fn(),
      listPublishedSegments: () => Promise.resolve({ status: 'unavailable' }),
    };

    await expect(listPublishedSegments(ports, 'production')).resolves.toEqual({ status: 'unavailable' });
    expect(readCurrentVersion).not.toHaveBeenCalled();
  });

  it('reports published segments as unused when the Environment has nothing published', async () => {
    const ports: ListPublishedSegmentsPorts = {
      readCurrentVersion: () => Promise.resolve(undefined),
      fetchSnapshotText: vi.fn(),
      listPublishedSegments: () => Promise.resolve({ status: 'listed', segments: [published('beta')] }),
    };

    await expect(listPublishedSegments(ports, 'production')).resolves.toEqual({
      status: 'listed',
      rows: [expect.objectContaining({ segmentKey: 'beta', usage: { status: 'unused' } })],
    });
  });

  it('reports published segments as unused when the current Snapshot Version is missing', async () => {
    const ports: ListPublishedSegmentsPorts = {
      readCurrentVersion: () => Promise.resolve(1),
      fetchSnapshotText: () => Promise.reject(fetchError('SNAPSHOT_NOT_FOUND')),
      listPublishedSegments: () => Promise.resolve({ status: 'listed', segments: [published('beta')] }),
    };

    await expect(listPublishedSegments(ports, 'production')).resolves.toEqual({
      status: 'listed',
      rows: [expect.objectContaining({ segmentKey: 'beta', usage: { status: 'unused' } })],
    });
  });

  it('reports published segments as unused when the current snapshot does not parse', async () => {
    const ports: ListPublishedSegmentsPorts = {
      readCurrentVersion: () => Promise.resolve(1),
      fetchSnapshotText: () => Promise.resolve('{ not json'),
      listPublishedSegments: () => Promise.resolve({ status: 'listed', segments: [published('beta')] }),
    };

    await expect(listPublishedSegments(ports, 'production')).resolves.toEqual({
      status: 'listed',
      rows: [expect.objectContaining({ segmentKey: 'beta', usage: { status: 'unused' } })],
    });
  });
});
