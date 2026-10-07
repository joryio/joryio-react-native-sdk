/**
 * Lint for the React Native bridge.
 *
 * Same posture as the web SDK: rules that catch BUGS, not style. The bridge is
 * the package where an unhandled rejection hurts most - a throw inside a
 * @ReactMethod or a floating promise surfaces as a red box in development and an
 * unhandled JS error in production, in someone else's app.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  env: { es2020: true },
  ignorePatterns: ['lib/', 'node_modules/', '.eslintrc.js', '*.spec.ts'],
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-constant-condition': 'error',
    'no-unreachable': 'error',
    eqeqeq: ['error', 'smart'],
    'no-console': 'warn',
    '@typescript-eslint/no-explicit-any': 'off',
  },
};
