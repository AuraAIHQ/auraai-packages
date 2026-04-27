#!/usr/bin/env node
// @auraaihq/cli — placeholder
// See https://github.com/AuraAIHQ/Agent24-Desktop/blob/main/docs/ROADMAP.md

export const VERSION = '0.0.0'

export function main(): void {
  console.log('@auraaihq/cli — M0 placeholder. Real CLI begins M1.')
}

// Only run when executed directly (not on import for tests)
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  main()
}
