import { test, expect } from '@playwright/test'

const baseKey = 'sk-account-mock'
const usageKey = 'chat-demo:local-chat-usage:v1'
const balanceTab = (page) => page.getByRole('tab', { name: '余额与用量', exact: true })
const balance = (page) => page.getByRole('region', { name: 'DeepSeek 账户余额' })
const usage = (page) => page.getByRole('region', { name: '本机 Token 用量' })

async function setup(page, key = baseKey) {
  await page.addInitScript(({ key }) => {
    const storageKey = 'test:simulated-native-key'
    const bridge = {
      onmessage: null,
      postMessage(raw) {
        const { id, action, value } = JSON.parse(raw)
        const reply = { id, ok: true, value: null }
        if (action === 'getKey') {
          const saved = sessionStorage.getItem(storageKey)
          reply.value = saved === null ? key : JSON.parse(saved)
        } else if (action === 'setKey') {
          if (value === 'sk-account-fail') {
            reply.ok = false
            reply.error = 'Simulated secure key save failed'
          } else {
            sessionStorage.setItem(storageKey, JSON.stringify(value))
          }
        }
        queueMicrotask(() => bridge.onmessage({ data: JSON.stringify(reply) }))
      },
    }
    window.DeepSeekAndroid = bridge
  }, { key })
  const requests = []
  let balanceReply = { json: { is_available: true, balance_infos: [
    { currency: 'CNY', total_balance: '10.0001', granted_balance: '0.0001', topped_up_balance: '10.00' },
    { currency: 'USD', total_balance: '0.1200', granted_balance: '0.0200', topped_up_balance: '0.1000' },
  ] } }
  // Never allow a live DeepSeek request even if a new endpoint is added to the app.
  await page.route(/^https:\/\/(?:api|platform)\.deepseek\.com(?:\/|$)/, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-api-key',
    }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (url.pathname === '/models') return route.fulfill({ headers, json: { data: [{ id: 'deepseek-flash' }] } })
    if (url.pathname === '/user/balance') {
      requests.push({ url: url.href, method: req.method(), authorization: req.headers().authorization, body: req.postData() })
      return typeof balanceReply === 'string'
        ? route.abort(balanceReply)
        : route.fulfill({ headers, ...balanceReply })
    }
    return route.abort()
  })
  return { requests, reply: (value) => { balanceReply = value } }
}

async function openSettings(page) {
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
}

async function openAccount(page) {
  await openSettings(page)
  await balanceTab(page).click()
}

async function closeSettings(page) {
  await page.evaluate(() => window.__deepseekAndroidBack())
  await expect(balanceTab(page)).toBeHidden()
  const closeSidebar = page.getByRole('button', { name: '收起边栏', exact: true })
  if (await closeSidebar.isVisible()) await closeSidebar.click()
}

function todayValues(page) {
  return usage(page).getByRole('heading', { name: '今天', exact: true }).locator('..').locator('dd')
}

