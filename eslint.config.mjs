// ESLint: a small set of rules that catch real bugs and keep the process boundaries, not style
// (Prettier owns formatting). Boundaries: renderer and shared never import main, preload or backend,
// shared imports no process code, main never imports renderer, and neither renderer nor shared imports electron.
//
//   pnpm lint          check
//   pnpm lint --fix    apply the safe fixes
//
// TypeScript files get the type-aware rules that find unhandled and misused promises, which
// plain tsc does not report, plus exhaustive switches, type-only imports and `no-restricted-imports`
// for the boundaries. Rules that only restate taste are left out on purpose.
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
      // A switch over a union lists every member; a new member is then a lint error, not a silent fall-through.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Type-only imports are erased per file by the bundler (isolatedModules), so they are marked.
      // `typeof import('...')` stays allowed: tests type vi.mock factories with it.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
      // Unused code: underscore marks an intentionally unused name.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // tsc already checks these (or they fight existing, deliberate patterns).
      'no-undef': 'off',
      // `any` hides what tsc would report. A warning, so a deliberate use stays visible without failing the build.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  // Process boundaries: specifier patterns, so no resolver is needed. A new alias or top-level folder under
  // src/ needs a pattern here. test/ and e2e/ are outside src/ and import freely.
  {
    files: [`${desktop}/src/renderer/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@main',
                '@main/*',
                '**/src/main',
                '**/src/main/**',
                '../**/main/**',
                '**/src/preload/**',
                '**/src/backend/**',
                '../**/preload/**',
                '../**/backend/**',
              ],
              message: 'The renderer reaches main through IPC (src/shared/channels.ts), not by import.',
            },
            { group: ['electron'], message: 'The renderer reaches Electron only through window.clover (preload).' },
          ],
        },
      ],
    },
  },
  {
    files: [`${desktop}/src/shared/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@main', '@main/*', '@renderer', '@renderer/*', '**/main/**', '**/renderer/**', '**/preload/**', '**/backend/**'],
              message: 'shared runs in every process; it imports no process code.',
            },
            { group: ['electron'], message: 'shared is bundled into the renderer; it must not import electron.' },
          ],
        },
      ],
    },
  },
  {
    files: [`${desktop}/src/main/**/*.ts`, `${desktop}/src/backend/**/*.ts`, `${desktop}/src/preload/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@renderer', '@renderer/*', '**/renderer/**'],
              message: 'main does not import renderer code; share it through src/shared.',
            },
          ],
        },
      ],
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
