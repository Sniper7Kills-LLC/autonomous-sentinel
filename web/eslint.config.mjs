// @ts-check
import nextPlugin from '@next/eslint-plugin-next';
import eslintReact from '@eslint-react/eslint-plugin';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import baseConfig from '../eslint.config.mjs';

export default [
  ...baseConfig,
  // React component/JSX rules via @eslint-react (#696). Replaces
  // eslint-plugin-react, which has no ESLint 10-compatible release —
  // @eslint-react@5 declares `eslint ^10.3.0`. Use the non-type-checked
  // `recommended` preset for parity with the old eslint-plugin-react
  // `configs.recommended` (also non-type-aware) and to avoid the very
  // slow per-file re-typecheck the `recommended-typescript` preset incurs
  // on top of the base config's `recommendedTypeChecked`.
  {
    files: ['**/*.{ts,tsx}'],
    ...eslintReact.configs.recommended,
  },
  // @eslint-react duplicates several eslint-plugin-react-hooks rules
  // (e.g. set-state-in-effect). Defer to eslint-plugin-react-hooks as the
  // canonical hooks linter and turn off @eslint-react's overlapping copies.
  {
    files: ['**/*.{ts,tsx}'],
    ...eslintReact.configs['disable-conflict-eslint-plugin-react-hooks'],
  },
  {
    // Deferred @eslint-react rules (#710): these fire against existing code
    // and, under the lint script's --max-warnings=0, would block the ESLint
    // 10 migration (#696). Turned off here to land the toolchain; #710 tracks
    // re-enabling each + fixing the violations. The 2 real errors
    // (react-hooks/purity Date.now-in-render, @eslint-react/unsupported-syntax
    // IIFE-in-JSX) were fixed in this change; unsupported-syntax stays on.
    files: ['**/*.{ts,tsx}'],
    rules: {
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
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      // react-hooks@7 ships two new opinionated rules in its recommended
      // preset (`set-state-in-effect`, `refs`) that fire broadly against the
      // existing component code. Turn them OFF so the toolchain upgrade lands
      // without a mass behavioural refactor (the lint script runs
      // --max-warnings=0, so 'warn' would fail). Adopting them as errors +
      // fixing the call sites is tracked as a follow-up (#710).
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
    },
  },
  {
    // Service workers live in `public/` and run under the `ServiceWorkerGlobalScope`
    // — give the parser the matching globals so `self`, `caches`, etc.
    // resolve without polluting the rest of the workspace's env.
    files: ['public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // The Amplify-Gen-2-generated `amplify_outputs.json` resolves to
    // different inferred types depending on which version of the
    // Amplify Gen 2 toolchain TypeScript reads from disk. Some envs
    // narrow it to a `ResourcesConfig`-compatible shape (cast is
    // "unnecessary"), CI's typecheck widens it to `unknown` (cast is
    // required to silence `no-unsafe-argument`). Disabling both rules
    // for this single file keeps the call site stable across envs;
    // there's nothing else in the file that would benefit from
    // keeping the rules on.
    files: ['lib/amplifyClient.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
];
