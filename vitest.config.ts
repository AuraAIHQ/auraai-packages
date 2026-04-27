import { defineConfig } from 'vitest/config'

// Coverage applies globally; per-project test discovery lives in each
// package's own vitest.config.ts (projects mode). This keeps environment
// per-package overridable in M1+ when some packages need jsdom/UI tests.
export default defineConfig({
  test: {
    // Match each project's own vitest.config.{ts,js,mjs} explicitly. Using
    // bare directory globs (e.g. 'packages/*') would error on placeholder
    // `.gitkeep` files in empty group dirs.
    projects: [
      'packages/*/vitest.config.{ts,js,mjs}',
      'community/*/vitest.config.{ts,js,mjs}',
      'publishers/*/vitest.config.{ts,js,mjs}',
      'scrapers/*/vitest.config.{ts,js,mjs}',
      'idoris/*/vitest.config.{ts,js,mjs}',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['{packages,community,publishers,scrapers,idoris}/**/src/**/*.{ts,tsx,cts,mts}'],
      exclude: [
        '**/*.test.{ts,tsx,cts,mts,js,jsx}',
        '**/*.spec.{ts,tsx,cts,mts,js,jsx}',
        '**/*.bench.{ts,tsx,cts,mts,js,jsx}',
        '**/*.benchmark.{ts,tsx,cts,mts,js,jsx}',
        '**/*.d.ts',
        '**/dist/**',
        '**/node_modules/**',
      ],
    },
  },
})
