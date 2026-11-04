import tseslint from 'typescript-eslint';

export default [
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unused-expressions': 'off',
      'prefer-const': 'off',
    },
  },
];
