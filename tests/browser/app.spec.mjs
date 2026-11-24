import { test, expect } from '@playwright/test'
import { unzipSync, strFromU8 } from 'fflate'

// These are frontend regressions using a SIMULATED native bridge and API.
// They do not certify Android Keystore, physical microphone, real model quality or API billing.
async function setup(page, options = {}) {
  await page.addInitScript(({ key = 'sk-simulated-only', failSave = false, cancelSave = false, oldEngine = false }) => {
    if (oldEngine) {
      delete Array.prototype.toReversed
      delete Array.prototype.toSorted
      delete AbortSignal.prototype.throwIfAborted
      delete AbortSignal.prototype.reason
    }
    window.__nativeCalls = []
    window.__nativeChunks = []
    window.__savedKey = key
    window.__nativeLogging = localStorage.getItem('chat-demo:diagnostics-enabled') !== 'false'
    window.__nativeEvents = window.__nativeLogging ? [
      { t: Date.now(), event: 'native.start', details: { androidSdk: 35, message: 'PRIVATE_NATIVE_MESSAGE', apiKey: 'sk-native-secret' } },
      { t: Date.now(), event: 'native.permission.request', details: { pending: true } },
      { t: Date.now(), event: 'native.permission.result', details: { granted: false, status: 1 } },
      { t: Date.now(), event: 'native.lifecycle.pause', details: { pending: true } },
    ] : []
    const bridge = { onmessage: null, postMessage(raw) {
      const message = JSON.parse(raw)
      window.__nativeCalls.push(message)
      let value = null
      let error
      if (message.action === 'getKey') value = window.__savedKey
      if (message.action === 'setKey') {
        if (failSave) error = { code: 'native_error', message: 'Test Keystore failure' }
        else window.__savedKey = message.value
      }
      if (message.action === 'saveBegin') {
        if (cancelSave) error = { code: 'cancelled', message: 'Save cancelled' }
        else { value = 'simulated-export'; window.__nativeChunks = [] }
      }
      if (message.action === 'saveChunk') window.__nativeChunks.push(message.data)
      if (message.action === 'setDiagnosticsEnabled') window.__nativeLogging = message.enabled
      if (message.action === 'clearDiagnostics') window.__nativeEvents = []
      if (message.action === 'getDiagnostics') value = {
        versionName: '1.0.4', versionCode: 5, androidSdk: 35, webViewVersion: '145.0.0.0',
        microphoneGranted: true, audioSettingsGranted: true, enabled: window.__nativeLogging, events: window.__nativeEvents,
        apiKey: 'sk-native-secret', message: 'PRIVATE_NATIVE_MESSAGE',
      }
      queueMicrotask(() => bridge.onmessage?.({ data: JSON.stringify({ id: message.id, ok: !error, value, error }) }))
    } }
    window.DeepSeekAndroid = bridge
  }, options)
  await page.route('https://api.deepseek.com/models', (route) => route.fulfill({
    json: { object: 'list', data: [{ id: 'deepseek-flash' }] },
    headers: { 'access-control-allow-origin': '*' },
  }))
}

const sse = (text, stopReason = 'end_turn') => [
  { type: 'message_start', message: { id: 'mock-message', role: 'assistant' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stopReason, title: '测试会话' } },
  { type: 'message_stop' },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

async function mockChat(page, text = '这是模拟接口的回答。') {
  const requests = []
  await page.route('https://api.deepseek.com/anthropic/v1/messages', async (route) => {
    const body = route.request().postDataJSON()
    expect(body).not.toHaveProperty('safety_check')
    requests.push(body)
    await route.fulfill({ status: 200, contentType: 'text/event-stream',
      headers: { 'access-control-allow-origin': '*' }, body: sse(text) })
  })
  return requests
}

// Use the production IndexedDB reader rather than opening a thousand network turns.
async function seedLongHistory(page, count, alternate = false) {
  await page.goto('/')
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  await page.evaluate(async ({ count, alternate }) => {
    const open = indexedDB.open('chat-demo')
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    try {
      const now = Date.now()
      const messages = Array.from({ length: count }, (_, i) => ({
        id: `perf-${i}`,
        parentId: i === 0 ? null : `perf-${i - 1}`,
        selectedChildId: i < count - 1 ? `perf-${i + 1}` : undefined,
        createdAt: now,
        ...(i % 2 === 0 ? { role: 'user', content: `历史问题 ${i}`, files: [] } : {
          role: 'assistant', status: 'done', prefix: true, model: 'deepseek-flash',
          blocks: [{ type: 'text', text: `历史回答 ${i}` }],
        }),
      }))
      if (alternate) {
        // Both branches need content below the switcher to keep the requested scroll
        // position possible when the viewport would otherwise clamp to the new bottom.
        messages.push(
          { ...messages.at(-1), id: 'alternate', selectedChildId: 'alt-question', blocks: [{ type: 'text', text: '历史回答另一个版本' }] },
          { id: 'alt-question', parentId: 'alternate', selectedChildId: 'alt-answer', createdAt: now, role: 'user', content: '另一个分支的提问', files: [] },
          { ...messages.at(-1), id: 'alt-answer', parentId: 'alt-question', blocks: [{ type: 'text', text: '分支尾部'.repeat(300) }] },
        )
      }
      const summary = { id: 'perf-session', title: '长对话样本', createdAt: now, updatedAt: now }
      const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
      tx.objectStore('sessions').put({ ...summary, rootMessageId: 'perf-0', messages })
      tx.objectStore('sessionSummaries').put({ ...summary, fileIds: [] })
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve
        tx.onabort = () => reject(tx.error)
      })
    } finally { db.close() }
  }, { count, alternate })
  await page.reload()
  await openLongHistory(page)
  await expect(page.getByText(`历史回答 ${count - 1}`, { exact: true })).toBeVisible()
}

async function openLongHistory(page) {
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByText('长对话样本', { exact: true }).last().click()
}

