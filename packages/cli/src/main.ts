import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  createS3SnapshotPublisher,
  S3PublishError,
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
}

export const nodeIo: CliIo = {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readFile: (path) => readFile(path, 'utf8'),
  createPublisher: createS3SnapshotPublisher,
};

const USAGE = [
  'Usage:',
  '  featuresync validate <file>',
  '  featuresync publish --env <env> [--bucket <bucket>] <file>',
  '  featuresync rollback --env <env> --to <version> [--bucket <bucket>]',
  'The bucket defaults to FEATURESYNC_BUCKET.',
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
}

const publisherFor = (io: CliIo, values: PublisherArgs): S3SnapshotPublisher =>
  io.createPublisher({
    bucket: requireValue(values.bucket ?? io.env['FEATURESYNC_BUCKET'], '--bucket or FEATURESYNC_BUCKET'),
    validate: validateSnapshot,
  });

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
  io.out(`Rolled ${env} back to version ${String(version)}`);
  return EXIT_OK;
}

function reportPublishError(io: CliIo, error: S3PublishError): ExitCode {
  io.err(error.message);
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
      options: { env: { type: 'string' }, bucket: { type: 'string' }, to: { type: 'string' } },
    });
    const [command, ...rest] = positionals;
    switch (command) {
      case 'validate':
        return await runValidate(io, rest);
      case 'publish':
        return await runPublish(io, values, rest);
      case 'rollback':
        return await runRollback(io, values);
      default:
        throw new UsageError(command === undefined ? 'Missing command' : `Unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof S3PublishError) return reportPublishError(io, error);
    io.err(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || (error as { code?: unknown }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      io.err(USAGE);
    }
    return EXIT_USAGE_OR_IO;
  }
}
