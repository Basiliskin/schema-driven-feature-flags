import { describe, expect, it } from 'vitest';
import { isMissing, isNotFound, readObjectText } from '../../src/infrastructure/s3-read.js';
import { fakeS3, s3Error } from './fake-s3.js';

describe('readObjectText', () => {
  it('returns the object body and ETag', async () => {
    const { client, send } = fakeS3({ 'a.json': { body: '{"x":1}', etag: '"e1"' } });

    await expect(readObjectText(client, 'bucket', 'a.json')).resolves.toEqual({ text: '{"x":1}', etag: '"e1"' });
    expect(send.mock.calls[0]?.[0].input).toEqual({ Bucket: 'bucket', Key: 'a.json' });
  });

  it('sends IfNoneMatch only when given', async () => {
    const { client, send } = fakeS3({ 'a.json': { body: '{}', etag: '"e1"' } });

    await readObjectText(client, 'bucket', 'a.json', '"e0"');

    expect(send.mock.calls[0]?.[0].input).toEqual({ Bucket: 'bucket', Key: 'a.json', IfNoneMatch: '"e0"' });
  });

  it('returns undefined text when the object has no body', async () => {
    const { client } = fakeS3({ 'a.json': { etag: '"e1"' } });

    await expect(readObjectText(client, 'bucket', 'a.json')).resolves.toEqual({ text: undefined, etag: '"e1"' });
  });

  it('propagates S3 failures unchanged', async () => {
    const failure = s3Error('InternalError', 500);
    const { client } = fakeS3({ 'a.json': { error: failure } });

    await expect(readObjectText(client, 'bucket', 'a.json')).rejects.toBe(failure);
  });
});

describe('isMissing', () => {
  it.each([
    ['NoSuchKey', 404],
    ['AccessDenied', 403],
    ['NoSuchKey', 0],
    ['AccessDenied', 0],
    ['Unknown', 404],
    ['Unknown', 403],
  ])('treats %s / %i as missing', (name, status) => {
    expect(isMissing(s3Error(name, status))).toBe(true);
  });

  it.each([s3Error('InternalError', 500), s3Error('NotModified', 304), new Error('boom'), 'boom', null])(
    'does not treat %s as missing',
    (error) => {
      expect(isMissing(error)).toBe(false);
    },
  );
});

describe('isNotFound', () => {
  it.each([
    ['NoSuchKey', 404],
    ['NoSuchKey', 0],
    ['Unknown', 404],
  ])('treats %s / %i as not found', (name, status) => {
    expect(isNotFound(s3Error(name, status))).toBe(true);
  });

  it.each([s3Error('AccessDenied', 403), s3Error('AccessDenied', 0), s3Error('Unknown', 403), s3Error('InternalError', 500), new Error('boom'), null])(
    'does not treat %s as not found',
    (error) => {
      expect(isNotFound(error)).toBe(false);
    },
  );
});
