const path = require('path')

module.exports = {
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.(t|j)s$',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  globalSetup: path.join(__dirname, 'jest', 'setup.ts'),
  globalTeardown: path.join(__dirname, 'jest', 'teardown.ts')
}
