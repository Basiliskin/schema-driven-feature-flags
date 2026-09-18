import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/application/logger.port.js';
import { ConfigurationError, createFeatureFlagsFromEnv } from '../../src/infrastructure/config-from-env.js';
import { paymentFlow, validSnapshot } from '../domain/fixtures.js';

let dir: string;
let path: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'featuresync-env-'));
  path = join(dir, 'flags.json');
  await writeFile(path, JSON.stringify(validSnapshot()));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createFeatureFlagsFromEnv', () => {
  it.each([{}, { FEATURESYNC_FILE: '' }])('throws a ConfigurationError when FEATURESYNC_FILE is unset (%o)', (env) => {
    expect(() => createFeatureFlagsFromEnv({ env })).toThrow(
      new ConfigurationError('Set FEATURESYNC_FILE to the path of a snapshot JSON file'),
    );
  });

  it('names the error', () => {
    expect(new ConfigurationError('x').name).toBe('ConfigurationError');
  });

  it('builds a client that loads the file named by FEATURESYNC_FILE', async () => {
    const flags = createFeatureFlagsFromEnv({ env: { FEATURESYNC_FILE: path }, definitions: [paymentFlow] });
    await flags.ready();

    expect(flags.evaluate('payment-flow', { plan: 'enterprise', country: 'DE' }).value.provider).toBe('adyen');
  });

  it('passes the logger to the client', async () => {
    const logger = { error: vi.fn<Logger['error']>() };
    const flags = createFeatureFlagsFromEnv({ env: { FEATURESYNC_FILE: join(dir, 'missing.json') }, logger });

    await expect(flags.ready()).rejects.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      'Snapshot load failed; keeping the active one',
      expect.objectContaining({ reason: 'READ_FAILED' }),
    );
  });

  it('reads process.env by default', async () => {
    vi.stubEnv('FEATURESYNC_FILE', path);
    const flags = createFeatureFlagsFromEnv({ watch: true });
    await flags.ready();
    flags.close();
    vi.unstubAllEnvs();

    expect(flags.version()).toBe(44);
  });
});