async function controlledReply(page) {
  await page.addInitScript(() => {
    // Narrow count: actual calls to map on the seeded conversation's whole message array.
    // It records structural work, not total rendering time or frame rate.
    const map = Array.prototype.map
    window.__historyMaps = 0
    Array.prototype.map = function (...args) {
      if (this.length >= 20 && this[0]?.id === 'perf-0') window.__historyMaps++
      return Reflect.apply(map, this, args)
    }
    const fetch = window.fetch.bind(window)
    window.__chatRequests = []
    window.fetch = (url, init) => {
      if (url !== 'https://api.deepseek.com/anthropic/v1/messages') return fetch(url, init)
      window.__chatRequests.push(JSON.parse(init.body))
      const stream = new ReadableStream({ start(controller) {
        const push = (event) => controller.enqueue(new TextEncoder().encode(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
        push({ type: 'message_start', message: { id: 'mock-live', role: 'assistant' } })
        push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        window.__liveDelta = (text) => push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        window.__liveEnd = () => {
          push({ type: 'content_block_stop', index: 0 })
          push({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })
          push({ type: 'message_stop' })
          controller.close()
        }
      } })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
  })
}

async function send(page, prompt = '你好') {
  await page.getByPlaceholder('请输入消息').fill(prompt)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}

async function openData(page) {
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '数据管理' }).click()
}

async function controlledMicrophone(page, deferred = true) {
  await page.addInitScript(({ deferred }) => {
    const Original = window.AudioContext
    window.__audioOrder = []
    window.__captureContexts = []
    window.AudioContext = class extends Original {
      constructor(options) { super(options); window.__audioOrder.push('context'); window.__captureContexts.push(this) }
      createScriptProcessor(...args) {
        const node = super.createScriptProcessor(...args)
        let callback = null
        // Deterministic fixture: feed PCM explicitly; do not depend on host audio hardware/timers.
        Object.defineProperty(node, 'onaudioprocess', { get: () => callback, set: (value) => { callback = value } })
        window.__testProcessor = node
        return node
      }
    }
    navigator.mediaDevices.getUserMedia = () => {
      window.__audioOrder.push('permission')
      return new Promise((resolve, reject) => {
        window.__grantMicrophone = () => {
          const context = new Original()
          const destination = context.createMediaStreamDestination()
          const track = destination.stream.getTracks()[0]
          const stop = track.stop.bind(track)
          track.stop = () => { stop(); void context.close().catch(() => {}) }
          window.__testStream = destination.stream
          resolve(destination.stream)
        }
        window.__denyMicrophone = () => reject(new DOMException('Fixture permission denied', 'NotAllowedError'))
        window.__unreadableMicrophone = () => reject(new DOMException('Could not start audio source', 'NotReadableError'))
        if (!deferred) window.__grantMicrophone()
      })
    }
  }, { deferred })
}

async function exportLogJson(page) {
  await page.getByRole('button', { name: '导出日志', exact: true }).click()
  await expect(page.getByText('诊断日志已导出', { exact: true })).toBeVisible()
  const chunks = await page.evaluate(() => window.__nativeChunks)
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64'))).toString('utf8')
  return { text, data: JSON.parse(text) }
}

test('permission-dialog visibility does not cancel Android capture and empty recording is explained', async ({ page }) => {
  await setup(page)
  await controlledMicrophone(page)
  let requests = 0
  await page.route('https://api.deepseek.com/v1/tools/asr', (route) => { requests++; return route.fulfill({ json: { text: 'unexpected' } }) })
  await page.goto('/')
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在启动录音，点击取消', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__audioOrder)).toEqual(['context', 'permission'])
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.getByRole('button', { name: '正在启动录音，点击取消', exact: true })).toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    window.__grantMicrophone()
  })
  await page.getByRole('button', { name: '结束录音并转写', exact: true }).click()
  await expect(page.getByText(/未录到声音/)).toBeVisible()
  expect(await page.evaluate(() => window.__testStream.getTracks()[0].readyState)).toBe('ended')
  expect(requests).toBe(0)
})

test('true Android background cancels pending permission and stops a late microphone stream', async ({ page }) => {
  await setup(page)
  await controlledMicrophone(page)
  await page.goto('/')
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在启动录音，点击取消', exact: true })).toBeVisible()
  await page.evaluate(() => window.__deepseekAndroidBackground())
  await expect(page.getByRole('button', { name: '语音输入', exact: true })).toBeVisible()
  await page.evaluate(() => window.__grantMicrophone())
  await expect.poll(() => page.evaluate(() => window.__testStream?.getTracks()[0].readyState)).toBe('ended')
  await expect.poll(() => page.evaluate(() => window.__captureContexts[0]?.state)).toBe('closed')
})

test('permission denial is visible and diagnosis export contains metadata but no private content', async ({ page }) => {
  await setup(page, { key: 'sk-private-key-never-export' })
  await controlledMicrophone(page)
  await mockChat(page, 'PRIVATE_CHAT_RESPONSE')
  await page.goto('/')
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await page.evaluate(() => window.__denyMicrophone())
  await expect(page.getByText(/无法使用麦克风/)).toBeVisible()
  await send(page, 'PRIVATE_CHAT_PROMPT')
  await expect(page.getByText('PRIVATE_CHAT_RESPONSE', { exact: true })).toBeVisible()
  await openData(page)
  const { text, data } = await exportLogJson(page)
  for (const secret of ['sk-private-key-never-export', 'PRIVATE_CHAT_PROMPT', 'PRIVATE_CHAT_RESPONSE', 'PRIVATE_NATIVE_MESSAGE', 'sk-native-secret', 'Fixture permission denied']) expect(text).not.toContain(secret)
  expect(data.web.events.some((event) => event.event === 'audio.permission.error' && event.details.errorName === 'NotAllowedError')).toBe(true)
  expect(data.web.events.some((event) => event.event === 'api.response')).toBe(true)
  expect(data.native.versionName).toBe('1.0.4')
  expect(data.native.audioSettingsGranted).toBe(true)
  expect(data.native.events[0].details).toEqual({ androidSdk: 35 })
  expect(data.native.events.some((event) => event.event === 'native.permission.result' && event.details.status === 1)).toBe(true)
  expect(data.native.events.some((event) => event.event === 'native.lifecycle.pause')).toBe(true)
})

