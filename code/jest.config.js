module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.js'],
    collectCoverageFrom: [
        'services/**/*.js',
        'middlewares/**/*.js',
        'routes/**/*.js',
        '!**/node_modules/**'
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    verbose: true,
    testTimeout: 10000,
    setupFilesAfterEnv: ['<rootDir>/tests/setup.js']
};
