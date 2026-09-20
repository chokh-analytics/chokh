import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
    ignores: ['packages/ee/**', 'packages/server/src/lib/load-extensions.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@chokh/ee', '@chokh/ee/*', '**/packages/ee/**', '../ee/*', '../../ee/*'],
              message:
                'The core never imports packages/ee. Only packages/server/src/lib/load-extensions.ts may, and if a second file needs to, the seam is in the wrong place.',
            },
          ],
        },
      ],
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
