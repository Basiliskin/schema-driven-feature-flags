import { describe, expect, it, vi } from 'vitest';
import { compareWithCurrent } from '../../src/application/compare-versions.js';

const snapshotText = (enabled: boolean, createdBy = 'alice') =>
  JSON.stringify({
    schemaVersion: 1,
    environment: 'production',
    version: 1,
    createdAt: '2026-09-19T06:00:00.000Z',
    createdBy,
    previousVersion: null,
    reason: 'why',
    features: { beta: { type: 'boolean', enabled } },
  });

const notFound = () => Object.assign(new Error('missing'), { reason: 'SNAPSHOT_NOT_FOUND' });

describe('compareWithCurrent', () => {
  it('is up to date without fetching snapshots when the version has not moved', async () => {
    const fetchSnapshotText = vi.fn();
    const ports = { readCurrentVersion: () => Promise.resolve(4), fetchSnapshotText };
    await expect(compareWithCurrent(ports, 'production', 4)).resolves.toEqual({
      status: 'up-to-date',
      environment: 'production',
      version: 4,
    });
    expect(fetchSnapshotText).not.toHaveBeenCalled();
  });

  it('diffs the page version against the latest and names who published it', async () => {
    const ports = {
      readCurrentVersion: () => Promise.resolve(5),
      fetchSnapshotText: (_env: string, version: number) => Promise.resolve(snapshotText(version === 5, `user${String(version)}`)),
    };
    const result = await compareWithCurrent(ports, 'production', 4);
    expect(result).toMatchObject({
      status: 'changed',
      from: 4,
      to: 5,
      latest: { createdBy: 'user5', reason: 'why' },
      changes: [{ kind: 'changed', key: 'beta', fields: [{ field: 'enabled', before: false, after: true }] }],
    });
  });

  it('leaves out the flag diff when the older snapshot is missing', async () => {
    const ports = {
      readCurrentVersion: () => Promise.resolve(5),
      fetchSnapshotText: (_env: string, version: number) =>
        version === 4 ? Promise.reject(notFound()) : Promise.resolve(snapshotText(true)),
    };
    const result = await compareWithCurrent(ports, 'production', 4);
    expect(result.status).toBe('changed');
    expect(result).not.toHaveProperty('changes');
    expect(result).toHaveProperty('latest');
  });
});

describe('compareWithCurrent edge cases', () => {
  it('treats an environment with no pointer as up to date at the page version', async () => {
    const ports = { readCurrentVersion: () => Promise.resolve(undefined), fetchSnapshotText: vi.fn() };
    await expect(compareWithCurrent(ports, 'production', 2)).resolves.toEqual({ status: 'up-to-date', environment: 'production', version: 2 });
  });

  it('leaves out who published when the latest snapshot is missing', async () => {
    const ports = {
      readCurrentVersion: () => Promise.resolve(5),
      fetchSnapshotText: (_env: string, version: number) =>
        version === 5 ? Promise.reject(notFound()) : Promise.resolve(snapshotText(true)),
    };
    const result = await compareWithCurrent(ports, 'production', 4);
    expect(result).toEqual({ status: 'changed', environment: 'production', from: 4, to: 5 });
  });
});
