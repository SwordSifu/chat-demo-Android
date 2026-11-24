import { expect, test } from '@playwright/test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { historyFixture, pickHistoryFixture } from './history-fixture.mjs'

const settings = (page) => page.getByRole('dialog', { name: '设置', exact: true })
const confirmation = (page) => page.getByRole('dialog', { name: '确认导入历史对话？', exact: true })
const progress = (page) => settings(page).getByRole('group', { name: '导入历史对话', exact: true })
const viewImported = (page) => settings(page).getByRole('button', { name: '查看导入的对话', exact: true })

async function showSidebar(page) {
  const open = page.getByRole('button', { name: '打开边栏', exact: true })
  const settingsButton = page.getByRole('button', { name: '设置', exact: true })
  await expect(open.or(settingsButton).first()).toBeVisible()
  if (!(await settingsButton.isVisible())) await open.click()
}

async function openDataSettings(page) {
  await showSidebar(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await settings(page).getByRole('tab', { name: '数据管理', exact: true }).click()
}

async function confirmImport(page, fixture) {
  await pickHistoryFixture(page, historyFixture(fixture))
  await confirmation(page).getByRole('button', { name: '确认导入', exact: true }).click()
}

async function openImportedSession(page, title) {
  await showSidebar(page)
  await page.getByText(title, { exact: true }).click()
}

// Observe real archive I/O and IndexedDB. Only pause inputs/transactions at test
// boundaries, rather than replacing the import or manufacturing progress events.
function installImportProbe() {
  const slice = File.prototype.slice
  const add = IDBObjectStore.prototype.add
  const put = IDBObjectStore.prototype.put
  const transaction = IDBDatabase.prototype.transaction

  IDBObjectStore.prototype.add = function (...args) {
    const state = window.__importObserved
    const request = Reflect.apply(add, this, args)
    if (state && this.name === 'sessionsStaging') request.addEventListener('success', () => state.staged++)
    return request
  }
  File.prototype.slice = function (...args) {
    const state = window.__importObserved
    const blob = Reflect.apply(slice, this, args)
    if (this.name !== 'bench.zip' || !state?.pauseReading) return blob
    const arrayBuffer = blob.arrayBuffer.bind(blob)
    blob.arrayBuffer = async () => {
      if (!state.checking) {
        state.checking = true
        await new Promise((resolve) => { state.release.checking = resolve })
      }
      return arrayBuffer()
    }
    return blob
  }
  IDBDatabase.prototype.transaction = function (names, mode, ...args) {
    const state = window.__importObserved
    const stores = typeof names === 'string' ? [names] : names
    if (state && mode === 'readwrite') {
      // Hold a real transaction after a batch has been staged. Do not depend on
      // a later File.slice: a read-ahead window can cover the whole archive.
      const hold = (phase, name) => {
        const blocker = Reflect.apply(transaction, this, [name, 'readwrite'])
        const store = blocker.objectStore(name)
        let released = false
        state.release[phase] = () => { released = true }
        const keepAlive = () => { if (!released) store.count().onsuccess = keepAlive }
        keepAlive()
      }
      if (state.pauseReading && !state.reading && state.staged && stores.length === 1 && stores[0] === 'sessionsStaging') {
        state.reading = true
        hold('reading', 'sessionsStaging')
      }
      if (stores.includes('sessionsStaging') && stores.includes('sessionSummaries')) {
        state.commits++
        if (state.pauseSaving) hold('saving', 'sessions')
      }
    }
    return Reflect.apply(transaction, this, [names, mode, ...args])
  }
  IDBObjectStore.prototype.put = function (...args) {
    const state = window.__importObserved
    if (state?.quota && this.name === 'sessions' && state.commits > 0 && !state.quotaThrown) {
      state.quotaThrown = true
      throw new DOMException('SYNTHETIC_PRIVATE_STORAGE_DETAILS', 'QuotaExceededError')
    }
    return Reflect.apply(put, this, args)
  }
}

async function observeImport(page, options = {}) {
  await page.evaluate((options) => {
    window.__importObserved = { ...options, checking: false, reading: false, staged: 0, commits: 0, quotaThrown: false, release: {} }
  }, options)
}

async function release(page, phase) {
  await page.evaluate((name) => window.__importObserved.release[name](), phase)
}

async function historyStorage(page) {
  return page.evaluate(async () => {
    const read = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const db = await read(indexedDB.open('chat-demo'))
    const stores = ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging']
    try {
      const tx = db.transaction(stores)
      const [sessions, summaries, files, stagedSessions, stagedFiles] = await Promise.all([
        read(tx.objectStore('sessions').getAll()),
        read(tx.objectStore('sessionSummaries').getAll()),
        read(tx.objectStore('files').getAll()),
        read(tx.objectStore('sessionsStaging').count()),
        read(tx.objectStore('filesStaging').count()),
      ])
      const originals = await Promise.all(files.map(async ({ id, blob }) => ({
        id,
        type: blob.type,
        size: blob.size,
        digest: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))),
      })))
      return { sessions, summaries, originals, stagedSessions, stagedFiles }
    } finally {
      db.close()
    }
  })
}