async function installChat(page) {
  await page.addInitScript(() => {
    const previous = window.fetch.bind(window)
    const encoder = new TextEncoder()
    window.__accountChats = []
    window.fetch = (url, init) => {
      if (url !== 'https://api.deepseek.com/anthropic/v1/messages') return previous(url, init)
      const body = new ReadableStream({ start(controller) {
        const send = (event) => controller.enqueue(encoder.encode(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
        send({ type: 'message_start', message: { id: 'mock-account', role: 'assistant',
          usage: { input_tokens: 900, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '模拟用量回复' } })
        window.__accountChats.push((result) => {
          send({ type: 'content_block_stop', index: 0 })
          const delta = { stop_reason: 'end_turn', title: '用量回归会话' }
          send({ type: 'message_delta', delta,
            usage: { input_tokens: 19, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } })
          send({ type: 'message_delta', delta, usage: result === 'bad'
            ? { input_tokens: -10, output_tokens: 7, cache_read_input_tokens: 8, cache_creation_input_tokens: 1 }
            : result === 'second'
              ? { input_tokens: 60, output_tokens: 98, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
              : { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 8, cache_creation_input_tokens: 1 } })
          if (result !== 'eof') send({ type: 'message_stop' })
          controller.close()
        })
      } })
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    }
  })
}

async function sendChat(page, index) {
  await page.getByPlaceholder('请输入消息').fill(`用量测试 ${index}`)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__accountChats.length)).toBe(index + 1)
}

async function finishChat(page, index, result = 'normal') {
  await page.evaluate(({ index, result }) => window.__accountChats[index](result), { index, result })
}

async function updateKey(page, key, fail = false) {
  await page.getByRole('tab', { name: '数据管理', exact: true }).click()
  await page.getByRole('button', { name: '修改 API Key', exact: true }).click()
  const keyInput = page.getByPlaceholder('请输入 API Key')
  await keyInput.fill(key)
  await page.getByRole('button', { name: '确定', exact: true }).click()
  if (fail) await expect(page.getByText(/Simulated secure key save failed/)).toBeVisible()
  else await expect(keyInput).toBeHidden()
}

test('balance is lazy, renders exact currency amounts, caches remounts, and refreshes status and update time', async ({ page }) => {
  const mock = await setup(page)
  await page.goto('/')
  await openSettings(page)
  await expect(balanceTab(page)).toBeVisible()
  expect(mock.requests).toHaveLength(0)
  await balanceTab(page).click()
  await expect(balance(page).getByText('0.1200', { exact: true })).toBeVisible()
  await expect(balance(page).getByText('10.0001', { exact: true })).toBeVisible()
  const dateTime = await balance(page).locator('time').getAttribute('datetime')
  expect(Number.isFinite(Date.parse(dateTime))).toBe(true)
  expect(mock.requests).toEqual([{ url: 'https://api.deepseek.com/user/balance', method: 'GET', authorization: `Bearer ${baseKey}`, body: null }])
  for (const [label, href] of [['前往官方充值', 'https://platform.deepseek.com/top_up'], ['打开官方开放平台', 'https://platform.deepseek.com/']]) {
    const link = balance(page).getByRole('link', { name: label })
    await expect(link).toHaveAttribute('href', href)
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  }
  await page.getByRole('tab', { name: '数据管理', exact: true }).click()
  await balanceTab(page).click()
  await expect(balance(page).locator('time')).toHaveAttribute('datetime', dateTime)
  expect(mock.requests).toHaveLength(1)
  const refresh = balance(page).getByRole('button', { name: '刷新余额' })
  const status = balance(page).getByRole('status')
  mock.reply({ json: { is_available: false, balance_infos: [] } })
  await refresh.click()
  await expect(status).toContainText('余额不足')
  expect(mock.requests).toHaveLength(2)
  mock.reply({ status: 401, json: { private: 'must never appear' } })
  await refresh.click()
  await expect(status).toContainText('鉴权失败')
  mock.reply('failed')
  await refresh.click()
  await expect(status).toContainText('无法查询余额，请检查网络')
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }))
  await refresh.click()
  await expect(status).toContainText('设备离线')
  expect(mock.requests).toHaveLength(4)
})

test('no key does not request a balance and leaves refresh disabled', async ({ page }) => {
  const mock = await setup(page, null)
  await page.goto('/')
  // First-run onboarding automatically opens Settings to enter the key.
  await balanceTab(page).click()
  await expect(balance(page).getByRole('status')).toContainText('添加 API Key')
  await expect(balance(page).getByRole('button', { name: '刷新余额' })).toBeDisabled()
  expect(mock.requests).toHaveLength(0)
})

test('counts only the final valid cumulative usage on completed chat; reload persists and manual reset is explicit', async ({ page }) => {
  await setup(page)
  await installChat(page)
  await page.goto('/')
  for (const [index, result] of ['normal', 'eof', 'bad'].entries()) {
    await sendChat(page, index)
    await finishChat(page, index, result)
  }
  await openAccount(page)
  await expect(todayValues(page)).toHaveText(['29', '7', '8'])
  const last30 = usage(page).getByRole('heading', { name: '最近 30 天（含今天）' }).locator('..').locator('dd')
  await expect(last30).toHaveText(['29', '7', '8'])
  await page.reload()
  await openAccount(page)
  await expect(todayValues(page)).toHaveText(['29', '7', '8'])
  await usage(page).getByRole('button', { name: '清空本机用量' }).click()
  await usage(page).getByRole('button', { name: '取消' }).click()
  await expect(todayValues(page)).toHaveText(['29', '7', '8'])
  await usage(page).getByRole('button', { name: '清空本机用量' }).click()
  await usage(page).getByRole('button', { name: '确认清空' }).click()
  await expect(todayValues(page)).toHaveText(['0', '0', '0'])
  expect(await page.evaluate((key) => localStorage.getItem(key), usageKey)).toBeNull()
})

