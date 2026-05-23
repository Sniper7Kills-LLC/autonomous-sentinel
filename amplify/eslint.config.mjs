// @ts-check
import globals from 'globals';
import baseConfig from '../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Lambda handlers commonly use console.log for CloudWatch
      'no-console': 'off',
    },
  },
  {
    // Container Lambda handlers ship as `.mjs` (no TS build step
    // inside the image — same file lives in the container as on
    // disk). Same Node-env globals; typed lint not applied since
    // `.mjs` isn't in the TS project.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
];
