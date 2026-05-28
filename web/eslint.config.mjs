// @ts-check
import nextPlugin from '@next/eslint-plugin-next';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import baseConfig from '../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
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
