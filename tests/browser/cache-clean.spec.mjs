import { expect, test } from '@playwright/test'
import { historyFixture, pickHistoryFixture } from './history-fixture.mjs'

const settings = (page) => page.getByRole('dialog', { name: '设置', exact: true })
const confirmation = (page) => page.getByRole('dialog', { name: '确认清除缓存？', exact: true })
const cacheButton = (dialog) => dialog.getByRole('button', { name: '清除缓存', exact: true })
const importConfirmation = (page) => page.getByRole('dialog', { name: '确认导入历史对话？', exact: true })
const appResult = '已清除应用内存中 1 个对话的缓存。'
const nativeSuccess = '已清除 Android WebView 资源缓存。'
const nativeFailure = '无法清除 Android WebView 资源缓存，请重试。'

async function setup(page, baseURL, android = false) {
  await page.route(/^https?:\/\//, (route) => new URL(route.request().url()).origin === new URL(baseURL).origin
    ? route.continue()
    : route.abort())
  await page.addInitScript((android) => {
    const key = 'sk-cache-clean-test-only'
    if (!android) localStorage.setItem('chat-demo:api-key', key)
    localStorage.setItem('chat-demo:theme-preference', 'light')
    localStorage.setItem('chat-demo:diagnostics-enabled', 'false')
    localStorage.setItem('chat-demo:diagnostics', JSON.stringify([{ t: 100, event: 'app.start', details: {} }]))
    localStorage.setItem('chat-demo:local-chat-usage:v1', JSON.stringify({
      [new Date().toLocaleDateString('sv-SE')]: { inputTokens: 12, outputTokens: 4, cacheHitTokens: 2, requests: 1 },
    }))
    if (android) {
      const native = window.__cacheNative = {
        key, logs: ['native.start'], calls: [], pendingId: null,
        finish(ok) {
          const id = this.pendingId
          this.pendingId = null
          reply(ok ? { id, ok, value: null } : { id, ok, error: { code: 'native_error', message: 'PRIVATE_CACHE_ERROR' } })
        },
      }
      const reply = (result) => bridge.onmessage?.({ data: JSON.stringify(result) })
      const bridge = window.DeepSeekAndroid = { onmessage: null, postMessage(raw) {
        const request = JSON.parse(raw)
        native.calls.push(request)
        const { id, action } = request
        if (action === 'clearWebViewCache') {
          native.pendingId = id
          return
        }
        if (action === 'setKey') native.key = request.value
        if (action === 'clearDiagnostics') native.logs = []
        queueMicrotask(() => reply({ id, ok: true, value: action === 'getKey' ? native.key : null }))
      } }
    }
    const probe = window.__cacheProbe = { operations: [], details: {}, tracing: false }
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (names, mode, ...options) {
      if (probe.tracing) probe.operations.push('transaction')
      const stores = typeof names === 'string' ? [names] : names
      if (mode === 'readwrite' && stores.length === 2 && stores.includes('sessionsStaging') && stores.includes('filesStaging')
          && probe.holdStaging) {
        probe.holdStaging = false
        // Hold the actual first staging transaction, so the store is in replacement mode.
        const blocker = Reflect.apply(transaction, this, ['sessionsStaging', 'readwrite'])
        const store = blocker.objectStore('sessionsStaging')
        let released = false
        probe.releaseStaging = () => { released = true }
        const next = () => { if (!released) store.count().onsuccess = next }
        next()
      }
      return Reflect.apply(transaction, this, [names, mode, ...options])
    }
    for (const name of ['open', 'deleteDatabase']) {
      const original = IDBFactory.prototype[name]
      IDBFactory.prototype[name] = function (...args) {
        if (probe.tracing) probe.operations.push(name)
        return Reflect.apply(original, this, args)
      }
    }
    const get = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === 'sessions') probe.details[key] = (probe.details[key] ?? 0) + 1
      return Reflect.apply(get, this, [key])
    }
  }, android)
  await page.goto('/')
  await openDataSettings(page)
}

