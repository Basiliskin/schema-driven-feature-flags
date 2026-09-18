import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createFeatureFlagsFromEnv, defineFeature, type FeatureFlags } from '../../src/index.js';

const checkout = defineFeature({
  key: 'checkout',
  schema: z.object({ provider: z.enum(['stripe', 'adyen']) }),
  default: { provider: 'stripe' },
  context: z.object({ plan: z.enum(['free', 'pro']) }),
});

const snapshot = (version: number, proProvider: 'stripe' | 'adyen') => ({
  schemaVersion: 1,
  environment: 'development',
  version,
  createdAt: '2026-09-18T06:00:00.000Z',
  createdBy: 'e2e',
  previousVersion: version > 1 ? version - 1 : null,
  reason: 'e2e',
  features: {
    checkout: {
      type: 'config',
      enabled: true,
      default: { provider: 'stripe' },
      rules: [{ when: { plan: 'pro' }, value: { provider: proProvider } }],
    },
  },
});

let dir: string;
let flags: FeatureFlags<[typeof checkout]> | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'featuresync-e2e-'));
});

afterEach(async () => {
  flags?.close();
  await rm(dir, { recursive: true, force: true });
});

it('serves a local snapshot file and follows valid rewrites while ignoring broken ones', async () => {
  const path = join(dir, 'feature-flags.json');
  await writeFile(path, JSON.stringify(snapshot(1, 'stripe')));
  const logger = { error: vi.fn() };

  flags = createFeatureFlagsFromEnv({
    env: { FEATURESYNC_FILE: path },
    definitions: [checkout],
    watch: true,
    logger,
  });
  await flags.ready();

  expect(flags.version()).toBe(1);
  expect(flags.evaluate('checkout', { plan: 'pro' }).value).toEqual({ provider: 'stripe' });

  await writeFile(path, JSON.stringify(snapshot(2, 'adyen')).slice(0, 40));
  await vi.waitFor(() => {
    expect(logger.error).toHaveBeenCalled();
  });
  expect(flags.version()).toBe(1);

  await writeFile(path, JSON.stringify(snapshot(2, 'adyen')));
  await vi.waitFor(() => {
    expect(flags?.version()).toBe(2);
  });
  expect(flags.evaluate('checkout', { plan: 'pro' }).value).toEqual({ provider: 'adyen' });
  expect(flags.evaluate('checkout', { plan: 'free' }).value).toEqual({ provider: 'stripe' });
});
