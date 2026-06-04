// @ts-check
import globals from 'globals';
import eslintReact from '@eslint-react/eslint-plugin';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import baseConfig from '../eslint.config.mjs';

export default [
  ...baseConfig,
  // Renderer process — React in browser env. React component/JSX rules via
  // @eslint-react (#696); eslint-plugin-react has no ESLint 10-compatible
  // release. Non-type-checked `recommended` preset (parity + perf).
  {
    files: ['src/**/*.{ts,tsx}'],
    ...eslintReact.configs.recommended,
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ...eslintReact.configs['disable-conflict-eslint-plugin-react-hooks'],
  },
  {
    // Deferred @eslint-react / react-hooks@7 rules (#710) — turned off so the
    // ESLint 10 migration (#696) lands without a mass refactor; #710 tracks
    // re-enabling each + fixing violations. Mirrors web/eslint.config.mjs.
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooksPlugin },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      '@eslint-react/no-array-index-key': 'off',
      '@eslint-react/set-state-in-effect': 'off',
      '@eslint-react/jsx-no-leaked-dollar': 'off',
      '@eslint-react/use-state': 'off',
      '@eslint-react/purity': 'off',
      '@eslint-react/dom-no-dangerously-set-innerhtml': 'off',
      '@eslint-react/no-use-context': 'off',
      '@eslint-react/no-unnecessary-use-prefix': 'off',
      '@eslint-react/naming-convention-ref-name': 'off',
      '@eslint-react/naming-convention-context-name': 'off',
    },
  },
  // Main + preload process — Node env
  {
    files: ['electron/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
