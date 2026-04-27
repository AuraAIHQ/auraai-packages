import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@auraaihq/cli',
    environment: 'node',
    include: ['src/**/*.{test,spec,bench}.?(c|m)[jt]s?(x)'],
  },
})
