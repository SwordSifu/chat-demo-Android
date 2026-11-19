import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

// The browser bundler resolves source .js specifiers to .ts. Limit that fallback to source imports.
const sourceRoot = new URL('../src/', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      /^\.\.?\//.test(specifier) &&
      specifier.endsWith('.js') &&
      context.parentURL?.startsWith(sourceRoot)
    ) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(url)) {
        return nextResolve(url.href, context)
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    // BackupError uses a TypeScript constructor parameter property.
    if (url === `${sourceRoot}services/chat/history/errors.ts`) {
      const source = stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' })
      return { source, format: 'module', shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
const [{ buildReplyView }, { toLocalSession }, { toRequestMessages }] = await Promise.all([
  import('../src/services/chat/view.ts'),
  import('../src/services/chat/history/toLocal.ts'),
  import('../src/services/chat/reply.ts'),
]).finally(() => hook.deregister())

const firstUrl = 'HTTPS://www.example.test'
const iconUrl = 'https://icons.example.test/sample.png'
const secondUrl = 'http://example.test/page'
const badUrl = 'https://example.test/two words'
const time = '2026-01-01T00:00:00Z'
const user = { id: 'u', role: 'user', content: 'Mock question', files: [], createdAt: 0 }
const reply = (blocks) => ({ id: 'a', role: 'assistant', status: 'done', createdAt: 0, blocks })
const tool = (id, kind, input) => ({
  type: 'server_tool_use',
  id,
  kind,
  name: kind === 'read_link' ? 'deepseek_read_url' : 'deepseek_web_search',
  input,
  caller: { type: 'direct' },
})
const searchResult = (url, title, site_icon = null) => ({
  type: 'web_search_result',
  url,
  title,
  site_icon,
  snippet: 'Sample snippet',
  site_name: null,
  page_age: null,
  encrypted_content: 'mock-search-data',
})
const fetched = (tool_use_id, kind, url, title, signature) => ({
  type: 'web_fetch_tool_result',
  tool_use_id,
  kind,
  content: {
    type: 'web_fetch_result',
    url,
    content: { type: 'document', title, source: { type: 'text', media_type: 'text/plain', data: '' } },
    published_at: null,
  },
  ...(signature ? { signature } : {}),
})
const citation = (url) => ({
  type: 'web_search_result_location', url, title: null, cited_text: 'Sample', encrypted_index: '',
})

test('reply deduplicates equivalent destinations and numbers only valid sources', () => {
  const citationOnly = 'https://example.test/citation-only'
  const message = reply([
    { type: 'text', text: 'Preamble.\n', citations: [citation(badUrl), citation(firstUrl)] },
    tool('search', 'deep_search', { action: 'search', queries: ['mock query'] }),
    {
      type: 'web_search_tool_result', tool_use_id: 'search', kind: 'deep_search',
      content: [
        searchResult('/relative', 'Not a source'),
        searchResult(firstUrl, 'First search result', iconUrl),
        searchResult(' https://www.example.test:443/ ', 'Duplicate result'),
      ],
    },
    tool('bad-open', 'deep_search', { action: 'open_page', url: badUrl }),
    fetched('bad-open', 'deep_search', badUrl, 'Plain page label'),
    tool('good-open', 'deep_search', { action: 'open_page', url: '' }),
    fetched('good-open', 'deep_search', secondUrl, null),
    {
      type: 'text', text: 'Answer. \n',
      citations: [
        citation(badUrl), citation(secondUrl), citation(firstUrl),
        citation('https://WWW.example.test/'), citation(citationOnly),
      ],
    },
  ])
  const original = structuredClone(message)
  const view = buildReplyView(message, false)

  assert.deepEqual(view.sources.map(({ url, index }) => [url, index]), [
    [firstUrl, 1], [secondUrl, 2], [citationOnly, 3],
  ])
  assert.equal(view.sources[0].title, 'First search result')
  assert.equal(view.sources[0].siteName, 'example.test')
  assert.equal(view.sources[0].siteIcon, iconUrl)
  assert.deepEqual(view.searchResults, [view.sources[0]])
  assert.deepEqual(view.steps[1].results, view.searchResults)
  assert.deepEqual(view.steps[2].pages, [
    { id: 'bad-open', title: 'Plain page label', status: 'done' },
    { id: 'good-open', url: secondUrl, title: secondUrl, status: 'done' },
  ])
  assert.equal(view.steps[0].markdown, 'Preamble.[citation:1]\n')
  assert.deepEqual(view.answer, { text: 'Answer. \n', markdown: 'Answer.[citation:2][citation:1][citation:3] \n' })
  assert.deepEqual(message, original)
})

test('read links are display-only while pending and signed tool history is still sent unchanged', () => {
  const pending = [
    tool('bad-read', 'read_link', { action: 'read_link', url: badUrl }),
    tool('valid-read', 'read_link', { action: 'read_link', url: firstUrl }),
    tool('no-url', 'read_link', { action: 'read_link', url: '' }),
  ]
  assert.deepEqual(buildReplyView(reply(pending), true).steps, [{
    type: 'read_link',
    links: [
      { id: 'bad-read', title: badUrl, status: 'wip' },
      { id: 'valid-read', url: firstUrl, title: firstUrl, status: 'wip' },
    ],
  }])

  const signed = fetched('bad-read', 'read_link', badUrl, 'Mock read result', 'mock-signature')
  const message = reply([pending[0], signed, { type: 'text', text: 'Reply' }])
  assert.deepEqual(buildReplyView(message, false).steps, [])
  const requests = toRequestMessages([user, message], { ...user, id: 'next' })
  assert.equal(requests[1].content[0].input.url, badUrl)
  assert.deepEqual(requests[1].content[1], signed)
})

test('new imports use the same strict validation while retaining accepted metadata and signed reads', () => {
  const fragments = [
    {
      type: 'TOOL_SEARCH', status: 'FINISHED', queries: ['mock query'],
      results: [
        { url: badUrl, title: 'Rejected row', snippet: '', published_at: null, site_name: null },
        { url: firstUrl, title: 'Accepted row', snippet: 'Mock snippet', published_at: time, site_name: 'Mock site', site_icon: iconUrl },
      ],
    },
    { type: 'TOOL_OPEN', status: 'FINISHED', url: badUrl, title: 'Archived plain title', published_at: null },
    { type: 'TOOL_OPEN', status: 'FINISHED', url: secondUrl, title: 'Accepted page', published_at: null },
    {
      type: 'READ_LINK', results: [
        { url: badUrl, signature: '' },
        { url: badUrl, title: 'Signed result', signature: 'mock-signature' },
        { url: firstUrl, signature: 'mock-valid-signature' },
      ],
    },
    { type: 'RESPONSE', content: 'Mock archived reply' },
  ]
  const data = {
    id: 'mock-session', title: 'Mock title', pinned: false, current_message_id: 2,
    inserted_at: time, updated_at: time,
    messages: [
      { id: 1, parent_id: null, role: 'USER', inserted_at: time, fragments: [{ type: 'REQUEST', content: user.content }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', inserted_at: time, status: 'FINISHED', fragments },
    ],
  }
  const { session } = toLocalSession(data)
  const message = session.messages[1]
  const view = buildReplyView(message, false)
  assert.deepEqual(view.sources.map(({ url, index }) => [url, index]), [[firstUrl, 1], [secondUrl, 2]])
  assert.deepEqual(view.steps[1].pages[0], {
    id: 'history-2-1', title: 'Archived plain title', status: 'done',
  })
  assert.equal(message.blocks[2].input.url, '')
  assert.deepEqual(view.searchResults, [{
    url: firstUrl, title: 'Accepted row', snippet: 'Mock snippet', publishedAt: time,
    siteName: 'Mock site', siteIcon: iconUrl, index: 1,
  }])
  const reads = message.blocks.filter((block) => block.kind === 'read_link' && block.type === 'web_fetch_tool_result')
  assert.deepEqual(reads.map(({ content, signature }) => [content.url, signature]), [
    ['', 'mock-signature'], [firstUrl, 'mock-valid-signature'],
  ])
})
