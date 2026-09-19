import { describe, expect, it, vi } from 'vitest';
import type { DashboardPorts } from '../src/infrastructure/http-server.js';
import { DEFAULT_PORT, EXIT_FAILURE, EXIT_OK, main, nodeIo, type DashboardIo } from '../src/main.js';

const ports: DashboardPorts = {
  readCurrentVersion: () => Promise.resolve(undefined),
  fetchSnapshotText: () => Promise.resolve(''),
  openWriter: () => ({ publish: () => Promise.resolve(1), rollback: () => Promise.resolve(1) }),
};

const harness = (env: Record<string, string | undefined> = { FEATURESYNC_BUCKET: 'env-bucket' }) => {
  const out: string[] = [];
  const err: string[] = [];
  const createPorts = vi.fn<DashboardIo['createPorts']>(() => ports);
  const startServer = vi.fn<DashboardIo['startServer']>(() =>
    Promise.resolve({ url: 'http://127.0.0.1:4455', close: () => Promise.resolve() }),
  );
  const io: DashboardIo = {
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    createPorts,
    startServer,
  };
  return { io, out, err, createPorts, startServer };
};

describe('main', () => {
  it('starts the dashboard on the default port with the bucket from the environment', async () => {
    const h = harness();

    await expect(main([], h.io)).resolves.toBe(EXIT_OK);

    expect(h.createPorts).toHaveBeenCalledWith({ bucket: 'env-bucket' });
    expect(h.startServer).toHaveBeenCalledWith(expect.objectContaining({ ports, port: DEFAULT_PORT }));
    expect(h.out).toEqual(['FeatureSync dashboard for bucket env-bucket at http://127.0.0.1:4455']);
    expect(h.err).toEqual([]);
  });

  it('prefers flags over environment variables', async () => {
    const h = harness({ FEATURESYNC_BUCKET: 'env-bucket', FEATURESYNC_TOPIC_ARN: 'env-topic' });

    await main(['--bucket', 'flag-bucket', '--topic-arn', 'flag-topic', '--port', '0'], h.io);

    expect(h.createPorts).toHaveBeenCalledWith({ bucket: 'flag-bucket', topicArn: 'flag-topic' });
    expect(h.startServer).toHaveBeenCalledWith(expect.objectContaining({ port: 0 }));
  });

  it('takes the topic ARN from the environment and ignores empty values', async () => {
    const h = harness({ FEATURESYNC_BUCKET: 'env-bucket', FEATURESYNC_TOPIC_ARN: 'env-topic' });

    await main(['--bucket', '', '--topic-arn', ''], h.io);

    expect(h.createPorts).toHaveBeenCalledWith({ bucket: 'env-bucket', topicArn: 'env-topic' });
  });

  it('logs unexpected server errors to stderr', async () => {
    const h = harness();
    await main([], h.io);
    const [[options]] = h.startServer.mock.calls as [[Parameters<DashboardIo['startServer']>[0]]];

    options.logError?.(new Error('boom'));

    expect(h.err).toEqual(['Error: boom']);
  });

  it.each([[{}], [{ FEATURESYNC_BUCKET: '' }]])('fails with usage when no bucket is configured (%o)', async (env) => {
    const h = harness(env);

    await expect(main([], h.io)).resolves.toBe(EXIT_FAILURE);

    expect(h.err[0]).toBe('Missing --bucket or FEATURESYNC_BUCKET');
    expect(h.err[1]).toContain('Usage:');
    expect(h.startServer).not.toHaveBeenCalled();
  });

  it.each(['-1', 'abc', '65536', '123456', '1.5'])('rejects --port %s', async (port) => {
    const h = harness();

    await expect(main([`--port=${port}`], h.io)).resolves.toBe(EXIT_FAILURE);

    expect(h.err[0]).toBe('--port must be an integer from 0 to 65535');
    expect(h.startServer).not.toHaveBeenCalled();
  });

  it('prints usage for an unknown option', async () => {
    const h = harness();

    await expect(main(['--nope'], h.io)).resolves.toBe(EXIT_FAILURE);

    expect(h.err[1]).toContain('Usage:');
  });

  it('reports a server that cannot start without printing usage', async () => {
    const h = harness();
    h.startServer.mockRejectedValueOnce(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));

    await expect(main([], h.io)).resolves.toBe(EXIT_FAILURE);

    expect(h.err).toEqual(['listen EADDRINUSE']);
  });

  it('reports a non-Error rejection', async () => {
    const h = harness();
    h.startServer.mockRejectedValueOnce('down');

    await expect(main([], h.io)).resolves.toBe(EXIT_FAILURE);

    expect(h.err).toEqual(['down']);
  });
});

describe('nodeIo', () => {
  it('writes lines to stdout and stderr', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    nodeIo.out('hello');
    nodeIo.err('oops');

    expect(stdout).toHaveBeenCalledWith('hello\n');
    expect(stderr).toHaveBeenCalledWith('oops\n');
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
