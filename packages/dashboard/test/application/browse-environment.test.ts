import { describe, expect, it, vi } from 'vitest';
import {
  browseEnvironment,
  ENVIRONMENT_VERSION_WINDOW,
  viewSnapshotVersion,
  type BrowsePorts,
} from '../../src/application/browse-environment.js';

const snapshotText = (version: number) =>
  JSON.stringify({
    schemaVersion: 1,
    environment: 'production',
    version,
    createdAt: '2026-09-19T06:00:00.000Z',
    createdBy: 'test',
    previousVersion: version === 1 ? null : version - 1,
    reason: `reason ${String(version)}`,
    features: {
      'new-dashboard': {
        type: 'boolean',
        enabled: true,
        rules: [{ when: { plan: 'pro' }, enabled: false }],
      },
      'checkout-limits': { type: 'config', enabled: false, default: { max: 3 } },
    },
  });

const inSegment = (key: string) => ({ when: { plan: { inSegment: key } }, enabled: true });

const segmentSnapshotText = () =>
  JSON.stringify({
    schemaVersion: 2,
    environment: 'production',
    version: 1,
    createdAt: '2026-09-19T06:00:00.000Z',
    createdBy: 'test',
    previousVersion: null,
    reason: 'segments',
    features: {
      'new-dashboard': { type: 'boolean', enabled: true, rules: [inSegment('zeta'), inSegment('alpha')] },
      'checkout-limits': { type: 'boolean', enabled: false, rules: [inSegment('mid'), inSegment('alpha')] },
    },
  });

const fetchError = (reason: string) => Object.assign(new Error(reason), { reason });

const portsWith = (current: number | undefined, fetchSnapshotText: BrowsePorts['fetchSnapshotText']) => ({
  readCurrentVersion: vi.fn(() => Promise.resolve(current)),
  fetchSnapshotText: vi.fn(fetchSnapshotText),
});

describe('browseEnvironment', () => {
  it('reports an Environment with no pointer as empty without fetching any snapshot', async () => {
    const ports = portsWith(undefined, () => Promise.resolve(snapshotText(1)));

    await expect(browseEnvironment(ports, 'production')).resolves.toEqual({
      environment: 'production',
      status: 'empty',
    });
    expect(ports.readCurrentVersion).toHaveBeenCalledWith('production');
    expect(ports.fetchSnapshotText).not.toHaveBeenCalled();
  });

  it('lists every version with its metadata and shows the current Flag Definitions when history fits the window', async () => {
    const ports = portsWith(3, (_environment, version) => Promise.resolve(snapshotText(version)));
    const metadata = (version: number) => ({
      createdAt: '2026-09-19T06:00:00.000Z',
      createdBy: 'test',
      reason: `reason ${String(version)}`,
    });

    await expect(browseEnvironment(ports, 'production')).resolves.toEqual({
      environment: 'production',
      status: 'published',
      currentVersion: 3,
      versions: [1, 2, 3].map((version) => ({ version, metadata: metadata(version) })),
      current: {
        environment: 'production',
        version: 3,
        status: 'available',
        contents: {
          status: 'valid',
          metadata: metadata(3),
          segmentKeys: [],
          raw: JSON.parse(snapshotText(3)) as unknown,
          flags: [
            { key: 'new-dashboard', type: 'boolean', enabled: true, defaultValue: true, ruleCount: 1, rules: [{ when: { plan: 'pro' }, enabled: false }] },
            { key: 'checkout-limits', type: 'config', enabled: false, defaultValue: { max: 3 }, ruleCount: 0, rules: [] },
          ],
        },
      },
    });
    expect(ports.fetchSnapshotText.mock.calls).toEqual([
      ['production', 1],
      ['production', 2],
      ['production', 3],
    ]);
  });

  it('lists a missing or invalid older version without metadata', async () => {
    const ports = portsWith(3, (_environment, version) =>
      version === 1 ? Promise.reject(fetchError('SNAPSHOT_NOT_FOUND')) : Promise.resolve(version === 2 ? '{}' : snapshotText(3)),
    );

    const view = await browseEnvironment(ports, 'production');

    expect(view).toMatchObject({ versions: [{ version: 1 }, { version: 2 }, { version: 3, metadata: { reason: 'reason 3' } }] });
    expect(view.status === 'published' && view.versions.slice(0, 2).map((entry) => 'metadata' in entry)).toEqual([false, false]);
  });

  it('fetches exactly the window when current sits on the window boundary', async () => {
    const ports = portsWith(ENVIRONMENT_VERSION_WINDOW, (_environment, version) => Promise.resolve(snapshotText(version)));

    const view = await browseEnvironment(ports, 'production');

    const expected = Array.from({ length: ENVIRONMENT_VERSION_WINDOW }, (_entry, index) => index + 1);
    expect(view.status === 'published' && view.versions.map((entry) => entry.version)).toEqual(expected);
    expect(ports.fetchSnapshotText.mock.calls).toEqual(expected.map((version) => ['production', version]));
  });

  it('fetches only the newest window and still resolves current by version number on a long history', async () => {
    const ports = portsWith(500, (_environment, version) => Promise.resolve(snapshotText(version)));

    const view = await browseEnvironment(ports, 'production');

    const expected = [496, 497, 498, 499, 500];
    expect(view.status === 'published' && view.versions.map((entry) => entry.version)).toEqual(expected);
    expect(ports.fetchSnapshotText.mock.calls).toEqual(expected.map((version) => ['production', version]));
    expect(view).toMatchObject({
      currentVersion: 500,
      current: { version: 500, contents: { status: 'valid', metadata: { reason: 'reason 500' } } },
    });
  });

  it('lists exactly version 1 when only one version was published', async () => {
    const ports = portsWith(1, () => Promise.resolve(snapshotText(1)));

    const view = await browseEnvironment(ports, 'production');

    expect(view).toMatchObject({ currentVersion: 1, versions: [{ version: 1 }] });
  });

  it('shows a missing current snapshot as not available', async () => {
    const ports = portsWith(2, () => Promise.reject(fetchError('SNAPSHOT_NOT_FOUND')));

    const view = await browseEnvironment(ports, 'production');

    expect(view).toMatchObject({ versions: [{ version: 1 }, { version: 2 }], current: { version: 2, status: 'not-available' } });
  });

  it('propagates a pointer read failure', async () => {
    const failure = fetchError('ACCESS_DENIED');
    const ports = { readCurrentVersion: () => Promise.reject(failure), fetchSnapshotText: vi.fn() };

    await expect(browseEnvironment(ports, 'production')).rejects.toBe(failure);
  });
});

