import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  createS3SnapshotFetcher,
  createS3SnapshotPublisher,
  S3FetchError,
  S3PublishError,
  type FetchedSnapshot,
  type S3SnapshotPublisher,
  type S3SnapshotPublisherOptions,
  type SnapshotValidation,
} from '@featuresync/aws';
import { parseSnapshot, SnapshotValidationError } from '@featuresync/core';

export const EXIT_OK = 0;
export const EXIT_INVALID_SNAPSHOT = 1;
export const EXIT_CONFLICT = 2;
export const EXIT_USAGE_OR_IO = 3;

export type ExitCode = typeof EXIT_OK | typeof EXIT_INVALID_SNAPSHOT | typeof EXIT_CONFLICT | typeof EXIT_USAGE_OR_IO;

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  readonly createPublisher: (options: S3SnapshotPublisherOptions) => S3SnapshotPublisher;
  readonly createFetcher: (bucket: string) => SnapshotFetcher;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
}

export interface SnapshotFetcher {
  fetch(environment: string, version: number): Promise<FetchedSnapshot>;
}

export const nodeIo: CliIo = {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readFile: (path) => readFile(path, 'utf8'),
  createPublisher: createS3SnapshotPublisher,
  createFetcher: (bucket) => createS3SnapshotFetcher({ bucket }),
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
  rename,
  rm: (path) => rm(path, { force: true }),
};

const USAGE = [
  'Usage:',
  '  featuresync validate <file>',
  '  featuresync publish --env <env> [--bucket <bucket>] <file>',
  '  featuresync rollback --env <env> --to <version> [--bucket <bucket>]',
  '  featuresync pull --env <env> --version <version> --out <file> [--bucket <bucket>]',
  'rollback republishes an earlier version as a new version; history is never rewritten.',
  'publish and rollback accept [--topic-arn <arn>] to send a change notification.',
  'The bucket defaults to FEATURESYNC_BUCKET and the topic ARN to FEATURESYNC_TOPIC_ARN.',
].join('\n');

class UsageError extends Error {}

const validateSnapshot = (raw: unknown): SnapshotValidation => {
  const parsed = parseSnapshot(raw);
  return parsed.ok ? { ok: true } : { ok: false, error: parsed.error };
};

const requireValue = (value: string | undefined, name: string): string => {
  if (value === undefined || value === '') throw new UsageError(`Missing ${name}`);
  return value;
};

const printIssues = (io: CliIo, error: SnapshotValidationError): void => {
  for (const issue of error.issues) io.err(`${issue.path}: ${issue.message}`);
};

async function readJson(io: CliIo, path: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await io.readFile(path);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    io.err(`${path}: not valid JSON (${(error as Error).message})`);
    return { ok: false };
  }
}

async function runValidate(io: CliIo, positionals: readonly string[]): Promise<ExitCode> {
  const path = requireValue(positionals[0], '<file>');
  const json = await readJson(io, path);
  if (!json.ok) return EXIT_INVALID_SNAPSHOT;
  const parsed = parseSnapshot(json.value);
  if (!parsed.ok) {
    printIssues(io, parsed.error);
    return EXIT_INVALID_SNAPSHOT;
  }
  io.out(`${path} is a valid snapshot`);
  return EXIT_OK;
}

interface PublisherArgs {
  readonly env?: string | undefined;
  readonly bucket?: string | undefined;
  readonly 'topic-arn'?: string | undefined;
}

const bucketFor = (io: CliIo, values: PublisherArgs): string =>
  requireValue(values.bucket ?? io.env['FEATURESYNC_BUCKET'], '--bucket or FEATURESYNC_BUCKET');

const publisherFor = (io: CliIo, values: PublisherArgs): S3SnapshotPublisher => {
  const topicArn = values['topic-arn'] ?? io.env['FEATURESYNC_TOPIC_ARN'];
  return io.createPublisher({
    bucket: bucketFor(io, values),
    validate: validateSnapshot,
    ...(topicArn === undefined ? {} : { topicArn }),
    onNotifyError: (error, { environment, version }) => {
      io.err(
        `Warning: change notification for ${environment} version ${String(version)} failed (${error instanceof Error ? error.message : String(error)})`,
      );
    },
  });
};

async function runPublish(io: CliIo, values: PublisherArgs, positionals: readonly string[]): Promise<ExitCode> {
  const env = requireValue(values.env, '--env');
  const path = requireValue(positionals[0], '<file>');
  const publisher = publisherFor(io, values);
  const json = await readJson(io, path);
  if (!json.ok) return EXIT_INVALID_SNAPSHOT;
  const version = await publisher.publish(env, json.value);
  io.out(`Published ${env} version ${String(version)}`);
  return EXIT_OK;
}

