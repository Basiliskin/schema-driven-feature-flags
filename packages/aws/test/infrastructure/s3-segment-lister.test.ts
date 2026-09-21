import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createS3SegmentLister } from '../../src/infrastructure/s3-segment-lister.js';
import { S3SegmentPublishError } from '../../src/infrastructure/s3-segment-publisher.js';
import { s3Error } from './fake-s3.js';

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

interface ListPage {
  readonly commonPrefixes?: readonly (string | undefined)[];
  readonly nextContinuationToken?: string;
}

const listerOver = (...pages: ListPage[]) => {
  const requested: ListObjectsV2Command['input'][] = [];
  const send = vi.fn((command: ListObjectsV2Command) => {
    requested.push(command.input);
    const page = pages.shift();
    if (page === undefined) return Promise.reject(new Error('one page too many was requested'));
    return Promise.resolve({
      ...(page.commonPrefixes === undefined ? {} : { CommonPrefixes: page.commonPrefixes.map((Prefix) => ({ Prefix })) }),
      IsTruncated: page.nextContinuationToken !== undefined,
      ...(page.nextContinuationToken === undefined ? {} : { NextContinuationToken: page.nextContinuationToken }),
    });
  });
  const client = { send } as unknown as Pick<import('@aws-sdk/client-s3').S3Client, 'send'>;
  return { lister: createS3SegmentLister({ bucket: 'flags', client }), send, inputs: () => requested };
};

const failingLister = (error: Error) => {
  const send = vi.fn(() => Promise.reject(error));
  const client = { send } as unknown as Pick<import('@aws-sdk/client-s3').S3Client, 'send'>;
  return createS3SegmentLister({ bucket: 'flags', client });
};

describe('createS3SegmentLister', () => {
  it('returns one bare Segment Key per common prefix under <environment>/segments/', async () => {
    const { lister, inputs } = listerOver({
      commonPrefixes: ['production/segments/gamma/', 'production/segments/alpha/', 'production/segments/beta/'],
    });

    await expect(lister.listSegmentKeys('production')).resolves.toEqual(['alpha', 'beta', 'gamma']);

    expect(inputs()).toEqual([
      { Bucket: 'flags', Prefix: 'production/segments/', Delimiter: '/' },
    ]);
  });

  it('follows a truncated listing with the token the previous page returned', async () => {
    const { lister, inputs } = listerOver(
      { commonPrefixes: ['production/segments/alpha/'], nextContinuationToken: 'page-2' },
      { commonPrefixes: ['production/segments/beta/'], nextContinuationToken: 'page-3' },
      { commonPrefixes: ['production/segments/gamma/'] },
    );

    await expect(lister.listSegmentKeys('production')).resolves.toEqual(['alpha', 'beta', 'gamma']);

    expect(inputs().map((input) => input.ContinuationToken)).toEqual([undefined, 'page-2', 'page-3']);
    expect(inputs().map((input) => input.Prefix)).toEqual([
      'production/segments/',
      'production/segments/',
      'production/segments/',
    ]);
  });

  it('stops paging when a truncated response carries no continuation token', async () => {
    const send = vi.fn(() =>
      Promise.resolve({ CommonPrefixes: [{ Prefix: 'production/segments/alpha/' }], IsTruncated: true }),
    );
    const client = { send } as unknown as Pick<import('@aws-sdk/client-s3').S3Client, 'send'>;

    await expect(createS3SegmentLister({ bucket: 'flags', client }).listSegmentKeys('production')).resolves.toEqual([
      'alpha',
    ]);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list, not an error, when the prefix holds nothing', async () => {
    const { lister } = listerOver({});

    await expect(lister.listSegmentKeys('production')).resolves.toEqual([]);
  });

  it('deduplicates a key repeated across pages', async () => {
    const { lister } = listerOver(
      { commonPrefixes: ['production/segments/alpha/'], nextContinuationToken: 'page-2' },
      { commonPrefixes: ['production/segments/alpha/'] },
    );

    await expect(lister.listSegmentKeys('production')).resolves.toEqual(['alpha']);
  });

  it('drops a common prefix that is not a single well-formed segment key', async () => {
    const { lister } = listerOver({
      commonPrefixes: [
        undefined,
        'staging/segments/foreign/',
        'production/segments/alpha',
        'production/segments/Not A Key/',
        'production/segments/alpha/',
      ],
    });

    await expect(lister.listSegmentKeys('production')).resolves.toEqual(['alpha']);
  });

  it('throws REQUEST_FAILED rather than reporting an empty environment when the listing is denied', async () => {
    const lister = failingLister(s3Error('AccessDenied', 403));

    const error = await lister.listSegmentKeys('production').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(S3SegmentPublishError);
    expect((error as S3SegmentPublishError).reason).toBe('REQUEST_FAILED');
    expect((error as S3SegmentPublishError).key).toBe('production/segments/');
  });

  it('rejects a bad environment name before sending anything', async () => {
    const { lister, send } = listerOver({});

    const error = await lister.listSegmentKeys('prod/uction').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect((error as S3SegmentPublishError).reason).toBe('INVALID_ENVIRONMENT');
    expect(send).not.toHaveBeenCalled();
  });

  it('builds its own S3 client from the environment when none is given', () => {
    constructedWith.length = 0;

    createS3SegmentLister({ bucket: 'flags' });

    expect(constructedWith).toEqual([{}]);
  });
});