async function seedOriginal(page) {
  await confirmImport(page, { count: 1, picture: true })
  await expect(settings(page).getByText('已导入 1 个对话', { exact: true })).toBeVisible()
  const original = await historyStorage(page)
  expect(original.sessions).toHaveLength(1)
  expect(original.originals).toHaveLength(1)
  expect(original.stagedSessions).toBe(0)
  expect(original.stagedFiles).toBe(0)
  return original
}

async function expectOriginalImage(page) {
  const image = page.locator('main img[alt="photo.bmp"]')
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBe(1536)
}

test.beforeEach(async ({ page, baseURL }) => {
  // Bypass first-run setup with a synthetic key. Never contact the account or model API.
  await page.route(/^https?:\/\//, (route) => new URL(route.request().url()).origin === new URL(baseURL).origin
    ? route.continue()
    : route.abort())
  await page.addInitScript(installImportProbe)
  await page.addInitScript(() => {
    localStorage.setItem('chat-demo:api-key', 'sk-synthetic-history-only')
    const get = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === 'sessions' && key === window.__failHistoryDetail) {
        delete window.__failHistoryDetail
        throw new DOMException('Simulated detail read failure', 'UnknownError')
      }
      return Reflect.apply(get, this, [key])
    }
  })
  await page.goto('/')
  await openDataSettings(page)
})

