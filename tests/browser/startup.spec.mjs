import { test, expect } from '@playwright/test'

// Explicitly release bridge replies so startup/paint and write ordering need no timer sleeps.
async function mockStartupBridge(page, options = {}) {
  await page.addInitScript(({ legacyKey, disabled = false }) => {
    if (legacyKey) { localStorage.setItem('chat-demo:api-key', legacyKey) }
    if (disabled) { localStorage.setItem('chat-demo:diagnostics-enabled', 'false') }

    const calls = []
    const state = { calls, nativeEnabled: !disabled }
    // Model the native preference as independent of subsequent web storage updates.
    const bridge = {
      onmessage: null,
      postMessage(raw) {
        const { id, action, enabled } = JSON.parse(raw)
        calls.push({ id, action, enabled,
          secure: document.documentElement.dataset.android === 'true',
          legacyKeyPresent: localStorage.getItem('chat-demo:api-key') !== null })
      },
    }
    window.DeepSeekAndroid = bridge
    window.__startupFixture = state
    window.__replyToStartup = (index, result) => {
      const { id, action, enabled } = calls[index]
      if (action === 'setDiagnosticsEnabled' && result.ok) { state.nativeEnabled = enabled }
      bridge.onmessage({ data: JSON.stringify({ id, ...result }) })
    }
  }, options)
  // Never reach the real API from these tests, even if startup regresses.
  const apiRequests = []
  await page.route('https://api.deepseek.com/**', (route) => {
    apiRequests.push(route.request().url())
    return route.fulfill({ json: { object: 'list', data: [] }, headers: { 'access-control-allow-origin': '*' } })
  })
  return apiRequests
}

const calls = (page) => page.evaluate(() => window.__startupFixture.calls)
const actions = async (page) => (await calls(page)).map(({ action }) => action)
const reply = (page, index, result) => page.evaluate(({ index, result }) => window.__replyToStartup(index, result), { index, result })

async function openDiagnostics(page) {
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '数据管理' }).click()
  return page.getByRole('switch', { name: '记录诊断日志', exact: true })
}

test('the app paints and is usable during a hung startup sync; a failed sync does not block the queued toggle', async ({ page }) => {
  await mockStartupBridge(page)
  await page.goto('/')
  const composer = page.getByPlaceholder('请输入消息')
  await expect.poll(() => actions(page)).toEqual(['getKey'])
  await expect(composer).toHaveCount(0)

  await reply(page, 0, { ok: true, value: 'sk-fixture-secure' })
  await expect(composer).toBeVisible()
  await expect.poll(() => actions(page)).toEqual(['getKey', 'setDiagnosticsEnabled'])
  expect((await calls(page))[1]).toMatchObject({ enabled: true, secure: true })
  await composer.fill('诊断仍在等待回复')
  await expect(composer).toHaveValue('诊断仍在等待回复')

  const logging = await openDiagnostics(page)
  await logging.click()
  await expect(logging).toBeDisabled()
  expect(await actions(page)).toEqual(['getKey', 'setDiagnosticsEnabled'])

  await reply(page, 1, { ok: false, error: { code: 'native_error', message: 'diagnostics unavailable' } })
  await expect.poll(async () => (await calls(page)).slice(1).map(({ enabled }) => enabled)).toEqual([true, false])
  await reply(page, 2, { ok: true, value: null })
  await expect(logging).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => ({
    web: localStorage.getItem('chat-demo:diagnostics-enabled'),
    native: window.__startupFixture.nativeEnabled,
  }))).toEqual({ web: 'false', native: false })
})

test('secure key failure never mounts the app, falls back to a plaintext key, or syncs diagnostics', async ({ page }) => {
  const legacyKey = 'sk-fixture-legacy-do-not-use'
  const apiRequests = await mockStartupBridge(page, { legacyKey })
  await page.goto('/')
  await expect.poll(() => actions(page)).toEqual(['getKey'])
  await reply(page, 0, { ok: false, error: { code: 'native_error', message: 'fixture keystore failure' } })

  await expect(page.getByText(/无法初始化安全存储或应用资源/)).toBeVisible()
  await expect(page.getByRole('button', { name: '重试 / Retry' })).toBeVisible()
  await expect(page.getByPlaceholder('请输入消息')).toHaveCount(0)
  expect(await actions(page)).toEqual(['getKey'])
  expect(await page.evaluate(() => localStorage.getItem('chat-demo:api-key'))).toBe(legacyKey)
  expect(apiRequests).toEqual([])
})

test('after secure migration a disabled preference never sends an enable or records new web events', async ({ page }) => {
  await mockStartupBridge(page, { legacyKey: 'sk-fixture-migrate', disabled: true })
  await page.goto('/')
  await expect.poll(() => actions(page)).toEqual(['getKey'])
  await reply(page, 0, { ok: true, value: null })
  await expect.poll(() => actions(page)).toEqual(['getKey', 'setKey'])
  await expect(page.getByPlaceholder('请输入消息')).toHaveCount(0)
  expect((await calls(page))[1]).toMatchObject({ secure: false, legacyKeyPresent: true })

  await reply(page, 1, { ok: true, value: null })
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  await expect.poll(() => actions(page)).toEqual(['getKey', 'setKey', 'setDiagnosticsEnabled'])
  expect((await calls(page))[2]).toMatchObject({ enabled: false, secure: true, legacyKeyPresent: false })
  await reply(page, 2, { ok: false, error: { code: 'native_error', message: 'diagnostics unavailable' } })
  const logging = await openDiagnostics(page)
  await expect(logging).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => {
    window.dispatchEvent(new Event('android-background'))
    return {
      native: window.__startupFixture.nativeEnabled,
      web: localStorage.getItem('chat-demo:diagnostics-enabled'),
      events: JSON.parse(localStorage.getItem('chat-demo:diagnostics')),
    }
  })).toEqual({ native: false, web: 'false', events: [] })
  expect(await actions(page)).toEqual(['getKey', 'setKey', 'setDiagnosticsEnabled'])
})
