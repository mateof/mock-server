// Test setup file
// This file runs before all tests

// Set test environment
process.env.NODE_ENV = 'test';

// Suppress console output during tests (optional, uncomment if needed)
// global.console = {
//     ...console,
//     log: jest.fn(),
//     error: jest.fn(),
//     warn: jest.fn(),
// };

// Global timeout for async operations
jest.setTimeout(10000);

// Clean up after all tests
afterAll(async () => {
    // Add any global cleanup here
});