test('diagnostic logging can be disabled, cleared and exported after reload without recording new events', async ({ page }) => {
  await setup(page)
  await mockChat(page)
  await page.goto('/')
  await openData(page)
  const logging = page.getByRole('switch', { name: '记录诊断日志', exact: true })
  await expect(logging).toHaveAttribute('aria-checked', 'true')
  await logging.click()
  await expect(logging).toHaveAttribute('aria-checked', 'false')
  await page.getByRole('button', { name: '清空日志', exact: true }).click()
  await expect(page.getByText('诊断日志已清空', { exact: true })).toBeVisible()
  await page.reload()
  await send(page)
  await expect(page.getByText('这是模拟接口的回答。', { exact: true })).toBeVisible()
  await openData(page)
  await expect(logging).toHaveAttribute('aria-checked', 'false')
  const { data } = await exportLogJson(page)
  expect(data.web.loggingEnabled).toBe(false)
  expect(data.web.events).toEqual([])
  expect(data.native.enabled).toBe(false)
  expect(data.native.events).toEqual([])
})

test('zero-PCM capture reports a startup stall and releases resources within five seconds', async ({ page }) => {
  await setup(page)
  await controlledMicrophone(page, false)
  await page.goto('/')
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await expect(page.getByRole('button', { name: '结束录音并转写', exact: true })).toBeVisible()
  await expect(page.getByText(/无法开始录音/)).toBeVisible({ timeout: 8000 })
  expect(await page.evaluate(() => window.__testStream.getTracks()[0].readyState)).toBe('ended')
})

test('ASR HTTP errors are actionable and their raw response is excluded from exported logs', async ({ page }) => {
  await setup(page)
  await controlledMicrophone(page, false)
  await page.route('https://api.deepseek.com/v1/tools/asr', (route) => route.fulfill({ status: 403, json: { error: { message: 'PRIVATE_ASR_BODY sk-do-not-export' } }, headers: { 'access-control-allow-origin': '*' } }))
  await page.goto('/')
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await page.getByRole('button', { name: '结束录音并转写', exact: true }).waitFor()
  await page.evaluate(() => window.__testProcessor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } }))
  await page.getByRole('button', { name: '结束录音并转写', exact: true }).click()
  await expect(page.getByText(/HTTP 403/)).toBeVisible()
  await openData(page)
  const { text, data } = await exportLogJson(page)
  expect(text).not.toContain('PRIVATE_ASR_BODY')
  expect(text).not.toContain('sk-do-not-export')
  expect(data.web.events.some((event) => event.event === 'api.error' && event.details.api === 'asr' && event.details.status === 403)).toBe(true)
})

test('NotReadableError is distinguished from denied permission and ASR without guessing microphone occupancy', async ({ page }) => {
  await setup(page)
  await controlledMicrophone(page)
  await page.goto('/')
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await page.evaluate(() => window.__unreadableMicrophone())
  await expect(page.getByText('无法打开音频输入设备。请导出诊断日志排查。', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__captureContexts[0]?.state)).toBe('closed')
  await openData(page)
  const { data } = await exportLogJson(page)
  expect(data.native.microphoneGranted).toBe(true)
  expect(data.native.audioSettingsGranted).toBe(true)
  expect(data.web.events.some((event) => event.event === 'audio.permission.error' && event.details.errorName === 'NotReadableError')).toBe(true)
  expect(data.web.events.some((event) => event.event === 'api.start' && event.details.api === 'asr')).toBe(false)
})

test('first run validates and saves a key only through the simulated native store', async ({ page }) => {
  await setup(page, { key: null })
  await page.goto('/')
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible()
  await page.getByPlaceholder('请输入 API Key').fill('sk-only-a-test')
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.getByPlaceholder('请输入 API Key')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('chat-demo:api-key'))).toBeNull()
  expect(await page.evaluate(() => window.__savedKey)).toBe('sk-only-a-test')
  expect(await page.evaluate(() => window.__deepseekAndroidBack())).toBe(true)
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toHaveCount(0)
})

test('native storage failure is shown without pretending the key was saved', async ({ page }) => {
  await setup(page, { key: null, failSave: true })
  await page.goto('/')
  await page.getByPlaceholder('请输入 API Key').fill('sk-only-a-test')
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.getByText(/Test Keystore failure/)).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('chat-demo:api-key'))).toBeNull()
  expect(await page.evaluate(() => window.__savedKey)).toBeNull()
})

