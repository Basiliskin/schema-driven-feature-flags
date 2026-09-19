import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { describe, expect, it, vi } from 'vitest';
import {
  createS3SnapshotPublisher,
  S3PublishError,
  type NotifyErrorHandler,
  type S3PublishErrorReason,
  type SnapshotValidation,
} from '../../src/infrastructure/s3-snapshot-publisher.js';
import { current, pointer, s3Error, type StoredObject } from './fake-s3.js';

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

interface SentCommand {
  readonly command: 'GetObject' | 'PutObject';
  readonly key: string;
  readonly input: Record<string, unknown>;
}

const snapshot = { version: 1, features: {} };
const accept = (): SnapshotValidation => ({ ok: true });

/** A GetObject/PutObject stand-in that records every command; `putErrors` fails a put to the given key. */
const fakeWritableS3 = (objects: Record<string, StoredObject>, putErrors: Record<string, Error> = {}) => {
  const sent: SentCommand[] = [];
  const send = vi.fn((command: GetObjectCommand | PutObjectCommand) => {
    const key = command.input.Key ?? '';
    if (command instanceof PutObjectCommand) {
      sent.push({ command: 'PutObject', key, input: { ...command.input } });
      const error = putErrors[key];
      return error === undefined ? Promise.resolve({ ETag: '"new"' }) : Promise.reject(error);
    }
    sent.push({ command: 'GetObject', key, input: { ...command.input } });
    const object = objects[key] ?? { error: s3Error('NoSuchKey', 404) };
    if ('error' in object) return Promise.reject(object.error);
    const { body, etag } = object;
    return Promise.resolve({
      ETag: etag,
      Body: body === undefined ? undefined : { transformToString: () => Promise.resolve(body) },
    });
  });
  const puts = () => sent.filter((entry) => entry.command === 'PutObject');
  return { client: { send } as unknown as Pick<S3Client, 'send'>, sent, puts };
};

const publisherOver = (
  objects: Record<string, StoredObject>,
  putErrors: Record<string, Error> = {},
  validate: (snapshot: unknown) => SnapshotValidation = accept,
) => {
  const fake = fakeWritableS3(objects, putErrors);
  return { ...fake, publisher: createS3SnapshotPublisher({ bucket: 'flags', client: fake.client, validate }) };
};

const publishError = async (promise: Promise<unknown>): Promise<S3PublishError> => {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(S3PublishError);
  return error as S3PublishError;
};

const expectReason = async (promise: Promise<unknown>, reason: S3PublishErrorReason, key: string) => {
  const error = await publishError(promise);
  expect(error.reason).toBe(reason);
  expect(error.key).toBe(key);
  return error;
};

const pointerBody = (input: Record<string, unknown>) => JSON.parse(String(input.Body)) as unknown;

