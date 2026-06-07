// @auraaihq/memory — Layered memory system for Agent24
//
// M1 phase ships L0 (key-value, namespace-scoped, sqlite-backed).
// L1 (essential), L2 (selective), L3 (deep), and SkillBank arrive in M3.

export { createMemory, type Memory, type MemoryOptions } from './memory'
export { VERSION } from './version'