test('mobile chat keeps official protocol, thinking/search switches, history and copy', async ({ page }) => {
  await setup(page, { oldEngine: true })
  const requests = await mockChat(page)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: '深度思考', exact: true }).click()
  await page.getByRole('button', { name: '智能搜索', exact: true }).click()
  await send(page)
  await expect(page.getByText('这是模拟接口的回答。', { exact: true })).toBeVisible()
  expect(requests[0].model).toBe('deepseek-flash')
  expect(requests[0].thinking.type).toBe('enabled')
  expect(requests[0].tools.map((tool) => tool.name)).toEqual(['deepseek_read_url', 'deepseek_web_search'])
  await page.getByRole('button', { name: '复制', exact: true }).last().click()
  await expect.poll(() => page.evaluate(() => window.__nativeCalls.filter((call) => call.action === 'copyText').length)).toBe(1)
  await page.reload()
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByText('测试会话', { exact: true }).click()
  await expect(page.getByText('这是模拟接口的回答。', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('all generation paths omit optional safety_check without breaking tools or server refusal handling', async ({ page }) => {
  await setup(page)
  const requests = []
  await page.route('https://api.deepseek.com/anthropic/v1/messages', async (route) => {
    const body = route.request().postDataJSON()
    expect(body).not.toHaveProperty('safety_check')
    requests.push(body)
    const index = requests.length
    const text = `模拟回归回答${index}`
    await route.fulfill({ status: 200, contentType: 'text/event-stream',
      headers: { 'access-control-allow-origin': '*' },
      body: sse(text, index === 1 ? 'max_tokens' : index === 6 ? 'refusal' : 'end_turn'),
    })
  })
  await page.goto('/')
  await send(page, '首次提问')
  await expect(page.getByText('模拟回归回答1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续生成', exact: true }).click()
  await expect(page.getByText(/模拟回归回答1.*模拟回归回答2/)).toBeVisible()
  expect(requests[1].messages.at(-1).role).toBe('assistant')
  await page.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect(page.getByText('模拟回归回答3', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '编辑消息', exact: true }).click()
  await page.getByRole('textbox', { name: '编辑消息', exact: true }).fill('修改后的提问')
  await page.getByRole('textbox', { name: '编辑消息', exact: true }).locator('..').getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('模拟回归回答4', { exact: true })).toBeVisible()
  expect(requests[3].messages.at(-1).content).toBe('修改后的提问')
  await page.getByRole('button', { name: '深度思考', exact: true }).click()
  await page.getByRole('button', { name: '智能搜索', exact: true }).click()
  await send(page, '开启思考搜索后的追问')
  await expect(page.getByText('模拟回归回答5', { exact: true })).toBeVisible()
  expect(requests[4].thinking.type).toBe('enabled')
  expect(requests[4].tools.map((tool) => tool.name)).toEqual(['deepseek_read_url', 'deepseek_web_search'])
  await send(page, '模拟服务端拒答响应')
  await expect(page.getByText('我无法回答这个问题。你可以试试其他话题。', { exact: true })).toBeVisible()
  await expect(page.getByText('模拟回归回答6', { exact: true })).toHaveCount(0)
  expect(requests).toHaveLength(6)
})

test('moderation switch hot-applies to later requests without aborting in-flight generation', async ({ page }) => {
  await setup(page)
  const requests = []
  const failures = []
  const pendingRequests = new Set()
  // SSE deliberately cancels its reader after message_stop; Chromium may then report ERR_ABORTED.
  // Only an abort while the server gate is still held would violate the switch's in-flight contract.
  page.on('requestfailed', (request) => {
    if (pendingRequests.has(request)) failures.push(request.url())
  })
  let releaseFirst
  let releaseThird
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const thirdGate = new Promise((resolve) => { releaseThird = resolve })
  page.once('close', () => { releaseFirst(); releaseThird() })
  await page.route('https://api.deepseek.com/anthropic/v1/messages', async (route) => {
    const body = route.request().postDataJSON()
    requests.push(body)
    const index = requests.length
    if (index === 1 || index === 3) {
      pendingRequests.add(route.request())
      await (index === 1 ? firstGate : thirdGate)
      pendingRequests.delete(route.request())
    }
    await route.fulfill({ status: 200, contentType: 'text/event-stream',
      headers: { 'access-control-allow-origin': '*' },
      body: sse(`热更新回答${index}`, index === 1 ? 'max_tokens' : 'end_turn'),
    })
  })
  await page.goto('/')
  await send(page, '先以默认检查发送')
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).not.toHaveProperty('safety_check')
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const moderation = page.getByRole('switch', { name: '额外内容安全审核', exact: true })
  await expect(moderation).toHaveAttribute('aria-checked', 'false')
  await moderation.click()
  await expect(moderation).toHaveAttribute('aria-checked', 'true')
  expect(await page.evaluate(() => localStorage.getItem('chat-demo:safety-check'))).toBe('true')
  await page.evaluate(() => window.__deepseekAndroidBack())
  await page.evaluate(() => window.__deepseekAndroidBack())
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  expect(requests).toHaveLength(1) // toggling does not resend or abort the posted request
  expect(requests[0]).not.toHaveProperty('safety_check')
  releaseFirst()
  await expect(page.getByText('热更新回答1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续生成', exact: true }).click()
  await expect(page.getByText(/热更新回答1.*热更新回答2/)).toBeVisible()
  expect(requests[1].safety_check).toEqual({ level: 'high' })
  await page.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect.poll(() => requests.length).toBe(3)
  expect(requests[2].safety_check).toEqual({ level: 'high' })
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await moderation.click()
  await expect(moderation).toHaveAttribute('aria-checked', 'false')
  await page.evaluate(() => window.__deepseekAndroidBack())
  await page.evaluate(() => window.__deepseekAndroidBack())
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  expect(requests).toHaveLength(3)
  expect(requests[2].safety_check).toEqual({ level: 'high' })
  releaseThird()
  await expect(page.getByText('热更新回答3', { exact: true })).toBeVisible()
  await send(page, '关闭后无需重启继续发送')
  await expect(page.getByText('热更新回答4', { exact: true })).toBeVisible()
  expect(requests[3]).not.toHaveProperty('safety_check')
  expect(failures).toEqual([])
})

test('moderation preference survives reload, remains editable in English, and affects the next request', async ({ page }) => {
  await setup(page)
  const requests = []
  await page.route('https://api.deepseek.com/anthropic/v1/messages', (route) => {
    requests.push(route.request().postDataJSON())
    return route.fulfill({ status: 200, contentType: 'text/event-stream',
      headers: { 'access-control-allow-origin': '*' }, body: sse('持久化审核测试回答'),
    })
  })
  await page.goto('/')
  await page.setViewportSize({ width: 320, height: 640 })
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('switch', { name: '额外内容安全审核', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('switch', { name: '额外内容安全审核', exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.evaluate(() => window.__deepseekAndroidBack())
  await page.evaluate(() => window.__deepseekAndroidBack())
  await send(page, '确认重启后沿用开关')
  await expect(page.getByText('持久化审核测试回答', { exact: true })).toBeVisible()
  expect(requests[0].safety_check).toEqual({ level: 'high' })
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '语言', exact: true }).click()
  await page.getByRole('option', { name: 'English', exact: true }).click()
  const englishSwitch = page.getByRole('switch', { name: 'Additional content moderation', exact: true })
  await expect(englishSwitch).toHaveAttribute('aria-checked', 'true')
  await englishSwitch.focus()
  await page.keyboard.press('Space')
  await expect(englishSwitch).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => localStorage.getItem('chat-demo:safety-check'))).toBe('false')
})

