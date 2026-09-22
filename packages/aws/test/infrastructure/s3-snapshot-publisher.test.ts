import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { describe, expect, it, vi } from 'vitest';
import {
  createS3SnapshotPublisher,
  DEFAULT_ROLLBACK_ACTOR,
  MAX_VERSION_PROBES,
  S3PublishError,
  type NotifyErrorHandler,
  type S3PublishErrorReason,
  type S3SnapshotPublisherOptions,
  type SnapshotValidation,
} from '../../src/infrastructure/s3-snapshot-publisher.js';
import { DEFAULT_ORPHAN_GRACE_MS } from '../../src/domain/publishing.js';
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
  readonly command: 'GetObject' | 'HeadObject' | 'PutObject';
  readonly key: string;
  readonly input: Record<string, unknown>;
}

const snapshot = { version: 1, features: {} };
const accept = (): SnapshotValidation => ({ ok: true });

/**
 * A GetObject/HeadObject/PutObject stand-in that records every command; `putErrors` fails a put to the given
 * key and `headErrors` fails a HeadObject on it. Any other command type is refused, so a ListObjectsV2 would fail.
 */
const fakeWritableS3 = (
  objects: Record<string, StoredObject>,
  putErrors: Record<string, Error> = {},
  headErrors: Record<string, Error> = {},
) => {
  const sent: SentCommand[] = [];
  const send = vi.fn((command: GetObjectCommand | HeadObjectCommand | PutObjectCommand) => {
    const key = command.input.Key ?? '';
    if (command instanceof HeadObjectCommand) {
      sent.push({ command: 'HeadObject', key, input: { ...command.input } });
      const error = headErrors[key];
      if (error !== undefined) return Promise.reject(error);
      const object = objects[key];
      if (object === undefined) return Promise.reject(s3Error('NotFound', 404));
      return Promise.resolve('lastModified' in object ? { LastModified: object.lastModified } : {});
    }
    if (command instanceof PutObjectCommand) {
      sent.push({ command: 'PutObject', key, input: { ...command.input } });
      const error = putErrors[key];
      return error === undefined ? Promise.resolve({ ETag: '"new"' }) : Promise.reject(error);
    }
    if (!(command instanceof GetObjectCommand)) return Promise.reject(new Error('unexpected S3 command'));
    sent.push({ command: 'GetObject', key, input: { ...command.input } });
    const object = objects[key] ?? { error: s3Error('NoSuchKey', 404) };
    if ('error' in object) return Promise.reject(object.error);
    const { body, etag, lastModified } = object;
    return Promise.resolve({
      ETag: etag,
      LastModified: lastModified,
      Body: body === undefined ? undefined : { transformToString: () => Promise.resolve(body) },
    });
  });
  const puts = () => sent.filter((entry) => entry.command === 'PutObject');
  return { client: { send } as unknown as Pick<S3Client, 'send'>, sent, puts };
};

const NOW = new Date('2026-09-19T12:00:00.000Z');
const EARLIER = new Date('2026-09-01T00:00:00.000Z');
const LATER = new Date('2026-09-02T00:00:00.000Z');
/** A pointer last moved at LATER, as an old-style rollback would leave it. */
const movedPointer = (version: number, etag?: string): StoredObject => ({ ...current(version, etag), lastModified: LATER });
const leftover = (body = '{}'): StoredObject => ({ body, lastModified: EARLIER });
/** Written 30s before NOW: well inside the default orphan grace period, so a publish may still own it. */
const RECENT = new Date(NOW.getTime() - 30_000);

