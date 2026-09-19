import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
  createS3SegmentPublisher,
  S3SegmentPublishError,
  type S3SegmentPublishErrorReason,
  type SegmentDraft,
} from '../../src/infrastructure/s3-segment-publisher.js';
import { s3Error, type StoredObject } from './fake-s3.js';

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

const POINTER_KEY = 'production/segments/beta/current.json';

const draft = (members: readonly string[] = ['u-1', '007']): SegmentDraft => ({
  key: 'beta',
  memberAttribute: 'userId',
  members,
});

const segmentPointer = (version: number, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  environment: 'production',
  segmentKey: 'beta',
  version,
  objectKey: `production/segments/beta/${String(version)}.json`,
  ...overrides,
});

const storedPointer = (version: number, etag = `"p${String(version)}"`): StoredObject => ({
  body: JSON.stringify(segmentPointer(version)),
  etag,
});

interface Put {
  readonly key: string;
  readonly input: Record<string, unknown>;
}

const fakeWritableS3 = (objects: Record<string, StoredObject>, putErrors: Record<string, Error> = {}) => {
  const puts: Put[] = [];
  const gets: string[] = [];
  const send = vi.fn((command: GetObjectCommand | PutObjectCommand) => {
    const key = command.input.Key ?? '';
    if (command instanceof PutObjectCommand) {
      puts.push({ key, input: { ...command.input } });
      const error = putErrors[key];
      return error === undefined ? Promise.resolve({ ETag: '"new"' }) : Promise.reject(error);
    }
    if (!(command instanceof GetObjectCommand)) return Promise.reject(new Error('unexpected S3 command'));
    gets.push(key);
    const object = objects[key] ?? { error: s3Error('NoSuchKey', 404) };
    if ('error' in object) return Promise.reject(object.error);
    const { body, etag } = object;
    return Promise.resolve({
      ETag: etag,
      Body: body === undefined ? undefined : { transformToString: () => Promise.resolve(body) },
    });
  });
  return { client: { send } as unknown as Pick<S3Client, 'send'>, puts, gets };
};

const publishError = async (promise: Promise<unknown>): Promise<S3SegmentPublishError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof S3SegmentPublishError) return error;
    throw error;
  }
  throw new Error('expected the publish to fail');
};

const expectReason = async (promise: Promise<unknown>, reason: S3SegmentPublishErrorReason, key: string) => {
  const error = await publishError(promise);
  expect(error.reason).toBe(reason);
  expect(error.key).toBe(key);
  return error;
};

