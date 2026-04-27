import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@auraaihq/sdk',
    environment: 'node',
    include: ['src/**/*.{test,spec,bench}.?(c|m)[jt]s?(x)'],
  },
})