const publisherOver = (
  objects: Record<string, StoredObject>,
  putErrors: Record<string, Error> = {},
  validate: (snapshot: unknown) => SnapshotValidation = accept,
  headErrors: Record<string, Error> = {},
  overrides: Partial<S3SnapshotPublisherOptions> = {},
) => {
  const fake = fakeWritableS3(objects, putErrors, headErrors);
  const publisher = createS3SnapshotPublisher({
    bucket: 'flags',
    client: fake.client,
    validate,
    now: () => NOW,
    ...overrides,
  });
  return { ...fake, publisher };
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
        'HeadObject production/snapshots/5.json',
        'PutObject production/snapshots/5.json',
        'PutObject production/current.json',
      ]);
      const [, , snapshotPut, pointerPut] = sent;
      expect(snapshotPut?.input).toMatchObject({ Bucket: 'flags', IfNoneMatch: '*', ContentType: 'application/json' });
      expect(snapshotPut?.input).not.toHaveProperty('IfMatch');
      expect(JSON.parse(String(snapshotPut?.input.Body))).toEqual({
        ...snapshot,
        version: 5,
        previousVersion: 4,
        createdAt: NOW.toISOString(),
      });
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

    it('rejects a stamped snapshot the injected validator refuses without writing anything', async () => {
      const refusal = new Error('features: required');
      const validate = vi.fn<(snapshot: unknown) => SnapshotValidation>(() => ({ ok: false, error: refusal }));
      const { publisher, puts } = publisherOver({}, {}, validate);

      const error = await expectReason(publisher.publish('production', {}), 'INVALID_SNAPSHOT', 'production/snapshots/1.json');

      expect(error.cause).toBe(refusal);
      expect(puts()).toEqual([]);
      expect(validate).toHaveBeenCalledWith({ version: 1, previousVersion: null, createdAt: NOW.toISOString() });
    });

    it.each([null, [], 'text', 3])('rejects a non-object body %j before touching S3', async (body) => {
      const { publisher, sent } = publisherOver({});

      await expectReason(publisher.publish('production', body), 'INVALID_SNAPSHOT', 'production/snapshots');
      expect(sent).toEqual([]);
    });

    describe('stamping version metadata', () => {
      const body = {
        schemaVersion: 1,
        environment: 'production',
        version: 1,
        createdAt: '2020-01-01T00:00:00.000Z',
        createdBy: 'ci',
        previousVersion: null,
        reason: 'copied from v1',
        features: { z: { type: 'boolean', enabled: true }, a: { type: 'config', enabled: false, default: { n: 1 } } },
      };

      it('stores a body that says version 1 as the third version, with the pointer as previousVersion', async () => {
        const { publisher, puts } = publisherOver({ 'production/current.json': current(2) });

        await expect(publisher.publish('production', body)).resolves.toBe(3);

        const stored = String(puts()[0]?.input.Body);
        expect(stored).toBe(
          JSON.stringify({ ...body, version: 3, previousVersion: 2, createdAt: NOW.toISOString() }),
        );
      });

      it('keeps every other field byte-equal, including key order inside features', async () => {
        const { publisher, puts } = publisherOver({ 'production/current.json': current(2) });

        await publisher.publish('production', body);

        const stored = JSON.parse(String(puts()[0]?.input.Body)) as Record<string, unknown>;
        expect(Object.keys(stored)).toEqual(Object.keys(body));
        expect(JSON.stringify(stored.features)).toBe(JSON.stringify(body.features));
        for (const field of ['schemaVersion', 'environment', 'createdBy', 'reason'] as const) {
          expect(stored[field]).toBe(body[field]);
        }
      });

      it('does not modify the caller\'s snapshot', async () => {
        const copy = structuredClone(body);
        const { publisher } = publisherOver({ 'production/current.json': current(2) });

        await publisher.publish('production', body);
        expect(body).toEqual(copy);
      });
    });

    describe('environment guard', () => {
      it('refuses a body naming another environment without sending anything to S3', async () => {
        const { publisher, sent } = publisherOver({ 'qa/current.json': current(2) });

        const error = await expectReason(
          publisher.publish('qa', { environment: 'development', features: {} }),
          'ENVIRONMENT_MISMATCH',
          'qa/snapshots',
        );

        expect((error.cause as Error).message).toBe('Snapshot names environment development, but is being published to qa');
        expect(sent).toEqual([]);
      });

      it('leaves a body without an environment to the validator', async () => {
        const { publisher, puts } = publisherOver({});

        await expect(publisher.publish('production', { features: {} })).resolves.toBe(1);
        expect(JSON.parse(String(puts()[0]?.input.Body))).not.toHaveProperty('environment');
      });
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

    describe('choosing the next version', () => {
      const legacyBucket = (): Record<string, StoredObject> => ({
        'production/current.json': movedPointer(1, '"etag-1"'),
        'production/snapshots/1.json': leftover(),
        'production/snapshots/2.json': leftover(),
        'production/snapshots/3.json': leftover(),
      });

      it('skips past snapshots an old-style rollback left above the pointer', async () => {
        const { publisher, sent } = publisherOver(legacyBucket());

        await expect(publisher.publish('production', snapshot)).resolves.toBe(4);

        expect(sent.map(({ command, key }) => `${command} ${key}`)).toEqual([
          'GetObject production/current.json',
          'HeadObject production/snapshots/2.json',
          'HeadObject production/snapshots/3.json',
          'HeadObject production/snapshots/4.json',
          'PutObject production/snapshots/4.json',
          'PutObject production/current.json',
        ]);
        expect(pointerBody(sent[5]?.input ?? {})).toEqual(pointer(4));
        expect(sent[5]?.input).toMatchObject({ IfMatch: '"etag-1"' });
      });

      it(`gives up with VERSION_PROBE_LIMIT after ${String(MAX_VERSION_PROBES)} occupied versions`, async () => {
        const occupied = Object.fromEntries(
          Array.from({ length: MAX_VERSION_PROBES }, (_, index) => [`production/snapshots/${String(index + 2)}.json`, leftover()]),
        );
        const { publisher, sent, puts } = publisherOver({ 'production/current.json': movedPointer(1), ...occupied });

        const error = await expectReason(
          publisher.publish('production', snapshot),
          'VERSION_PROBE_LIMIT',
          'production/snapshots/2.json',
        );

        expect((error.cause as Error).message).toBe(`No free version within ${String(MAX_VERSION_PROBES)} of v2`);
        expect(sent.filter(({ command }) => command === 'HeadObject')).toHaveLength(MAX_VERSION_PROBES);
        expect(puts()).toEqual([]);
      });

      it.each<[string, Record<string, StoredObject>, string]>([
        [
          'written moments ago',
          { 'production/snapshots/2.json': { lastModified: RECENT } },
          'Written 30s ago by a publish that may still be in flight; it is stepped over as an orphan once it is 300s old',
        ],
        [
          'without a LastModified',
          { 'production/snapshots/2.json': {} },
          'Exists with no LastModified, so a publish in flight cannot be ruled out',
        ],
      ])('does not skip a snapshot %s, since a concurrent publish may own it', async (_label, objects, message) => {
        const { publisher, puts } = publisherOver({ 'production/current.json': movedPointer(1), ...objects });

        const error = await expectReason(publisher.publish('production', snapshot), 'VERSION_EXISTS', 'production/snapshots/2.json');

        expect((error.cause as Error).message).toBe(message);
        expect(puts()).toEqual([]);
      });

      it('waits the whole grace period out before treating a snapshot as an orphan', async () => {
        const onTheEdge = new Date(NOW.getTime() - (DEFAULT_ORPHAN_GRACE_MS - 1));
        const { publisher, puts } = publisherOver({
          'production/current.json': movedPointer(1),
          'production/snapshots/2.json': { lastModified: onTheEdge },
        });

        await expectReason(publisher.publish('production', snapshot), 'VERSION_EXISTS', 'production/snapshots/2.json');
        expect(puts()).toEqual([]);
      });

      // The wedge this recovers from: a publish wrote its snapshot, then died before moving the pointer.
      it('steps over an orphan the grace period old, so a half-finished publish cannot wedge the environment', async () => {
        const orphaned = new Date(NOW.getTime() - DEFAULT_ORPHAN_GRACE_MS);
        const { publisher, sent } = publisherOver({
          'production/current.json': { ...current(1, '"etag-1"'), lastModified: EARLIER },
          'production/snapshots/2.json': { lastModified: orphaned },
        });

        await expect(publisher.publish('production', snapshot)).resolves.toBe(3);

        expect(sent.map(({ command, key }) => `${command} ${key}`)).toEqual([
          'GetObject production/current.json',
          'HeadObject production/snapshots/2.json',
          'HeadObject production/snapshots/3.json',
          'PutObject production/snapshots/3.json',
          'PutObject production/current.json',
        ]);
        // The orphan is stepped over, never rewritten, and the pointer swap stays conditional on the etag read.
        expect(sent[4]?.input).toMatchObject({ IfMatch: '"etag-1"' });
        expect(pointerBody(sent[4]?.input ?? {})).toEqual(pointer(3));
      });

      it('steps over a stale orphan when the pointer has no LastModified', async () => {
        const { publisher } = publisherOver({
          'production/current.json': current(1),
          'production/snapshots/2.json': leftover(),
        });

        await expect(publisher.publish('production', snapshot)).resolves.toBe(3);
      });

      it('recovers version 1 when the first publish ever died before writing the pointer', async () => {
        const { publisher, sent } = publisherOver({ 'production/snapshots/1.json': leftover() });

        await expect(publisher.publish('production', snapshot)).resolves.toBe(2);

        // With no pointer to match on, the recovering pointer write must still be create-only.
        expect(sent.at(-1)?.input).toMatchObject({ IfNoneMatch: '*' });
      });

      it('honours a custom orphan grace period', async () => {
        const { publisher } = publisherOver(
          {
            'production/current.json': movedPointer(1),
            'production/snapshots/2.json': { lastModified: RECENT },
          },
          {},
          accept,
          {},
          { orphanGraceMs: 10_000 },
        );

        await expect(publisher.publish('production', snapshot)).resolves.toBe(3);
      });

      it('fails without writing when a probe is refused for a reason other than not found', async () => {
        const denied = s3Error('AccessDenied', 403);
        const { publisher, puts } = publisherOver(
          { 'production/current.json': current(4) },
          {},
          accept,
          { 'production/snapshots/5.json': denied },
        );

        const error = await expectReason(publisher.publish('production', snapshot), 'REQUEST_FAILED', 'production/snapshots/5.json');

        expect(error.cause).toBe(denied);
        expect(puts()).toEqual([]);
      });
    });

    describe('with an expected current version', () => {
      it('publishes the next version when the pointer is at the expected version, reading it once', async () => {
        const { publisher, sent } = publisherOver({ 'production/current.json': current(5, '"etag-5"') });

        await expect(publisher.publish('production', snapshot, { expectedCurrentVersion: 5 })).resolves.toBe(6);

        expect(sent.map(({ command, key }) => `${command} ${key}`)).toEqual([
          'GetObject production/current.json',
          'HeadObject production/snapshots/6.json',
          'PutObject production/snapshots/6.json',
          'PutObject production/current.json',
        ]);
        expect(sent[3]?.input).toMatchObject({ IfMatch: '"etag-5"' });
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
    const v2 = {
      schemaVersion: 1,
      environment: 'production',
      version: 2,
      createdAt: '2026-09-01T00:00:00.000Z',
      createdBy: 'ci',
      previousVersion: 1,
      reason: 'second',
      features: { b: { type: 'boolean', enabled: false }, a: { type: 'boolean', enabled: true } },
    };
    const published = (): Record<string, StoredObject> => ({
      'production/current.json': current(4, '"etag-4"'),
      'production/snapshots/2.json': { body: JSON.stringify(v2), etag: '"s2"' },
      'production/snapshots/4.json': { body: '{}' },
    });

    it('republishes the target as the next version with rollback metadata, then swaps the pointer', async () => {
      const validate = vi.fn(accept);
      const { publisher, sent } = publisherOver(published(), {}, validate);

      await expect(publisher.rollback('production', 2, { actor: 'dimitry' })).resolves.toBe(5);

      expect(sent.map(({ command, key }) => `${command} ${key}`)).toEqual([
        'GetObject production/current.json',
        'GetObject production/snapshots/2.json',
        'HeadObject production/snapshots/5.json',
        'PutObject production/snapshots/5.json',
        'PutObject production/current.json',
      ]);
      const [, , , snapshotPut, pointerPut] = sent;
      const expected = {
        ...v2,
        version: 5,
        previousVersion: 4,
        createdAt: NOW.toISOString(),
        createdBy: 'dimitry',
        reason: 'Rollback to v2',
      };
      expect(snapshotPut?.input).toMatchObject({ IfNoneMatch: '*' });
      expect(snapshotPut?.input.Body).toBe(JSON.stringify(expected));
      expect(validate).toHaveBeenNthCalledWith(1, v2);
      expect(validate).toHaveBeenNthCalledWith(2, expected);
      expect(pointerPut?.input).toMatchObject({ IfMatch: '"etag-4"' });
      expect(pointerBody(pointerPut?.input ?? {})).toEqual(pointer(5));
    });

    it('records the default actor when none is given', async () => {
      const { publisher, puts } = publisherOver(published());

      await publisher.rollback('production', 2);

      expect(pointerBody(puts()[0]?.input ?? {})).toMatchObject({ createdBy: DEFAULT_ROLLBACK_ACTOR });
    });

    it('defaults to the system clock for createdAt', async () => {
      const fake = fakeWritableS3(published());
      const publisher = createS3SnapshotPublisher({ bucket: 'flags', client: fake.client, validate: accept });
      const before = Date.now();

      await publisher.rollback('production', 2);

      const { createdAt } = pointerBody(fake.puts()[0]?.input ?? {}) as { createdAt: string };
      expect(Date.parse(createdAt)).toBeGreaterThanOrEqual(before);
    });

    it('skips past newer snapshots an old-style rollback left behind', async () => {
      const { publisher, puts } = publisherOver({
        'production/current.json': movedPointer(1),
        'production/snapshots/1.json': leftover(JSON.stringify({ ...v2, version: 1, previousVersion: null })),
        'production/snapshots/2.json': leftover(JSON.stringify(v2)),
        'production/snapshots/3.json': leftover(),
      });

      await expect(publisher.rollback('production', 2)).resolves.toBe(4);

      expect(puts().map(({ key }) => key)).toEqual(['production/snapshots/4.json', 'production/current.json']);
      expect(pointerBody(puts()[0]?.input ?? {})).toMatchObject({ version: 4, previousVersion: 1, reason: 'Rollback to v2' });
    });

    it('accepts a target above the pointer that an old-style rollback left behind', async () => {
      const { publisher } = publisherOver({
        'production/current.json': movedPointer(1),
        'production/snapshots/2.json': leftover(JSON.stringify(v2)),
      });

      await expect(publisher.rollback('production', 2)).resolves.toBe(3);
    });

    it('refuses a target that fails validation without writing', async () => {
      const { publisher, puts } = publisherOver(published(), {}, () => ({ ok: false, error: new Error('bad') }));

      await expectReason(publisher.rollback('production', 2), 'INVALID_SNAPSHOT', 'production/snapshots/2.json');
      expect(puts()).toEqual([]);
    });

    it('refuses a rolled-back body that fails validation without writing', async () => {
      const validate = vi.fn<(snapshot: unknown) => SnapshotValidation>(accept);
      validate.mockReturnValueOnce({ ok: true }).mockReturnValueOnce({ ok: false, error: new Error('bad') });
      const { publisher, puts } = publisherOver(published(), {}, validate);

      await expectReason(publisher.rollback('production', 2), 'INVALID_SNAPSHOT', 'production/snapshots/5.json');
      expect(puts()).toEqual([]);
    });

    it.each([
      ['a body that is not JSON', 'nope'],
      ['a body that is not a JSON object', '[1]'],
      ['a null body', 'null'],
    ])('refuses a target with %s', async (_label, body) => {
      const { publisher, puts } = publisherOver({
        ...published(),
        'production/snapshots/2.json': { body, etag: '"s2"' },
      });

      await expectReason(publisher.rollback('production', 2), 'INVALID_SNAPSHOT', 'production/snapshots/2.json');
      expect(puts()).toEqual([]);
    });

    it.each([
      ['the current version', 4],
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

    it('maps a lost race on the new snapshot key to VERSION_EXISTS and leaves the pointer alone', async () => {
      const { publisher, puts } = publisherOver(published(), {
        'production/snapshots/5.json': s3Error('PreconditionFailed', 412),
      });

      await expectReason(publisher.rollback('production', 2), 'VERSION_EXISTS', 'production/snapshots/5.json');
      expect(puts().map(({ key }) => key)).toEqual(['production/snapshots/5.json']);
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

  it('sends one notification for the new version after a rollback', async () => {
    const sns = fakeSns();
    const { publisher } = notifyingPublisher(
      { 'production/current.json': current(5), 'production/snapshots/3.json': { body: JSON.stringify(snapshot) } },
      sns,
    );

    await expect(publisher.rollback('production', 3)).resolves.toBe(6);

    expect(sns.messages).toEqual([notification(6)]);
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