describe('viewSnapshotVersion', () => {
  it('returns the Flag Definitions of the requested version', async () => {
    const ports = portsWith(3, () => Promise.resolve(snapshotText(2)));

    const view = await viewSnapshotVersion(ports, 'production', 2);

    expect(view).toMatchObject({ environment: 'production', version: 2, status: 'available' });
    expect(ports.fetchSnapshotText).toHaveBeenCalledExactlyOnceWith('production', 2);
  });

  it('lists every referenced Segment Key once, sorted, whatever order the rules mention them in', async () => {
    const ports = portsWith(1, () => Promise.resolve(segmentSnapshotText()));

    const view = await viewSnapshotVersion(ports, 'production', 1);

    expect(view.status === 'available' && view.contents.status === 'valid' && view.contents.segmentKeys).toEqual([
      'alpha',
      'mid',
      'zeta',
    ]);
  });

  it('marks a SNAPSHOT_NOT_FOUND version as not available', async () => {
    const ports = portsWith(3, () => Promise.reject(fetchError('SNAPSHOT_NOT_FOUND')));

    await expect(viewSnapshotVersion(ports, 'production', 2)).resolves.toEqual({
      environment: 'production',
      version: 2,
      status: 'not-available',
    });
  });

  it.each([
    ['ACCESS_DENIED', fetchError('ACCESS_DENIED')],
    ['REQUEST_FAILED', fetchError('REQUEST_FAILED')],
    ['an error without a reason', new Error('boom')],
    ['a non-object rejection', 'boom'],
    ['a null rejection', null],
  ])('rethrows %s instead of hiding it as not available', async (_label, failure) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error rejections are the case under test
    const ports = portsWith(3, () => Promise.reject(failure));

    await expect(viewSnapshotVersion(ports, 'production', 2)).rejects.toBe(failure);
  });

  it('reports snapshot text that is not JSON as invalid', async () => {
    const ports = portsWith(3, () => Promise.resolve('{ not json'));

    const view = await viewSnapshotVersion(ports, 'production', 2);

    expect(view).toMatchObject({ status: 'available', contents: { status: 'invalid' } });
    expect(view.status === 'available' && view.contents.status === 'invalid' && view.contents.issues).toEqual([
      { path: '', message: expect.any(String) as string },
    ]);
  });

  it('reports a snapshot failing core validation with its field-level issues', async () => {
    const ports = portsWith(3, () => Promise.resolve(JSON.stringify({ schemaVersion: 1, features: 'nope' })));

    const view = await viewSnapshotVersion(ports, 'production', 2);

    expect(view.status === 'available' && view.contents.status).toBe('invalid');
    expect(view.status === 'available' && view.contents.status === 'invalid' && view.contents.issues.length).toBeGreaterThan(0);
  });
});
