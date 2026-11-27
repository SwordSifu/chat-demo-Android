import { expect, test } from '@playwright/test'

const capture = 'chatdemo-capture-0123456789abcdef0123456789abcdef.jpg'
const button = (page, name) => page.getByRole('button', { name, exact: true })
const field = (page) => page.getByPlaceholder('请输入消息')
const panel = (page) => page.getByRole('group', { name: '添加附件', exact: true })

async function setup(page) {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript((capture) => {
    window.__pickerCalls = []
    window.__rejectSessionSave = false
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'sessions' && window.__rejectSessionSave) {
        throw new DOMException('synthetic quota failure', 'QuotaExceededError')
      }
      return put.apply(this, args)
    }
    const native = window.DeepSeekAndroid = {
      onmessage: null,
      postMessage(raw) {
        const { id, action, name } = JSON.parse(raw)
        if (action === 'retainCapturedPhoto' || action === 'releaseCapturedPhoto') {
          window.__pickerCalls.push([action, name])
        }
        const value = action === 'getKey' ? 'synthetic-key' : name === capture
        queueMicrotask(() => native.onmessage?.({ data: JSON.stringify({ id, ok: true, value }) }))
      },
    }
  }, capture)
  let uploads = 0
  await page.route('https://api.deepseek.com/**', (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': '*' }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    const path = new URL(route.request().url()).pathname
    if (path === '/anthropic/v1/files') return route.fulfill({ headers, json: { id: `fixture-${++uploads}` } })
    if (path === '/models') return route.fulfill({ headers, json: { data: [{ id: 'deepseek-flash' }] } })
    return route.fulfill({ status: 400, headers, json: { error: { message: 'synthetic response' } } })
  })
  await page.goto('/')
  await expect(field(page)).toBeVisible()
  return () => uploads
}

async function choose(page, action) {
  await button(page, '添加附件').click()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button(panel(page), action).click()])
  await expect(panel(page)).toHaveCount(0)
  return chooser
}

async function cameraFixture(page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 384
    canvas.getContext('2d').fillRect(0, 0, 512, 384)
    return canvas.toDataURL('image/jpeg').split(',')[1]
  })
  return { name: capture, mimeType: 'image/jpeg', buffer: Buffer.from(data, 'base64') }
}

const calls = (page) => page.evaluate(() => window.__pickerCalls)

test('Android attachment panel does not open a picker until a source is chosen', async ({ page }) => {
  const uploads = await setup(page)
  let pickerCount = 0
  page.on('filechooser', () => pickerCount++)
  await field(page).fill('草稿保留')
  await button(page, '添加附件').click()
  await expect(panel(page)).toBeVisible()
  await expect(button(page, '收起附件')).toHaveAttribute('aria-expanded', 'true')
  expect(pickerCount).toBe(0)
  expect(await page.evaluate(() => window.__deepseekAndroidBack())).toBe(true)
  await expect(panel(page)).toHaveCount(0)
  await expect(field(page)).toHaveValue('草稿保留')
  const gallery = await choose(page, '相册')
  expect(gallery.isMultiple()).toBe(true)
  expect(await gallery.element().getAttribute('accept')).toBe('image/*')
  await gallery.setFiles([])
  const files = await choose(page, '文件')
  expect(files.isMultiple()).toBe(true)
  expect(await files.element().getAttribute('accept')).toContain('.pdf')
  await files.setFiles([])
  const camera = await choose(page, '拍照')
  expect(camera.isMultiple()).toBe(false)
  expect(await camera.element().getAttribute('capture')).toBe('environment')
  await camera.setFiles([])
  expect(await calls(page)).toEqual([])
  expect(uploads()).toBe(0)
})

test('selected camera drafts use a compact preview and release only on discard', async ({ page }) => {
  const uploads = await setup(page)
  const fixture = await cameraFixture(page)
  await (await choose(page, '拍照')).setFiles(fixture)
  await expect.poll(() => uploads()).toBe(1)
  const image = page.getByAltText(capture, { exact: true })
  await expect.poll(() => image.evaluate((img) => img.naturalWidth)).toBe(128)
  await button(page, capture).click()
  const preview = page.getByRole('dialog', { name: capture, exact: true })
  await expect.poll(() => preview.getByAltText(capture).evaluate((img) => img.naturalWidth)).toBe(512)
  await button(preview, '关闭').click()
  await button(page, '添加附件').click()
  await expect(panel(page).getByAltText(capture, { exact: true })).toBeVisible()
  await expect.poll(() => calls(page)).toEqual([['retainCapturedPhoto', capture]])
  await button(panel(page), '删除').click()
  await expect.poll(() => calls(page)).toEqual([['retainCapturedPhoto', capture], ['releaseCapturedPhoto', capture]])
  await expect(image).toHaveCount(0)
})

test('a failed history save retains the camera original; retry commits exact bytes before release', async ({ page }) => {
  await setup(page)
  const fixture = await cameraFixture(page)
  await (await choose(page, '拍照')).setFiles(fixture)
  const send = button(page, '发送')
  await expect(send).toHaveAttribute('aria-disabled', 'false')
  await page.evaluate(() => { window.__rejectSessionSave = true })
  await send.click()
  const saveError = page.getByRole('alert').filter({ has: button(page, '重试') })
  await expect(saveError).toBeVisible()
  expect(await calls(page)).toEqual([['retainCapturedPhoto', capture]])
  await page.evaluate(() => { window.__rejectSessionSave = false })
  await button(saveError, '重试').click()
  await expect.poll(() => calls(page)).toEqual([['retainCapturedPhoto', capture], ['releaseCapturedPhoto', capture]])
  const files = await page.evaluate(async () => {
    const read = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const db = await read(indexedDB.open('chat-demo'))
    try {
      const rows = await read(db.transaction('files').objectStore('files').getAll())
      return Promise.all(rows.map(async ({ blob }) => [...new Uint8Array(await blob.arrayBuffer())]))
    } finally { db.close() }
  })
  expect(files).toEqual([[...fixture.buffer]])
})
