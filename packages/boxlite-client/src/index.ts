// @auraaihq/boxlite-client — BoxLite OCI container client
// Service container manager (SimpleBox) + sandboxed Python runner (CodeBox).

export type { ContainerConfig, StartResult } from './service.js'
export {
  isServiceAvailable,
  getServiceError,
  startService,
  stopService,
  stopAll,
  getHostPort,
  isRegistered,
  proxyToService,
  __resetForTest,
  __injectEntryForTest,
} from './service.js'

export {
  isBoxliteAvailable,
  getBoxliteError,
  runPython,
  __resetHostForTest,
} from './host.js'
