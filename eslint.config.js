import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { importX } from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

export default defineConfig(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', '*.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['examples/**/*.js'],
    languageOptions: { globals: { console: 'readonly' } },
  },
  {
    files: ['examples/local-dashboard/*.js'],
    languageOptions: {
      globals: { process: 'readonly', URL: 'readonly', fetch: 'readonly', setInterval: 'readonly', clearInterval: 'readonly' },
    },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver()],
    },
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './packages/*/src/domain/**/*',
              from: ['./packages/*/src/application/**/*', './packages/*/src/infrastructure/**/*'],
              message: 'The domain layer must not depend on outer layers.',
            },
            {
              target: './packages/*/src/application/**/*',
              from: './packages/*/src/infrastructure/**/*',
              message: 'The application layer must not depend on infrastructure.',
            },
          ],
        },
      ],
    },
  },
);
