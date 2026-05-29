import { describe, it, expect } from 'vitest'
import { VERSION } from './index'

describe('@auraaihq/sdk', () => {
  it('exports VERSION', () => {
    expect(VERSION).toBe('0.0.0')
  })

  it('VERSION is a string', () => {
    expect(typeof VERSION).toBe('string')
  })
})
