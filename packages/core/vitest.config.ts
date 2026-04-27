import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@auraaihq/core',
    environment: 'node',
    // Use Vitest's default include pattern — captures .test/.spec/.bench in ts/tsx/cts/mts.
    include: ['src/**/*.{test,spec,bench}.?(c|m)[jt]s?(x)'],
  },
})
