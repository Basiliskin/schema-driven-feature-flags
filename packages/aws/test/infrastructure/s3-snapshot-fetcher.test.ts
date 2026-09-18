import { describe, expect, it, vi } from 'vitest';
import {
  createS3SnapshotFetcher,
  S3FetchError,
  type S3FetchErrorReason,
} from '../../src/infrastructure/s3-snapshot-fetcher.js';
import { fakeS3, s3Error, type StoredObject } from './fake-s3.js';

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

const KEY = 'production/snapshots/3.json';
const BODY = '{ "flags": {} }\n';

const fetcherOver = (objects: Record<string, StoredObject>) => {
  const s3 = fakeS3(objects);
  return { ...s3, fetcher: createS3SnapshotFetcher({ bucket: 'flags', client: s3.client }) };
};

const failure = async (promise: Promise<unknown>): Promise<S3FetchError> => {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(S3FetchError);
  return error as S3FetchError;
};

describe('createS3SnapshotFetcher', () => {
  it('defaults to an S3 client built only from the standard AWS SDK configuration', () => {
    constructedWith.length = 0;
    createS3SnapshotFetcher({ bucket: 'flags' });
    expect(constructedWith).toEqual([{}]);
  });

  it('reads exactly the pinned snapshot key and returns its bytes unchanged', async () => {
    const { fetcher, send } = fetcherOver({ [KEY]: { body: BODY, etag: '"s3"' } });

    await expect(fetcher.fetch('production', 3)).resolves.toEqual({
      environment: 'production',
      version: 3,
      key: KEY,
      text: BODY,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].input).toEqual({ Bucket: 'flags', Key: KEY });
  });

  it.each([['../x'], [''], ['a/b']])('rejects environment %j before calling S3', async (environment) => {
    const { fetcher, send } = fetcherOver({});

    const error = await failure(fetcher.fetch(environment, 3));

    expect(error.reason).toBe('INVALID_ENVIRONMENT');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([[0], [-1], [1.5], [Number.NaN], ['abc' as unknown as number]])(
    'rejects version %j before calling S3',
    async (version) => {
      const { fetcher, send } = fetcherOver({});

      const error = await failure(fetcher.fetch('production', version));

      expect(error.reason).toBe('INVALID_VERSION');
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each<[string, Error, S3FetchErrorReason]>([
    ['NoSuchKey', s3Error('NoSuchKey', 404), 'SNAPSHOT_NOT_FOUND'],
    ['a bare 404', s3Error('Unknown', 404), 'SNAPSHOT_NOT_FOUND'],
    ['a generic network error', new Error('socket hang up'), 'REQUEST_FAILED'],
  ])('maps %s to its reason and keeps the cause', async (_label, cause, reason) => {
    const { fetcher } = fetcherOver({ [KEY]: { error: cause } });

    const error = await failure(fetcher.fetch('production', 3));

    expect(error.reason).toBe(reason);
    expect(error.key).toBe(KEY);
    expect(error.cause).toBe(cause);
  });

  it.each([s3Error('AccessDenied', 403), s3Error('AccessDenied', 0), s3Error('Unknown', 403)])(
    'reports %s as ACCESS_DENIED rather than a missing version',
    async (cause) => {
      const { fetcher } = fetcherOver({ [KEY]: { error: cause } });

      const error = await failure(fetcher.fetch('production', 3));

      expect(error.reason).toBe('ACCESS_DENIED');
      expect(error.cause).toBe(cause);
    },
  );

  it.each<[string, StoredObject]>([
    ['an empty body', { body: '' }],
    ['no body', {}],
  ])('reports %s as EMPTY_SNAPSHOT', async (_label, object) => {
    const { fetcher } = fetcherOver({ [KEY]: object });

    const error = await failure(fetcher.fetch('production', 3));

    expect(error.reason).toBe('EMPTY_SNAPSHOT');
    expect(error.key).toBe(KEY);
  });
});