test('reply sheets use final receipts, track the selected branch, and survive reload', async ({ page }) => {
  const mock = await setup(page)
  await installChat(page)
  await page.clock.setFixedTime(new Date('2026-11-27T22:30:00+08:00'))
  await page.goto('/')
  await sendChat(page, 0)
  await finishChat(page, 0)
  const trigger = page.getByTestId('reply-usage-button')
  const dialog = page.getByTestId('reply-usage-dialog')
  const total = dialog.getByTestId('reply-usage-total')
  await trigger.click()
  await expect(total).toHaveText('¥0.00004916')
  await expect(dialog.getByTestId('reply-usage-context')).toContainText('<1%')
  await expect.poll(() => page.evaluate(() => window.__deepseekAndroidBack())).toBe(true)
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  await page.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__accountChats.length)).toBe(2)
  await finishChat(page, 1, 'second')
  await trigger.click()
  await expect(total).toHaveText('¥0.000452')
  await expect(dialog.getByTestId('reply-usage-row')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: '上一个版本', exact: true }).click()
  await trigger.click()
  await expect(total).toHaveText('¥0.00004916')
  expect(mock.requests).toHaveLength(0)
  await page.reload()
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByText('用量回归会话', { exact: true }).click()
  await trigger.click()
  await expect(total).toHaveText('¥0.00004916')
})

test('a reply without a complete receipt never shows partial tokens as a bill', async ({ page }) => {
  await setup(page)
  await installChat(page)
  await page.goto('/')
  await sendChat(page, 0)
  await finishChat(page, 0, 'eof')
  await page.getByTestId('reply-usage-button').click()
  const dialog = page.getByTestId('reply-usage-dialog')
  await expect(dialog.getByText(/用量未返回或记录不完整/)).toBeVisible()
  await expect(dialog.getByTestId('reply-usage-total')).toHaveText('—')
  await expect(dialog.getByTestId('reply-usage-row')).toHaveCount(0)
})

test('only an actual successful key change clears usage and late old-key stream completion cannot restore it', async ({ page }) => {
  const mock = await setup(page)
  await installChat(page)
  await page.goto('/')
  await sendChat(page, 0)
  await finishChat(page, 0)
  await openAccount(page)
  await expect(todayValues(page)).toHaveText(['29', '7', '8'])
  await updateKey(page, 'sk-account-fail', true)
  await balanceTab(page).click()
  await expect(todayValues(page)).toHaveText(['29', '7', '8'])
  // The previous failed editor is still active until the dialog closes.
  await closeSettings(page)
  await openSettings(page)
  await updateKey(page, baseKey)
  await balanceTab(page).click()
  await expect(todayValues(page)).toHaveText(['29', '7', '8'])
  expect(mock.requests).toHaveLength(1)
  await closeSettings(page)
  await sendChat(page, 1)
  await openSettings(page)
  await updateKey(page, 'sk-changed-account-mock')
  await balanceTab(page).click()
  await expect(todayValues(page)).toHaveText(['0', '0', '0'])
  await expect.poll(() => mock.requests.at(-1)?.authorization).toBe('Bearer sk-changed-account-mock')
  await finishChat(page, 1)
  await closeSettings(page)
  await expect(page.getByText('模拟用量回复', { exact: true })).toHaveCount(2)
  await openAccount(page)
  await expect(todayValues(page)).toHaveText(['0', '0', '0'])
  expect(await page.evaluate((key) => localStorage.getItem(key), usageKey)).toBeNull()
})

test('removing the key clears accounting but does not delete conversations', async ({ page }) => {
  const mock = await setup(page)
  await installChat(page)
  await page.goto('/')
  await sendChat(page, 0)
  await finishChat(page, 0)
  await openAccount(page)
  await expect(todayValues(page)).toHaveText(['29', '7', '8'])
  await expect(balance(page).getByText('10.0001', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '数据管理', exact: true }).click()
  await page.getByRole('button', { name: '删除 API Key', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '删除 API Key', exact: true })
  await confirm.getByRole('button', { name: '删除 API Key', exact: true }).click()
  await expect(page.getByPlaceholder('请输入 API Key')).toBeVisible()
  await balanceTab(page).click()
  await expect(todayValues(page)).toHaveText(['0', '0', '0'])
  await expect(balance(page).getByRole('status')).toContainText('添加 API Key')
  expect(mock.requests).toHaveLength(1)
  expect(await page.evaluate(() => sessionStorage.getItem('test:simulated-native-key'))).toBe('null')
  await closeSettings(page)
  await expect(page.getByText('模拟用量回复', { exact: true })).toBeVisible()
})
