// @auraaihq/sdk — public SDK for Agent24-Desktop module developers.
//
// Per ADR-010, this v0.1 interface is intentionally minimal. It will
// be revised in M1-M2 once 2-3 reference modules expose real
// requirements. Treat anything here as unstable until @auraaihq/sdk
// reaches v1.0.

export { VERSION } from './version'
export {
  type Module,
  type ModuleManifest,
  type ModuleLifecycle,
  type ModuleContext,
  type Intent,
  type Result,
  type Permission,
  type Logger,
  type AIHandle,
  type AICompletionResult,
  type MemoryHandle,
  type AdapterErrorCode,
  type BridgeErrorCode,
  defineModule,
} from './module'
