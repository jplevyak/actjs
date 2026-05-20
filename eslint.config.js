import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  {
    // Beta.js / Gamma.js are uploaded actor class fixtures executed inside
    // an AsyncFunction with `gact` injected — not framework source.
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      'Beta.js',
      'Gamma.js',
      // Codegen fixtures: raw class source authored against the
      // global `actjs`/`handler` symbols, parsed as text by the
      // codegen pipeline. They aren't compiled.
      'tests/codegen/fixtures/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: {
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc' },
        },
      ],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    // CLI entrypoints legitimately write to stdout/stderr via console.log.
    files: ['src/cli/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
