// @auraaihq/ai-bridge — AI Layer router for Agent24-Desktop kernel.
//
// Concrete provider adapters (idoris / claude / openai / local) ship
// as separate packages (@auraaihq/ai-* — landing in M1+). This package
// defines the adapter contract, the routing/fallback bridge, and an
// in-process adapter for testing.

export { VERSION } from './version'
export {
  type Adapter,
  type AdapterMetadata,
  type AdapterErrorCode,
  type ProviderFamily,
  type CompleteOptions,
  type CompleteResult,
  AdapterError,
  isAdapterError,
} from './adapter'
export {
  createBridge,
  type Bridge,
  type BridgeOptions,
  type BridgeErrorCode,
  type RoutingPolicy,
  BridgeError,
} from './bridge'
export {
  createInProcessAdapter,
  type InProcessAdapterOptions,
} from './in-process-adapter'
