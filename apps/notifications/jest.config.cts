module.exports = {
  displayName: 'notifications',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '\\.db\\.spec\\.ts$'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/notifications',
};
