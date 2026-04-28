// @auraaihq/ai-bridge — AI Layer router for Agent24-Desktop kernel.
//
// Concrete adapters (idoris / claude / openai / local) are separate
// packages (@auraaihq/ai-* — landing in M1+). This package defines
// the adapter contract, the routing/fallback bridge, and a dummy
// adapter for testing.

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
export { createDummyAdapter, type DummyAdapterOptions } from './dummy-adapter'
