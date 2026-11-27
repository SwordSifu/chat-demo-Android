import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const key = 'fixture-key-not-real'
const title = '附件操作样本'
const raster = { name: 'broken.PNG', mimeType: 'text/plain', buffer: Buffer.from('undecodable test image') }
const svg = {
  name: 'shape.SVG', mimeType: 'application/octet-stream',
  buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'),
}
const pdf = { name: 'report.PDF', mimeType: 'image/png', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') }
const other = { name: 'notes.txt', mimeType: 'image/jpeg', buffer: Buffer.from('local notes only') }
const fixtures = [raster, svg, pdf, other]
const missingName = 'missing.png'

async function setup(page, android) {
  await page.addInitScript(({ android, key }) => {
    const create = URL.createObjectURL
    const revoke = URL.revokeObjectURL
    window.__attachmentObjectURLs = {}
    window.__attachmentRevocations = []
    URL.createObjectURL = function (blob) {
      const url = create.call(this, blob)
      window.__attachmentObjectURLs[url] = blob.type
      return url
    }
    URL.revokeObjectURL = function (url) {
      window.__attachmentRevocations.push(url)
      return revoke.call(this, url)
    }
    if (!android) {
      localStorage.setItem('chat-demo:api-key', key)
      return
    }
    window.__attachmentSaves = []
    const bridge = {
      onmessage: null,
      postMessage(raw) {
        const { id, action, name, mime, data } = JSON.parse(raw)
        let value = null
        let current = window.__attachmentSaves.at(-1)
        if (action === 'getKey') value = key
        if (action === 'saveBegin') {
          current = { name, mime, chunks: [], done: false }
          window.__attachmentSaves.push(current)
          value = 'test-save-token'
        }
        if (action === 'saveChunk') current.chunks.push(data)
        if (action === 'saveEnd') current.done = true
        queueMicrotask(() => bridge.onmessage?.({ data: JSON.stringify({ id, ok: true, value }) }))
      },
    }
    window.DeepSeekAndroid = bridge
  }, { android, key })
  let nextId = 0
  await page.route('https://api.deepseek.com/**', (route) => {
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': '*',
    }
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (path === '/models') return route.fulfill({ headers, json: { object: 'list', data: [{ id: 'deepseek-flash' }] } })
    if (path === '/anthropic/v1/files') return route.fulfill({ headers, json: { id: `file-fixture-${++nextId}` } })
    return route.abort()
  })
  await page.goto('/')
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
}

async function showFiles(page, draft) {
  if (draft) {
    await page.locator('input[type=file][multiple]:not([accept="image/*"])').setInputFiles(fixtures)
    return
  }
  await page.evaluate(async ({ files, title, missingName }) => {
    const open = indexedDB.open('chat-demo')
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    try {
      const now = Date.now()
      const summary = { id: 'fixture-session', title, createdAt: now, updatedAt: now }
      const tx = db.transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
      const attachments = files.map(({ name, mimeType, data }, i) => {
        const id = `fixture-file-${i}`
        const blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mimeType })
        tx.objectStore('files').put({ id, blob })
        return { id, name, size: blob.size, mimeType, isImage: mimeType.startsWith('image/'), serverId: `remote-${i}` }
      })
      attachments.push({ id: 'missing', name: missingName, size: 12, mimeType: 'image/png', isImage: true, serverId: null })
      tx.objectStore('sessions').put({ ...summary, rootMessageId: 'fixture-message', messages: [{
        id: 'fixture-message', parentId: null, createdAt: now, role: 'user', content: '本机附件', files: attachments,
      }] })
      tx.objectStore('sessionSummaries').put({ ...summary, fileIds: attachments.map((attachment) => attachment.id) })
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }, {
    files: fixtures.map(({ name, mimeType, buffer }) => ({ name, mimeType, data: buffer.toString('base64') })),
    title, missingName,
  })
  await page.reload()
  const open = page.getByRole('button', { name: '打开边栏', exact: true })
  const session = page.getByText(title, { exact: true })
  await expect(open.or(session).first()).toBeVisible()
  if (!(await session.isVisible())) await open.click()
  await session.click()
  await expect(page.getByText('本机附件', { exact: true })).toBeVisible()
}

