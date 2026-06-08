'use strict'

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  forceExit: true,
  clearMocks: true,
  collectCoverageFrom: [
    'services/**/*.js',
    'middleware/**/*.js',
    'routes/**/*.js',
    'workers/**/*.js',
    'utils/**/*.js',
    '!**/*.map.js',
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
  coverageReporters: ['text', 'text-summary', 'html', 'lcov'],
}
