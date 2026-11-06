// ESLint: a small set of rules that catch real bugs, not style (Prettier owns formatting).
//
//   pnpm lint          check
//   pnpm lint --fix    apply the safe fixes
//
// TypeScript files get the type-aware rules that find unhandled and misused promises, which
// plain tsc does not report. Rules that only restate taste are left out on purpose.
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const desktop = 'apps/desktop'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '.dev-data/**',
      '.omc/**',
      '.claude/**',
      'docs/archive/**',
      'release/**',
      'apps/launcher/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: [`${desktop}/**/*.{ts,tsx,mts}`],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: [
          `${desktop}/tsconfig.node.json`,
          `${desktop}/tsconfig.web.json`,
          `${desktop}/tsconfig.test.json`,
          `${desktop}/tsconfig.test.web.json`,
          `${desktop}/tsconfig.e2e.json`,
        ],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Bugs tsc does not catch.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/await-thenable': 'error',
      // Unused code: underscore marks an intentionally unused name.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // tsc already checks these (or they fight existing, deliberate patterns).
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // React rules for React code only: test helpers such as useTempDataRoot are not hooks.
    files: [`${desktop}/src/renderer/**/*.{ts,tsx}`],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Injected into the page by the E2E visual audit.
    files: [`${desktop}/e2e/**/*.browser.js`],
    languageOptions: { globals: { ...globals.browser } },
  },
  prettier,
)
