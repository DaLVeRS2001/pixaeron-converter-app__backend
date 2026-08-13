module.exports = {
  displayName: 'rate-limit',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.spec\\.ts$'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/rate-limit',
};
