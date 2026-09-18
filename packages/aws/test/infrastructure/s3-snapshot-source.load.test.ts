import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { S3SnapshotError, type S3SnapshotErrorReason } from '../../src/infrastructure/s3-snapshot-error.js';
import { createS3SnapshotSource } from '../../src/infrastructure/s3-snapshot-source.js';
import { current, fakeS3, pointer, s3Error, type StoredObject } from './fake-s3.js';

const { constructedWith } = vi.hoisted(() => ({
  constructedWith: [] as unknown[],
}));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  class S3Client {
    constructor(config: unknown) {
      constructedWith.push(config);
    }
    send() {
      return Promise.reject(new Error('the default client must not be called in unit tests'));
    }
  }
  return { ...actual, S3Client };
});

const sourceOver = (objects: Record<string, StoredObject>) => {
  const fake = fakeS3(objects);
  return {
    ...fake,
    source: createS3SnapshotSource({
      bucket: 'flags',
      environment: 'production',
      client: fake.client,
    }),
  };
};

const loadError = async (promise: Promise<unknown>): Promise<S3SnapshotError> => {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(S3SnapshotError);
  return error as S3SnapshotError;
};

const expectFailure = async (
  objects: Record<string, StoredObject>,
  reason: S3SnapshotErrorReason,
  key: string,
): Promise<S3SnapshotError> => {
  const error = await loadError(sourceOver(objects).source.load());
  expect(error.reason).toBe(reason);
  expect(error.key).toBe(key);
  expect(error.name).toBe('S3SnapshotError');
  expect(error.message).toBe(`${reason} for s3 object ${key}`);
  return error;
};