test('history import shows actual progress, saves without cancellation, then opens the latest chat', async ({ page }) => {
  await observeImport(page, { pauseReading: true, pauseSaving: true })
  const entries = unzipSync(historyFixture({ count: 2, picture: true }))
  const newest = 'chat_sessions/bench-0.json'
  const older = 'chat_sessions/bench--older.json'
  const oldPath = 'chat_sessions/bench-1.json'
  const indexPath = 'chat_session_index.json'
  const oldSession = JSON.parse(strFromU8(entries[oldPath]))
  const index = JSON.parse(strFromU8(entries[indexPath]))
  delete entries[oldPath]
  entries[indexPath] = strToU8(JSON.stringify(index.map((session) =>
    session.id === oldSession.id ? { ...session, id: 'bench--older' } : session)))
  // Older first in both ZIP order and IndexedDB key order; latest must use time.
  const reordered = {
    'manifest.json': entries['manifest.json'],
    [older]: strToU8(JSON.stringify({ ...oldSession, id: 'bench--older' })),
    [newest]: entries[newest],
    ...entries,
  }
  await pickHistoryFixture(page, Buffer.from(zipSync(reordered, { level: 1 })))
  await expect(confirmation(page)).toBeVisible()
  await expect(progress(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.__importObserved.checking)).toBe(false)
  await confirmation(page).getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(progress(page).getByText('正在检查文件…', { exact: true })).toBeVisible()
  await expect(progress(page).getByRole('progressbar')).not.toHaveAttribute('value')
  await expect(progress(page).getByRole('button', { name: '取消导入', exact: true })).toHaveCount(1)
  // Close during preflight, before the chat store's replacement guard takes effect.
  await expect.poll(() => page.evaluate(() => window.__importObserved.checking)).toBe(true)
  await settings(page).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings(page)).toHaveCount(0)
  await openDataSettings(page)
  await expect(progress(page).getByText('正在检查文件…', { exact: true })).toBeVisible()
  const busyButton = settings(page).getByRole('button', { name: '导入历史对话', exact: true })
  await expect(busyButton).toBeDisabled()
  await expect(busyButton).toHaveAttribute('aria-busy', 'true')
  await expect(busyButton.locator('svg')).toBeVisible()
  // Even a delayed file-picker response cannot queue a second import.
  await pickHistoryFixture(page, historyFixture({ count: 1 }))
  await expect(confirmation(page)).toHaveCount(0)
  await release(page, 'checking')

  await expect.poll(() => page.evaluate(() => window.__importObserved.reading)).toBe(true)
  const bar = progress(page).getByRole('progressbar')
  // Both real totals are visible. The last published snapshot may be throttled;
  // completion cannot be reported while the transaction is still blocked.
  await expect(progress(page).getByText(/^正在读取：[1-4] \/ 5 个条目$/)).toBeVisible()
  await expect(progress(page).getByText(/^已处理 [0-2] \/ 2 个对话$/)).toBeVisible()
  await expect(bar).toHaveAttribute('value', /^[1-4]$/)
  await expect(bar).toHaveAttribute('max', '5')
  await release(page, 'reading')

  await expect(progress(page).getByText('正在保存，请勿关闭应用…', { exact: true })).toBeVisible()
  await expect(progress(page).getByRole('button', { name: '取消导入', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(settings(page)).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.__importObserved.commits)).toBe(1)
  await release(page, 'saving')
  await expect.poll(async () => (await historyStorage(page)).sessions.length).toBe(2)
  await openDataSettings(page)
  await expect(settings(page).getByText('已导入 2 个对话', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__importObserved.commits)).toBe(1)

  // The shortcut follows the ordinary detail path (including retry), not a copied preview.
  await page.evaluate(() => { window.__failHistoryDetail = 'bench-0' })
  await viewImported(page).click()
  await expect(settings(page)).toHaveCount(0)
  await expect(page.getByText('无法加载此对话，请重试。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByText('合成回答 0-0', { exact: true })).toBeVisible()
  await expectOriginalImage(page)
  await page.getByRole('button', { name: '下一个版本', exact: true }).click()
  await expect(page.getByText('替代回答', { exact: true })).toBeVisible()

  await page.reload()
  await openImportedSession(page, '合成会话 0')
  await expect(page.getByText('替代回答', { exact: true })).toBeVisible()
  await expectOriginalImage(page)
  await openImportedSession(page, '合成会话 1')
  await expect(page.getByText('合成回答 1-0', { exact: true })).toBeVisible()
})

test('cancelling after staging restores the previous chats and image without committing', async ({ page }) => {
  const original = await seedOriginal(page)
  await observeImport(page, { pauseReading: true })
  await confirmImport(page, { count: 33, turns: 2 })
  await expect.poll(() => page.evaluate(() => window.__importObserved.checking)).toBe(true)
  await release(page, 'checking')
  await expect.poll(() => page.evaluate(() => window.__importObserved.reading)).toBe(true)
  expect(await page.evaluate(() => window.__importObserved.staged)).toBeGreaterThan(0)
  await progress(page).getByRole('button', { name: '取消导入', exact: true }).click()
  await release(page, 'reading')
  await expect(settings(page).getByText('已取消导入，原有对话未更改。', { exact: true })).toBeVisible()
  await expect(settings(page).getByText(/导入失败/)).toHaveCount(0)
  await expect(viewImported(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.__importObserved.commits)).toBe(0)
  expect(await historyStorage(page)).toEqual(original)

  await page.reload()
  await openImportedSession(page, '合成会话 0')
  await expect(page.getByText('合成回答 0-0', { exact: true })).toBeVisible()
  await expectOriginalImage(page)
  await showSidebar(page)
  await expect(page.getByText('合成会话 1', { exact: true })).toHaveCount(0)
})

for (const { name, quota, fixture, result } of [
  { name: 'malformed archive index', quota: false, fixture: { badIndex: true },
    result: '导入失败：文件内容不完整' },
  { name: 'storage quota during commit', quota: true, fixture: { count: 3, turns: 2 },
    result: '存储空间不足，原有对话未更改。请腾出空间后重试。' },
]) {
  test(`${name} shows a safe localized error and retains live data`, async ({ page }) => {
    const original = await seedOriginal(page)
    await observeImport(page, { quota })
    await confirmImport(page, fixture)
    await expect(settings(page).getByText(result, { exact: true })).toBeVisible()
    await expect(viewImported(page)).toHaveCount(0)
    await expect(settings(page).getByText(/SYNTHETIC_PRIVATE_STORAGE_DETAILS/)).toHaveCount(0)
    const observed = await page.evaluate(() => window.__importObserved)
    expect(observed.staged).toBeGreaterThan(0)
    expect(observed.commits).toBe(quota ? 1 : 0)
    expect(observed.quotaThrown).toBe(quota)
    expect(await historyStorage(page)).toEqual(original)
  })
}
