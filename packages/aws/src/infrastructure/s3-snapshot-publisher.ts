import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { SNSClient } from '@aws-sdk/client-sns';
import { parseCurrentPointer, snapshotKeyFor, type CurrentPointer } from '../domain/current-pointer.js';
import {
  buildCurrentPointer,
  buildRollbackSnapshot,
  checkRollbackTarget,
  nextSnapshotVersion,
  stampSnapshot,
  validateEnvironmentName,
} from '../domain/publishing.js';
import { errorShape } from './s3-errors.js';
import { isNotFound, readObjectText } from './s3-read.js';
import { createSnsChangeNotifier } from './sns-change-notifier.js';

/** Why a publish or rollback wrote nothing, or stopped before moving the pointer. */
export type S3PublishErrorReason =
  | 'INVALID_ENVIRONMENT'
  | 'INVALID_POINTER'
  | 'INVALID_SNAPSHOT'
  | 'ENVIRONMENT_MISMATCH'
  | 'VERSION_EXISTS'
  | 'CONFLICT'
  | 'INVALID_ROLLBACK_TARGET'
  | 'VERSION_PROBE_LIMIT'
  | 'REQUEST_FAILED';

/** A publish or rollback failed. `cause` holds the underlying S3 or validation error. */
export class S3PublishError extends Error {
  override readonly name = 'S3PublishError';

  constructor(
    readonly reason: S3PublishErrorReason,
    readonly key: string,
    cause: unknown,
  ) {
    super(`${reason} for s3 object ${key}`, { cause });
  }
}

/** The live version whose Change Notification could not be sent. */
export interface NotifyFailure {
  readonly environment: string;
  readonly version: number;
}

export type NotifyErrorHandler = (error: unknown, failure: NotifyFailure) => void;

export type SnapshotValidation = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/** Options for {@link createS3SnapshotPublisher}. */
export interface S3SnapshotPublisherOptions {
  readonly bucket: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly client?: Pick<S3Client, 'send'>;
  /** Decides whether a raw snapshot may be published or restored, e.g. the core package's `parseSnapshot`. */
  readonly validate: (snapshot: unknown) => SnapshotValidation;
  /** SNS topic that receives a Change Notification after every successful pointer write. Omit to send nothing. */
  readonly topicArn?: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly snsClient?: Pick<SNSClient, 'send'>;
  /** Receives a failed notification. The publish still succeeds; defaults to a one-line `console.warn`. */
  readonly onNotifyError?: NotifyErrorHandler;
  /** Clock for the `createdAt` every published version is stamped with. Defaults to the system clock. */
  readonly now?: () => Date;
}

/** Options for {@link S3SnapshotPublisher.publish}. */
export interface PublishOptions {
  /**
   * The version the caller built this snapshot on. When the Current Pointer is at any other version, or
   * absent, publish throws `CONFLICT` before writing anything.
   */
  readonly expectedCurrentVersion?: number;
}

/** Options for {@link S3SnapshotPublisher.rollback}. */
export interface RollbackOptions {
  /** Recorded as `createdBy` on the new version. Defaults to {@link DEFAULT_ROLLBACK_ACTOR}. */
  readonly actor?: string;
}

export const DEFAULT_ROLLBACK_ACTOR = 'featuresync';

/**
 * How far past the pointer the publisher looks for a free version number. Old-style rollbacks left newer
 * snapshots above the pointer; the next write skips past them.
 */
export const MAX_VERSION_PROBES = 1000;

export interface S3SnapshotPublisher {
  /**
   * Writes the snapshot as the next version and makes it current. Resolves to the new version. The stored body's
   * `version`, `previousVersion` and `createdAt` are always set by the publisher; its `environment` must match.
   */
  publish(environment: string, snapshot: unknown, options?: PublishOptions): Promise<number>;
  /** Republishes an existing version's snapshot as the next version and makes it current. Resolves to the new version. */
  rollback(environment: string, targetVersion: number, options?: RollbackOptions): Promise<number>;
}

interface ReadPointer {
  readonly pointer: CurrentPointer;
  readonly etag: string;
  readonly lastModified: Date | undefined;
}

// S3 answers a lost conditional-write race with 412, or 409 while a competing write is in flight.
const isPreconditionFailed = (error: unknown): boolean => {
  const { name, status } = errorShape(error);
  return name === 'PreconditionFailed' || name === 'ConditionalRequestConflict' || status === 412 || status === 409;
};