describe('createS3SnapshotSource load', () => {
  it('reads the current pointer, then the snapshot it names, and returns the raw JSON', async () => {
    const { source, keys, send } = sourceOver({
      'production/current.json': current(7),
      'production/snapshots/7.json': {
        body: '{"schemaVersion":1,"features":{}}',
      },
    });

    await expect(source.load()).resolves.toEqual({
      schemaVersion: 1,
      features: {},
    });
    expect(keys).toEqual(['production/current.json', 'production/snapshots/7.json']);
    const commands = send.mock.calls.map(([command]) => command);
    expect(commands.every((command) => command instanceof GetObjectCommand)).toBe(true);
    expect(commands.map((command) => command.input.Bucket)).toEqual(['flags', 'flags']);
  });

  it('returns the raw value without validating it as a snapshot', async () => {
    const { source } = sourceOver({
      'production/current.json': current(1),
      'production/snapshots/1.json': { body: '"not a snapshot"' },
    });

    await expect(source.load()).resolves.toBe('not a snapshot');
  });

  it('reuses the loaded snapshot while the pointer ETag is unchanged', async () => {
    const objects: Record<string, StoredObject> = {
      'production/current.json': current(3),
      'production/snapshots/3.json': { body: '{"v":3}' },
    };
    const { source, keys } = sourceOver(objects);

    const first = await source.load();
    const second = await source.load();

    expect(second).toBe(first);
    expect(keys).toEqual(['production/current.json', 'production/snapshots/3.json', 'production/current.json']);
  });

  it('follows the pointer back to a lower version on rollback', async () => {
    const objects: Record<string, StoredObject> = {
      'production/current.json': current(9),
      'production/snapshots/9.json': { body: '{"v":9}' },
      'production/snapshots/8.json': { body: '{"v":8}' },
    };
    const { source, keys } = sourceOver(objects);

    await expect(source.load()).resolves.toEqual({ v: 9 });
    objects['production/current.json'] = current(8);
    await expect(source.load()).resolves.toEqual({ v: 8 });
    expect(keys.at(-1)).toBe('production/snapshots/8.json');
  });

  it('fetches both objects on every load when the pointer has no ETag', async () => {
    const { source, keys } = sourceOver({
      'production/current.json': { body: JSON.stringify(pointer(2)) },
      'production/snapshots/2.json': { body: '{}' },
    });

    await source.load();
    await source.load();

    expect(keys).toHaveLength(4);
  });

  it('refetches the pointer after a failed load instead of serving a stale snapshot', async () => {
    const objects: Record<string, StoredObject> = {
      'production/current.json': current(4),
      'production/snapshots/4.json': { body: '{"v":4}' },
    };
    const { source } = sourceOver(objects);
    await source.load();

    objects['production/current.json'] = { body: '{', etag: '"broken"' };
    await loadError(source.load());
    objects['production/current.json'] = current(4);

    await expect(source.load()).resolves.toEqual({ v: 4 });
  });

  describe('missing objects', () => {
    it.each([
      ['NoSuchKey', 404],
      ['AccessDenied', 403],
    ])('maps %s on the pointer to POINTER_NOT_FOUND', async (name, status) => {
      const cause = s3Error(name, status);
      const error = await expectFailure(
        { 'production/current.json': { error: cause } },
        'POINTER_NOT_FOUND',
        'production/current.json',
      );
      expect(error.cause).toBe(cause);
    });

    it.each([
      ['NoSuchKey', 404],
      ['AccessDenied', 403],
    ])('maps %s on the snapshot to SNAPSHOT_NOT_FOUND', async (name, status) => {
      const cause = s3Error(name, status);
      const error = await expectFailure(
        {
          'production/current.json': current(5),
          'production/snapshots/5.json': { error: cause },
        },
        'SNAPSHOT_NOT_FOUND',
        'production/snapshots/5.json',
      );
      expect(error.cause).toBe(cause);
    });

    it.each([
      ['a 403 status under another error name', s3Error('Forbidden', 403)],
      ['a 404 status under another error name', s3Error('NotFound', 404)],
      ['the error name alone', Object.assign(new Error('denied'), { name: 'AccessDenied' })],
    ])('recognises %s as missing', async (_, cause) => {
      const error = await expectFailure(
        { 'production/current.json': { error: cause } },
        'POINTER_NOT_FOUND',
        'production/current.json',
      );
      expect(error.cause).toBe(cause);
    });
  });

  describe('request failures', () => {
    it.each([
      ['a 5xx response', s3Error('InternalError', 500)],
      ['a network error', new Error('socket hang up')],
    ])('maps %s to REQUEST_FAILED', async (_, cause) => {
      const error = await expectFailure(
        { 'production/current.json': { error: cause } },
        'REQUEST_FAILED',
        'production/current.json',
      );
      expect(error.cause).toBe(cause);
    });
  });

  it.each([
    ['a string', 'boom'],
    ['undefined', undefined],
    ['null', null],
  ])('maps a rejection with %s to REQUEST_FAILED', async (_, cause) => {
    const client = {
      send: vi.fn().mockRejectedValue(cause),
    } as unknown as Pick<S3Client, 'send'>;
    const source = createS3SnapshotSource({
      bucket: 'flags',
      environment: 'production',
      client,
    });

    const error = await loadError(source.load());

    expect(error.reason).toBe('REQUEST_FAILED');
    expect(error.cause).toBe(cause);
  });

  describe('malformed objects', () => {
    it('maps a malformed pointer body to INVALID_JSON', async () => {
      const error = await expectFailure(
        { 'production/current.json': { body: '{', etag: '"x"' } },
        'INVALID_JSON',
        'production/current.json',
      );
      expect(error.cause).toBeInstanceOf(SyntaxError);
    });

    it('maps a malformed snapshot body to INVALID_JSON', async () => {
      const error = await expectFailure(
        {
          'production/current.json': current(6),
          'production/snapshots/6.json': { body: 'nope' },
        },
        'INVALID_JSON',
        'production/snapshots/6.json',
      );
      expect(error.cause).toBeInstanceOf(SyntaxError);
    });

    it.each([
      ['a missing body', {}],
      ['an empty body', { body: '' }],
    ])('maps %s to INVALID_JSON instead of throwing a TypeError', async (_, object) => {
      const error = await expectFailure(
        { 'production/current.json': object },
        'INVALID_JSON',
        'production/current.json',
      );
      expect(error.cause).toEqual(new Error('Object body is empty'));
    });

    it('maps a pointer that fails validation to INVALID_POINTER with the validation issues', async () => {
      const error = await expectFailure(
        {
          'production/current.json': {
            body: JSON.stringify({ ...pointer(3), version: 0 }),
          },
        },
        'INVALID_POINTER',
        'production/current.json',
      );
      expect(error.cause).toMatchObject({
        reason: 'INVALID_POINTER',
        issues: expect.arrayContaining([expect.objectContaining({ path: 'version' })]) as unknown,
      });
    });

    it('rejects a pointer for another environment without fetching its snapshot', async () => {
      const { source, keys } = sourceOver({
        'production/current.json': {
          body: JSON.stringify(pointer(3, 'staging')),
        },
        'staging/snapshots/3.json': { body: '{}' },
      });

      const error = await loadError(source.load());

      expect(error.reason).toBe('INVALID_POINTER');
      expect(error.cause).toEqual(new Error('Pointer names environment staging, expected production'));
      expect(keys).toEqual(['production/current.json']);
    });
  });

  describe('client', () => {
    it('builds a default client with an empty config when none is injected', () => {
      constructedWith.length = 0;

      const source = createS3SnapshotSource({
        bucket: 'flags',
        environment: 'production',
      });

      expect(constructedWith).toEqual([{}]);
      expect(Object.keys(source)).toEqual(['load', 'subscribe']);
    });

    it('sends requests through the default client when none is injected', async () => {
      const source = createS3SnapshotSource({
        bucket: 'flags',
        environment: 'production',
      });

      const error = await loadError(source.load());

      expect(error.reason).toBe('REQUEST_FAILED');
    });

    it('uses an injected client instead of building one', async () => {
      constructedWith.length = 0;
      const { source, send } = sourceOver({
        'production/current.json': current(1),
        'production/snapshots/1.json': { body: '{}' },
      });

      await source.load();

      expect(constructedWith).toEqual([]);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});

describe('package entry point', () => {
  it('exports the S3 snapshot source, the publisher, the fetcher, the notification queue and their errors', async () => {
    const entry = await import('../../src/index.js');

    expect(Object.keys(entry).sort()).toEqual([
      'S3FetchError',
      'S3PublishError',
      'S3SnapshotError',
      'createS3SnapshotFetcher',
      'createS3SnapshotPublisher',
      'createS3SnapshotSource',
      'createSqsNotificationQueue',
    ]);
  });
});
