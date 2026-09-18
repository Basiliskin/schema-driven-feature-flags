import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3PublishError, type S3PublishErrorReason } from '@featuresync/aws';
import { parseSnapshot, type SnapshotValidationError } from '@featuresync/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_CONFLICT,
  EXIT_INVALID_SNAPSHOT,
  EXIT_OK,
  EXIT_USAGE_OR_IO,
  main,
  nodeIo,
  type CliIo,
} from '../src/main.js';

const validSnapshot = () => ({
  schemaVersion: 1,
  environment: 'production',
  version: 2,
  previousVersion: 1,
  createdAt: '2026-09-18T06:00:00.000Z',
  createdBy: 'dimitry',
  reason: 'Enable dashboard',
  features: { x: { type: 'boolean', enabled: true, rules: [] } },
});

const invalidSnapshot = () => ({ ...validSnapshot(), features: { x: { type: 'nope', enabled: true, rules: [] } } });

const files: Record<string, string> = {
  'valid.json': JSON.stringify(validSnapshot()),
  'invalid.json': JSON.stringify(invalidSnapshot()),
  'broken.json': '{ not json',
};

const harness = (env: Record<string, string | undefined> = { FEATURESYNC_BUCKET: 'env-bucket' }) => {
  const out: string[] = [];
  const err: string[] = [];
  const publisher = { publish: vi.fn(() => Promise.resolve(7)), rollback: vi.fn(() => Promise.resolve(3)) };
  const createPublisher = vi.fn<CliIo['createPublisher']>(() => publisher);
  const io: CliIo = {
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readFile: (path) => {
      const text = files[path];
      return text === undefined ? Promise.reject(new Error(`ENOENT: no such file ${path}`)) : Promise.resolve(text);
    },
    createPublisher,
  };
  return { io, out, err, publisher, createPublisher };
};

const typeIssue = (): SnapshotValidationError => {
  const parsed = parseSnapshot(invalidSnapshot());
  if (parsed.ok) throw new Error('fixture should be invalid');
  return parsed.error;
};