for (const count of [20, 200, 1000]) {
  test(`long stream structural comparison (${count} history messages)`, async ({ page }) => {
    await setup(page)
    await controlledReply(page)
    await seedLongHistory(page, count)
    await send(page, '长对话的新问题')
    await expect.poll(() => page.evaluate(() => window.__chatRequests.length)).toBe(1)
    const body = await page.evaluate(() => window.__chatRequests[0])
    const turns = body.messages.filter(({ role }) => role === 'user' || role === 'assistant')
    expect(turns).toHaveLength(count + 1)
    expect(turns[0].content).toBe('历史问题 0')
    expect(turns.at(-2).content[0].text).toBe(`历史回答 ${count - 1}`)
    expect(turns.at(-1).content).toBe('长对话的新问题')

    const answer = page.locator('.ds-assistant-message-main-content').last()
    let text = '流式起点'
    await page.evaluate((part) => window.__liveDelta(part), text)
    await expect(answer).toHaveText(text)
    const before = await page.evaluate(() => window.__historyMaps)
    for (let i = 0; i < 6; i++) {
      const part = '、追加'.repeat(i === 0 ? 100 : 1)
      text += part
      await page.evaluate((next) => window.__liveDelta(next), part)
      await expect(answer).toHaveText(text)
    }
    const passes = await page.evaluate((start) => window.__historyMaps - start, before)
    console.log(`[stream-structure] ${count} messages, 6 rendered deltas, ${passes} history maps`)
    if (process.env.CHAT_STREAM_BASELINE === '1') expect(passes).toBeGreaterThan(0)
    else expect(passes).toBe(0)
    await page.evaluate(() => window.__liveEnd())
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    await expect(answer).toHaveText(text)
  })
}

test('live answer survives background checkpoint and export, then stop, reload and branch switch', async ({ page }) => {
  await setup(page)
  await controlledReply(page)
  await seedLongHistory(page, 20, true)
  await send(page, '跟随测试问题')
  await expect.poll(() => page.evaluate(() => window.__chatRequests.length)).toBe(1)
  await page.evaluate(() => window.__liveDelta('实时起点'))
  await expect(page.getByText('实时起点', { exact: true })).toBeVisible()
  // Locate the real scrolling ancestor of the first history row, without depending on CSS hashes.
  const older = page.getByText('历史问题 0', { exact: true })
  const scrollAnchor = await older.evaluateHandle((element) => {
    for (let box = element.parentElement; box; box = box.parentElement) {
      if (getComputedStyle(box).overflowY === 'auto' && box.scrollHeight > box.clientHeight) return box
    }
    throw new Error('message scroll container missing')
  })
  await scrollAnchor.evaluate((box) => { box.scrollTop = 0 })
  await expect.poll(() => scrollAnchor.evaluate((box) => box.scrollTop)).toBe(0)
  const delta = '背景快照'.repeat(80)
  await page.evaluate((part) => window.__liveDelta(part), delta)
  await expect(page.locator('.ds-assistant-message-main-content').last()).toHaveText(`实时起点${delta}`)
  await page.evaluate(() => window.dispatchEvent(new Event('android-background')))
  expect(await scrollAnchor.evaluate((box) => box.scrollTop)).toBe(0)
  await expect.poll(() => page.evaluate(async () => {
    const request = indexedDB.open('chat-demo')
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const entry = db.transaction('sessions').objectStore('sessions').get('perf-session')
      return await new Promise((resolve, reject) => {
        entry.onsuccess = () => resolve(entry.result?.messages.at(-1)?.blocks?.[0]?.text)
        entry.onerror = () => reject(entry.error)
      })
    } finally { db.close() }
  })).toBe(`实时起点${delta}`)

  await page.evaluate(() => window.__liveDelta('仅实时导出'))
  const reply = `实时起点${delta}仅实时导出`
  await expect(page.locator('.ds-assistant-message-main-content').last()).toHaveText(reply)
  await openData(page)
  await page.getByRole('button', { name: '下载', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__nativeCalls.some((call) => call.action === 'saveEnd'))).toBe(true)
  const chunks = await page.evaluate(() => window.__nativeChunks)
  const zip = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')))
  expect(Object.values(unzipSync(zip)).map((bytes) => strFromU8(bytes)).join('\n')).toContain(reply)

  await page.evaluate(() => window.__deepseekAndroidBack())
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '收起边栏', exact: true }).click()
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续生成', exact: true })).toBeVisible()
  await page.reload()
  await openLongHistory(page)
  await expect(page.locator('.ds-assistant-message-main-content').last()).toHaveText(reply)
  const next = page.getByRole('button', { name: '下一个版本', exact: true })
  await next.scrollIntoViewIfNeeded()
  const top = (await next.boundingBox()).y
  await next.click()
  await expect(page.getByText('历史回答另一个版本', { exact: true })).toBeVisible()
  const previous = page.getByRole('button', { name: '上一个版本', exact: true })
  expect(Math.abs((await previous.boundingBox()).y - top)).toBeLessThan(10)
  await previous.click()
  await expect(page.locator('.ds-assistant-message-main-content').last()).toHaveText(reply)
})

test('native back dismisses settings before the drawer, then allows activity exit', async ({ page }) => {
  await setup(page)
  await page.goto('/')
  await openData(page)
  expect(await page.evaluate(() => window.__deepseekAndroidBack())).toBe(true)
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.__deepseekAndroidBack())).toBe(true)
  await expect(page.getByRole('button', { name: '设置', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.__deepseekAndroidBack())).toBe(false)
})

test('export ZIP goes through chunked bridge and reimports without ES2023 array APIs', async ({ page }) => {
  await setup(page, { oldEngine: true })
  await mockChat(page)
  await page.goto('/')
  await send(page)
  await expect(page.getByText('这是模拟接口的回答。', { exact: true })).toBeVisible()
  await openData(page)
  await page.getByRole('button', { name: '下载', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__nativeCalls.some((call) => call.action === 'saveEnd'))).toBe(true)
  const chunks = await page.evaluate(() => window.__nativeChunks)
  const zip = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')))
  const files = unzipSync(zip)
  expect(Object.keys(files)).toContain('manifest.json')
  expect(Object.values(files).map((bytes) => strFromU8(bytes)).join('\n')).not.toContain('sk-simulated-only')
  expect(Object.values(files).map((bytes) => strFromU8(bytes)).join('\n')).toContain('这是模拟接口的回答。')
  await page.locator('input[type=file][accept*=".zip"]').setInputFiles({ name: 'roundtrip.zip', mimeType: 'application/zip', buffer: zip })
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page.getByText('已导入 1 个对话', { exact: true })).toBeVisible()
})