async function runRollback(io: CliIo, values: PublisherArgs & { readonly to?: string | undefined }): Promise<ExitCode> {
  const env = requireValue(values.env, '--env');
  const target = Number(requireValue(values.to, '--to'));
  const version = await publisherFor(io, values).rollback(env, target);
  io.out(`Rolled ${env} back to v${String(target)} as version ${String(version)}`);
  return EXIT_OK;
}

interface PullArgs extends PublisherArgs {
  readonly version?: string | undefined;
  readonly out?: string | undefined;
}

async function writeAtomically(io: CliIo, path: string, text: string): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`;
  let renamed = false;
  try {
    await io.writeFile(temp, text);
    await io.rename(temp, path);
    renamed = true;
  } finally {
    if (!renamed) await io.rm(temp);
  }
}

async function runPull(io: CliIo, values: PullArgs): Promise<ExitCode> {
  const env = requireValue(values.env, '--env');
  const version = Number(requireValue(values.version, '--version'));
  const out = requireValue(values.out, '--out');
  const fetched = await io.createFetcher(bucketFor(io, values)).fetch(env, version);
  let raw: unknown;
  try {
    raw = JSON.parse(fetched.text);
  } catch (error) {
    io.err(`${fetched.key}: not valid JSON (${(error as Error).message})`);
    return EXIT_INVALID_SNAPSHOT;
  }
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) {
    printIssues(io, parsed.error);
    return EXIT_INVALID_SNAPSHOT;
  }
  await writeAtomically(io, out, fetched.text);
  io.out(`pulled ${fetched.environment} v${String(fetched.version)} -> ${out}`);
  return EXIT_OK;
}

const FETCH_ERROR_MESSAGES: Record<S3FetchError['reason'], string> = {
  INVALID_ENVIRONMENT: 'Invalid --env',
  INVALID_VERSION: '--version must be a positive integer',
  SNAPSHOT_NOT_FOUND: 'Snapshot version not found; was it published to this environment?',
  ACCESS_DENIED: 'Access denied; check the credentials and their s3:GetObject permission',
  EMPTY_SNAPSHOT: 'Snapshot object is empty',
  REQUEST_FAILED: 'S3 request failed',
};

function reportFetchError(io: CliIo, error: S3FetchError): ExitCode {
  io.err(`${FETCH_ERROR_MESSAGES[error.reason]} (${error.key})`);
  return EXIT_USAGE_OR_IO;
}

function reportPublishError(io: CliIo, error: S3PublishError): ExitCode {
  if (error.reason === 'ENVIRONMENT_MISMATCH') {
    io.err(`${(error.cause as Error).message}; pass the matching --env or fix the snapshot's environment`);
    return EXIT_INVALID_SNAPSHOT;
  }
  io.err(error.message);
  if (error.reason === 'INVALID_ROLLBACK_TARGET') {
    io.err('--to must name an existing version other than the current one');
  }
  switch (error.reason) {
    case 'INVALID_SNAPSHOT':
    case 'INVALID_POINTER':
      if (error.cause instanceof SnapshotValidationError) printIssues(io, error.cause);
      return EXIT_INVALID_SNAPSHOT;
    case 'CONFLICT':
    case 'VERSION_EXISTS':
      return EXIT_CONFLICT;
    case 'INVALID_ENVIRONMENT':
    case 'INVALID_ROLLBACK_TARGET':
    case 'VERSION_PROBE_LIMIT':
    case 'REQUEST_FAILED':
      return EXIT_USAGE_OR_IO;
  }
}

/** Runs one featuresync command and resolves to its process exit code; never exits the process itself. */
export async function main(argv: readonly string[], io: CliIo = nodeIo): Promise<ExitCode> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        env: { type: 'string' },
        bucket: { type: 'string' },
        to: { type: 'string' },
        version: { type: 'string' },
        out: { type: 'string' },
        'topic-arn': { type: 'string' },
      },
    });
    const [command, ...rest] = positionals;
    switch (command) {
      case 'validate':
        return await runValidate(io, rest);
      case 'publish':
        return await runPublish(io, values, rest);
      case 'rollback':
        return await runRollback(io, values);
      case 'pull':
        return await runPull(io, values);
      default:
        throw new UsageError(command === undefined ? 'Missing command' : `Unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof S3PublishError) return reportPublishError(io, error);
    if (error instanceof S3FetchError) return reportFetchError(io, error);
    io.err(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || (error as { code?: unknown }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      io.err(USAGE);
    }
    return EXIT_USAGE_OR_IO;
  }
}
