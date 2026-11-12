import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The two imports this repository forbids by where a file lives. Named once,
// because a later block that sets no-restricted-imports replaces an earlier
// one's options rather than adding to them, so each block below has to state
// everything that applies to its files.
const EE_IMPORTS = {
  group: ['@chokh/ee', '@chokh/ee/*', '**/packages/ee/**', '../ee/*', '../../ee/*'],
  message:
    'The core never imports packages/ee. Only packages/server/src/lib/load-extensions.ts may, and if a second file needs to, the seam is in the wrong place.',
};

const PG_IMPORTS = {
  group: [
    'pg',
    'pg/*',
    'pg-pool',
    'pg-cursor',
    'pg-query-stream',
    'pg-types',
    'pg-protocol',
    'pg-connection-string',
  ],
  message:
    'Only packages/store-postgres talks to PostgreSQL. Everything else asks the AnalyticsStore interface, and a query anywhere else is a query the conformance suite never sees.',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Rule 3: no query outside an adapter. The PostgreSQL driver is imported
    // by packages/store-postgres and by nothing else in the repository: not
    // the server, not the paid half, not a script. CI injects a crossing on
    // every push to prove this still refuses one.
    files: ['**/*.{ts,tsx,mjs,js}'],
    ignores: ['packages/store-postgres/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [PG_IMPORTS] }],
    },
  },
  {
    // The line between the MIT core and packages/ee, in the editor.
    //
    // ADR-0073: a paid feature lands nowhere but packages/ee, and the core
    // never reaches into it. One file may, and its whole job is that. The same
    // rule is checked again in CI by scripts/ee-boundary.mjs, which also covers
    // the licence key and the dependency direction, because a build that
    // skipped lint is a build that skipped this.
    //
    // It matters because the crossing cannot be undone: a feature released
    // under MIT is free for ever, and a paid one that lands in packages/server
    // by accident is not a bug to fix next week, it is a feature given away.
    files: ['packages/**/*.{ts,tsx,mjs,js}'],
    ignores: [
      'packages/ee/**',
      'packages/server/src/lib/load-extensions.ts',
      'packages/store-postgres/**',
    ],
    rules: {
      // Both, because these files are in the core and outside the adapter.
      'no-restricted-imports': ['error', { patterns: [EE_IMPORTS, PG_IMPORTS] }],
    },
  },
  {
    // The adapter is core too: it may import the driver and never the paid half.
    files: ['packages/store-postgres/**/*.{ts,tsx,mjs,js}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [EE_IMPORTS] }],
    },
  },
  {
    files: ['packages/tracker/**/*.ts', 'packages/dashboard/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // The scripts that drive a browser are node programs that carry snippets
    // evaluated inside the page, so localStorage and document are real there
    // and the node globals around them are real here.
    files: ['packages/dashboard/scripts/**/*.mjs', 'packages/dashboard/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
);
