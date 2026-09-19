import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

const envFile = '../../.env';
const dotenv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const awsEnv = Object.fromEntries(
  Object.entries({ ...dotenv, ...process.env }).filter(
    (entry): entry is [string, string] => entry[0].startsWith('AWS_') && entry[1] !== undefined,
  ),
);

export default defineConfig({
  test: {
    include: ['integration/**/*.localstack.test.ts'],
    env: awsEnv,
    coverage: { enabled: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
