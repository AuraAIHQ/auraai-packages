import { defineConfig } from 'vitest/config'

// Coverage applies globally; per-project test discovery lives in each
// package's own vitest.config.ts (projects mode). This keeps environment
// per-package overridable in M1+ when some packages need jsdom/UI tests.
export default defineConfig({
  test: {
    // All workspace group directories. Add new groups (e.g., agents/) here
    // when introduced. Each subpath must contain its own vitest.config.ts.
    // Match each project's own vitest.config.{ts,js} explicitly. Using
    // bare directory globs (e.g. 'packages/*') would error on placeholder
    // `.gitkeep` files in empty group dirs.
    projects: [
      'packages/*/vitest.config.ts',
      'community/*/vitest.config.ts',
      'publishers/*/vitest.config.ts',
      'scrapers/*/vitest.config.ts',
      'idoris/*/vitest.config.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['{packages,community,publishers,scrapers,idoris}/**/src/**/*.ts'],
      exclude: [
        '**/*.test.{ts,tsx,cts,mts,js,jsx}',
        '**/*.spec.{ts,tsx,cts,mts,js,jsx}',
        '**/*.bench.{ts,tsx,cts,mts,js,jsx}',
        '**/*.d.ts',
        '**/dist/**',
        '**/node_modules/**',
      ],
    },
  },
})
