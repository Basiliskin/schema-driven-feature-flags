import { describe, expect, it, vi } from 'vitest';
import { createS3CurrentPointerReader } from '../../src/infrastructure/s3-current-pointer-reader.js';
import { S3FetchError, type S3FetchErrorReason } from '../../src/infrastructure/s3-snapshot-fetcher.js';
import { S3SnapshotError, type S3SnapshotErrorReason } from '../../src/infrastructure/s3-snapshot-error.js';
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

const KEY = 'production/current.json';

const readerOver = (objects: Record<string, StoredObject>) => {
  const s3 = fakeS3(objects);
  return { ...s3, reader: createS3CurrentPointerReader({ bucket: 'flags', client: s3.client }) };
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

const fetchFailure = async (promise: Promise<unknown>): Promise<S3FetchError> => {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(S3FetchError);
  return error as S3FetchError;
};

const pointerFailure = async (promise: Promise<unknown>): Promise<S3SnapshotError> => {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(S3SnapshotError);
  return error as S3SnapshotError;
};

describe('createS3CurrentPointerReader', () => {
  it('defaults to an S3 client built only from the standard AWS SDK configuration', () => {
    constructedWith.length = 0;
    createS3CurrentPointerReader({ bucket: 'flags' });
    expect(constructedWith).toEqual([{}]);
  });

  it('reads exactly the current pointer key and resolves to the version it names', async () => {
    const { reader, send } = readerOver({ [KEY]: current(4) });

    await expect(reader.read('production')).resolves.toBe(4);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].input).toEqual({ Bucket: 'flags', Key: KEY });
  });

  it.each([s3Error('NoSuchKey', 404), s3Error('Unknown', 404)])(
    'resolves to undefined when the environment has no pointer yet (%s)',
    async (cause) => {
      const { reader } = readerOver({ [KEY]: { error: cause } });

      await expect(reader.read('production')).resolves.toBeUndefined();
    },
  );

  it.each([['../x'], [''], ['a/b']])('rejects environment %j before calling S3', async (environment) => {
    const { reader, send } = readerOver({});

    const error = await fetchFailure(reader.read(environment));

    expect(error.reason).toBe('INVALID_ENVIRONMENT');
    expect(send).not.toHaveBeenCalled();
  });

  it.each<[string, Error, S3FetchErrorReason]>([
    ['AccessDenied', s3Error('AccessDenied', 0), 'ACCESS_DENIED'],
    ['a bare 403', s3Error('Unknown', 403), 'ACCESS_DENIED'],
    ['a generic network error', new Error('socket hang up'), 'REQUEST_FAILED'],
  ])('maps %s to its reason and keeps the cause', async (_label, cause, reason) => {
    const { reader } = readerOver({ [KEY]: { error: cause } });

    const error = await fetchFailure(reader.read('production'));

    expect(error.reason).toBe(reason);
    expect(error.key).toBe(KEY);
    expect(error.cause).toBe(cause);
  });

  it.each<[string, StoredObject, S3SnapshotErrorReason]>([
    ['no body', {}, 'INVALID_JSON'],
    ['an empty body', { body: '' }, 'INVALID_JSON'],
    ['a body that is not JSON', { body: '{ not json' }, 'INVALID_JSON'],
    ['a pointer with a wrong schema', { body: JSON.stringify({ ...pointer(4), version: 0 }) }, 'INVALID_POINTER'],
    ['a pointer for another environment', { body: JSON.stringify(pointer(4, 'staging')) }, 'INVALID_POINTER'],
  ])('reports %s as a malformed pointer', async (_label, object, reason) => {
    const { reader } = readerOver({ [KEY]: object });

    const error = await pointerFailure(reader.read('production'));

    expect(error.reason).toBe(reason);
    expect(error.key).toBe(KEY);
  });
});
