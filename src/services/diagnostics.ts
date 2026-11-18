import { DiagnosticBuffer, sanitizeEvent } from './diagnosticsCore.js'
import { isAndroid, nativeCall } from '../platform/android.js'

const DATA_KEY = 'chat-demo:diagnostics'
const ENABLED_KEY = 'chat-demo:diagnostics-enabled'
const read = (key: string) => {
  try { return localStorage.getItem(key) } catch { return null }
}
const buffer = new DiagnosticBuffer(read(DATA_KEY) ?? undefined)
let enabled = read(ENABLED_KEY) !== 'false'
let persistent = true
let saveTimer: ReturnType<typeof setTimeout> | undefined
let installed = false
const subscribers = new Set<() => void>()

export const diagnosticsEnabled = () => enabled
export const subscribeDiagnostics = (listener: () => void) => {
  subscribers.add(listener)
  return () => { subscribers.delete(listener) }
}

export const flushDiagnostics = () => {
  clearTimeout(saveTimer)
  saveTimer = undefined
  try {
    localStorage.setItem(DATA_KEY, buffer.serialize())
    persistent = true
  } catch {
    persistent = false // An in-memory export remains available when storage is unavailable.
  }
}

/** No free text: the core drops unknown event names, fields and non-enumerated strings. */
export const diagnostic = (event: string, details: Record<string, unknown> = {}) => {
  if (!enabled) { return }
  buffer.record(event, details)
  if (event.endsWith('.error') || event.endsWith('.stall') || event.endsWith('.empty')) {
    flushDiagnostics()
  } else {
    saveTimer ??= setTimeout(flushDiagnostics, 300)
  }
}

export const diagnosticError = (event: string, error: unknown, details: Record<string, unknown> = {}) => {
  let errorName = 'unknown'
  let apiKind: unknown
  let status: unknown
  try {
    if (typeof error === 'object' && error !== null) {
      const value = error as { name?: unknown; kind?: unknown; status?: unknown }
      if (typeof value.name === 'string') { errorName = value.name }
      apiKind = value.kind
      status = value.status
    }
  } catch { /* Never serialize an error object or its message/stack. */ }
  diagnostic(event, { ...details, errorName,
    ...(apiKind === undefined ? {} : { apiKind }),
    ...(status === undefined ? {} : { status }),
  })
}

let loggingQueue = Promise.resolve()
const enqueueLoggingUpdate = (update: () => Promise<void>) => {
  const result = loggingQueue.then(update)
  loggingQueue = result.catch(() => {}) // Report failures to the caller without poisoning later writes.
  return result
}

export const synchronizeNativeDiagnostics = () => enqueueLoggingUpdate(async () => {
  if (isAndroid()) {
    // Read at execution, not scheduling: a preceding toggle may have changed the preference.
    await nativeCall('setDiagnosticsEnabled', { enabled })
  }
})

export const setDiagnosticLogging = (value: boolean) => enqueueLoggingUpdate(async () => {
  if (isAndroid()) {
    await nativeCall('setDiagnosticsEnabled', { enabled: value })
  }
  enabled = value
  try { localStorage.setItem(ENABLED_KEY, String(value)) } catch { persistent = false }
  flushDiagnostics()
  for (const listener of subscribers) { listener() }
})

export const clearDiagnostics = async () => {
  if (isAndroid()) { await nativeCall('clearDiagnostics') }
  buffer.clear()
  flushDiagnostics()
}

export const setupDiagnostics = () => {
  if (installed) { return }
  installed = true
  diagnostic('app.start', {
    secureContext: window.isSecureContext,
    mediaAvailable: typeof navigator.mediaDevices?.getUserMedia === 'function',
    audioAvailable: typeof AudioContext === 'function',
  })
  window.addEventListener('error', (event) => diagnosticError('app.error', event.error))
  window.addEventListener('unhandledrejection', (event) => diagnosticError('app.rejection', event.reason))
  window.addEventListener('android-background', () => {
    diagnostic('app.background')
    flushDiagnostics()
  })
  document.addEventListener('visibilitychange', () => { if (document.hidden) { flushDiagnostics() } })
  window.addEventListener('pagehide', flushDiagnostics)
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Extract only bounded compatibility metadata. Never dump the bridge response wholesale. */
const nativeSnapshot = (value: unknown) => {
  const native = asRecord(value)
  const version = (input: unknown) => typeof input === 'string' && /^\d+(?:\.\d+){1,5}$/.test(input) && input.length <= 40
    ? input : 'unknown'
  const integer = (input: unknown, max: number) => typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 && input <= max ? input : null
  return {
    available: typeof native.androidSdk === 'number',
    versionName: version(native.versionName),
    versionCode: integer(native.versionCode, 1_000_000_000),
    androidSdk: integer(native.androidSdk, 1000),
    webViewVersion: version(native.webViewVersion),
    microphoneGranted: typeof native.microphoneGranted === 'boolean' ? native.microphoneGranted : null,
    audioSettingsGranted: typeof native.audioSettingsGranted === 'boolean' ? native.audioSettingsGranted : null,
    enabled: typeof native.enabled === 'boolean' ? native.enabled : null,
    events: Array.isArray(native.events) ? native.events.slice(-128).map(sanitizeEvent).filter((entry) => entry !== null) : [],
  }
}

export const diagnosticArchive = async (): Promise<{ name: string; blob: Blob }> => {
  diagnostic('logs.export')
  flushDiagnostics()
  let native: unknown = null
  let nativeReadFailed = false
  if (isAndroid()) {
    try { native = await nativeCall('getDiagnostics') } catch { nativeReadFailed = true }
  }
  const now = new Date()
  const chrome = /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent)
  const data = {
    formatVersion: 1,
    exportedAt: now.toISOString(),
    privacy: 'Metadata only. No API keys, authorization headers, URLs, chat, transcript, audio, file names or raw error messages/stacks are recorded.',
    web: {
      loggingEnabled: enabled,
      persistent,
      secureContext: window.isSecureContext,
      chromiumMajor: chrome ? Number(chrome[1]) : null,
      mediaAvailable: typeof navigator.mediaDevices?.getUserMedia === 'function',
      audioAvailable: typeof AudioContext === 'function',
      events: buffer.snapshot(),
    },
    nativeReadFailed,
    native: nativeSnapshot(native),
  }
  return {
    name: `ds-api-chat-logs-${now.toISOString().replace(/[:.]/g, '-')}.json`,
    blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  }
}
