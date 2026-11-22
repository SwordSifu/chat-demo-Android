import { expect, test } from '@playwright/test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { historyFixture } from './history-fixture.mjs'

const settings = (page) => page.getByRole('dialog', { name: '设置', exact: true })
const input = (page) => page.getByRole('searchbox', { name: '搜索本机对话', exact: true })
const results = (page) => page.getByRole('list', { name: '对话搜索结果', exact: true })
const rows = (page) => results(page).getByRole('listitem')
const noMatches = (page) => page.getByText('未找到匹配的对话', { exact: true })

async function showSidebar(page) {
  const open = page.getByRole('button', { name: '打开边栏', exact: true })
  await expect(input(page).or(open).first()).toBeVisible()
  if (!(await input(page).isVisible())) await open.click()
  await expect(input(page)).toBeVisible()
}

async function chooseImport(page, archive) {
  await showSidebar(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await settings(page).getByRole('tab', { name: '数据管理', exact: true }).click()
  await page.locator('input[type=file][accept*=".zip"]').setInputFiles({
    name: 'search-fixture.zip', mimeType: 'application/zip', buffer: archive,
  })
}

async function startImport(page) {
  await page.getByRole('dialog', { name: '确认导入历史对话？' })
    .getByRole('button', { name: '确认导入', exact: true }).click()
}

async function finishImport(page, count) {
  await expect(settings(page).getByText(`已导入 ${count} 个对话`, { exact: true })).toBeVisible()
  await settings(page).getByRole('button', { name: '关闭', exact: true }).click()
}

async function seed(page, count, archive = historyFixture({ count })) {
  await chooseImport(page, archive)
  await startImport(page)
  await finishImport(page, count)
  await showSidebar(page)
}

function installProbe() {
  const get = IDBObjectStore.prototype.get
  const getAll = IDBObjectStore.prototype.getAll
  const transaction = IDBDatabase.prototype.transaction
  window.__searchProbe = { reads: [], writes: 0, bulkReads: [], fail: null, completed: 0 }
  IDBObjectStore.prototype.get = function (key) {
    const probe = window.__searchProbe
    probe.reads.push([this.name, key])
    if (this.name === 'sessions' && key === probe.fail) {
      throw new DOMException('SYNTHETIC_PRIVATE_IDB_ERROR', 'UnknownError')
    }
    const request = Reflect.apply(get, this, arguments)
    if (this.name === 'sessions') request.addEventListener('success', () => { probe.completed++ })
    return request
  }
  IDBObjectStore.prototype.getAll = function () {
    window.__searchProbe.bulkReads.push(this.name)
    return Reflect.apply(getAll, this, arguments)
  }
  IDBDatabase.prototype.transaction = function (_stores, mode) {
    if (mode === 'readwrite') window.__searchProbe.writes++
    return Reflect.apply(transaction, this, arguments)
  }
  // Hold real sessions transactions until explicitly released, not a fake search result.
  window.__blockSearchReads = async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const blocker = Reflect.apply(transaction, db, ['sessions', 'readwrite'])
    const store = blocker.objectStore('sessions')
    let blocked = true
    window.__releaseSearchReads = () => { blocked = false }
    blocker.oncomplete = () => db.close()
    const keepAlive = () => { if (blocked) store.count().onsuccess = keepAlive }
    keepAlive()
  }
}

const resetProbe = (page) => page.evaluate(() => {
  Object.assign(window.__searchProbe, { reads: [], writes: 0, bulkReads: [], completed: 0 })
})
const probe = (page) => page.evaluate(() => window.__searchProbe)
const sessionReads = async (page) => (await probe(page)).reads.filter(([store]) => store === 'sessions').map(([, id]) => id)
const releaseReads = (page) => page.evaluate(() => window.__releaseSearchReads())

function updateArchive(archive, edit) {
  const files = unzipSync(archive)
  const change = (path, fn) => {
    const data = JSON.parse(strFromU8(files[path]))
    fn(data)
    files[path] = strToU8(JSON.stringify(data))
  }
  edit(change)
  return Buffer.from(zipSync(files, { level: 1 }))
}

const editSession = (change, i, fn) => change(`chat_sessions/bench-${i}.json`, fn)
const fromMessage = (id, page) => page.locator(`main [data-history-message-id="${id}"]`)

test.beforeEach(async ({ page, baseURL }) => {
  await page.route(/^https?:\/\//, (route) => new URL(route.request().url()).origin === new URL(baseURL).origin
    ? route.continue() : route.abort())
  await page.addInitScript(installProbe)
  await page.addInitScript(() => localStorage.setItem('chat-demo:api-key', 'sk-synthetic-search-only'))
  await page.goto('/')
})

