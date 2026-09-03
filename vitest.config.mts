import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
    },
    include: ['tests/**/*.test.ts'],
    // Real MongoDB/S3/Razorpay network tests are opt-in and separated from the default suite.
    exclude: ['tests/**/*.integration.test.ts'],
  },
});
