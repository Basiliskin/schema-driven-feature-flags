import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  S3FetchError,
  S3PublishError,
  S3SegmentPublishError,
  type S3FetchErrorReason,
  type S3PublishErrorReason,
  type S3SegmentPublishErrorReason,
  type SegmentDraft,
  type SegmentPointer,
} from '@featuresync/aws';
import { createFeatureFlagsFromEnv, parseSnapshot, type SnapshotValidationError } from '@featuresync/core';
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
  'members.csv': 'userId\r\nsecret-user@example.com\n alice \n\nalice\n',
  'emails.csv': 'email\nsecret-user@example.com\n',
  'empty.csv': 'userId\n\n',
  'malformed.csv': 'userId\nsecret-user@example.com,bob\n',
  'repeated-header.csv': 'userId\nsecret-user@example.com\nuserId\n',
  'too-many.csv': Array.from({ length: 100_001 }, (_, index) => `user-${String(index)}`).join('\n'),
  'too-long.csv': `secret-user@example.com\n${'x'.repeat(257)}\n`,
};

const SECRET_MEMBER = 'secret-user@example.com';

const PULLED_TEXT = `${JSON.stringify(validSnapshot(), null, 2)}\n`;

const harness = (env: Record<string, string | undefined> = { FEATURESYNC_BUCKET: 'env-bucket' }) => {
  const out: string[] = [];
  const err: string[] = [];
  const publisher = { publish: vi.fn(() => Promise.resolve(7)), rollback: vi.fn(() => Promise.resolve(3)) };
  const createPublisher = vi.fn<CliIo['createPublisher']>(() => publisher);
  const fetcher = {
    fetch: vi.fn((environment: string, version: number) =>
      Promise.resolve({ environment, version, key: `stored/${String(version)}`, text: PULLED_TEXT }),
    ),
  };
  const createFetcher = vi.fn<CliIo['createFetcher']>(() => fetcher);
  const segmentPublisher = {
    publish: vi.fn((environment: string, segment: SegmentDraft) =>
      Promise.resolve<SegmentPointer>({
        schemaVersion: 1,
        environment,
        segmentKey: segment.key,
        version: 4,
        objectKey: `${environment}/segments/${segment.key}/4.json`,
      }),
    ),
  };
  const createSegmentPublisher = vi.fn<CliIo['createSegmentPublisher']>(() => segmentPublisher);
  const writeFileHook = vi.fn<CliIo['writeFile']>(() => Promise.resolve());
  const renameHook = vi.fn<CliIo['rename']>(() => Promise.resolve());
  const rmHook = vi.fn<CliIo['rm']>(() => Promise.resolve());
  const io: CliIo = {
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readFile: (path) => {
      const text = files[path];
      return text === undefined ? Promise.reject(new Error(`ENOENT: no such file ${path}`)) : Promise.resolve(text);
    },
    createPublisher,
    createSegmentPublisher,
    createFetcher,
    writeFile: writeFileHook,
    rename: renameHook,
    rm: rmHook,
  };
  return {
    io,
    out,
    err,
    publisher,
    createPublisher,
    segmentPublisher,
    createSegmentPublisher,
    fetcher,
    createFetcher,
    writeFile: writeFileHook,
    rename: renameHook,
    rm: rmHook,
  };
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

  it('explains an environment mismatch naming both environments and exits 1', async () => {
    const h = harness();
    h.publisher.publish.mockRejectedValue(
      new S3PublishError(
        'ENVIRONMENT_MISMATCH',
        'qa/snapshots',
        new Error('Snapshot names environment development, but is being published to qa'),
      ),
    );

    expect(await main(['publish', '--env', 'qa', 'valid.json'], h.io)).toBe(EXIT_INVALID_SNAPSHOT);
    expect(EXIT_INVALID_SNAPSHOT).toBe(1);
    expect(h.err).toEqual([
      "Snapshot names environment development, but is being published to qa; pass the matching --env or fix the snapshot's environment",
    ]);
  });

  it.each<[S3PublishErrorReason, number]>([
    ['CONFLICT', EXIT_CONFLICT],
    ['VERSION_EXISTS', EXIT_CONFLICT],
    ['INVALID_POINTER', EXIT_INVALID_SNAPSHOT],
    ['INVALID_ENVIRONMENT', EXIT_USAGE_OR_IO],
    ['VERSION_PROBE_LIMIT', EXIT_USAGE_OR_IO],
    ['REQUEST_FAILED', EXIT_USAGE_OR_IO],
  ])('maps %s to exit code %i', async (reason, code) => {
    const h = harness();
    h.publisher.publish.mockRejectedValue(new S3PublishError(reason, 'production/current.json', new Error('boom')));

    expect(await main(['publish', '--env', 'production', 'valid.json'], h.io)).toBe(code);
    expect(h.err).toEqual([`${reason} for s3 object production/current.json`]);
  });
});