const warnNotifyFailure: NotifyErrorHandler = (error, { environment, version }) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`featuresync: change notification for ${environment} v${String(version)} failed: ${detail}`);
};

const parseJson = (text: string | undefined): unknown => JSON.parse(text ?? '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Writes the `<environment>/snapshots/<n>.json` + `<environment>/current.json` layout with S3 conditional writes. */
export function createS3SnapshotPublisher(options: S3SnapshotPublisherOptions): S3SnapshotPublisher {
  const { bucket, validate } = options;
  const client = options.client ?? new S3Client({});
  const notifier =
    options.topicArn === undefined
      ? undefined
      : createSnsChangeNotifier({ topicArn: options.topicArn, client: options.snsClient });
  const onNotifyError = options.onNotifyError ?? warnNotifyFailure;
  const now = options.now ?? (() => new Date());

  const notify = async (environment: string, version: number): Promise<void> => {
    if (notifier === undefined) return;
    try {
      await notifier(environment, version);
    } catch (error) {
      try {
        onNotifyError(error, { environment, version });
      } catch (handlerError) {
        warnNotifyFailure(handlerError, { environment, version });
      }
    }
  };

  const checkEnvironment = (environment: string): string => {
    const checked = validateEnvironmentName(environment);
    if (!checked.ok) throw new S3PublishError('INVALID_ENVIRONMENT', environment, checked.error);
    return checked.value;
  };

  const checkSnapshot = (key: string, snapshot: unknown): void => {
    const verdict = validate(snapshot);
    if (!verdict.ok) throw new S3PublishError('INVALID_SNAPSHOT', key, verdict.error);
  };

  const getObject = (key: string) => readObjectText(client, bucket, key);

  const readPointer = async (environment: string): Promise<ReadPointer | undefined> => {
    const key = `${environment}/current.json`;
    let object: Awaited<ReturnType<typeof getObject>>;
    try {
      object = await getObject(key);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new S3PublishError('REQUEST_FAILED', key, error);
    }
    if (object.etag === undefined) {
      throw new S3PublishError('REQUEST_FAILED', key, new Error('Pointer response carries no ETag'));
    }
    let raw: unknown;
    try {
      raw = parseJson(object.text);
    } catch (error) {
      throw new S3PublishError('INVALID_POINTER', key, error);
    }
    const pointer = parseCurrentPointer(raw);
    if (!pointer.ok) throw new S3PublishError('INVALID_POINTER', key, pointer.error);
    if (pointer.value.environment !== environment) {
      throw new S3PublishError(
        'INVALID_POINTER',
        key,
        new Error(`Pointer names environment ${pointer.value.environment}, expected ${environment}`),
      );
    }
    return { pointer: pointer.value, etag: object.etag, lastModified: object.lastModified };
  };

  const put = async (
    key: string,
    body: string,
    condition: { IfMatch: string } | { IfNoneMatch: '*' },
    onPreconditionFailed: 'VERSION_EXISTS' | 'CONFLICT',
  ): Promise<void> => {
    try {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json', ...condition }),
      );
    } catch (error) {
      throw new S3PublishError(isPreconditionFailed(error) ? onPreconditionFailed : 'REQUEST_FAILED', key, error);
    }
  };

  const writePointer = (environment: string, version: number, etag: string | undefined): Promise<void> =>
    put(
      `${environment}/current.json`,
      JSON.stringify(buildCurrentPointer(environment, version)),
      etag === undefined ? { IfNoneMatch: '*' } : { IfMatch: etag },
      'CONFLICT',
    );

  const checkExpectedVersion = (env: string, current: ReadPointer | undefined, expected: number | undefined): void => {
    if (expected === undefined || expected === current?.pointer.version) return;
    const found = current === undefined ? 'none' : String(current.pointer.version);
    throw new S3PublishError(
      'CONFLICT',
      `${env}/current.json`,
      new Error(`Expected current version ${String(expected)}, found ${found}`),
    );
  };

  /** Resolves to the snapshot's LastModified, `null` when it has none, or `undefined` when there is no such key. */
  const headSnapshot = async (key: string): Promise<Date | null | undefined> => {
    try {
      const { LastModified } = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return LastModified ?? null;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new S3PublishError('REQUEST_FAILED', key, error);
    }
  };

  // A snapshot written before the pointer was last moved is a leftover from an old-style rollback. One written
  // at the same time or later belongs to a publish still in flight, so it must not be skipped.
  const isLeftover = (snapshotModified: Date | null, current: ReadPointer | undefined): boolean =>
    snapshotModified !== null &&
    current?.lastModified !== undefined &&
    snapshotModified.getTime() < current.lastModified.getTime();

  // Probes forward with HeadObject rather than listing, so the publisher needs no bucket-wide ListBucket.
  const resolveNextVersion = async (env: string, current: ReadPointer | undefined): Promise<number> => {
    const first = nextSnapshotVersion(current?.pointer);
    for (let version = first; version < first + MAX_VERSION_PROBES; version += 1) {
      const key = snapshotKeyFor(env, version);
      const modified = await headSnapshot(key);
      if (modified === undefined) return version;
      if (!isLeftover(modified, current)) {
        throw new S3PublishError('VERSION_EXISTS', key, new Error('Written after the current pointer by another publish'));
      }
    }
    throw new S3PublishError(
      'VERSION_PROBE_LIMIT',
      snapshotKeyFor(env, first),
      new Error(`No free version within ${String(MAX_VERSION_PROBES)} of v${String(first)}`),
    );
  };

  const writeNextVersion = async (
    env: string,
    current: ReadPointer | undefined,
    body: Readonly<Record<string, unknown>>,
  ): Promise<number> => {
    const version = await resolveNextVersion(env, current);
    const key = snapshotKeyFor(env, version);
    const snapshot = stampSnapshot(body, { version, previousVersion: current?.pointer.version ?? null, now: now() });
    checkSnapshot(key, snapshot);
    await put(key, JSON.stringify(snapshot), { IfNoneMatch: '*' }, 'VERSION_EXISTS');
    await writePointer(env, version, current?.etag);
    await notify(env, version);
    return version;
  };

  const checkBody = (env: string, snapshot: unknown): Readonly<Record<string, unknown>> => {
    const key = `${env}/snapshots`;
    if (!isRecord(snapshot)) throw new S3PublishError('INVALID_SNAPSHOT', key, new Error('Snapshot is not a JSON object'));
    const named = snapshot.environment;
    if (typeof named === 'string' && named !== env) {
      throw new S3PublishError(
        'ENVIRONMENT_MISMATCH',
        key,
        new Error(`Snapshot names environment ${named}, but is being published to ${env}`),
      );
    }
    return snapshot;
  };

  const publish = async (environment: string, snapshot: unknown, publishOptions?: PublishOptions): Promise<number> => {
    const env = checkEnvironment(environment);
    const body = checkBody(env, snapshot);
    const current = await readPointer(env);
    checkExpectedVersion(env, current, publishOptions?.expectedCurrentVersion);
    return writeNextVersion(env, current, body);
  };

  const readSnapshot = async (key: string): Promise<unknown> => {
    let text: string | undefined;
    try {
      ({ text } = await getObject(key));
    } catch (error) {
      throw new S3PublishError(isNotFound(error) ? 'INVALID_ROLLBACK_TARGET' : 'REQUEST_FAILED', key, error);
    }
    try {
      return parseJson(text);
    } catch (error) {
      throw new S3PublishError('INVALID_SNAPSHOT', key, error);
    }
  };

  const rollback = async (
    environment: string,
    targetVersion: number,
    rollbackOptions?: RollbackOptions,
  ): Promise<number> => {
    const env = checkEnvironment(environment);
    const current = await readPointer(env);
    const target = checkRollbackTarget(current?.pointer, targetVersion);
    if (!target.ok) throw new S3PublishError('INVALID_ROLLBACK_TARGET', `${env}/current.json`, target.error);
    const { targetVersion: restored } = target.value;
    const key = snapshotKeyFor(env, restored);
    const source = await readSnapshot(key);
    checkSnapshot(key, source);
    if (!isRecord(source)) throw new S3PublishError('INVALID_SNAPSHOT', key, new Error('Snapshot is not a JSON object'));
    const createdBy = rollbackOptions?.actor ?? DEFAULT_ROLLBACK_ACTOR;
    return writeNextVersion(env, current, buildRollbackSnapshot(source, { targetVersion: restored, createdBy }));
  };

  return { publish, rollback };
}
