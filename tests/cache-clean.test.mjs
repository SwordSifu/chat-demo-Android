import assert from 'node:assert/strict'
import test from 'node:test'
import { clearWebViewCache, initializeAndroid, NativeError } from '../src/platform/android.ts'

test('WebView cache RPC sends no arguments and keeps native success and failure distinct', async (t) => {
  const requests = []
  const bridge = {
    onmessage: null,
    postMessage(raw) {
      const request = JSON.parse(raw)
      requests.push(request)
      if (request.action === 'getKey') queueMicrotask(() => reply({ id: request.id, ok: true, value: null }))
    },
  }
  const reply = (value) => bridge.onmessage({ data: JSON.stringify(value) })
  for (const [key, value] of Object.entries({
    window: { DeepSeekAndroid: bridge },
    localStorage: { getItem: () => null, removeItem() {} },
    document: { documentElement: { dataset: {} } },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key])
  }
  await initializeAndroid()

  const success = clearWebViewCache()
  const first = requests.at(-1)
  assert.deepEqual(first, { id: first.id, action: 'clearWebViewCache' })
  reply({ id: first.id, ok: true, value: null })
  assert.equal(await success, undefined)

  const failure = clearWebViewCache()
  const second = requests.at(-1)
  assert.deepEqual(second, { id: second.id, action: 'clearWebViewCache' })
  assert.notEqual(second.id, first.id)
  reply({ id: second.id, ok: false, error: { code: 'native_error', message: 'Simulated WebView error' } })
  await assert.rejects(failure, (error) => error instanceof NativeError && error.code === 'native_error')
  assert.deepEqual(requests.map(({ action }) => action), ['getKey', 'clearWebViewCache', 'clearWebViewCache'])
})
