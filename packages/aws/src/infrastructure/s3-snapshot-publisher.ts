import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { SNSClient } from '@aws-sdk/client-sns';
import { parseCurrentPointer, snapshotKeyFor, type CurrentPointer } from '../domain/current-pointer.js';
import {
  buildCurrentPointer,
  checkRollbackTarget,
  nextSnapshotVersion,
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
  | 'VERSION_EXISTS'
  | 'CONFLICT'
  | 'INVALID_ROLLBACK_TARGET'
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
}

/** Options for {@link S3SnapshotPublisher.publish}. */
export interface PublishOptions {
  /**
   * The version the caller built this snapshot on. When the Current Pointer is at any other version, or
   * absent, publish throws `CONFLICT` before writing anything.
   */
  readonly expectedCurrentVersion?: number;
}

export interface S3SnapshotPublisher {
  /** Writes the snapshot as the next version and makes it current. Resolves to the new version. */
  publish(environment: string, snapshot: unknown, options?: PublishOptions): Promise<number>;
  /** Points `current.json` back at an existing lower version. Resolves to that version. */
  rollback(environment: string, targetVersion: number): Promise<number>;
}

interface ReadPointer {
  readonly pointer: CurrentPointer;
  readonly etag: string;
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

/** Writes the `<environment>/snapshots/<n>.json` + `<environment>/current.json` layout with S3 conditional writes. */
export function createS3SnapshotPublisher(options: S3SnapshotPublisherOptions): S3SnapshotPublisher {
  const { bucket, validate } = options;
  const client = options.client ?? new S3Client({});
  const notifier =
    options.topicArn === undefined
      ? undefined
      : createSnsChangeNotifier({ topicArn: options.topicArn, client: options.snsClient });
  const onNotifyError = options.onNotifyError ?? warnNotifyFailure;

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
    return { pointer: pointer.value, etag: object.etag };
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

  const publish = async (environment: string, snapshot: unknown, publishOptions?: PublishOptions): Promise<number> => {
    const env = checkEnvironment(environment);
    checkSnapshot(`${env}/snapshots`, snapshot);
    const current = await readPointer(env);
    checkExpectedVersion(env, current, publishOptions?.expectedCurrentVersion);
    const version = nextSnapshotVersion(current?.pointer);
    await put(snapshotKeyFor(env, version), JSON.stringify(snapshot), { IfNoneMatch: '*' }, 'VERSION_EXISTS');
    await writePointer(env, version, current?.etag);
    await notify(env, version);
    return version;
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

  const rollback = async (environment: string, targetVersion: number): Promise<number> => {
    const env = checkEnvironment(environment);
    const current = await readPointer(env);
    const target = checkRollbackTarget(current?.pointer, targetVersion);
    if (!target.ok) throw new S3PublishError('INVALID_ROLLBACK_TARGET', `${env}/current.json`, target.error);
    const key = snapshotKeyFor(env, target.value);
    checkSnapshot(key, await readSnapshot(key));
    await writePointer(env, target.value, current?.etag);
    await notify(env, target.value);
    return target.value;
  };

  return { publish, rollback };
}
