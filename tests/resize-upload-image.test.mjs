import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isUploadImageOversized, resizeUploadImage } from '../src/utils/resizeUploadImage.ts'

function browser(t, { width, height, decode, encode } = {}) {
  const state = { revoked: [], draws: [], removed: false }
  t.mock.method(URL, 'createObjectURL', () => 'blob:fixture')
  t.mock.method(URL, 'revokeObjectURL', (url) => state.revoked.push(url))
  const previousImage = globalThis.Image
  globalThis.Image = class {
    constructor() {
      this.naturalWidth = width
      this.naturalHeight = height
    }
    decode() { return decode ? decode() : Promise.resolve() }
    removeAttribute() { state.removed = true }
  }
  t.after(() => { globalThis.Image = previousImage })
  t.mock.method(document, 'createElement', () => {
    const canvas = {
      getContext: () => ({ drawImage: (_image, ...args) => state.draws.push(args) }),
      toBlob: (callback, type) => {
        state.type = type
        if (encode) encode(callback)
        else callback(new Blob(['copy'], { type }))
      },
    }
    state.canvas = canvas
    return canvas
  })
  return state
}

globalThis.Image = function () {}
globalThis.document = { createElement() {} }
const original = new File(['original'], 'camera.webp', { type: 'image/webp', lastModified: 1234 })

test('4096 pixels is inclusive; passing the check alone does not encode', async (t) => {
  const state = browser(t, { width: 54, height: 4096 })
  assert.equal(await isUploadImageOversized(original), false)
  assert.equal(await resizeUploadImage(original), original)
  assert.deepEqual(state.draws, [])
  assert.deepEqual(state.revoked, ['blob:fixture', 'blob:fixture'])
})

test('portrait and narrow images preserve ratio and never round to zero', async (t) => {
  const state = browser(t, { width: 1, height: 8192 })
  assert.equal(await isUploadImageOversized(original), true)
  const result = await resizeUploadImage(original)
  assert.deepEqual(state.draws, [[0, 0, 1, 4096]])
  assert.equal(result.type, 'image/webp')
  assert.equal(result.name, 'camera.webp')
  assert.equal(result.lastModified, original.lastModified)
  assert.equal(await result.text(), 'copy')
  assert.equal(await original.text(), 'original')
  assert.equal(state.canvas.height, 0)
})

test('landscape upload uses the real output format when the encoder falls back', async (t) => {
  const state = browser(t, { width: 5000, height: 3000, encode: (done) => done(new Blob(['png'], { type: 'image/png' })) })
  const result = await resizeUploadImage(original)
  assert.deepEqual(state.draws, [[0, 0, 4096, 2458]])
  assert.equal(state.type, 'image/webp')
  assert.equal(result.name, 'camera.png')
  assert.equal(result.type, 'image/png')
  assert.equal(state.canvas.width, 0)
})

test('unreadable dimensions are not mistaken for an in-limit image and release the URL', async (t) => {
  const state = browser(t, { width: 0, height: 0 })
  assert.equal(await isUploadImageOversized(original), null)
  assert.equal(await resizeUploadImage(original), null)
  assert.deepEqual(state.draws, [])
  assert.deepEqual(state.revoked, ['blob:fixture', 'blob:fixture'])
})

test('abort after decoding starts prevents encoding and releases the URL', async (t) => {
  let resolve
  const state = browser(t, { width: 4097, height: 8, decode: () => new Promise((done) => { resolve = done }) })
  const controller = new AbortController()
  const operation = resizeUploadImage(original, controller.signal)
  controller.abort()
  resolve()
  await assert.rejects(operation, { name: 'AbortError' })
  assert.equal(state.removed, true)
  assert.deepEqual(state.draws, [])
  assert.deepEqual(state.revoked, ['blob:fixture'])
})

test('a cancelled encode cannot return an upload file and releases the canvas', async (t) => {
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const state = browser(t, { width: 4097, height: 8, encode: started })
  const controller = new AbortController()
  const operation = resizeUploadImage(original, controller.signal)
  const finish = await ready
  controller.abort()
  finish(new Blob(['late'], { type: 'image/webp' }))
  await assert.rejects(operation, { name: 'AbortError' })
  assert.equal(state.canvas.width, 0)
  assert.equal(state.canvas.height, 0)
})