describe('createS3SegmentPublisher', () => {
  it('publishes version 1 and creates the pointer only if none exists', async () => {
    const s3 = fakeWritableS3({});
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    await expect(publisher.publish('production', draft())).resolves.toEqual(segmentPointer(1));

    expect(s3.gets).toEqual([POINTER_KEY]);
    expect(s3.puts).toEqual([
      {
        key: 'production/segments/beta/1.json',
        input: {
          Bucket: 'flags',
          Key: 'production/segments/beta/1.json',
          Body: JSON.stringify({
            schemaVersion: 1,
            key: 'beta',
            version: 1,
            memberAttribute: 'userId',
            members: ['u-1', '007'],
          }),
          ContentType: 'application/json',
          IfNoneMatch: '*',
        },
      },
      {
        key: POINTER_KEY,
        input: {
          Bucket: 'flags',
          Key: POINTER_KEY,
          Body: JSON.stringify(segmentPointer(1)),
          ContentType: 'application/json',
          IfNoneMatch: '*',
        },
      },
    ]);
  });

  it('publishes the next version and moves the pointer with IfMatch on its ETag', async () => {
    const s3 = fakeWritableS3({ [POINTER_KEY]: storedPointer(4, '"etag-4"') });
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    await expect(publisher.publish('production', draft())).resolves.toEqual(segmentPointer(5));

    expect(s3.puts.map(({ key, input }) => [key, input.IfNoneMatch, input.IfMatch])).toEqual([
      ['production/segments/beta/5.json', '*', undefined],
      [POINTER_KEY, undefined, '"etag-4"'],
    ]);
  });

  it('ignores a segment version the caller supplied', async () => {
    const s3 = fakeWritableS3({ [POINTER_KEY]: storedPointer(1) });
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    await publisher.publish('production', { ...draft(), version: 9 } as SegmentDraft);

    expect(s3.puts[0]?.key).toBe('production/segments/beta/2.json');
    expect(JSON.parse(String(s3.puts[0]?.input.Body))).toMatchObject({ version: 2 });
  });

  it('reports VERSION_EXISTS and leaves the pointer alone when the version object already exists', async () => {
    const versionKey = 'production/segments/beta/5.json';
    const s3 = fakeWritableS3({ [POINTER_KEY]: storedPointer(4) }, { [versionKey]: s3Error('PreconditionFailed', 412) });
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    await expectReason(publisher.publish('production', draft()), 'VERSION_EXISTS', versionKey);
    expect(s3.puts.map(({ key }) => key)).toEqual([versionKey]);
  });

  it.each([
    ['a 412', s3Error('PreconditionFailed', 412)],
    ['a 409', s3Error('ConditionalRequestConflict', 409)],
  ])('reports CONFLICT when the pointer moved underneath (%s)', async (_label, error) => {
    const s3 = fakeWritableS3({ [POINTER_KEY]: storedPointer(4) }, { [POINTER_KEY]: error });
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    await expectReason(publisher.publish('production', draft()), 'CONFLICT', POINTER_KEY);
  });

  it('reports CONFLICT when another upload created the first pointer first', async () => {
    const s3 = fakeWritableS3({}, { [POINTER_KEY]: s3Error('PreconditionFailed', 412) });
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    await expectReason(publisher.publish('production', draft()), 'CONFLICT', POINTER_KEY);
    expect(s3.puts[1]?.input.IfNoneMatch).toBe('*');
  });

  it.each([
    ['the version write', 'production/segments/beta/1.json'],
    ['the pointer write', POINTER_KEY],
  ])('reports REQUEST_FAILED when %s fails for another reason', async (_label, key) => {
    const s3 = fakeWritableS3({}, { [key]: s3Error('InternalError', 500) });
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    await expectReason(publisher.publish('production', draft()), 'REQUEST_FAILED', key);
  });

  it('reports REQUEST_FAILED when the pointer cannot be read', async () => {
    const s3 = fakeWritableS3({ [POINTER_KEY]: { error: s3Error('AccessDenied', 403) } });
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    await expectReason(publisher.publish('production', draft()), 'REQUEST_FAILED', POINTER_KEY);
    expect(s3.puts).toEqual([]);
  });

  it('reports REQUEST_FAILED when the pointer response has no ETag', async () => {
    const s3 = fakeWritableS3({ [POINTER_KEY]: { body: JSON.stringify(segmentPointer(1)) } });
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    await expectReason(publisher.publish('production', draft()), 'REQUEST_FAILED', POINTER_KEY);
  });

  it.each([
    ['not JSON', '{'],
    ['an empty body', undefined],
    ['an invalid pointer', JSON.stringify(segmentPointer(0))],
    [
      'a pointer for another segment',
      JSON.stringify(segmentPointer(1, { segmentKey: 'other', objectKey: 'production/segments/other/1.json' })),
    ],
    [
      'a pointer for another environment',
      JSON.stringify(segmentPointer(1, { environment: 'staging', objectKey: 'staging/segments/beta/1.json' })),
    ],
  ])('reports INVALID_POINTER for %s', async (_label, body) => {
    const s3 = fakeWritableS3({ [POINTER_KEY]: body === undefined ? { etag: '"p"' } : { body, etag: '"p"' } });
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    await expectReason(publisher.publish('production', draft()), 'INVALID_POINTER', POINTER_KEY);
    expect(s3.puts).toEqual([]);
  });

  it.each(['', 'prod/eu'])('rejects environment %j before any request', async (environment) => {
    const s3 = fakeWritableS3({});
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    await expectReason(publisher.publish(environment, draft()), 'INVALID_ENVIRONMENT', environment);
    expect(s3.gets).toEqual([]);
  });

  it.each(['../x', 'A B', ''])('rejects segment key %j before any request', async (key) => {
    const s3 = fakeWritableS3({});
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    await expectReason(publisher.publish('production', { ...draft(), key }), 'INVALID_SEGMENT_KEY', 'production/segments');
    expect(s3.gets).toEqual([]);
  });

  it('rejects an invalid segment without writing and without a member in the error', async () => {
    const s3 = fakeWritableS3({});
    const publisher = createS3SegmentPublisher({ bucket: 'flags', client: s3.client });

    const error = await expectReason(
      publisher.publish('production', draft(['secret@example.com', 'secret@example.com'])),
      'INVALID_SEGMENT',
      'production/segments/beta/1.json',
    );
    expect(s3.puts).toEqual([]);
    expect(error.message).not.toContain('secret');
    expect((error.cause as Error).message).not.toContain('secret');
  });

  it('builds a default S3 client from the environment when none is given', async () => {
    constructedWith.length = 0;
    const publisher = createS3SegmentPublisher({ bucket: 'flags' });

    await expectReason(publisher.publish('production', draft()), 'REQUEST_FAILED', POINTER_KEY);
    expect(constructedWith).toEqual([{}]);
  });
});