describe('featuresync validate', () => {
  it('accepts a valid file without building a publisher', async () => {
    const h = harness();
    h.createPublisher.mockImplementation(() => {
      throw new Error('validate must not touch S3');
    });

    expect(await main(['validate', 'valid.json'], h.io)).toBe(EXIT_OK);
    expect(h.out).toEqual(['valid.json is a valid snapshot']);
    expect(h.createPublisher).not.toHaveBeenCalled();
  });

  it('prints each issue as path: message on stderr', async () => {
    const h = harness();
    const message = typeIssue().issues.find((issue) => issue.path === 'features.x.type')?.message;

    expect(await main(['validate', 'invalid.json'], h.io)).toBe(EXIT_INVALID_SNAPSHOT);
    expect(message).toBeDefined();
    expect(h.err).toContain(`features.x.type: ${String(message)}`);
  });

  it('reports a file that is not JSON as invalid', async () => {
    const h = harness();

    expect(await main(['validate', 'broken.json'], h.io)).toBe(EXIT_INVALID_SNAPSHOT);
    expect(h.err[0]).toMatch(/^broken\.json: not valid JSON/);
  });

  it('reports a missing file as an I/O failure', async () => {
    const h = harness();

    expect(await main(['validate', 'missing.json'], h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err).toEqual(['ENOENT: no such file missing.json']);
  });

  it('needs a file argument', async () => {
    const h = harness();

    expect(await main(['validate'], h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err[0]).toBe('Missing <file>');
    expect(h.err[1]).toMatch(/^Usage:/);
  });
});

describe('featuresync publish', () => {
  it('publishes the parsed file and prints the new version', async () => {
    const h = harness();

    expect(await main(['publish', '--env', 'production', 'valid.json'], h.io)).toBe(EXIT_OK);
    expect(h.publisher.publish).toHaveBeenCalledWith('production', validSnapshot());
    expect(h.out).toEqual(['Published production version 7']);
  });

  it('prefers --bucket over FEATURESYNC_BUCKET', async () => {
    const h = harness();

    await main(['publish', '--env', 'production', '--bucket', 'flag-bucket', 'valid.json'], h.io);
    expect(h.createPublisher.mock.calls[0]?.[0].bucket).toBe('flag-bucket');
  });

  it('falls back to FEATURESYNC_BUCKET and validates with core parseSnapshot', async () => {
    const h = harness();

    await main(['publish', '--env', 'production', 'valid.json'], h.io);
    const options = h.createPublisher.mock.calls[0]?.[0];
    expect(options?.bucket).toBe('env-bucket');
    expect(options?.validate(validSnapshot())).toEqual({ ok: true });
    expect(options?.validate(invalidSnapshot())).toEqual({ ok: false, error: typeIssue() });
  });

  it('needs a bucket', async () => {
    const h = harness({});

    expect(await main(['publish', '--env', 'production', 'valid.json'], h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err[0]).toBe('Missing --bucket or FEATURESYNC_BUCKET');
  });

  it('needs --env', async () => {
    const h = harness();

    expect(await main(['publish', 'valid.json'], h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err[0]).toBe('Missing --env');
    expect(h.publisher.publish).not.toHaveBeenCalled();
  });

  it('needs a file argument', async () => {
    const h = harness();

    expect(await main(['publish', '--env', 'production'], h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err[0]).toBe('Missing <file>');
  });

  it('does not publish a file that is not JSON', async () => {
    const h = harness();

    expect(await main(['publish', '--env', 'production', 'broken.json'], h.io)).toBe(EXIT_INVALID_SNAPSHOT);
    expect(h.publisher.publish).not.toHaveBeenCalled();
  });

  it('prints validation issues when the publisher rejects the snapshot', async () => {
    const h = harness();
    h.publisher.publish.mockRejectedValue(new S3PublishError('INVALID_SNAPSHOT', 'production/snapshots', typeIssue()));

    expect(await main(['publish', '--env', 'production', 'invalid.json'], h.io)).toBe(EXIT_INVALID_SNAPSHOT);
    expect(h.err).toContain(`features.x.type: ${String(typeIssue().issues.find((issue) => issue.path === 'features.x.type')?.message)}`);
  });

  it.each<[S3PublishErrorReason, number]>([
    ['CONFLICT', EXIT_CONFLICT],
    ['VERSION_EXISTS', EXIT_CONFLICT],
    ['INVALID_POINTER', EXIT_INVALID_SNAPSHOT],
    ['INVALID_ENVIRONMENT', EXIT_USAGE_OR_IO],
    ['REQUEST_FAILED', EXIT_USAGE_OR_IO],
  ])('maps %s to exit code %i', async (reason, code) => {
    const h = harness();
    h.publisher.publish.mockRejectedValue(new S3PublishError(reason, 'production/current.json', new Error('boom')));

    expect(await main(['publish', '--env', 'production', 'valid.json'], h.io)).toBe(code);
    expect(h.err).toEqual([`${reason} for s3 object production/current.json`]);
  });
});

describe('featuresync rollback', () => {
  it('rolls back to the requested version and prints it', async () => {
    const h = harness();

    expect(await main(['rollback', '--env', 'production', '--to', '3'], h.io)).toBe(EXIT_OK);
    expect(h.publisher.rollback).toHaveBeenCalledWith('production', 3);
    expect(h.out).toEqual(['Rolled production back to version 3']);
  });

  it('needs --to', async () => {
    const h = harness();

    expect(await main(['rollback', '--env', 'production'], h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err[0]).toBe('Missing --to');
  });

  it('maps an invalid rollback target to the usage code, not the conflict code', async () => {
    const h = harness();
    h.publisher.rollback.mockRejectedValue(
      new S3PublishError('INVALID_ROLLBACK_TARGET', 'production/current.json', new Error('not below current')),
    );

    expect(await main(['rollback', '--env', 'production', '--to', '9'], h.io)).toBe(EXIT_USAGE_OR_IO);
  });
});

describe('command line errors', () => {
  it('rejects an unknown command', async () => {
    const h = harness();

    expect(await main(['deploy'], h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err[0]).toBe('Unknown command deploy');
  });

  it('rejects a missing command', async () => {
    const h = harness();

    expect(await main([], h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err[0]).toBe('Missing command');
  });

  it('rejects an unknown option with usage', async () => {
    const h = harness();

    expect(await main(['validate', '--force', 'valid.json'], h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err[1]).toMatch(/^Usage:/);
  });

  it('turns an unexpected non-Error throw into the usage or I/O code', async () => {
    const h = harness();
    h.publisher.publish.mockRejectedValue('socket hang up');

    expect(await main(['publish', '--env', 'production', 'valid.json'], h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err).toEqual(['socket hang up']);
  });
});

describe('nodeIo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads files and writes lines to the process streams', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const dir = await mkdtemp(join(tmpdir(), 'featuresync-cli-'));
    const path = join(dir, 'snapshot.json');
    await writeFile(path, '{}');

    expect(await nodeIo.readFile(path)).toBe('{}');
    nodeIo.out('hello');
    nodeIo.err('oops');
    expect(stdout).toHaveBeenCalledWith('hello\n');
    expect(stderr).toHaveBeenCalledWith('oops\n');
    expect(nodeIo.createPublisher({ bucket: 'b', validate: () => ({ ok: true }) })).toHaveProperty('publish');
  });

  it('is the default io', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(await main(['deploy'])).toBe(EXIT_USAGE_OR_IO);
    expect(stderr).toHaveBeenCalledWith('Unknown command deploy\n');
  });
});
