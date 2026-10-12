import { describe, it, expect } from 'vitest'
import { versionBelow } from '../updater.js'

describe('minimum version floor', () => {
  it('compares semver parts numerically, not lexically', () => {
    expect(versionBelow('0.9.0', '0.10.0')).toBe(true)
    expect(versionBelow('0.10.0', '0.9.0')).toBe(false)
    expect(versionBelow('1.2.3', '1.2.3')).toBe(false)
    expect(versionBelow('1.2.2', '1.2.3')).toBe(true)
    expect(versionBelow('2.0.0', '1.9.9')).toBe(false)
  })

  it('treats missing parts as zero', () => {
    expect(versionBelow('1.0', '1.0.1')).toBe(true)
    expect(versionBelow('1', '1.0.0')).toBe(false)
  })
})
