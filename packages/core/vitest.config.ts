import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@auraaihq/core',
    environment: 'node',
    // Vitest's default test discovery pattern. Benchmarks (.bench.*) are
    // intentionally NOT included — run via `vitest bench` separately.
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    benchmark: {
      include: ['src/**/*.bench.?(c|m)[jt]s?(x)'],
    },
  },
})