test('paginates 53 imported chats in updated order; empty search does not scan and search performs only single detail reads', async ({ page }) => {
  await seed(page, 53)
  await resetProbe(page)
  const requests = []
  page.on('request', (request) => requests.push(request.url()))
  await input(page).fill('  ')
  await expect(page.getByText('合成会话 0', { exact: true })).toBeVisible()
  await expect.poll(() => sessionReads(page)).toEqual([])
  await input(page).fill('合成回答')
  await expect(rows(page)).toHaveCount(50)
  await expect(rows(page).first()).toContainText('合成会话 0')
  await expect(rows(page).last()).toContainText('合成会话 49')
  await expect(rows(page).first().locator('mark')).toHaveText('合成回答')
  expect(await sessionReads(page)).toEqual(Array.from({ length: 50 }, (_, i) => `bench-${i}`))
  await page.getByRole('button', { name: '加载更多结果', exact: true }).click()
  await expect(rows(page)).toHaveCount(53)
  await expect(rows(page).last()).toContainText('合成会话 52')
  await expect(page.getByRole('button', { name: '加载更多结果', exact: true })).toHaveCount(0)
  const observed = await probe(page)
  expect(observed.reads).toHaveLength(53)
  expect(observed.reads.every(([store]) => store === 'sessions')).toBe(true)
  expect(observed.writes).toBe(0)
  expect(observed.bulkReads).toEqual([])
  expect(requests).toEqual([])
  await page.getByRole('button', { name: '清空对话搜索', exact: true }).click()
  await expect(input(page)).toHaveValue('')
  await expect(results(page)).toHaveCount(0)
  await expect(page.getByText('合成会话 0', { exact: true })).toBeVisible()
})

test('searches literal title, question and final answer only; no hidden, tool, attachment, or draft matches', async ({ page }) => {
  const archive = updateArchive(historyFixture({ count: 2, picture: true }), (change) => {
    editSession(change, 0, ({ messages }) => {
      messages[1].fragments = [
        { type: 'RESPONSE', content: 'preamblePrivate' },
        { type: 'THINK', content: 'thinkPrivate', elapsed_secs: null },
        { type: 'TOOL_SEARCH', queries: ['toolPrivate'], results: [], status: 'FINISHED' },
        { type: 'TEMPLATE_RESPONSE', content: 'templatePrivate' },
        { type: 'RESPONSE', content: '<b>AScII.[汉字]</b>' },
      ]
    })
  })
  await seed(page, 2, archive)
  await page.getByRole('button', { name: '收起边栏', exact: true }).click()
  await page.getByPlaceholder('请输入消息').fill('draftPrivate')
  await showSidebar(page)
  await resetProbe(page)
  await input(page).fill('ascii.[汉字]')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first().locator('mark')).toHaveText('AScII.[汉字]')
  await expect(rows(page).first()).toContainText('<b>AScII.[汉字]</b>')
  await expect(rows(page).first().locator('b')).toHaveCount(0)
  for (const term of ['preamblePrivate', 'thinkPrivate', 'toolPrivate', 'templatePrivate', 'photo.bmp', 'draftPrivate', '替代回答']) {
    await input(page).fill(term)
    await expect(noMatches(page)).toBeVisible()
  }
  expect((await probe(page)).reads.every(([store]) => store === 'sessions')).toBe(true)
  await input(page).fill('合成提问 1-0')
  await expect(rows(page).first().locator('mark')).toHaveText('合成提问 1-0')
  await input(page).fill('合成会话 1')
  await expect(rows(page).first().locator('mark')).toHaveText('合成会话 1')
  await rows(page).first().getByRole('button').click()
  await expect(page.locator('main').getByText('合成回答 1-0', { exact: true })).toBeVisible()
})

