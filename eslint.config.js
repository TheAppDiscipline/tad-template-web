import js from '@eslint/js'
import globals from 'globals'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

// Discipline Loop Non-Negotiables enforced via ESLint:
//   NN #11 AI Studio Lane   -> no-console (except warn/error)
//   NN #18 Error Handling   -> no-empty (no catch {} vacios)
//   NN #21 TypeScript Strict -> no-explicit-any (error), ban-ts-comment (require descripcion)
//   NN #24 Accessibility    -> jsx-a11y/* (static, prescribed by SOP 64)
// Cambios <warn>-first permiten calibrar falsos positivos durante Wave 3.1.
// When PROFILE=LAUNCH/PROD, the gate must run these rules as 'error'.

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          'argsIgnorePattern': '^_',
          'varsIgnorePattern': '^_',
          'caughtErrorsIgnorePattern': '^_'
        }
      ],
      // Discipline Loop NN #18 Error Handling Discipline
      'no-empty': ['error', { allowEmptyCatch: false }],
      // Discipline Loop NN #11 AI Studio Lane / logging discipline
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Discipline Loop NN #21 TypeScript Strictness
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': { descriptionFormat: '^: .+$' },
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 10,
        },
      ],
      // Discipline Loop NN #24 Accessibility (SOP 64), critical rules as errors
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
    },
  },
  // Tools, tests, and operational scripts may use console freely
  {
    files: ['tools/**/*.{js,ts}', 'tests/**/*.{js,ts}', 'scripts/**/*.{js,ts}'],
    rules: {
      'no-console': 'off',
    },
  },
)
