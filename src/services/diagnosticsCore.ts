/** Privacy boundary: accept only fixed events and primitive, explicitly allowed detail values. */
export type DiagnosticEvent = {
  t: number
  event: string
  details: Record<string, number | boolean | string>
}

const MAX_EVENTS = 256
const MAX_SERIALIZED_CHARS = 65_536
const MAX_HISTORY_BYTES = 128 * 1024
const MAX_NUMBER = 1e12

const EVENTS = new Set([
  'app.start', 'app.error', 'app.rejection', 'app.background',
  'audio.permission.request', 'audio.permission.granted', 'audio.permission.error',
  'audio.context.ready', 'audio.context.state', 'audio.context.error',
  'audio.capture.start', 'audio.capture.stop', 'audio.capture.cancel',
  'audio.capture.empty', 'audio.capture.stall', 'audio.capture.limit',
  'voice.start', 'voice.stop', 'voice.cancel', 'voice.error',
  'asr.start', 'asr.success', 'asr.error', 'asr.cancel',
  'api.start', 'api.response', 'api.error', 'api.cancel', 'logs.export',
  'native.start', 'native.permission.request', 'native.permission.result',
  'native.permission.cancel', 'native.lifecycle.pause', 'native.lifecycle.stop',
  'native.lifecycle.resume', 'native.renderer.gone', 'native.bridge.error', 'native.webview',
])

const NUMBER_KEYS = [
  'durationMs', 'elapsedMs', 'inputRate', 'outputRate', 'frames', 'samples',
  'bytes', 'status', 'count', 'androidSdk', 'webViewMajor',
] as const
const BOOLEAN_KEYS = [
  'granted', 'pending', 'crashed', 'enabled', 'secureContext', 'mediaAvailable', 'audioAvailable',
] as const
const ENUM_VALUES: Record<string, ReadonlySet<string>> = {
  api: new Set(['models', 'messages', 'files', 'asr', 'tts', 'unknown']),
  method: new Set(['GET', 'POST', 'DELETE', 'OTHER']),
  contextState: new Set(['running', 'suspended', 'interrupted', 'closed', 'unknown']),
  errorName: new Set([
    'Error', 'TypeError', 'RangeError', 'DOMException', 'AbortError', 'NotAllowedError',
    'NotFoundError', 'NotReadableError', 'SecurityError', 'NotSupportedError',
    'InvalidStateError', 'OverconstrainedError', 'TimeoutError', 'NativeError', 'ApiError',
    'SecurityException', 'IllegalArgumentException', 'IllegalStateException', 'JSONException',
    'IOException', 'GeneralSecurityException', 'RuntimeException', 'Exception', 'unknown',
  ]),
  apiKind: new Set(['http', 'network', 'protocol', 'interrupted', 'stream', 'abort', 'unknown']),
  reason: new Set([
    'user', 'background', 'unmount', 'limit', 'start_failure', 'no_samples',
    'stalled', 'timeout', 'permission_denied', 'other',
  ]),
  source: new Set(['js', 'native']),
}

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Do not invoke getters, inherit polluted fields, stringify objects or coerce arbitrary input. */
const ownValue = (value: object, key: string): unknown =>
  Object.getOwnPropertyDescriptor(value, key)?.value

export const sanitizeEvent = (input: unknown): DiagnosticEvent | null => {
  try {
    if (!isObject(input)) {
      return null
    }
    const event = ownValue(input, 'event')
    const t = ownValue(input, 't')
    if (
      typeof event !== 'string' || !EVENTS.has(event) ||
      typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > Number.MAX_SAFE_INTEGER
    ) {
      return null
    }
    const details: DiagnosticEvent['details'] = {}
    const raw = ownValue(input, 'details')
    if (isObject(raw)) {
      for (const key of NUMBER_KEYS) {
        const value = ownValue(raw, key)
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_NUMBER) {
          details[key] = value
        }
      }
      for (const key of BOOLEAN_KEYS) {
        const value = ownValue(raw, key)
        if (typeof value === 'boolean') {
          details[key] = value
        }
      }
      for (const [key, values] of Object.entries(ENUM_VALUES)) {
        const value = ownValue(raw, key)
        if (typeof value === 'string' && values.has(value)) {
          details[key] = value
        }
      }
    }
    return { t, event, details }
  } catch {
    // Revoked proxies or throwing property-descriptor traps must fail closed, not break recording.
    return null
  }
}

type BufferedEvent = { value: DiagnosticEvent; size: number }

/** Oldest events are evicted first; serialized output is a JSON array, never an arbitrary envelope. */
export class DiagnosticBuffer {
  #entries: BufferedEvent[] = []
  #serializedLength = 2 // JSON array brackets, including when empty.

  constructor(serialized?: string) {
    if (typeof serialized !== 'string' || serialized.length > MAX_HISTORY_BYTES) {
      return
    }
    // The input limit is bytes, not UTF-16 code units. Check length first to bound this allocation.
    if (new TextEncoder().encode(serialized).byteLength > MAX_HISTORY_BYTES) {
      return
    }
    try {
      const history: unknown = JSON.parse(serialized)
      if (Array.isArray(history)) {
        for (const input of history) {
          const event = sanitizeEvent(input)
          if (event) {
            this.#append(event)
          }
        }
      }
    } catch {
      // Invalid/obsolete storage is treated as empty; never retain or log its contents.
    }
  }

  record(event: string, details?: Record<string, unknown>, t = Date.now()): void {
    const value = sanitizeEvent({ t, event, details })
    if (value) {
      this.#append(value)
    }
  }

  #append(value: DiagnosticEvent): void {
    const size = JSON.stringify(value).length
    this.#serializedLength += size + (this.#entries.length ? 1 : 0)
    this.#entries.push({ value, size })
    while (this.#entries.length > MAX_EVENTS || this.#serializedLength > MAX_SERIALIZED_CHARS) {
      const removed = this.#entries.shift()
      if (removed) {
        this.#serializedLength -= removed.size + (this.#entries.length ? 1 : 0)
      }
    }
  }

  clear(): void {
    this.#entries = []
    this.#serializedLength = 2
  }

  snapshot(): DiagnosticEvent[] {
    return this.#entries.map(({ value }) => ({ ...value, details: { ...value.details } }))
  }

  serialize(): string {
    return JSON.stringify(this.#entries.map(({ value }) => value))
  }
}
