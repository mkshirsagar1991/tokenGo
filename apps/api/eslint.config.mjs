// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'migrations/**', 'scripts/**', 'jest.config.js', '.dependency-cruiser.cjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Money must never be a JS float: forbid parseFloat anywhere in source.
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'Use Money (integer minor units); never floats for money.' }],
      eqeqeq: ['error', 'always'],
    },
  },
);
