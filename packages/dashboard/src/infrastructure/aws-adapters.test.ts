import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3PublishError, S3SegmentPublishError } from '@featuresync/aws';
import { describe, expect, it, vi } from 'vitest';
import { createAwsDashboardPorts } from './aws-adapters.js';

const SNAPSHOT = JSON.stringify({
  schemaVersion: 1,
  environment: 'production',
  version: 2,
  createdAt: '2026-09-19T06:00:00.000Z',
  createdBy: 'test',
  previousVersion: 1,
  reason: 'test',
  features: { dark: { type: 'boolean', enabled: true } },
});

const fakeClient = (objects: Record<string, string>) => {
  const send = vi.fn((command: unknown) => {
    if (command instanceof PutObjectCommand) return Promise.resolve({ ETag: '"etag"' });
    const key = command instanceof GetObjectCommand ? command.input.Key : undefined;
    const text = key === undefined ? undefined : objects[key];
    if (text === undefined) return Promise.reject(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    return Promise.resolve({ Body: { transformToString: () => Promise.resolve(text) }, ETag: '"etag"' });
  });
  return { send };
};

const segmentClient = (currentVersion: number) =>
  fakeClient({
    'production/segments/beta/current.json': JSON.stringify({
      schemaVersion: 1,
      environment: 'production',
      segmentKey: 'beta',
      version: currentVersion,
      objectKey: `production/segments/beta/${String(currentVersion)}.json`,
    }),
  });

const putCommands = (client: { send: { mock: { calls: [unknown][] } } }): PutObjectCommand[] =>
  client.send.mock.calls.map(([command]) => command).filter((command) => command instanceof PutObjectCommand);

describe('createAwsDashboardPorts', () => {
  it('reads the current pointer and snapshot text through the aws readers', async () => {
    const client = fakeClient({
      'production/current.json': JSON.stringify({
        schemaVersion: 1,
        environment: 'production',
        version: 2,
        snapshotKey: 'production/snapshots/2.json',
      }),
      'production/snapshots/2.json': SNAPSHOT,
    });
    const ports = createAwsDashboardPorts({ bucket: 'flags', client });

    await expect(ports.readCurrentVersion('production')).resolves.toBe(2);
    await expect(ports.fetchSnapshotText('production', 2)).resolves.toBe(SNAPSHOT);
    await expect(ports.readCurrentVersion('staging')).resolves.toBeUndefined();
  });

  it('rejects an invalid snapshot with core validation without writing to S3', async () => {
    const client = fakeClient({});
    const writer = createAwsDashboardPorts({ bucket: 'flags', client, topicArn: 'arn:aws:sns:us-east-1:1:t' }).openWriter(
      vi.fn(),
    );

    const error: unknown = await writer.publish('production', { features: { bad: { type: 'nope' } } }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(S3PublishError);
    expect((error as S3PublishError).reason).toBe('INVALID_SNAPSHOT');
    expect(client.send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });

  it('lets a valid snapshot through core validation to the snapshot write', async () => {
    const client = fakeClient({});
    const writer = createAwsDashboardPorts({ bucket: 'flags', client }).openWriter(vi.fn());

    await writer.publish('production', JSON.parse(SNAPSHOT)).catch(() => undefined);

    const put = client.send.mock.calls.find(([command]) => command instanceof PutObjectCommand)?.[0] as PutObjectCommand;
    expect(put.input.Key).toBe('production/snapshots/1.json');
  });

  it('publishes a segment as the next version through the shared bucket and client', async () => {
    const client = segmentClient(3);
    const ports = createAwsDashboardPorts({ bucket: 'flags', client });

    const pointer = await ports.publishSegment('production', {
      key: 'beta',
      memberAttribute: 'userId',
      members: ['u1', 'u2'],
      expectedCurrentVersion: 3,
    });

    expect(pointer.version).toBe(4);
    const puts = putCommands(client);
    expect(puts.map((put) => put.input.Key)).toEqual([
      'production/segments/beta/4.json',
      'production/segments/beta/current.json',
    ]);
    expect(puts.every((put) => put.input.Bucket === 'flags')).toBe(true);
  });

  it('rejects a stale expected segment version with CONFLICT and writes nothing', async () => {
    const client = segmentClient(3);
    const ports = createAwsDashboardPorts({ bucket: 'flags', client });

    const error: unknown = await ports
      .publishSegment('production', {
        key: 'beta',
        memberAttribute: 'userId',
        members: ['u1'],
        expectedCurrentVersion: 2,
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(S3SegmentPublishError);
    expect((error as S3SegmentPublishError).reason).toBe('CONFLICT');
    expect(putCommands(client)).toHaveLength(0);
  });

  it('reads the current segment version, and null when the segment has never been published', async () => {
    const ports = createAwsDashboardPorts({ bucket: 'flags', client: segmentClient(3) });

    await expect(ports.readSegmentVersion('production', 'beta')).resolves.toBe(3);
    await expect(ports.readSegmentVersion('production', 'gamma')).resolves.toBeNull();
  });

  it('accepts a valid snapshot and falls back to the default S3 client when none is given', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new Error('offline'));
    const writer = createAwsDashboardPorts({ bucket: 'flags' }).openWriter(vi.fn());

    const error: unknown = await writer.publish('production', JSON.parse(SNAPSHOT)).catch((thrown: unknown) => thrown);

    expect((error as S3PublishError).reason).toBe('REQUEST_FAILED');
    expect(send).toHaveBeenCalled();
    send.mockRestore();
  });
});