test('cancelled export is silent and never sends contents', async ({ page }) => {
  await setup(page, { cancelSave: true })
  await mockChat(page)
  await page.goto('/')
  await send(page)
  await expect(page.getByText('这是模拟接口的回答。', { exact: true })).toBeVisible()
  await openData(page)
  await page.getByRole('button', { name: '下载', exact: true }).click()
  await expect(page.getByRole('button', { name: '下载', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => window.__nativeCalls.filter((call) => call.action === 'saveChunk' || call.action === 'saveEnd').length)).toBe(0)
  await expect(page.getByText(/导出失败/)).toHaveCount(0)
})

test('network failure is recoverable and does not erase the user prompt', async ({ page }) => {
  await setup(page)
  await page.route('https://api.deepseek.com/anthropic/v1/messages', (route) => route.abort('internetdisconnected'))
  await page.goto('/')
  await send(page, '断网测试提问')
  await expect(page.getByText('断网测试提问', { exact: true })).toBeVisible()
  await expect(page.getByText('网络连接失败，请检查网络后重试。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
})

test('Markdown code, formula and Mermaid still render under strict CSP', async ({ page }) => {
  await setup(page)
  await mockChat(page, '# 测试标题\n\n**粗体**\n\n$$x^2 + y^2$$\n\n```javascript\nconst x = 1\n```\n\n```mermaid\ngraph TD\nA[开始] --> B[结束]\n```')
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await send(page)
  await expect(page.getByRole('heading', { name: '测试标题' })).toBeVisible()
  await expect(page.locator('.katex').first()).toBeVisible()
  await expect(page.locator('.md-mermaid-diagram svg')).toBeVisible()
  expect(errors).toEqual([])
})

test('image upload uses official Files API and safe in-app preview/save', async ({ page }) => {
  await setup(page)
  const requests = await mockChat(page)
  await page.route('https://api.deepseek.com/anthropic/v1/files', (route) => route.fulfill({
    json: { id: 'file-simulated-image' }, headers: { 'access-control-allow-origin': '*' },
  }))
  await page.goto('/')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=', 'base64')
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: png })
  await send(page, '描述图片')
  await expect(page.getByText('这是模拟接口的回答。', { exact: true })).toBeVisible()
  expect(requests[0].messages.at(-1).content[0].source.file_id).toBe('file-simulated-image')
  await page.getByRole('button', { name: 'tiny.png', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'tiny.png' })).toBeVisible()
  expect(await page.locator('iframe').count()).toBe(0)
  await page.getByRole('button', { name: '下载', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__nativeCalls.some((call) => call.action === 'saveEnd'))).toBe(true)
  const chunks = await page.evaluate(() => window.__nativeChunks)
  expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')))).toEqual(png)
})

async function pngFixture(page, width, height) {
  const data = await page.evaluate(([width, height]) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#1789be'
    ctx.fillRect(0, 0, width, height)
    return canvas.toDataURL('image/png').split(',')[1]
  }, [width, height])
  return Buffer.from(data, 'base64')
}

async function mockFileUploads(page) {
  const uploads = []
  await page.route('https://api.deepseek.com/anthropic/v1/files', async (route) => {
    const request = route.request()
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': '*',
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    const form = await new Response(request.postDataBuffer(), {
      headers: { 'content-type': request.headers()['content-type'] },
    }).formData()
    expect([...form.keys()]).toEqual(form.has('purpose') ? ['purpose', 'file'] : ['file'])
    const file = form.get('file')
    const id = `file-sized-${uploads.length + 1}`
    uploads.push({ id, name: file.name, mime: file.type, purpose: form.get('purpose'), bytes: Buffer.from(await file.arrayBuffer()) })
    await route.fulfill({ headers, json: { id } })
  })
  return uploads
}

const fileIds = (body) => body.messages.flatMap(({ content }) =>
  Array.isArray(content) ? content.filter((block) => block.source?.type === 'file').map((block) => block.source.file_id) : [])
const pngDimensions = (bytes) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]

async function legacyImageHistory(page) {
  const wide = await pngFixture(page, 5000, 250)
  const tall = await pngFixture(page, 200, 5000)
  const edge = await pngFixture(page, 80, 4096)
  const docs = [
    ['wide', wide, 'file-old-wide', 'file-previous-copy'],
    ['edge', edge, 'file-old-edge'],
    ['missing', null, 'file-old-missing'],
    ['undecodable', Buffer.from('not a decodable image'), 'file-old-undecodable'],
    ['checked', wide, 'file-checked-copy', 'file-checked-copy'],
    ['hidden', tall, 'file-old-hidden'],
  ]
  await page.evaluate(async (docs) => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('chat-demo')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    try {
      const now = Date.now()
      const summary = { id: 'legacy-images', title: '旧图样本', createdAt: now, updatedAt: now }
      const tx = db.transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
      const files = docs.map(([id, base64, serverId, imageSizeCheckedFor]) => {
        const blob = base64 === null ? null : new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' })
        if (blob) tx.objectStore('files').put({ id, blob })
        return { id, name: `${id}.png`, size: blob?.size ?? 12, isImage: true, mimeType: 'image/png', serverId, imageSizeCheckedFor }
      })
      const messages = [
        { id: 'q', role: 'user', parentId: null, selectedChildId: 'a', content: '先前的问题', files: files.slice(0, -1) },
        { id: 'a', role: 'assistant', parentId: 'q', selectedChildId: 'q2', status: 'done', blocks: [{ type: 'text', text: '先前的回复' }] },
        { id: 'q2', role: 'user', parentId: 'a', selectedChildId: 'a2', content: '失败的轮次', files: files.slice(-1) },
        { id: 'a2', role: 'assistant', parentId: 'q2', status: 'error', blocks: [] },
      ].map((message) => ({ ...message, createdAt: now }))
      tx.objectStore('sessions').put({ ...summary, rootMessageId: 'q', messages })
      tx.objectStore('sessionSummaries').put({ ...summary, fileIds: files.map((file) => file.id) })
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve
        tx.onabort = () => reject(tx.error)
      })
    } finally { db.close() }
  }, docs.map(([id, buffer, serverId, checked]) => [id, buffer?.toString('base64') ?? null, serverId, checked]))
  await reopenLegacyImages(page)
}