for (const [layout, width] of [['mobile', 393], ['desktop', 1200]]) {
  test(`locates a cold session's message, not the same message ID in the active session (${layout})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 })
    const archive = updateArchive(historyFixture({ count: 2, turns: 10 }), (change) => {
      editSession(change, 1, ({ messages }) => {
        messages[1].fragments[0].content = '合成定位正文'
      })
    })
    await seed(page, 2, archive)
    await page.getByText('合成会话 0', { exact: true }).click()
    await expect(fromMessage(2, page)).toHaveText(/合成回答 0-0/)
    await showSidebar(page)
    await input(page).fill('定位正文')
    await expect(rows(page)).toHaveCount(1)
    await resetProbe(page)
    await page.evaluate(() => window.__blockSearchReads())
    await rows(page).getByRole('button').click()
    await expect.poll(() => sessionReads(page)).toEqual(['bench-1'])
    await expect(page.getByText('正在加载对话…', { exact: true })).toBeVisible()
    await expect(fromMessage(2, page)).toHaveCount(0)
    await releaseReads(page)
    await expect(fromMessage(2, page)).toHaveText(/合成定位正文/)
    await expect(fromMessage(2, page)).toBeInViewport()
    await expect(fromMessage(20, page)).not.toBeInViewport()
  })
}

test('cancels pending reads on new query, closing the drawer, and history import without stale results', async ({ page }) => {
  await seed(page, 4)
  await resetProbe(page)
  await page.evaluate(() => window.__blockSearchReads())
  await input(page).fill('合成提问')
  await expect.poll(() => sessionReads(page)).toEqual(['bench-0'])
  await input(page).fill('合成回答 3-0')
  await releaseReads(page)
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first().locator('mark')).toHaveText('合成回答 3-0')
  expect(await sessionReads(page)).toEqual(['bench-0', 'bench-0', 'bench-1', 'bench-2', 'bench-3'])

  await resetProbe(page)
  await page.evaluate(() => window.__blockSearchReads())
  await input(page).fill('合成提问')
  await expect.poll(() => sessionReads(page)).toEqual(['bench-0'])
  await page.getByRole('button', { name: '收起边栏', exact: true }).click()
  await releaseReads(page)
  await expect.poll(async () => (await probe(page)).completed).toBe(1)
  await showSidebar(page)
  await expect(input(page)).toHaveValue('')
  await expect(results(page)).toHaveCount(0)
  expect(await sessionReads(page)).toEqual(['bench-0'])

  await resetProbe(page)
  await page.evaluate(() => window.__blockSearchReads())
  await input(page).fill('合成提问')
  await expect.poll(() => sessionReads(page)).toEqual(['bench-0'])
  const replacement = updateArchive(historyFixture({ count: 1 }), (change) => {
    editSession(change, 0, ({ messages }) => {
      messages[0].fragments[0].content = '替换后的历史提问'
    })
  })
  await chooseImport(page, replacement)
  await startImport(page)
  await expect(input(page)).toHaveValue('')
  await releaseReads(page)
  await finishImport(page, 1)
  await showSidebar(page)
  await expect(results(page)).toHaveCount(0)
  expect(await sessionReads(page)).toEqual(['bench-0'])
  await input(page).fill('替换后的历史提问')
  await expect(rows(page).first().locator('mark')).toHaveText('替换后的历史提问')
})

test('a match moved off the selected branch opens the chat without switching branches', async ({ page }) => {
  await seed(page, 2)
  await input(page).fill('合成回答 0-0')
  await expect(rows(page)).toHaveCount(1)
  // Simulate a branch selection persisted by another window after the search read.
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('sessions', 'readwrite')
        const store = tx.objectStore('sessions')
        const request = store.get('bench-0')
        request.onsuccess = () => {
          const session = request.result
          session.messages.find(({ id }) => id === '1').selectedChildId = '3'
          store.put(session)
        }
        tx.oncomplete = resolve
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  })
  await rows(page).getByRole('button').click()
  await expect(fromMessage(3, page)).toContainText('替代回答')
  await expect(fromMessage(2, page)).toHaveCount(0)
  await expect(page.getByText('匹配的消息不在当前分支，无法跳转。', { exact: true })).toBeVisible()
})

test('read failures do not claim no matches, and a failed jump is not replayed when loading is retried', async ({ page }) => {
  await seed(page, 1, historyFixture({ count: 1, turns: 10 }))
  await page.evaluate(() => { window.__searchProbe.fail = 'bench-0' })
  await input(page).fill('合成回答 0-0')
  await expect(page.getByRole('alert')).toContainText('搜索结果可能不完整')
  await expect(noMatches(page)).toHaveCount(0)
  await expect(page.getByText('SYNTHETIC_PRIVATE_IDB_ERROR')).toHaveCount(0)
  await page.evaluate(() => { window.__searchProbe.fail = null })
  await page.getByRole('alert').getByRole('button', { name: '重试', exact: true }).click()
  await expect(rows(page)).toHaveCount(1)
  await page.evaluate(() => { window.__searchProbe.fail = 'bench-0' })
  await rows(page).getByRole('button').click()
  await expect(page.getByText('无法加载此对话，请重试。', { exact: true })).toBeVisible()
  await page.evaluate(() => { window.__searchProbe.fail = null })
  await page.locator('main').getByRole('button', { name: '重试', exact: true }).click()
  await expect(fromMessage(20, page)).toBeInViewport()
  await expect(fromMessage(2, page)).not.toBeInViewport()
})
