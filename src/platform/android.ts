/** Small, origin-scoped Android RPC bridge. No native runtime is bundled in the web build. */
type NativeBridge = {
  postMessage: (message: string) => void
  onmessage: ((event: { data: string }) => void) | null
}

declare global {
  interface Window {
    DeepSeekAndroid?: NativeBridge
    __deepseekAndroidBack?: () => boolean
    __deepseekAndroidBackground?: () => void
  }
}

type Reply = { id: string; ok: boolean; value?: unknown; error?: string | { code?: string; message?: string } }
const pending = new Map<string, {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()
let sequence = 0
let nativeApiKey: string | null = null

export const isAndroid = (): boolean => typeof window !== 'undefined' && !!window.DeepSeekAndroid
export const getNativeApiKey = () => nativeApiKey

export class NativeError extends Error {
  readonly code: string
  constructor(message: string, code = '') {
    super(message)
    this.code = code
    this.name = 'NativeError'
  }
}

export const nativeCall = <T = void>(
  action: string,
  args: Record<string, unknown> = {},
  timeout = 30_000
): Promise<T> => new Promise((resolve, reject) => {
  const bridge = window.DeepSeekAndroid
  if (!bridge) {
    reject(new NativeError('Android bridge unavailable'))
    return
  }
  const id = String(++sequence)
  const timer = setTimeout(() => {
    pending.delete(id)
    reject(new NativeError('Android operation timed out'))
  }, timeout)
  pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
  try {
    bridge.postMessage(JSON.stringify({ ...args, id, action }))
  } catch (error) {
    clearTimeout(timer)
    pending.delete(id)
    reject(error)
  }
})

/** Must finish before importing settings/App: never initialize an Android key from localStorage. */
export const initializeAndroid = async (): Promise<void> => {
  const bridge = window.DeepSeekAndroid
  if (!bridge) {
    return
  }
  bridge.onmessage = ({ data }) => {
    let reply: Reply
    try {
      reply = JSON.parse(data) as Reply
    } catch {
      return
    }
    const entry = pending.get(reply.id)
    if (!entry || typeof reply.ok !== 'boolean') {
      return
    }
    pending.delete(reply.id)
    clearTimeout(entry.timer)
    if (reply.ok) {
      entry.resolve(reply.value)
    } else {
      const error = reply.error
      entry.reject(new NativeError(
        typeof error === 'string' ? error : error?.message || 'Android operation failed',
        typeof error === 'object' ? error.code : undefined
      ))
    }
  }
  const key = await nativeCall<unknown>('getKey')
  if (key !== null && typeof key !== 'string') {
    throw new NativeError('Invalid key storage response')
  }
  nativeApiKey = key
  // One-time migration for older app builds. Never erase the only copy before native save succeeds.
  const oldKey = localStorage.getItem('chat-demo:api-key')
  if (!nativeApiKey && oldKey) {
    await saveNativeApiKey(oldKey)
  }
  localStorage.removeItem('chat-demo:api-key')
  document.documentElement.dataset.android = 'true'
}

export const saveNativeApiKey = async (value: string | null): Promise<void> => {
  await nativeCall('setKey', { value })
  nativeApiKey = value
}

export const isSaveCancelled = (error: unknown) =>
  error instanceof NativeError && (error.message === 'cancelled' || error.code.toLowerCase() === 'cancelled')

/** SAF writes one 48 KiB block at a time; never base64-encode a whole attachment or ZIP. */
export const saveBlob = async (blob: Blob, name: string): Promise<void> => {
  if (!isAndroid()) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return
  }
  const token = await nativeCall<string>('saveBegin', {
    name, mime: blob.type || 'application/octet-stream',
  }, 600_000)
  try {
    const chunkSize = 48 * 1024
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      await nativeCall('saveChunk', { token, data: btoa(binary) })
    }
    await nativeCall('saveEnd', { token })
  } catch (error) {
    await nativeCall('saveCancel', { token }).catch(() => {})
    throw error
  }
}
