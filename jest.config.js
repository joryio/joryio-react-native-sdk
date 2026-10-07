/**
 * Unit tests for the JavaScript layer. The native module is replaced by a mock
 * (see __tests__/helpers.ts), so these run in plain Node with no simulator.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
};
