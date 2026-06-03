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
      // Local-only esbuild bundler for the .ablx (not in any CI tsconfig, runs via tsx
      // with the SDK installed locally; see ARCHITECTURE_DECISIONS §6). Same class as
      // the *.config.ts files above: tooling, not shipped, not type-checked in CI.
      '**/build.ts',
      // The SDK-facing code is the ONLY code that imports @ableton-extensions/sdk
      // (the non-redistributable beta): the adapter, the five context-menu command
      // modules, and the activate() bootstrap. It is excluded from the committed CI
      // tsconfig so `tsc --noEmit` passes with NO SDK present (ARCHITECTURE_DECISIONS.md
      // §1/§4), which means the type-aware ESLint project service cannot resolve these
      // files either. Ignore them here so the committed `eslint .` stays green SDK-free;
      // they are typechecked locally against the real types via tsconfig.live.json. The
      // SDK-free extension files (commands/support.ts, webviews/**) stay linted.
      'packages/extension/src/adapter/**',
      'packages/extension/src/commands/*.command.ts',
      'packages/extension/src/extension.ts',
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
    // The extension shell (the SDK-free, still-linted parts) logs to stderr via
    // `console.error`; the Extension Host tees fd 2 to `ExtensionHost.txt` and there is
    // no pino in the .ablx bundle, so console IS the logging channel here (unlike the
    // mcp package, where stdout is the JSON-RPC wire). Allow it for these files.
    files: ['packages/extension/src/**/*.ts'],
    rules: {
      'no-console': 'off',
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
