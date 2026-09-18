import { readdirSync, readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

const packageNames = readdirSync('packages');

export default defineConfig({
  test: {
    projects: packageNames.map((dir) => ({
      extends: true,
      test: {
        name: (JSON.parse(readFileSync(`packages/${dir}/package.json`, 'utf8')) as { name: string }).name,
        root: `packages/${dir}`,
        exclude: [...configDefaults.exclude, 'integration/**'],
      },
    })),
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
