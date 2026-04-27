import { describe, it, expect, vi } from 'vitest'
import { VERSION, main } from './index'

describe('@auraaihq/cli', () => {
  it('exports VERSION', () => {
    expect(VERSION).toBe('0.0.0')
  })

  it('main() prints placeholder message', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    main()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('M0 placeholder'))
    spy.mockRestore()
  })
})
