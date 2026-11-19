import { expect, test } from '@playwright/test'

const searchUrl = 'HTTPS://www.example.test'
const pageUrl = 'https://example.test/open'
const iconUrl = 'https://icons.example.test/site.png'
const invalidRead = '/mock-relative-read'
const tool = (id, kind, input) => ({
  type: 'server_tool_use', id, kind, input,
  name: kind === 'read_link' ? 'deepseek_read_url' : 'deepseek_web_search',
  caller: { type: 'direct' },
})
const result = (url, title) => ({
  type: 'web_search_result', url, title, snippet: 'Mock snippet', site_icon: iconUrl,
  site_name: 'Mock site', page_age: null, encrypted_content: 'mock-result-only',
})
const fetched = (tool_use_id, kind, url, title) => ({
  type: 'web_fetch_tool_result', tool_use_id, kind,
  content: {
    type: 'web_fetch_result', url, published_at: null,
    content: { type: 'document', title, source: { type: 'text', media_type: 'text/plain', data: '' } },
  },
})
const citation = (url) => ({
  type: 'web_search_result_location', url, title: null, cited_text: '合成答案。', encrypted_index: '',
})

const pending = [
  tool('read-invalid', 'read_link', { action: 'read_link', url: invalidRead }),
  tool('read-valid', 'read_link', { action: 'read_link', url: pageUrl }),
]
const invalidPage = 'https://example.test/open page'
const completed = [
  { ...fetched('read-invalid', 'read_link', invalidRead, 'Mock read'), signature: 'mock-signature-a' },
  { ...fetched('read-valid', 'read_link', pageUrl, 'Mock read'), signature: 'mock-signature-b' },
  tool('search', 'deep_search', { action: 'search', queries: ['合成查询'] }),
  {
    type: 'web_search_tool_result', tool_use_id: 'search', kind: 'deep_search',
    content: [
      result('https://example.test/search result', '不应显示的结果'),
      result(searchUrl, '有效搜索结果'),
      result('https://www.example.test:443/', '重复搜索结果'),
    ],
  },
  tool('bad-page', 'deep_search', { action: 'open_page', url: invalidPage }),
  fetched('bad-page', 'deep_search', invalidPage, '不带外链的网页'),
  tool('good-page', 'deep_search', { action: 'open_page', url: pageUrl }),
  fetched('good-page', 'deep_search', pageUrl, '可打开的网页'),
  { type: 'text', text: '合成答案。', citations: [citation(invalidPage), citation(searchUrl), citation(pageUrl)] },
]

async function mockSourceStream(page, origin) {
  const externalRequests = []
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin === origin) {
      return route.continue()
    }
    externalRequests.push(url.href)
    return route.abort()
  })
  await page.addInitScript(({ pending, completed }) => {
    window.localStorage.setItem('chat-demo:api-key', 'sk-synthetic-source-links')
    window.localStorage.setItem('chat-demo:locale', 'zh-CN')
    window.__sourceOpens = []
    window.open = (...args) => {
      window.__sourceOpens.push(args)
      return null
    }
    const fetch = window.fetch.bind(window)
    window.fetch = (url, init) => {
      if (url !== 'https://api.deepseek.com/anthropic/v1/messages') {
        return fetch(url, init)
      }
      const stream = new ReadableStream({ start(controller) {
        const encoder = new TextEncoder()
        const push = (event) => controller.enqueue(encoder.encode(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ))
        let index = 0
        const pushBlock = (content_block) => {
          push({ type: 'content_block_start', index, content_block })
          push({ type: 'content_block_stop', index: index++ })
        }
        push({ type: 'message_start', message: { id: 'mock-source-reply', role: 'assistant' } })
        pending.forEach(pushBlock)
        window.__finishSourceReply = () => {
          completed.forEach(pushBlock)
          push({ type: 'message_delta', delta: { stop_reason: 'end_turn', title: '合成网页链接' } })
          push({ type: 'message_stop' })
          controller.close()
        }
      } })
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    }
  }, { pending, completed })
  return externalRequests
}

async function expectPlainText(label) {
  await expect(label).toBeVisible()
  await expect(label).toHaveCSS('text-decoration-line', 'none')
  await expect(label).toHaveCSS('cursor', 'auto')
  expect(await label.evaluate((node) => node.closest('a')?.href ?? null)).toBeNull()
}

test('streamed citations, search rows and page links only expose valid external URLs', async ({ page, baseURL }) => {
  const externalRequests = await mockSourceStream(page, new URL(baseURL).origin)
  await page.goto('/')
  await page.getByPlaceholder('请输入消息').fill('合成提问')
  await page.getByRole('button', { name: '发送', exact: true }).click()

  await expectPlainText(page.getByText(invalidRead, { exact: true }))
  await expect(page.getByRole('link', { name: pageUrl, exact: true })).toHaveAttribute('href', pageUrl)
  await page.evaluate(() => window.__finishSourceReply())
  await expect(page.getByText(invalidRead, { exact: true })).toHaveCount(0)
  await expectPlainText(page.getByText('不带外链的网页', { exact: true }))
  const openPage = page.getByRole('link', { name: '可打开的网页' })
  await expect(openPage).toHaveAttribute('href', pageUrl)
  await expect(openPage).toHaveAttribute('target', '_blank')
  await expect(openPage).toHaveAttribute('rel', 'noopener noreferrer')

  const citations = page.locator('.ds-assistant-message-main-content').getByRole('link')
  await expect(citations).toHaveText(['1', '2'])
  await citations.first().click()
  expect(await page.evaluate(() => window.__sourceOpens)).toEqual([
    ['https://www.example.test/', '_blank', 'noopener,noreferrer'],
  ])

  await page.getByText('搜索到 1 个网页', { exact: true }).click()
  const panel = page.locator('aside').filter({ has: page.getByRole('heading', { name: '搜索结果' }) })
  const results = panel.getByRole('link')
  await expect(results).toHaveCount(1)
  await expect(results.first()).toContainText('有效搜索结果')
  await expect(results.first()).toHaveAttribute('href', 'https://www.example.test/')
  await expect(panel.locator('img')).toHaveCount(0)
  expect(externalRequests.filter((url) => new URL(url).hostname === 'icons.example.test')).toEqual([])
})
