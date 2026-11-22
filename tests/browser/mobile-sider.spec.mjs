import { devices, expect, test } from '@playwright/test'

test.use({ ...devices['Pixel 7'], defaultBrowserType: 'chromium' })

const trigger = (page) => page.getByRole('button', { name: '打开边栏', exact: true })
const drawer = (page) => page.locator('#mobile-sider')
const conversations = (page) => page.getByRole('dialog', { name: '对话', exact: true })
const offset = (page) => drawer(page).evaluate((el) => el.getBoundingClientRect().left)

async function launch(page, key = 'sk-fixture') {
  await page.addInitScript((key) => {
    const bridge = {
      onmessage: null,
      postMessage(raw) {
        const { id, action } = JSON.parse(raw)
        queueMicrotask(() => bridge.onmessage?.({ data: JSON.stringify({
          id, ok: true, value: action === 'getKey' ? key : null,
        }) }))
      },
    }
    window.DeepSeekAndroid = bridge
  }, key)
  await page.route('https://api.deepseek.com/**', (route) => route.fulfill({
    json: { object: 'list', data: [] }, headers: { 'access-control-allow-origin': '*' },
  }))
  await page.goto('/')
  await expect(trigger(page)).toBeVisible()
  // A real Chromium touch stream exercises default scrolling and synthetic click suppression.
  const cdp = await page.context().newCDPSession(page)
  const send = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map(([x, y], id) => ({ x, y, id })),
  })
  return {
    start: (x, y) => send('touchStart', [[x, y]]),
    move: (x, y) => send('touchMove', [[x, y]]),
    addFinger: (x, y, x2, y2) => send('touchStart', [[x, y], [x2, y2]]),
    end: () => send('touchEnd', []),
    cancel: () => send('touchCancel', []),
  }
}

async function history(page) {
  await page.evaluate(async () => {
    const request = indexedDB.open('chat-demo')
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const now = Date.now()
    const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
    for (let i = 0; i < 40; i++) {
      const summary = { id: `s-${i}`, title: `手势样本 ${i}`, createdAt: now - i, updatedAt: now - i }
      tx.objectStore('sessions').put({ ...summary, rootMessageId: null, messages: [] })
      tx.objectStore('sessionSummaries').put({ ...summary, fileIds: [] })
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  })
  await page.reload()
  await expect(trigger(page)).toBeVisible()
}

test('edge swipe follows the finger, dims the chat, and settles in both directions', async ({ page }) => {
  const touch = await launch(page)
  const width = await drawer(page).evaluate((el) => el.offsetWidth)
  await touch.start(19, 260)
  await touch.move(84, 262)
  await expect.poll(() => offset(page)).toBeCloseTo(-width + 65, 0)
  await expect.poll(() => drawer(page).evaluate((el) => Number(getComputedStyle(el.previousElementSibling).opacity)))
    .toBeCloseTo(65 / width, 2)
  await expect(conversations(page)).toHaveCount(0)
  await touch.move(164, 264)
  await touch.end()
  await expect(conversations(page)).toBeVisible()
  await expect(conversations(page)).toBeFocused()
  await expect.poll(() => offset(page)).toBeCloseTo(0, 1)

  await touch.start(235, 250)
  await touch.move(167, 252)
  await expect.poll(() => offset(page)).toBeCloseTo(-68, 0)
  await touch.move(84, 253)
  await touch.end()
  await expect(conversations(page)).toHaveCount(0)
  await expect(trigger(page)).toBeFocused()
  await expect.poll(() => offset(page)).toBeCloseTo(-width, 0)
})

test('vertical, short, off-edge, multitouch and cancelled gestures do not change state', async ({ page }) => {
  const touch = await launch(page)
  for (const [[x, y], [toX, toY]] of [[[19, 300], [32, 450]], [[19, 300], [35, 302]], [[80, 300], [270, 302]]]) {
    await touch.start(x, y)
    await touch.move(toX, toY)
    await touch.end()
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false')
  }

  await touch.start(20, 275)
  await touch.move(170, 275)
  await touch.addFinger(170, 275, 240, 310)
  await touch.end()
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => offset(page)).toBeCloseTo(-304, 0)

  await touch.start(20, 275)
  await touch.move(170, 275)
  await touch.cancel()
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => offset(page)).toBeCloseTo(-304, 0)
})

test('history scroll and text fields keep touch; swiping a row does not select it', async ({ page }) => {
  const touch = await launch(page)
  await history(page)
  await trigger(page).click()
  await expect.poll(() => offset(page)).toBeCloseTo(0, 1)
  const search = conversations(page).getByRole('searchbox')
  const searchBox = await search.boundingBox()
  await touch.start(200, searchBox.y + searchBox.height / 2)
  await touch.move(35, searchBox.y + searchBox.height / 2)
  await touch.end()
  await expect(conversations(page)).toBeVisible()

  const row = conversations(page).getByText('手势样本 3', { exact: true })
  const top = (await row.boundingBox()).y
  await touch.start(130, 550)
  await touch.move(126, 435)
  await touch.move(123, 312)
  await touch.end()
  await expect.poll(async () => (await row.boundingBox()).y).toBeLessThan(top - 80)
  await expect(conversations(page)).toBeVisible()

  const visibleRow = conversations(page).getByText(/^手势样本 /).filter({ visible: true })
  // Pick a row through hit testing after native kinetic scrolling, not the first DOM row.
  const title = await page.evaluate(() => document.elementFromPoint(166, 350)?.closest('#mobile-sider') != null)
  expect(title).toBe(true)
  expect(await visibleRow.count()).toBe(40)
  await touch.start(166, 350)
  await touch.move(40, 352)
  await touch.end()
  await expect(conversations(page)).toHaveCount(0)
  await expect(page.locator('main h1')).toBeVisible()
})

test('menu, mask, Escape, and Android Back still work with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await launch(page)
  await trigger(page).click()
  await expect(conversations(page)).toHaveCSS('transition-duration', '0s')
  await expect(page.locator('main')).toHaveAttribute('inert', '')
  await page.keyboard.press('Escape')
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger(page)).toBeFocused()
  await trigger(page).click()
  await page.touchscreen.tap(360, 280)
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false')
  await trigger(page).click()
  expect(await page.evaluate(() => window.__deepseekAndroidBack())).toBe(true)
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false')
  expect(await page.evaluate(() => window.__deepseekAndroidBack())).toBe(false)
})

test('edge gesture does not open over settings, and the desktop keeps its sidebar', async ({ page }) => {
  const touch = await launch(page, null)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings).toBeVisible()
  await touch.start(19, 250)
  await touch.move(180, 251)
  await touch.end()
  await expect(conversations(page)).toHaveCount(0)
  await expect(settings).toBeVisible()
  await page.setViewportSize({ width: 900, height: 680 })
  await expect(drawer(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '收起边栏', exact: true })).toBeVisible()
})
