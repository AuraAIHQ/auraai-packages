import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@auraaihq/publish-blog',
    environment: 'node',
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    benchmark: {
      include: ['src/**/*.{bench,benchmark}.?(c|m)[jt]s?(x)'],
    },
  },
})
