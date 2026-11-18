import test from 'node:test'
import assert from 'node:assert/strict'
import { ServerSentEventDecoder, readServerSentEvents } from '../src/services/api/sse.ts'
import { readMessageEvent } from '../src/services/api/parseEvent.ts'
import { handleAndroidBack, registerBackHandler } from '../src/platform/back.ts'
import { getSafeExternalUrl } from '../src/utils/urls.ts'

let moduleId = 0
async function nativeFixture({ key = null, legacy = null, failSave = false, cancelSave = false } = {}) {
  const values = new Map(legacy ? [['chat-demo:api-key', legacy]] : [])
  const calls = []
  const blocks = []
  const bridge = {
    onmessage: null,
    postMessage(raw) {
      const request = JSON.parse(raw)
      calls.push(request)
      let value = null
      let error
      switch (request.action) {
        case 'getKey': value = key; break
        case 'setKey':
          if (failSave) error = { code: 'native_error', message: 'Keystore unavailable' }
          else key = request.value
          break
        case 'saveBegin':
          if (cancelSave) error = { code: 'cancelled', message: 'Save cancelled' }
          else value = 'test-session'
          break
        case 'saveChunk': blocks.push(Buffer.from(request.data, 'base64')); break
      }
      queueMicrotask(() => bridge.onmessage?.({ data: JSON.stringify({ id: request.id, ok: !error, value, error }) }))
    },
  }
  globalThis.window = { DeepSeekAndroid: bridge }
  globalThis.localStorage = {
    getItem: (name) => values.get(name) ?? null,
    removeItem: (name) => values.delete(name),
  }
  globalThis.document = { documentElement: { dataset: {} } }
  const api = await import(`../src/platform/android.ts?test=${++moduleId}`)
  return { api, values, calls, blocks, bridge }
}

test('source URLs accept absolute HTTP(S) only and reject ambiguous or active schemes', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///sdcard/test', 'content://media/1', 'intent://test', '//example.org', '/local', 'https://user:password@example.org/', 'https://example.org/with space', 'https://example.org/\\npath', 'https:\\\\evil.org', 'blob:https://example.org/1', '', 'about:blank']) {
    assert.equal(getSafeExternalUrl(url), undefined, url)
  }
  assert.equal(getSafeExternalUrl('https://example.org/a?q=1#b'), 'https://example.org/a?q=1#b')
  assert.equal(getSafeExternalUrl('http://example.org'), 'http://example.org/')
})

test('SSE handles split CRLF, multiline data, comments and IDs', () => {
  const decoder = new ServerSentEventDecoder()
  assert.deepEqual(decoder.push(': ping\r\nid: 7\r\nevent: delta\r\ndata: first\r'), [])
  assert.deepEqual(decoder.push('\ndata: second\r\n\r\n'), [{ event: 'delta', data: 'first\nsecond', lastEventId: '7' }])
  assert.deepEqual(decoder.push('data: incomplete'), [])
  assert.deepEqual(decoder.end(), [])
})

test('SSE decodes Chinese UTF-8 at every byte boundary', async () => {
  const bytes = new TextEncoder().encode('data: 中文🙂\n\n')
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
    controller.close()
  } })
  const events = []
  for await (const event of readServerSentEvents(stream)) events.push(event.data)
  assert.deepEqual(events, ['中文🙂'])
})

test('SSE early return cancels and unlocks the upstream reader', async () => {
  let cancelled = false
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: one\n\ndata: two\n\n'))
  }, cancel() { cancelled = true } })
  for await (const event of readServerSentEvents(stream)) { assert.equal(event.data, 'one'); break }
  assert.equal(cancelled, true)
  assert.equal(stream.locked, false)
})

test('SSE abort cancels a pending body read', async () => {
  let cancelled = false
  const controller = new AbortController()
  const stream = new ReadableStream({ cancel() { cancelled = true } })
  const iterator = readServerSentEvents(stream, controller.signal)
  const next = iterator.next()
  controller.abort()
  assert.equal((await next).done, true)
  assert.equal(cancelled, true)
  assert.equal(stream.locked, false)
})

test('protocol ignores malformed blocks but retains supported thinking/text events', () => {
  assert.equal(readMessageEvent({ type: 'content_block_start', index: -1, content_block: { type: 'text', text: 'x' } }), null)
  assert.equal(readMessageEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 42 } }), null)
  assert.equal(readMessageEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '思考' } }).content_block.thinking, '思考')
})

test('Android back closes the topmost highest-priority layer only', () => {
  const seen = []
  const base = registerBackHandler(() => { seen.push('base'); return true })
  const modal = registerBackHandler(() => { seen.push('modal'); return true }, 10)
  const menu = registerBackHandler(() => { seen.push('menu'); return true }, 20)
  assert.equal(handleAndroidBack(), true)
  assert.deepEqual(seen, ['menu'])
  menu(); modal(); base()
  assert.equal(handleAndroidBack(), false)
})

test('simulated Android reads native key without writing plaintext storage', async () => {
  const { api, values, calls } = await nativeFixture({ key: 'test-key-not-real' })
  await api.initializeAndroid()
  assert.equal(api.getNativeApiKey(), 'test-key-not-real')
  assert.equal(values.size, 0)
  assert.deepEqual(calls.map((x) => x.action), ['getKey'])
  await api.saveNativeApiKey('replacement-test-key')
  assert.equal(api.getNativeApiKey(), 'replacement-test-key')
  assert.equal(values.size, 0)
})

test('legacy migration removes plaintext only after native save succeeds', async () => {
  const { api, values, calls } = await nativeFixture({ legacy: 'old-test-key' })
  await api.initializeAndroid()
  assert.equal(api.getNativeApiKey(), 'old-test-key')
  assert.equal(values.size, 0)
  assert.deepEqual(calls.map((x) => x.action), ['getKey', 'setKey'])
})

test('Keystore failure rejects initialization without erasing the legacy key', async () => {
  const { api, values } = await nativeFixture({ legacy: 'old-test-key', failSave: true })
  await assert.rejects(api.initializeAndroid(), /Keystore unavailable/)
  assert.equal(values.get('chat-demo:api-key'), 'old-test-key')
  assert.equal(api.getNativeApiKey(), null)
})

test('large simulated export uses bounded sequential chunks and roundtrips exactly', async () => {
  const { api, calls, blocks } = await nativeFixture()
  await api.initializeAndroid()
  const bytes = new Uint8Array(160_001)
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
  await api.saveBlob(new Blob([bytes]), 'test.zip')
  assert.equal(calls.filter((x) => x.action === 'saveChunk').length, 4)
  assert.ok(blocks.every((block) => block.byteLength <= 48 * 1024))
  assert.deepEqual(Buffer.concat(blocks), Buffer.from(bytes))
  assert.equal(calls.at(-1).action, 'saveEnd')
})

test('cancelled native file picker sends no file chunks or false success', async () => {
  const { api, calls } = await nativeFixture({ cancelSave: true })
  await api.initializeAndroid()
  await assert.rejects(api.saveBlob(new Blob(['abc']), 'test.zip'), (error) => api.isSaveCancelled(error))
  assert.equal(calls.filter((x) => x.action === 'saveChunk' || x.action === 'saveEnd').length, 0)
})

test('missing Android bridge rejects sensitive operations instead of falling back', async () => {
  const { api } = await nativeFixture()
  window.DeepSeekAndroid = undefined
  await assert.rejects(api.nativeCall('setKey', { value: 'test' }), /unavailable/)
})
