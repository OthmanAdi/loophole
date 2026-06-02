// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Global ignores: build output, deps, and config files that are not type-checked.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        // Type-aware linting: use each package's nearest tsconfig.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The fake's mutators are intentionally async to honor the LiveBridge
      // port's Promise contract (the real SDK mutators return Promises), even
      // where the in-memory fake resolves synchronously. Keep them async.
      '@typescript-eslint/require-await': 'off',
      // No "any": the strict-TS contract bans it. Surface every escape hatch.
      '@typescript-eslint/no-explicit-any': 'error',
      // stdout is the JSON-RPC channel on stdio transport; route logs through pino.
      'no-console': 'warn',
      // Async mutations are everywhere; an unhandled Promise is a correctness bug.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The mcp package excludes test files from its build tsconfig (composite +
    // declaration emit), so the project service cannot type-check them. Point
    // the type-aware program for this package at tsconfig.eslint.json, which
    // includes src plus tests, so test files are linted with full type info.
    files: ['packages/mcp/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['packages/mcp/tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Test files: relax a few type-aware rules that fight fixtures and fakes.
    files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts', '**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // The sync-callback misuse test deliberately leaves a mutator unawaited
      // inside a void-returning callback to prove the fake rejects that misuse.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  // Disable formatting-related lint rules; Prettier owns formatting.
  prettier,
);