async function showSidebar(page) {
  const open = page.getByRole('button', { name: '打开边栏', exact: true })
  const button = page.getByRole('button', { name: '设置', exact: true })
  await expect(open.or(button).first()).toBeVisible()
  if (!(await button.isVisible())) await open.click()
}

async function openDataSettings(page) {
  await showSidebar(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await settings(page).getByRole('tab', { name: '数据管理', exact: true }).click()
}

async function openSession(page, index) {
  await showSidebar(page)
  await page.getByText(`合成会话 ${index}`, { exact: true }).click()
  await expect(page.getByText(`合成回答 ${index}-0`, { exact: true })).toBeVisible()
}

async function warmTwoChats(page, picture = false) {
  await pickHistoryFixture(page, historyFixture({ count: 2, picture }))
  await importConfirmation(page).getByRole('button', { name: '确认导入', exact: true }).click()
  await settings(page).getByRole('button', { name: '查看导入的对话', exact: true }).click()
  await expect(page.getByText('合成回答 0-0', { exact: true })).toBeVisible()
  if (picture) await expectImage(page)
  await page.getByPlaceholder('请输入消息').fill('合成未发送草稿')
  await openSession(page, 1)
  await openDataSettings(page)
}

async function expectImage(page) {
  const image = page.locator('main img[alt="photo.bmp"]')
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBe(1536)
}

async function persistentSnapshot(page, seed = false) {
  return page.evaluate(async (seed) => {
    const read = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const db = await read(indexedDB.open('chat-demo'))
    const stores = ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging']
    try {
      if (seed) {
        const tx = db.transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
        tx.objectStore('sessionsStaging').put({ id: 'staging-session-sentinel' })
        tx.objectStore('filesStaging').put({ id: 'staging-file-sentinel', blob: new Blob(['staged']) })
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
        sessionStorage.setItem('cache-clean-session-sentinel', 'session-storage')
        const cache = await caches.open('cache-clean-test')
        await cache.put('/cache-clean-sentinel', new Response('browser-cache'))
        document.cookie = 'cache-clean-sentinel=browser-cookie; path=/'
      }
      const tx = db.transaction(stores)
      const entries = await Promise.all(stores.map((name) => read(tx.objectStore(name).getAll())))
      const hash = async (rows) => Promise.all(rows.map(async ({ id, blob }) => ({
        id, type: blob.type, size: blob.size,
        hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))],
      })))
      const blobRows = await Promise.all([hash(entries[2]), hash(entries[4])])
      return {
        sessions: entries[0], summaries: entries[1], files: blobRows[0],
        stagedSessions: entries[3], stagedFiles: blobRows[1],
        local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie,
        cache: await (await caches.match('/cache-clean-sentinel'))?.text(),
      }
    } finally {
      db.close()
    }
  }, seed)
}

async function expectReloadedDetail(page) {
  const previous = await page.evaluate(() => ({ ...window.__cacheProbe.details }))
  expect(Object.values(previous)).toHaveLength(2)
  await settings(page).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByText('合成回答 1-0', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__cacheProbe.details)).toEqual(previous)
  await openSession(page, 0)
  await expect(page.getByPlaceholder('请输入消息')).toHaveValue('合成未发送草稿')
  const current = await page.evaluate(() => window.__cacheProbe.details)
  expect(Object.keys(current)).toEqual(Object.keys(previous))
  expect(Object.keys(current).filter((id) => current[id] === previous[id] + 1)).toHaveLength(1)
}