describe('featuresync rollback', () => {
  it('republishes the requested version as a new version and prints both', async () => {
    const h = harness();
    h.publisher.rollback.mockResolvedValue(8);

    expect(await main(['rollback', '--env', 'production', '--to', '3'], h.io)).toBe(EXIT_OK);
    expect(h.publisher.rollback).toHaveBeenCalledWith('production', 3);
    expect(h.out).toEqual(['Rolled production back to v3 as version 8']);
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
    expect(h.err).toEqual([
      'INVALID_ROLLBACK_TARGET for s3 object production/current.json',
      '--to must name an existing version other than the current one',
    ]);
  });
});

describe('change notification topic', () => {
  const PUBLISH = ['publish', '--env', 'production', 'valid.json'];
  const ROLLBACK = ['rollback', '--env', 'production', '--to', '3'];
  const ENV = { FEATURESYNC_BUCKET: 'env-bucket', FEATURESYNC_TOPIC_ARN: 'arn:env' };

  it.each([
    ['publish', PUBLISH],
    ['rollback', ROLLBACK],
  ])('%s passes --topic-arn to the publisher', async (_command, argv) => {
    const h = harness();

    await main([...argv, '--topic-arn', 'arn:flag'], h.io);
    expect(h.createPublisher.mock.calls[0]?.[0].topicArn).toBe('arn:flag');
  });

  it.each([
    ['publish', PUBLISH],
    ['rollback', ROLLBACK],
  ])('%s falls back to FEATURESYNC_TOPIC_ARN', async (_command, argv) => {
    const h = harness(ENV);

    await main(argv, h.io);
    expect(h.createPublisher.mock.calls[0]?.[0].topicArn).toBe('arn:env');
  });

  it('prefers --topic-arn over FEATURESYNC_TOPIC_ARN', async () => {
    const h = harness(ENV);

    await main([...PUBLISH, '--topic-arn', 'arn:flag'], h.io);
    expect(h.createPublisher.mock.calls[0]?.[0].topicArn).toBe('arn:flag');
  });

  it('sends no topic when neither the flag nor the variable is set', async () => {
    const h = harness();

    await main(PUBLISH, h.io);
    expect(h.createPublisher.mock.calls[0]?.[0]).not.toHaveProperty('topicArn');
  });

  it.each([
    ['an Error', new Error('sns down'), 'sns down'],
    ['a non-Error value', 'throttled', 'throttled'],
  ])('reports a failed notification with %s as one warning and still exits 0', async (_kind, error, message) => {
    const h = harness(ENV);
    h.publisher.publish.mockImplementation(() => {
      h.createPublisher.mock.calls[0]?.[0].onNotifyError?.(error, { environment: 'production', version: 7 });
      return Promise.resolve(7);
    });

    expect(await main(PUBLISH, h.io)).toBe(EXIT_OK);
    expect(h.err).toEqual([`Warning: change notification for production version 7 failed (${message})`]);
    expect(h.out).toEqual(['Published production version 7']);
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

describe('featuresync segment upload', () => {
  const upload = (...extra: string[]) => [
    'segment',
    'upload',
    '--env',
    'production',
    '--key',
    'beta-testers',
    '--file',
    'members.csv',
    ...extra,
  ];

  const expectNoMember = (h: ReturnType<typeof harness>) => {
    expect([...h.out, ...h.err].join('\n')).not.toContain(SECRET_MEMBER);
  };

  it('uploads the parsed members and prints the key and new version without members', async () => {
    const h = harness();

    expect(await main(upload(), h.io)).toBe(EXIT_OK);
    expect(h.createSegmentPublisher).toHaveBeenCalledWith({ bucket: 'env-bucket' });
    expect(h.segmentPublisher.publish).toHaveBeenCalledWith('production', {
      key: 'beta-testers',
      memberAttribute: 'userId',
      members: [SECRET_MEMBER, 'alice'],
    });
    expect(h.out).toEqual(['Uploaded segment beta-testers to production as version 4']);
    expect(h.err).toEqual([]);
    expectNoMember(h);
  });

  it('prefers --bucket over FEATURESYNC_BUCKET', async () => {
    const h = harness();

    await main(upload('--bucket', 'flag-bucket'), h.io);
    expect(h.createSegmentPublisher).toHaveBeenCalledWith({ bucket: 'flag-bucket' });
  });

  it('uses --attribute as the member attribute and header', async () => {
    const h = harness();
    const args = upload('--attribute', 'email');
    args[args.indexOf('members.csv')] = 'emails.csv';

    expect(await main(args, h.io)).toBe(EXIT_OK);
    expect(h.segmentPublisher.publish).toHaveBeenCalledWith('production', {
      key: 'beta-testers',
      memberAttribute: 'email',
      members: [SECRET_MEMBER],
    });
  });

  it('sends no change notification', async () => {
    const h = harness({ FEATURESYNC_BUCKET: 'env-bucket', FEATURESYNC_TOPIC_ARN: 'arn:aws:sns:x' });

    expect(await main(upload('--topic-arn', 'arn:aws:sns:y'), h.io)).toBe(EXIT_OK);
    expect(h.createPublisher).not.toHaveBeenCalled();
    expect(Object.keys(h.createSegmentPublisher.mock.calls[0]?.[0] ?? {})).toEqual(['bucket']);
  });

  it.each([
    ['EMPTY_FILE', 'empty.csv'],
    ['MALFORMED_ROW', 'malformed.csv'],
    ['HEADER', 'repeated-header.csv'],
    ['TOO_MANY_MEMBERS', 'too-many.csv'],
    ['INVALID_SEGMENT', 'too-long.csv'],
  ])('rejects a %s file with exit 1 before publishing and without printing members', async (_reason, file) => {
    const h = harness();
    const args = upload();
    args[args.indexOf('members.csv')] = file;

    expect(await main(args, h.io)).toBe(EXIT_INVALID_SNAPSHOT);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toMatch(new RegExp(`^${file.replace('.', '\\.')}: `));
    expect(h.segmentPublisher.publish).not.toHaveBeenCalled();
    expectNoMember(h);
  });

  it('rejects an invalid segment key with exit 1', async () => {
    const h = harness();
    const args = upload();
    args[args.indexOf('beta-testers')] = '../x';

    expect(await main(args, h.io)).toBe(EXIT_INVALID_SNAPSHOT);
    expect(h.segmentPublisher.publish).not.toHaveBeenCalled();
  });

  it.each<[S3SegmentPublishErrorReason, number]>([
    ['INVALID_SEGMENT_KEY', EXIT_INVALID_SNAPSHOT],
    ['INVALID_SEGMENT', EXIT_INVALID_SNAPSHOT],
    ['INVALID_POINTER', EXIT_INVALID_SNAPSHOT],
    ['CONFLICT', EXIT_CONFLICT],
    ['VERSION_EXISTS', EXIT_CONFLICT],
    ['INVALID_ENVIRONMENT', EXIT_USAGE_OR_IO],
    ['REQUEST_FAILED', EXIT_USAGE_OR_IO],
  ])('maps a publisher %s to exit code %i without printing members', async (reason, code) => {
    const h = harness();
    const key = 'production/segments/beta-testers/current.json';
    h.segmentPublisher.publish.mockRejectedValue(new S3SegmentPublishError(reason, key, new Error(SECRET_MEMBER)));

    expect(await main(upload(), h.io)).toBe(code);
    expect(h.err).toEqual([`${reason} for s3 object ${key}`]);
    expectNoMember(h);
  });

  it.each([
    ['--env', upload().filter((_, index, all) => all[index - 1] !== '--env' && all[index] !== '--env')],
    ['--key', upload().filter((_, index, all) => all[index - 1] !== '--key' && all[index] !== '--key')],
    ['--file', upload().filter((_, index, all) => all[index - 1] !== '--file' && all[index] !== '--file')],
  ])('needs %s', async (option, args) => {
    const h = harness();

    expect(await main(args, h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err[0]).toBe(`Missing ${option}`);
    expect(h.err[1]).toMatch(/^Usage:/);
    expect(h.segmentPublisher.publish).not.toHaveBeenCalled();
  });

  it('needs a bucket', async () => {
    const h = harness({});

    expect(await main(upload(), h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err[0]).toBe('Missing --bucket or FEATURESYNC_BUCKET');
  });

  it('reports an unreadable file as an I/O failure', async () => {
    const h = harness();
    const args = upload();
    args[args.indexOf('members.csv')] = 'missing.csv';

    expect(await main(args, h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err).toEqual(['ENOENT: no such file missing.csv']);
    expect(h.segmentPublisher.publish).not.toHaveBeenCalled();
  });

  it.each([
    [['segment'], 'Missing segment subcommand'],
    [['segment', 'delete'], 'Unknown segment subcommand delete'],
  ])('rejects %j with usage', async (args, message) => {
    const h = harness();

    expect(await main(args, h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err[0]).toBe(message);
    expect(h.err[1]).toMatch(/^Usage:/);
    expect(h.createSegmentPublisher).not.toHaveBeenCalled();
  });
});

describe('featuresync pull', () => {
  const pull = ['pull', '--env', 'production', '--version', '2', '--out', 'flags.json'];

  it('writes the fetched bytes through a temp file and prints the pulled version', async () => {
    const h = harness();

    expect(await main([...pull, '--bucket', 'flag-bucket'], h.io)).toBe(EXIT_OK);
    expect(h.createFetcher).toHaveBeenCalledWith('flag-bucket');
    expect(h.fetcher.fetch).toHaveBeenCalledWith('production', 2);
    const [temp, text] = h.writeFile.mock.calls[0] ?? [];
    expect(temp).toMatch(/^flags\.json\.tmp-/);
    expect(text).toBe(PULLED_TEXT);
    expect(h.rename).toHaveBeenCalledWith(temp, 'flags.json');
    expect(h.writeFile.mock.invocationCallOrder[0]).toBeLessThan(h.rename.mock.invocationCallOrder[0] ?? 0);
    expect(h.rm).not.toHaveBeenCalled();
    expect(h.out).toEqual(['pulled production v2 -> flags.json']);
  });

  it('falls back to FEATURESYNC_BUCKET', async () => {
    const h = harness({ FEATURESYNC_BUCKET: 'env-bucket' });

    expect(await main(pull, h.io)).toBe(EXIT_OK);
    expect(h.createFetcher).toHaveBeenCalledWith('env-bucket');
  });

  it.each([
    ['--env', ['pull', '--version', '2', '--out', 'flags.json']],
    ['--version', ['pull', '--env', 'production', '--out', 'flags.json']],
    ['--out', ['pull', '--env', 'production', '--version', '2']],
    ['--bucket or FEATURESYNC_BUCKET', pull],
  ])('requires %s', async (name, argv) => {
    const h = harness({});

    expect(await main(argv, h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err[0]).toBe(`Missing ${name}`);
    expect(h.err[1]).toContain('featuresync pull --env <env> --version <version> --out <file> [--bucket <bucket>]');
    expect(h.createFetcher).not.toHaveBeenCalled();
  });

  it('passes a non-integer --version to the fetcher, which rejects it', async () => {
    const h = harness();
    h.fetcher.fetch.mockRejectedValue(new S3FetchError('INVALID_VERSION', '1.5', undefined));

    expect(await main(['pull', '--env', 'production', '--version', '1.5', '--out', 'flags.json'], h.io)).toBe(
      EXIT_USAGE_OR_IO,
    );
    expect(h.fetcher.fetch).toHaveBeenCalledWith('production', 1.5);
    expect(h.err).toEqual(['--version must be a positive integer (1.5)']);
  });

  it.each<[S3FetchErrorReason, string]>([
    ['SNAPSHOT_NOT_FOUND', 'Snapshot version not found; was it published to this environment? (k)'],
    ['ACCESS_DENIED', 'Access denied; check the credentials and their s3:GetObject permission (k)'],
    ['REQUEST_FAILED', 'S3 request failed (k)'],
    ['INVALID_ENVIRONMENT', 'Invalid --env (k)'],
    ['INVALID_VERSION', '--version must be a positive integer (k)'],
    ['EMPTY_SNAPSHOT', 'Snapshot object is empty (k)'],
  ])('reports %s with its own message and exit 3', async (reason, message) => {
    const h = harness();
    h.fetcher.fetch.mockRejectedValue(new S3FetchError(reason, 'k', undefined));

    expect(await main(pull, h.io)).toBe(EXIT_USAGE_OR_IO);
    expect(h.err).toEqual([message]);
    expect(h.writeFile).not.toHaveBeenCalled();
  });

  it('writes nothing when the fetched snapshot is invalid', async () => {
    const h = harness();
    h.fetcher.fetch.mockResolvedValue({
      environment: 'production',
      version: 2,
      key: 'k',
      text: JSON.stringify(invalidSnapshot()),
    });

    expect(await main(pull, h.io)).toBe(EXIT_INVALID_SNAPSHOT);
    expect(h.err.some((line) => line.startsWith('features.x.type: '))).toBe(true);
    expect(h.writeFile).not.toHaveBeenCalled();
  });

  it('writes nothing when the fetched text is not JSON', async () => {
    const h = harness();
    h.fetcher.fetch.mockResolvedValue({ environment: 'production', version: 2, key: 'k', text: '{ not json' });

    expect(await main(pull, h.io)).toBe(EXIT_INVALID_SNAPSHOT);
    expect(h.err[0]).toMatch(/^k: not valid JSON/);
    expect(h.writeFile).not.toHaveBeenCalled();
  });

  it.each(['writeFile', 'rename'] as const)('removes the temp file when %s fails', async (step) => {
    const h = harness();
    h[step].mockRejectedValue(new Error(`${step} failed`));

    expect(await main(pull, h.io)).toBe(EXIT_USAGE_OR_IO);
    const temp = h.writeFile.mock.calls[0]?.[0];
    expect(temp).toMatch(/^flags\.json\.tmp-/);
    expect(h.rm).toHaveBeenCalledWith(temp);
    expect(h.err).toEqual([`${step} failed`]);
    expect(h.out).toEqual([]);
  });

  it('writes a file that FEATURESYNC_FILE loads unchanged', async () => {
    const h = harness();
    const dir = await mkdtemp(join(tmpdir(), 'featuresync-pull-'));
    const out = join(dir, 'flags.json');
    const io: CliIo = { ...h.io, writeFile: nodeIo.writeFile, rename: nodeIo.rename, rm: nodeIo.rm };

    expect(await main(['pull', '--env', 'production', '--version', '2', '--out', out], io)).toBe(EXIT_OK);
    expect(await readFile(out, 'utf8')).toBe(PULLED_TEXT);
    expect(await readdir(dir)).toEqual(['flags.json']);
    const flags = createFeatureFlagsFromEnv({ env: { FEATURESYNC_FILE: out } });
    await flags.ready();

    expect(flags.version()).toBe(2);
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
    expect(nodeIo.createFetcher('b')).toHaveProperty('fetch');
    expect(nodeIo.createSegmentPublisher({ bucket: 'b' })).toHaveProperty('publish');
  });

  it('writes, renames and force-removes files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'featuresync-cli-'));
    const temp = join(dir, 'a.tmp');
    const final = join(dir, 'a.json');

    await nodeIo.writeFile(temp, 'x');
    await nodeIo.rename(temp, final);
    await nodeIo.rm(temp);
    await nodeIo.rm(final);

    expect(await readdir(dir)).toEqual([]);
  });

  it('is the default io', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(await main(['deploy'])).toBe(EXIT_USAGE_OR_IO);
    expect(stderr).toHaveBeenCalledWith('Unknown command deploy\n');
  });
});
