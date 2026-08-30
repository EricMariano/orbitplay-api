import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Unit tests. SWC transforms TS with decorator metadata so Nest DI works.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.module.ts', 'src/main.ts', 'src/openapi.ts'],
    },
  },
  plugins: [swc.vite()],
});
