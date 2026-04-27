import { defineConfig } from 'vitest/config'

// Coverage applies globally; per-project test discovery lives in each
// package's own vitest.config.ts (projects mode). This keeps environments
// per-package overridable in M1+ when some packages need jsdom/UI tests.
export default defineConfig({
  test: {
    projects: [
      'packages/*',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/**/src/**/*.ts'],
      exclude: [
        '**/*.test.{ts,tsx,js,jsx}',
        '**/*.spec.{ts,tsx,js,jsx}',
        '**/*.bench.ts',
        '**/*.d.ts',
        '**/dist/**',
        '**/node_modules/**',
      ],
    },
  },
})
