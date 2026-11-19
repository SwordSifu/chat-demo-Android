import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getAttachmentViewMime,
  isAttachmentThumbnail,
  loadAttachmentView,
} from '../src/utils/attachmentPreview.ts'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'
const mimeType = (response) => response.headers.get('content-type')

function fakeFileReader(t, read) {
  const previous = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL(blob) { read(this, blob) }
    abort() { this.onabort() }
  }
  t.after(() => {
    if (previous === undefined) delete globalThis.FileReader
    else globalThis.FileReader = previous
  })
}

test('attachment viewing classifies only the final allowlisted filename extension', () => {
  for (const [name, mime] of [
    ['diagram.ApNg', 'image/png'], ['photo.JFIF', 'image/jpeg'], ['capture.avif', 'image/avif'],
    ['portrait.HEIF', 'image/heif'], ['shape.SvG', 'image/svg+xml'], ['report.pdf', 'application/pdf'],
    ['report.svgz', 'application/octet-stream'], ['photo.png.txt', 'application/octet-stream'],
    ['no-extension', 'application/octet-stream'], ['reference.constructor', 'application/octet-stream'],
  ]) {
    assert.equal(getAttachmentViewMime(name), mime)
    assert.equal(isAttachmentThumbnail(mime), mime.startsWith('image/'))
  }
})

test('browser tabs get explicit raster/PDF MIME; other originals download inertly', async () => {
  for (const [name, action, mime, thumbnail] of [
    ['photo.PNG', 'tab', 'image/png', true],
    ['report.PDF', 'tab', 'application/pdf', false],
    ['document.txt', 'download', 'application/octet-stream', false],
  ]) {
    const controller = new AbortController()
    const original = new Blob(['attachment test bytes'], { type: 'text/plain' })
    const view = await loadAttachmentView(() => original, name, false, controller.signal)
    assert.equal(view.action, action)
    assert.equal(view.thumbnail, thumbnail ? view.url : null)
    try {
      const response = await fetch(view.url)
      assert.equal(mimeType(response), mime)
      assert.equal(await response.text(), await original.text())
    } finally {
      controller.abort()
    }
    await assert.rejects(fetch(view.url))
  }
})

test('SVG thumbnail is a data URL; web download has a separate inert URL and original bytes', async (t) => {
  fakeFileReader(t, (reader, blob) => {
    void blob.arrayBuffer().then((bytes) => {
      assert.equal(blob.type, 'image/svg+xml')
      reader.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`
      reader.onload()
    })
  })
  const controller = new AbortController()
  try {
    const original = new Blob([svg], { type: 'application/octet-stream' })
    const view = await loadAttachmentView(() => original, 'shape.svg', false, controller.signal)
    assert.equal(view.action, 'download')
    assert.match(view.thumbnail, /^data:image\/svg\+xml;base64,/)
    assert.match(view.url, /^blob:/)
    const response = await fetch(view.url)
    assert.equal(mimeType(response), 'application/octet-stream')
    assert.equal(await response.text(), svg)
  } finally {
    controller.abort()
  }
})

test('failed or oversized SVG thumbnail conversion leaves a download/save action', async (t) => {
  let attempts = 0
  fakeFileReader(t, (reader) => { attempts++; queueMicrotask(() => reader.onerror()) })
  const controller = new AbortController()
  try {
    const oversized = new Blob([svg, ' '.repeat(512 * 1024)])
    const native = await loadAttachmentView(() => oversized, 'big.svg', true, controller.signal)
    assert.equal(native.action, 'save')
    assert.equal(native.thumbnail, null)
    assert.equal(native.file.size, oversized.size)
    assert.equal(attempts, 0)
    const web = await loadAttachmentView(() => new Blob([svg]), 'shape.svg', false, controller.signal)
    assert.equal(web.action, 'download')
    assert.equal(web.thumbnail, null)
    assert.equal(attempts, 1)
  } finally {
    controller.abort()
  }
})

test('Android actions retain original bytes and create no navigable URL for PDFs or other files', async () => {
  const controller = new AbortController()
  try {
    const undecodable = new Blob(['not actually a raster image'], { type: 'text/plain' })
    for (const [name, action, mime] of [
      ['broken.png', 'preview', 'image/png'],
      ['report.pdf', 'save', 'application/pdf'],
      ['other.txt', 'save', 'application/octet-stream'],
    ]) {
      const view = await loadAttachmentView(() => undecodable, name, true, controller.signal)
      assert.equal(view.action, action)
      assert.equal('url' in view, false)
      assert.equal(view.file.type, mime)
      assert.equal(await view.file.text(), await undecodable.text())
      if (action === 'preview') assert.match(view.thumbnail, /^blob:/)
      else assert.equal(view.thumbnail, null)
    }
  } finally {
    controller.abort()
  }
})

test('missing/failed reads fall back, stale reads and aborted thumbnail conversions never create object URLs', async (t) => {
  const createURL = t.mock.method(URL, 'createObjectURL')
  const live = new AbortController()
  assert.equal(await loadAttachmentView(() => undefined, 'fixture.png', false, live.signal), null)
  assert.equal(await loadAttachmentView(() => Promise.reject(new Error('read failed')), 'fixture.png', false, live.signal), null)

  const pending = new AbortController()
  const original = Promise.withResolvers()
  const load = loadAttachmentView(() => original.promise, 'fixture.png', false, pending.signal)
  pending.abort()
  original.resolve(new Blob(['late original']))
  assert.equal(await load, null)

  const readerStarted = Promise.withResolvers()
  const conversion = new AbortController()
  fakeFileReader(t, () => readerStarted.resolve())
  const svgView = loadAttachmentView(() => new Blob([svg]), 'shape.svg', false, conversion.signal)
  await readerStarted.promise
  conversion.abort()
  assert.equal(await svgView, null)
  assert.equal(createURL.mock.callCount(), 0)
})
