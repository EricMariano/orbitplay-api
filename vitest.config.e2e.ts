import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// e2e tests: run serially against a dedicated test Postgres. globalSetup
// migrates the test database once before the suite.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    globalSetup: ['test/setup-e2e.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    // Point the app at the separate test database and mark the env as test.
    // Other required vars (JWT secrets, storage, etc.) still come from .env,
    // which @nestjs/config loads without overriding these.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://orbitplay:orbitplay@localhost:5432/orbitplay_test',
      // Higher limit so multi-login functional specs don't trip the throttle;
      // the dedicated ratelimit spec still exceeds it to prove the 429.
      AUTH_THROTTLE_LIMIT: '20',
      AUTH_THROTTLE_TTL: '60',
    },
  },
  plugins: [swc.vite()],
});
