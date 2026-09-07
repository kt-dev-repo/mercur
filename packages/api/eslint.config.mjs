import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * Lint for the backend.
 *
 * This package had no `lint` script at all, so `npm run lint` covered the two panels and
 * silently skipped every subscriber, provider, workflow and the seed — in CI too. The
 * panels' config cannot be reused here: it pulls in the React plugins and sets browser
 * globals, neither of which applies to a Node process.
 *
 * Deliberately the recommended sets and nothing bespoke. The point is to have the backend
 * covered at the same strictness the panels already are, not to open a style argument.
 */
export default defineConfig([
  // Build artifacts and generated code. `.mercur` holds the generated route types and
  // `.medusa` the compiled server; neither is ours to lint.
  globalIgnores(['.medusa', '.mercur', 'dist', 'coverage']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.jest },
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Test doubles stand in for Medusa services whose real types are generated at build
    // time and absent in CI (see packages/api/CLAUDE.md). Spelling those out in a mock
    // buys nothing and is exactly the inference the surrounding code deliberately avoids,
    // so `any` is allowed here and nowhere else.
    files: ['**/__tests__/**/*.ts', 'integration-tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])