async function reopenLegacyImages(page) {
  await page.reload()
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByText('旧图样本', { exact: true }).click()
  await expect(page.getByText('先前的回复', { exact: true })).toBeVisible()
}

async function savedLegacyFiles(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('chat-demo')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    try {
      return await new Promise((resolve, reject) => {
        const read = db.transaction('sessions').objectStore('sessions').get('legacy-images')
        read.onsuccess = () => resolve(read.result.messages[0].files)
        read.onerror = () => reject(read.error)
      })
    } finally { db.close() }
  })
}

test('Files API resizes only oversized pixels; preview, save and ZIP keep original bytes', async ({ page }) => {
  await setup(page)
  const requests = await mockChat(page)
  const uploads = await mockFileUploads(page)
  await page.goto('/')
  const wide = await pngFixture(page, 5000, 250)
  const tall = await pngFixture(page, 200, 4097)
  const edge = await pngFixture(page, 4096, 80)
  const notes = Buffer.from('original document data')
  await page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'wide.png', mimeType: 'image/png', buffer: wide },
    { name: 'tall.png', mimeType: 'image/png', buffer: tall },
    { name: 'edge.png', mimeType: 'image/png', buffer: edge },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: notes },
  ])
  await send(page, '检查上传附件')
  await expect(page.getByText('这是模拟接口的回答。', { exact: true })).toBeVisible()
  expect(uploads).toHaveLength(4)
  const byName = Object.fromEntries(uploads.map((file) => [file.name, file]))
  expect(pngDimensions(byName['wide.png'].bytes)).toEqual([4096, 205])
  expect(pngDimensions(byName['tall.png'].bytes)).toEqual([200, 4096])
  expect(byName['edge.png'].bytes).toEqual(edge)
  expect(byName['notes.txt']).toMatchObject({ purpose: 'user_data', mime: 'text/plain', bytes: notes })
  expect(uploads.filter(({ mime }) => mime === 'image/png').every(({ purpose }) => purpose === null)).toBe(true)
  expect(fileIds(requests[0])).toEqual(['wide.png', 'tall.png', 'edge.png', 'notes.txt'].map((name) => byName[name].id))

  await page.getByRole('button', { name: 'wide.png', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'wide.png' })
  await expect.poll(() => dialog.locator('img').evaluate((image) => image.naturalWidth)).toBe(5000)
  await dialog.getByRole('button', { name: '下载', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__nativeCalls.filter((call) => call.action === 'saveEnd').length)).toBe(1)
  const saved = async () => Buffer.concat((await page.evaluate(() => window.__nativeChunks)).map((chunk) => Buffer.from(chunk, 'base64')))
  expect(await saved()).toEqual(wide)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await openData(page)
  await page.getByRole('button', { name: '下载', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__nativeCalls.filter((call) => call.action === 'saveEnd').length)).toBe(2)
  const zip = await saved()
  const entries = Object.entries(unzipSync(zip))
  for (const [name, bytes] of [['wide.png', wide], ['tall.png', tall], ['edge.png', edge]]) {
    const packed = entries.find(([path]) => path.endsWith(`_${name}`))
    expect(Buffer.from(packed[1])).toEqual(bytes)
  }
  // Importing the same ZIP replaces local records; its file IDs must not match stale in-memory uploads.
  await page.locator('input[type=file][accept*=".zip"]').setInputFiles({ name: 'roundtrip.zip', mimeType: 'application/zip', buffer: zip })
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await page.getByRole('button', { name: '查看导入的对话', exact: true }).click()
  await send(page, '追问备份恢复后的图片')
  await expect.poll(() => requests.length).toBe(2)
  expect(uploads).toHaveLength(7)
  expect(fileIds(requests[1]).sort()).toEqual(uploads.slice(4).map((file) => file.id).sort())
})

test('an undecodable new attachment keeps its original upload and is not marked checked', async ({ page }) => {
  await setup(page)
  const requests = await mockChat(page)
  const uploads = await mockFileUploads(page)
  await page.goto('/')
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  const bytes = Buffer.from('synthetic unsupported encoding')
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'opaque.tiff', mimeType: 'image/tiff', buffer: bytes })
  await send(page, '检查无法解码的附件')
  await expect(page.getByText('这是模拟接口的回答。', { exact: true })).toBeVisible()
  expect(uploads).toHaveLength(1)
  expect(uploads[0]).toMatchObject({ name: 'opaque.tiff', mime: 'image/tiff', purpose: null, bytes })
  expect(fileIds(requests[0])).toEqual([uploads[0].id])
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('chat-demo')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    try {
      return await new Promise((resolve, reject) => {
        const read = db.transaction('sessions').objectStore('sessions').getAll()
        read.onsuccess = () => {
          const file = read.result[0]?.messages[0]?.files[0]
          resolve(file?.serverId ? [file.serverId, file.imageSizeCheckedFor ?? null] : null)
        }
        read.onerror = () => reject(read.error)
      })
    } finally { db.close() }
  })).toEqual([uploads[0].id, null])
})

test('history only replaces confirmed oversized IDs and keeps new IDs after reload', async ({ page }) => {
  await setup(page)
  const requests = await mockChat(page)
  const uploads = await mockFileUploads(page)
  await page.goto('/')
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  await legacyImageHistory(page)
  await send(page, '检查旧附件')
  await expect.poll(() => requests.length).toBe(1)
  expect(uploads).toHaveLength(1)
  expect(uploads[0].name).toBe('wide.png')
  expect(pngDimensions(uploads[0].bytes)).toEqual([4096, 205])
  const expected = [uploads[0].id, 'file-old-edge', 'file-old-missing', 'file-old-undecodable', 'file-checked-copy']
  expect(fileIds(requests[0])).toEqual(expected)
  await expect.poll(async () => (await savedLegacyFiles(page)).map((file) => file.imageSizeCheckedFor)).toEqual([
    uploads[0].id, 'file-old-edge', undefined, undefined, 'file-checked-copy',
  ])
  await expect(page.getByText('这是模拟接口的回答。', { exact: true })).toBeVisible()
  await reopenLegacyImages(page)
  await send(page, '刷新后复用')
  await expect.poll(() => requests.length).toBe(2)
  expect(uploads).toHaveLength(1)
  expect(fileIds(requests[1])).toEqual(expected)
})

