import { describe, expect, it, vi } from 'vitest';
import { S3SegmentPublishError, type S3SegmentPublishErrorReason } from '../../src/infrastructure/s3-segment-publisher.js';
import { createS3SegmentVersionReader } from '../../src/infrastructure/s3-segment-version-reader.js';
import { fakeS3, s3Error, segmentPointer, type StoredObject } from './fake-s3.js';

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

const readerOver = (objects: Record<string, StoredObject>) => {
  const s3 = fakeS3(objects);
  return { ...s3, reader: createS3SegmentVersionReader({ bucket: 'flags', client: s3.client }) };
};

const storedPointer = (version: number): StoredObject => ({
  body: JSON.stringify(segmentPointer('beta', version)),
  etag: `"v${String(version)}"`,
});

const expectReason = async (work: Promise<unknown>, reason: S3SegmentPublishErrorReason): Promise<Error> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(S3SegmentPublishError);
  expect((error as S3SegmentPublishError).reason).toBe(reason);
  return error as Error;
};

describe('createS3SegmentVersionReader', () => {
  it('returns the version the Segment Pointer names, reading only that key', async () => {
    const { reader, keys, send } = readerOver({
      [POINTER_KEY]: storedPointer(4),
      'production/segments/beta/4.json': { body: JSON.stringify({ members: ['secret-member'] }) },
    });

    await expect(reader.readVersion('production', 'beta')).resolves.toBe(4);

    expect(keys).toEqual([POINTER_KEY]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].input.Key).toBe(POINTER_KEY);
  });

  it('returns null, not 0 or undefined, when the segment has never been published', async () => {
    const { reader } = readerOver({});

    const version = await reader.readVersion('production', 'beta');

    expect(version).toBeNull();
  });

  it('throws REQUEST_FAILED rather than null when S3 denies the read', async () => {
    const { reader } = readerOver({ [POINTER_KEY]: { error: s3Error('AccessDenied', 403) } });

    await expectReason(reader.readVersion('production', 'beta'), 'REQUEST_FAILED');
  });

  it('throws INVALID_POINTER on an unparsable pointer body', async () => {
    const { reader } = readerOver({ [POINTER_KEY]: { body: '{not json', etag: '"x"' } });

    await expectReason(reader.readVersion('production', 'beta'), 'INVALID_POINTER');
  });

  it('throws INVALID_POINTER on a well-formed body that is not a Segment Pointer', async () => {
    const { reader } = readerOver({ [POINTER_KEY]: { body: JSON.stringify({ version: 4 }), etag: '"x"' } });

    await expectReason(reader.readVersion('production', 'beta'), 'INVALID_POINTER');
  });

  it('throws INVALID_POINTER when the pointer names another segment', async () => {
    const { reader } = readerOver({
      [POINTER_KEY]: { body: JSON.stringify(segmentPointer('alpha', 4)), etag: '"x"' },
    });

    await expectReason(reader.readVersion('production', 'beta'), 'INVALID_POINTER');
  });

  it('throws INVALID_POINTER when the pointer names another environment', async () => {
    const { reader } = readerOver({
      [POINTER_KEY]: { body: JSON.stringify(segmentPointer('beta', 4, 'staging')), etag: '"x"' },
    });

    await expectReason(reader.readVersion('production', 'beta'), 'INVALID_POINTER');
  });

  it('rejects a bad environment or segment key before sending anything', async () => {
    const { reader, keys } = readerOver({ [POINTER_KEY]: storedPointer(4) });

    await expectReason(reader.readVersion('prod/uction', 'beta'), 'INVALID_ENVIRONMENT');
    await expectReason(reader.readVersion('production', 'Beta Key'), 'INVALID_SEGMENT_KEY');

    expect(keys).toEqual([]);
  });

  it('throws INVALID_POINTER on an empty pointer body', async () => {
    const { reader } = readerOver({ [POINTER_KEY]: { etag: '"x"' } });

    await expectReason(reader.readVersion('production', 'beta'), 'INVALID_POINTER');
  });

  it('returns the whole pointer, including the stored Member Attribute, from readPointer', async () => {
    const { reader } = readerOver({
      [POINTER_KEY]: { body: JSON.stringify({ ...segmentPointer('beta', 4), memberAttribute: 'accountId' }), etag: '"x"' },
    });

    await expect(reader.readPointer('production', 'beta')).resolves.toMatchObject({
      segmentKey: 'beta',
      version: 4,
      memberAttribute: 'accountId',
    });
  });

  it('leaves memberAttribute undefined on a pointer written before it was stored', async () => {
    const { reader } = readerOver({ [POINTER_KEY]: storedPointer(4) });

    const pointer = await reader.readPointer('production', 'beta');

    expect(pointer?.memberAttribute).toBeUndefined();
  });

  it('returns null from readPointer when the segment has never been published', async () => {
    const { reader } = readerOver({});

    await expect(reader.readPointer('production', 'beta')).resolves.toBeNull();
  });

  it('builds its own S3 client from the environment when none is given', () => {
    constructedWith.length = 0;

    createS3SegmentVersionReader({ bucket: 'flags' });

    expect(constructedWith).toEqual([{}]);
  });
});