describe('createS3SnapshotPublisher', () => {
  it('defaults to an S3 client built only from the standard AWS SDK configuration', () => {
    constructedWith.length = 0;
    createS3SnapshotPublisher({ bucket: 'flags', validate: accept });
    expect(constructedWith).toEqual([{}]);
  });

  describe('publish', () => {
    it('reads the pointer, writes the next snapshot create-only, then swaps the pointer on its ETag', async () => {
      const { publisher, sent } = publisherOver({ 'production/current.json': current(4, '"etag-4"') });

      await expect(publisher.publish('production', snapshot)).resolves.toBe(5);

      expect(sent.map(({ command, key }) => `${command} ${key}`)).toEqual([
        'GetObject production/current.json',
        'PutObject production/snapshots/5.json',
        'PutObject production/current.json',
      ]);
      const [, snapshotPut, pointerPut] = sent;
      expect(snapshotPut?.input).toMatchObject({ Bucket: 'flags', IfNoneMatch: '*', ContentType: 'application/json' });
      expect(snapshotPut?.input).not.toHaveProperty('IfMatch');
      expect(JSON.parse(String(snapshotPut?.input.Body))).toEqual(snapshot);
      expect(pointerPut?.input).toMatchObject({ Bucket: 'flags', IfMatch: '"etag-4"' });
      expect(pointerPut?.input).not.toHaveProperty('IfNoneMatch');
      expect(pointerBody(pointerPut?.input ?? {})).toEqual(pointer(5));
    });

    it('publishes version 1 with a create-only pointer when nothing has been published', async () => {
      const { publisher, puts } = publisherOver({});

      await expect(publisher.publish('production', snapshot)).resolves.toBe(1);

      const [snapshotPut, pointerPut] = puts();
      expect(snapshotPut).toMatchObject({ key: 'production/snapshots/1.json', input: { IfNoneMatch: '*' } });
      expect(pointerPut).toMatchObject({ key: 'production/current.json', input: { IfNoneMatch: '*' } });
      expect(pointerPut?.input).not.toHaveProperty('IfMatch');
      expect(pointerBody(pointerPut?.input ?? {})).toEqual(pointer(1));
    });

    it('treats a 404 without the NoSuchKey name as no pointer yet', async () => {
      const { publisher } = publisherOver({ 'production/current.json': { error: s3Error('NotFound', 404) } });

      await expect(publisher.publish('production', snapshot)).resolves.toBe(1);
    });

    it('rejects a snapshot the injected validator refuses without sending anything', async () => {
      const refusal = new Error('features: required');
      const { publisher, sent } = publisherOver({}, {}, () => ({ ok: false, error: refusal }));

      const error = await expectReason(publisher.publish('production', {}), 'INVALID_SNAPSHOT', 'production/snapshots');

      expect(error.cause).toBe(refusal);
      expect(sent).toEqual([]);
    });

    it('rejects an environment name containing "/" before touching S3', async () => {
      const { publisher, sent } = publisherOver({});

      await expectReason(publisher.publish('prod/eu', snapshot), 'INVALID_ENVIRONMENT', 'prod/eu');
      expect(sent).toEqual([]);
    });

    it('fails on a 403 pointer read instead of publishing version 1', async () => {
      const denied = s3Error('AccessDenied', 403);
      const { publisher, puts } = publisherOver({ 'production/current.json': { error: denied } });

      const error = await expectReason(publisher.publish('production', snapshot), 'REQUEST_FAILED', 'production/current.json');

      expect(error.cause).toBe(denied);
      expect(puts()).toEqual([]);
    });

    it('fails when a non-object is thrown by the pointer read', async () => {
      const { publisher } = publisherOver({ 'production/current.json': { error: 'boom' as unknown as Error } });

      await expectReason(publisher.publish('production', snapshot), 'REQUEST_FAILED', 'production/current.json');
    });

    it('maps a lost race on the snapshot key to VERSION_EXISTS and leaves the pointer alone', async () => {
      const { publisher, puts } = publisherOver(
        { 'production/current.json': current(4) },
        { 'production/snapshots/5.json': s3Error('PreconditionFailed', 412) },
      );

      await expectReason(publisher.publish('production', snapshot), 'VERSION_EXISTS', 'production/snapshots/5.json');
      expect(puts().map(({ key }) => key)).toEqual(['production/snapshots/5.json']);
    });

    it('maps a ConditionalRequestConflict on the snapshot key to VERSION_EXISTS', async () => {
      const { publisher } = publisherOver({}, { 'production/snapshots/1.json': s3Error('ConditionalRequestConflict', 409) });

      await expectReason(publisher.publish('production', snapshot), 'VERSION_EXISTS', 'production/snapshots/1.json');
    });

    it('does not write the pointer when the snapshot put fails for any other reason', async () => {
      const { publisher, puts } = publisherOver({}, { 'production/snapshots/1.json': s3Error('InternalError', 500) });

      await expectReason(publisher.publish('production', snapshot), 'REQUEST_FAILED', 'production/snapshots/1.json');
      expect(puts().map(({ key }) => key)).toEqual(['production/snapshots/1.json']);
    });

    it('maps a 412 on the pointer put to CONFLICT', async () => {
      const { publisher } = publisherOver(
        { 'production/current.json': current(4) },
        { 'production/current.json': s3Error('PreconditionFailed', 412) },
      );

      await expectReason(publisher.publish('production', snapshot), 'CONFLICT', 'production/current.json');
    });

    it.each<[string, StoredObject]>([
      ['a body that is not JSON', { body: '{', etag: '"e"' }],
      ['an empty body', { etag: '"e"' }],
      ['a pointer that fails the pointer schema', { body: JSON.stringify({ version: 4 }), etag: '"e"' }],
      ['a pointer for another environment', { body: JSON.stringify(pointer(4, 'staging')), etag: '"e"' }],
    ])('refuses to publish over %s', async (_label, object) => {
      const { publisher, puts } = publisherOver({ 'production/current.json': object });

      await expectReason(publisher.publish('production', snapshot), 'INVALID_POINTER', 'production/current.json');
      expect(puts()).toEqual([]);
    });

    it('refuses a pointer response without an ETag, since the swap could not be conditional', async () => {
      const { publisher, puts } = publisherOver({ 'production/current.json': { body: JSON.stringify(pointer(4)) } });

      await expectReason(publisher.publish('production', snapshot), 'REQUEST_FAILED', 'production/current.json');
      expect(puts()).toEqual([]);
    });

    describe('with an expected current version', () => {
      it('publishes the next version when the pointer is at the expected version, reading it once', async () => {
        const { publisher, sent } = publisherOver({ 'production/current.json': current(5, '"etag-5"') });

        await expect(publisher.publish('production', snapshot, { expectedCurrentVersion: 5 })).resolves.toBe(6);

        expect(sent.map(({ command, key }) => `${command} ${key}`)).toEqual([
          'GetObject production/current.json',
          'PutObject production/snapshots/6.json',
          'PutObject production/current.json',
        ]);
        expect(sent[2]?.input).toMatchObject({ IfMatch: '"etag-5"' });
      });

      it('throws CONFLICT without writing when the pointer has moved past the expected version', async () => {
        const { publisher, sent, puts } = publisherOver({ 'production/current.json': current(5) });

        const error = await expectReason(
          publisher.publish('production', snapshot, { expectedCurrentVersion: 4 }),
          'CONFLICT',
          'production/current.json',
        );

        expect((error.cause as Error).message).toBe('Expected current version 4, found 5');
        expect(puts()).toHaveLength(0);
        expect(sent.filter(({ key }) => key === 'production/current.json')).toHaveLength(1);
      });

      it('throws CONFLICT without writing when an expectation is given but nothing has been published', async () => {
        const { publisher, puts } = publisherOver({});

        const error = await expectReason(
          publisher.publish('production', snapshot, { expectedCurrentVersion: 0 }),
          'CONFLICT',
          'production/current.json',
        );

        expect((error.cause as Error).message).toBe('Expected current version 0, found none');
        expect(puts()).toHaveLength(0);
      });

      it('publishes as before when the options carry no expectation', async () => {
        const { publisher, puts } = publisherOver({ 'production/current.json': current(2) });

        await expect(publisher.publish('production', snapshot, {})).resolves.toBe(3);

        expect(puts().map(({ key }) => key)).toEqual(['production/snapshots/3.json', 'production/current.json']);
      });
    });
  });

  describe('rollback', () => {
    const published = (): Record<string, StoredObject> => ({
      'production/current.json': current(4, '"etag-4"'),
      'production/snapshots/2.json': { body: JSON.stringify({ version: 2, features: {} }), etag: '"s2"' },
    });

    it('re-validates the target, then rewrites only the pointer on its ETag', async () => {
      const validate = vi.fn(accept);
      const { publisher, sent, puts } = publisherOver(published(), {}, validate);

      await expect(publisher.rollback('production', 2)).resolves.toBe(2);

      expect(sent.map(({ command, key }) => `${command} ${key}`)).toEqual([
        'GetObject production/current.json',
        'GetObject production/snapshots/2.json',
        'PutObject production/current.json',
      ]);
      expect(validate).toHaveBeenCalledWith({ version: 2, features: {} });
      const [pointerPut] = puts();
      expect(puts()).toHaveLength(1);
      expect(pointerPut?.input).toMatchObject({ IfMatch: '"etag-4"' });
      expect(pointerBody(pointerPut?.input ?? {})).toEqual(pointer(2));
      expect(sent.some(({ command, key }) => command === 'PutObject' && key.includes('/snapshots/'))).toBe(false);
    });

    it('refuses a target that fails validation without moving the pointer', async () => {
      const { publisher, puts } = publisherOver(published(), {}, () => ({ ok: false, error: new Error('bad') }));

      await expectReason(publisher.rollback('production', 2), 'INVALID_SNAPSHOT', 'production/snapshots/2.json');
      expect(puts()).toEqual([]);
    });

    it('refuses a target whose body is not JSON', async () => {
      const { publisher, puts } = publisherOver({
        ...published(),
        'production/snapshots/2.json': { body: 'nope', etag: '"s2"' },
      });

      await expectReason(publisher.rollback('production', 2), 'INVALID_SNAPSHOT', 'production/snapshots/2.json');
      expect(puts()).toEqual([]);
    });

    it.each([
      ['a target not below the current version', 4],
      ['a target that is not a positive integer', 0],
    ])('rejects %s before reading any snapshot', async (_label, target) => {
      const { publisher, sent } = publisherOver(published());

      await expectReason(publisher.rollback('production', target), 'INVALID_ROLLBACK_TARGET', 'production/current.json');
      expect(sent.map(({ key }) => key)).toEqual(['production/current.json']);
    });

    it('rejects a rollback when nothing has been published', async () => {
      const { publisher, sent } = publisherOver({});

      await expectReason(publisher.rollback('production', 1), 'INVALID_ROLLBACK_TARGET', 'production/current.json');
      expect(sent).toHaveLength(1);
    });

    it('rejects a target version whose snapshot is missing', async () => {
      const { publisher, puts } = publisherOver({ 'production/current.json': current(4) });

      await expectReason(publisher.rollback('production', 3), 'INVALID_ROLLBACK_TARGET', 'production/snapshots/3.json');
      expect(puts()).toEqual([]);
    });

    it('fails when the target snapshot cannot be read', async () => {
      const { publisher, puts } = publisherOver({
        ...published(),
        'production/snapshots/2.json': { error: s3Error('AccessDenied', 403) },
      });

      await expectReason(publisher.rollback('production', 2), 'REQUEST_FAILED', 'production/snapshots/2.json');
      expect(puts()).toEqual([]);
    });

    it('maps a 412 on the pointer put to CONFLICT', async () => {
      const { publisher } = publisherOver(published(), { 'production/current.json': s3Error('PreconditionFailed', 412) });

      await expectReason(publisher.rollback('production', 2), 'CONFLICT', 'production/current.json');
    });

    it('rejects an invalid environment name before touching S3', async () => {
      const { publisher, sent } = publisherOver({});

      await expectReason(publisher.rollback('', 1), 'INVALID_ENVIRONMENT', '');
      expect(sent).toEqual([]);
    });
  });
});