test('regenerating an old question replaces its oversized image before sending', async ({ page }) => {
  await setup(page)
  const requests = await mockChat(page)
  const uploads = await mockFileUploads(page)
  await page.goto('/')
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  await legacyImageHistory(page)
  await page.getByText('先前的回复', { exact: true }).hover()
  await page.getByRole('button', { name: '重新生成', exact: true }).first().click()
  await expect.poll(() => requests.length).toBe(1)
  expect(uploads).toHaveLength(1)
  expect(uploads[0].name).toBe('wide.png')
  expect(fileIds(requests[0])).toEqual([uploads[0].id, 'file-old-edge', 'file-old-missing', 'file-old-undecodable', 'file-checked-copy'])
})

test('stopping legacy image inspection without new AbortSignal APIs does not send a request or discard its ID', async ({ page }) => {
  await setup(page, { oldEngine: true })
  const requests = await mockChat(page)
  const uploads = await mockFileUploads(page)
  await page.goto('/')
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  await legacyImageHistory(page)
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode
    HTMLImageElement.prototype.decode = async function () {
      await decode.call(this)
      await new Promise((done) => {
        window.__finishLegacyDecode = () => {
          HTMLImageElement.prototype.decode = decode
          done()
        }
      })
    }
  })
  await send(page, '准备中取消')
  await expect.poll(() => page.evaluate(() => Boolean(window.__finishLegacyDecode))).toBe(true)
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
  await page.evaluate(() => window.__finishLegacyDecode())
  expect((await savedLegacyFiles(page))[0].serverId).toBe('file-old-wide')
  expect(requests).toHaveLength(0)
  expect(uploads).toHaveLength(0)
  await send(page, '取消后再发')
  await expect.poll(() => requests.length).toBe(1)
  expect(uploads).toHaveLength(1)
  expect(fileIds(requests[0])[0]).toBe(uploads[0].id)
})

test('simulated PCM capture encodes WAV for ASR and cancels the stream on background', async ({ page }) => {
  await setup(page)
  await page.addInitScript(() => {
    const OriginalAudioContext = window.AudioContext
    window.AudioContext = class extends OriginalAudioContext {
      createScriptProcessor(...args) {
        const processor = super.createScriptProcessor(...args)
        window.__testProcessor = processor
        return processor
      }
    }
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new OriginalAudioContext()
      const destination = context.createMediaStreamDestination()
      const track = destination.stream.getTracks()[0]
      const stop = track.stop.bind(track)
      track.stop = () => { stop(); void context.close() }
      window.__testStream = destination.stream
      return destination.stream
    }
  })
  let transcriptions = 0
  await page.route('https://api.deepseek.com/v1/tools/asr', (route) => {
    transcriptions++
    expect(route.request().postDataBuffer().includes(Buffer.from('RIFF'))).toBe(true)
    return route.fulfill({ json: { text: '模拟语音识别结果' }, headers: { 'access-control-allow-origin': '*' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__testStream?.getTracks()[0].readyState)).toBe('live')
  // Headless Edge on this host leaves synthetic 16 kHz contexts at currentTime=0.
  // Inject known PCM into the installed callback: validates encoding/API/lifecycle, NOT microphone capture.
  await expect.poll(() => page.evaluate(() => typeof window.__testProcessor?.onaudioprocess)).toBe('function')
  await page.evaluate(() => window.__testProcessor.onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) },
  }))
  await page.getByRole('button', { name: '结束录音并转写', exact: true }).click()
  await expect(page.getByPlaceholder('请输入消息')).toHaveValue('模拟语音识别结果')
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__testStream?.getTracks()[0].readyState)).toBe('live')
  await page.evaluate(() => window.__deepseekAndroidBackground())
  await expect(page.getByRole('button', { name: '语音输入', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__testStream.getTracks()[0].readyState)).toBe('ended')
  expect(transcriptions).toBe(1)
})

test('synthetic PCM read-aloud closes audio context on EOF and on background', async ({ page }) => {
  await setup(page)
  await mockChat(page)
  await page.addInitScript(() => {
    const Original = window.AudioContext
    window.__testAudioContexts = []
    window.AudioContext = class extends Original {
      constructor(options) { super(options); window.__testAudioContexts.push(this) }
    }
  })
  let calls = 0
  await page.route('https://api.deepseek.com/v1/tools/tts', (route) => {
    calls++
    return route.fulfill({ body: Buffer.alloc(calls === 1 ? 4800 : 240000), contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } })
  })
  await page.goto('/')
  await send(page)
  await expect(page.getByText('这是模拟接口的回答。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '朗读', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__testAudioContexts.at(-1)?.state)).toBe('closed')
  await page.getByRole('button', { name: '朗读', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止朗读', exact: true })).toBeVisible()
  await page.evaluate(() => window.__deepseekAndroidBackground())
  await expect(page.getByRole('button', { name: '朗读', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__testAudioContexts.at(-1).state)).toBe('closed')
})

test('mobile layout remains usable at narrow and tablet widths with theme switching', async ({ page }) => {
  await setup(page)
  await page.goto('/')
  await page.setViewportSize({ width: 320, height: 640 })
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
  const input = await page.getByPlaceholder('请输入消息').boundingBox()
  expect(input.y + input.height).toBeLessThanOrEqual(640)
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('radio', { name: '深色', exact: true }).click()
  await expect(page.locator('body')).toHaveClass(/dark/)
  await page.evaluate(() => window.__deepseekAndroidBack())
  await page.evaluate(() => window.__deepseekAndroidBack())
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(page.getByPlaceholder('请输入消息')).toBeVisible()
})