test('clear cache in browser evicts only inactive app memory and preserves persistent data', async ({ page, baseURL }) => {
  await setup(page, baseURL)
  await warmTwoChats(page, true)
  const before = await persistentSnapshot(page, true)
  expect(before.sessions).toHaveLength(2)
  expect(before.files).toHaveLength(1)
  expect(before.stagedSessions).toHaveLength(1)
  expect(before.stagedFiles).toHaveLength(1)
  expect(before.cache).toBe('browser-cache')

  await cacheButton(settings(page)).click()
  const dialog = confirmation(page)
  await expect(dialog).toContainText('只清除应用内存中非活跃对话的缓存。')
  await expect(dialog).toContainText('保留对话、附件、草稿、API Key、偏好设置、Token 用量和诊断日志。')
  await expect(dialog).toContainText('不会修改 IndexedDB、导入暂存区或浏览器数据。')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  await cacheButton(settings(page)).click()
  await page.evaluate(() => { window.__cacheProbe.tracing = true })
  await cacheButton(dialog).click()
  await expect(settings(page).getByText(appResult, { exact: true })).toBeVisible()
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => {
    window.__cacheProbe.tracing = false
    return window.__cacheProbe.operations
  })).toEqual([])
  expect(await persistentSnapshot(page)).toEqual(before)
  await expectReloadedDetail(page)
  await expectImage(page)
})

for (const ok of [true, false]) {
  test(`clear cache on Android reports ${ok ? 'native success' : 'native failure after app success'} without repeating`, async ({ page, baseURL }) => {
    await setup(page, baseURL, true)
    await warmTwoChats(page)
    const before = await persistentSnapshot(page)
    await cacheButton(settings(page)).click()
    const dialog = confirmation(page)
    await expect(dialog).toContainText('Android WebView 的资源缓存')
    await cacheButton(dialog).evaluate((button) => {
      for (let i = 0; i < 3; i++) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await expect(settings(page).getByText(appResult, { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '正在清除缓存…', exact: true })).toBeDisabled()
    await expect(cacheButton(settings(page))).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await page.evaluate((ok) => window.__cacheNative.finish(ok), ok)
    await expect(dialog).toHaveCount(0)
    await expect(settings(page).getByText(appResult, { exact: true })).toBeVisible()
    await expect(settings(page).getByText(ok ? nativeSuccess : nativeFailure, { exact: true })).toBeVisible()
    await expect(settings(page).getByText(ok ? nativeFailure : nativeSuccess, { exact: true })).toHaveCount(0)
    await expect(settings(page)).not.toContainText('PRIVATE_CACHE_ERROR')
    expect(await page.evaluate(() => ({
      key: window.__cacheNative.key, logs: window.__cacheNative.logs,
      calls: window.__cacheNative.calls.filter(({ action }) => !['getKey', 'setDiagnosticsEnabled'].includes(action)),
    }))).toEqual({ key: 'sk-cache-clean-test-only', logs: ['native.start'], calls: [{ id: expect.any(String), action: 'clearWebViewCache' }] })
    expect(await persistentSnapshot(page)).toEqual(before)
    await expectReloadedDetail(page)
  })
}

test('clear cache disables both entry and confirmation during history replacement', async ({ page, baseURL }) => {
  await setup(page, baseURL, true)
  await cacheButton(settings(page)).click()
  const dialog = confirmation(page)
  await expect(cacheButton(dialog)).toBeEnabled()
  // Simulate an outstanding file picker resolving while the cache confirmation is open.
  await pickHistoryFixture(page, historyFixture({ count: 1 }))
  await expect(cacheButton(settings(page))).toBeDisabled()
  await expect(cacheButton(dialog)).toBeDisabled()
  await page.evaluate(() => { window.__cacheProbe.holdStaging = true })
  await importConfirmation(page).getByRole('button', { name: '确认导入', exact: true }).dispatchEvent('click')
  try {
    await expect.poll(() => page.evaluate(() => !!window.__cacheProbe.releaseStaging)).toBe(true)
    await expect(cacheButton(settings(page))).toBeDisabled()
    await expect(cacheButton(dialog)).toBeDisabled()
    await cacheButton(dialog).dispatchEvent('click')
    expect(await page.evaluate(() => window.__cacheNative.pendingId)).toBeNull()
  } finally {
    await page.evaluate(() => window.__cacheProbe.releaseStaging?.())
  }
  await expect(settings(page).getByText('已导入 1 个对话', { exact: true })).toBeVisible()
  await expect(cacheButton(dialog)).toBeEnabled()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(cacheButton(settings(page))).toBeEnabled()
})
