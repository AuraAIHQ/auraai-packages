// @auraaihq/core — Agent24-Desktop kernel.
//
// M1 phase ships the in-memory module registry + loader. Sandboxing,
// dynamic npm install, and signature verification arrive in M3 (per
// ADR-016). Until then, modules are registered programmatically by the
// host (Agent24-Desktop main process).

export { VERSION } from './version'
export { createKernel, type Kernel, type KernelOptions } from './kernel'
export type {
  KernelLogger,
  ModuleRecord,
  KernelEvents,
} from './kernel'
