// CodeBox host — availability check and sandboxed Python runner.
// Requires: Apple Silicon macOS 12+ (Hypervisor.framework) or Linux x86_64/ARM64 with KVM.
// The native NAPI binding is loaded lazily; all public functions degrade gracefully
// when the binding is unavailable.

type CodeBoxInstance = { run(code: string): Promise<string>; stop(): Promise<void> }
type CodeBoxConstructor = new () => CodeBoxInstance

let _CodeBoxClass: CodeBoxConstructor | null = null
let _initError: string | null = null
let _initialized = false

function ensureInit(): void {
  if (_initialized) return
  _initialized = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@boxlite-ai/boxlite') as { CodeBox: CodeBoxConstructor }
    _CodeBoxClass = mod.CodeBox
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    // Replace low-level NAPI errors with a human-readable hardware requirement message.
    _initError = `Requires Apple Silicon macOS 12+ (Hypervisor.framework) or Linux x86_64/ARM64 (KVM). Details: ${raw}`
  }
}

/** Returns true if the BoxLite native binding is loaded and CodeBox is available. */
export function isBoxliteAvailable(): boolean {
  ensureInit()
  return _CodeBoxClass !== null
}

/** Returns the init error message if the native binding failed to load, null otherwise. */
export function getBoxliteError(): string | null {
  ensureInit()
  return _initError
}

/** Run Python code in an isolated CodeBox. A fresh box is created and stopped after each call. */
export async function runPython(
  code: string,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  ensureInit()
  if (!_CodeBoxClass) {
    return { ok: false, error: `BoxLite unavailable: ${_initError}` }
  }
  const box = new _CodeBoxClass()
  try {
    const output = await box.run(code)
    return { ok: true, output }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await box.stop().catch(() => { /* best-effort cleanup */ })
  }
}

// Test-only: inject a fake CodeBox constructor and reset state.
export function __resetHostForTest(fakeCodeBox?: CodeBoxConstructor): void {
  _CodeBoxClass = fakeCodeBox ?? null
  _initError = fakeCodeBox ? null : 'injected for test'
  _initialized = true
}