const link = (page, { name }) => page.getByRole('link', { name, exact: true })
const button = (page, { name }) => page.getByRole('button', { name, exact: true })
const svgImage = (page) => page.getByAltText(svg.name, { exact: true })

async function expectSvgThumbnail(page) {
  await expect(svgImage(page)).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
  await expect.poll(() => svgImage(page).evaluate((image) => image.naturalWidth)).toBe(8)
}

async function expectBlobMime(page, fixture, mime) {
  const anchor = link(page, fixture)
  await expect(anchor).toHaveAttribute('href', /^blob:/)
  const url = await anchor.getAttribute('href')
  expect(await page.evaluate((url) => window.__attachmentObjectURLs[url], url)).toBe(mime)
  return url
}

async function expectNativeSave(page, fixture, mime) {
  const { name, buffer } = fixture
  await expect.poll(() => page.evaluate((name) => window.__attachmentSaves.find((entry) => entry.name === name && entry.done), name)).toMatchObject({ name, mime, done: true })
  const chunks = await page.evaluate((name) => window.__attachmentSaves.find((entry) => entry.name === name).chunks, name)
  expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')))).toEqual(buffer)
}

for (const draft of [true, false]) {
  const area = draft ? 'draft' : 'history'
  test(`browser ${area} types previewable blobs and downloads SVG and other files by name`, async ({ page }) => {
    await setup(page, false)
    await showFiles(page, draft)
    await expectSvgThumbnail(page)
    for (const [file, mime] of [[raster, 'image/png'], [pdf, 'application/pdf']]) {
      await expectBlobMime(page, file, mime)
      await expect(link(page, file)).toHaveAttribute('target', '_blank')
      await expect(link(page, file)).toHaveAttribute('rel', /\bnoopener\b/)
      await expect(link(page, file)).not.toHaveAttribute('download')
    }
    for (const file of [svg, other]) {
      await expectBlobMime(page, file, 'application/octet-stream')
      await expect(link(page, file)).toHaveAttribute('download', file.name)
      await expect(link(page, file)).not.toHaveAttribute('target')
      const [download] = await Promise.all([page.waitForEvent('download'), link(page, file).click()])
      expect(download.suggestedFilename()).toBe(file.name)
      expect(await readFile(await download.path())).toEqual(file.buffer)
    }
    if (draft) {
      const url = await link(page, raster).getAttribute('href')
      await page.getByTitle(raster.name, { exact: true }).getByRole('button', { name: '删除', exact: true }).click()
      await expect(link(page, raster)).toHaveCount(0)
      await expect.poll(() => page.evaluate((url) => window.__attachmentRevocations.includes(url), url)).toBe(true)
    } else {
      await expect(page.getByText(missingName, { exact: true })).toBeVisible()
      await expect(link(page, { name: missingName })).toHaveCount(0)
    }
  })

  test(`simulated Android ${area} previews raster locally and saves original bytes via SAF`, async ({ page }) => {
    await setup(page, true)
    await showFiles(page, draft)
    const mainPageUrl = page.url()
    await expectSvgThumbnail(page)
    await expect(link(page, raster)).toHaveCount(0)
    await button(page, raster).click()
    const dialog = page.getByRole('dialog', { name: raster.name, exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[role="img"]')).toHaveAccessibleName(raster.name)
    await expect(dialog.locator('a, iframe, object, embed')).toHaveCount(0)
    await dialog.getByRole('button', { name: '下载', exact: true }).click()
    await expectNativeSave(page, raster, 'image/png')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    for (const [file, mime] of [[svg, 'image/svg+xml'], [pdf, 'application/pdf'], [other, 'application/octet-stream']]) {
      await expect(link(page, file)).toHaveCount(0)
      await button(page, file).click()
      await expectNativeSave(page, file, mime)
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }
    if (!draft) {
      await expect(page.getByText(missingName, { exact: true })).toBeVisible()
      await expect(button(page, { name: missingName })).toHaveCount(0)
    }
    expect(page.url()).toBe(mainPageUrl)
    expect(page.context().pages()).toHaveLength(1)
  })
}