describe('change notifications', () => {
  const topicArn = 'arn:aws:sns:eu-west-1:123456789012:featuresync-updates';

  const fakeSns = (error?: Error) => {
    const messages: unknown[] = [];
    const send = vi.fn((command: PublishCommand) => {
      if (error !== undefined) return Promise.reject(error);
      expect(command.input.TopicArn).toBe(topicArn);
      messages.push(JSON.parse(command.input.Message ?? ''));
      return Promise.resolve({});
    });
    return { snsClient: { send } as unknown as Pick<SNSClient, 'send'>, messages, send };
  };

  const notifyingPublisher = (
    objects: Record<string, StoredObject>,
    sns: ReturnType<typeof fakeSns>,
    extra: { putErrors?: Record<string, Error>; onNotifyError?: NotifyErrorHandler; topicArn?: string } = { topicArn },
  ) => {
    const s3 = fakeWritableS3(objects, extra.putErrors);
    const publisher = createS3SnapshotPublisher({
      bucket: 'flags',
      client: s3.client,
      validate: accept,
      snsClient: sns.snsClient,
      ...(extra.topicArn === undefined ? {} : { topicArn: extra.topicArn }),
      ...(extra.onNotifyError === undefined ? {} : { onNotifyError: extra.onNotifyError }),
    });
    return { ...s3, publisher };
  };

  const notification = pointer;

  it('sends one notification after a publish moves the pointer', async () => {
    const sns = fakeSns();
    const { publisher } = notifyingPublisher({ 'production/current.json': current(4) }, sns);

    await expect(publisher.publish('production', snapshot)).resolves.toBe(5);

    expect(sns.messages).toEqual([notification(5)]);
  });

  it('sends one notification after a rollback moves the pointer', async () => {
    const sns = fakeSns();
    const { publisher } = notifyingPublisher(
      { 'production/current.json': current(5), 'production/snapshots/3.json': { body: JSON.stringify(snapshot) } },
      sns,
    );

    await expect(publisher.rollback('production', 3)).resolves.toBe(3);

    expect(sns.messages).toEqual([notification(3)]);
  });

  it('sends nothing without a topicArn', async () => {
    const sns = fakeSns();
    const { publisher } = notifyingPublisher({}, sns, {});

    await expect(publisher.publish('production', snapshot)).resolves.toBe(1);

    expect(sns.send).not.toHaveBeenCalled();
  });

  it('sends nothing when the pointer write fails', async () => {
    const sns = fakeSns();
    const { publisher } = notifyingPublisher({ 'production/current.json': current(4) }, sns, {
      topicArn,
      putErrors: { 'production/current.json': s3Error('PreconditionFailed', 412) },
    });

    await expectReason(publisher.publish('production', snapshot), 'CONFLICT', 'production/current.json');

    expect(sns.send).not.toHaveBeenCalled();
  });

  it('routes an SNS failure to onNotifyError and still resolves with the version', async () => {
    const failure = new Error('sns down');
    const onNotifyError = vi.fn<NotifyErrorHandler>();
    const { publisher, puts } = notifyingPublisher({ 'production/current.json': current(4) }, fakeSns(failure), {
      topicArn,
      onNotifyError,
    });

    await expect(publisher.publish('production', snapshot)).resolves.toBe(5);

    expect(onNotifyError).toHaveBeenCalledExactlyOnceWith(failure, { environment: 'production', version: 5 });
    expect(puts().map(({ key }) => key)).toEqual(['production/snapshots/5.json', 'production/current.json']);
  });

  it.each([
    ['an Error', new Error('sns down'), 'sns down'],
    ['a non-Error value', 'timeout' as unknown as Error, 'timeout'],
  ])('warns on the console for %s when no onNotifyError is given', async (_label, failure, detail) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { publisher } = notifyingPublisher({}, fakeSns(failure));

    await expect(publisher.publish('production', snapshot)).resolves.toBe(1);

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `featuresync: change notification for production v1 failed: ${detail}`,
    );
    warn.mockRestore();
  });

  it('warns on the console when onNotifyError itself throws, and still resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { publisher } = notifyingPublisher({}, fakeSns(new Error('sns down')), {
      topicArn,
      onNotifyError: () => {
        throw new Error('handler broke');
      },
    });

    await expect(publisher.publish('production', snapshot)).resolves.toBe(1);

    expect(warn).toHaveBeenCalledExactlyOnceWith('featuresync: change notification for production v1 failed: handler broke');
    warn.mockRestore();
  });
});
