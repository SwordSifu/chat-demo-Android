import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Match the bundler's .js -> .ts mapping when importing app code in Node.
const root = new URL('../src/', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && specifier.endsWith('.js') && context.parentURL?.startsWith(root)) {
      const mapped = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(mapped)) return next(mapped.href, context)
    }
    return next(specifier, context)
  },
})
const { historySearchQuery, matchesHistorySearchMessage, searchHistoryPage } = await import(
  '../src/services/chat/historySearch.ts'
).finally(() => hook.deregister())

const user = (id, content, rest = {}) => ({ id, role: 'user', content, files: [], createdAt: 0, ...rest })
const answer = (id, blocks, rest = {}) => ({
  id, role: 'assistant', blocks, status: 'done', model: null, prefix: false, createdAt: 0, ...rest,
})
const text = (text) => ({ type: 'text', text })
const session = (id, title, messages, rest = {}) => ({ id, title, createdAt: 0, updatedAt: 0, messages, ...rest })
const noCache = () => undefined
const byId = (sessions) => ({
  cachedSession: noCache,
  liveReplyId: noCache,
  readSession: async (id) => sessions.find((session) => session.id === id),
})
const search = (sessions, query, sources = byId(sessions)) =>
  searchHistoryPage(sessions, historySearchQuery(query), 0, new AbortController().signal, sources)

test('literal ASCII folding, Chinese, whitespace, and bounded plain-text snippets', async () => {
  const long = '🙂'.repeat(205)
  const source = [session('one', `开头${long}[Ab.*]中文`, [user('one', `${long}<Ab.*>中文${long}`)])]
  const { results: [result] } = await search(source, 'aB.*')
  assert.equal(result.title.match, 'Ab.*')
  assert.equal(result.message.excerpt.match, 'Ab.*')
  assert.equal(result.message.excerpt.before.endsWith('<'), true)
  assert.equal(result.message.excerpt.after.startsWith('>中文'), true)
  for (const preview of [result.title, result.message.excerpt]) {
    const output = Object.values(preview).join('')
    assert.ok(output.length <= 122)
    assert.equal(output.isWellFormed(), true)
  }
  assert.equal((await search(source, '中文')).results.length, 1)
  for (const query of ['.*nope', ' ab.*', 'AB.**', ' \t ']) {
    assert.equal((await search(source, query)).results.length, 0, query)
  }
  assert.equal((await search([session('x', 'É', [])], 'é')).results.length, 0)
})

test('only current branch, questions, and final visible reply text are searched', async () => {
  const source = [session('s', 'TITLE', [
    user('u', 'questionneedle', { selectedChildId: 'a', files: [{ name: 'attachmentneedle' }] }),
    answer('a', [
      text('preambleneedle'),
      { type: 'thinking', thinking: 'thinkingneedle' },
      { type: 'server_tool_use', kind: 'search', id: 'tool', input: { action: 'search', queries: ['toolneedle'] } },
      text('fi'), text('nalneedle'), { type: 'text', text: 'templateneedle', isTemplate: true },
    ], { selectedChildId: 'u2' }),
    answer('other', [text('hiddenbranchneedle')]),
    user('u2', 'second question', { selectedChildId: 'a2' }),
    answer('a2', [text('streamingneedle')], { status: 'pending', selectedChildId: 'u3' }),
    user('u3', 'third question', { selectedChildId: 'a3' }),
    answer('a3', [text('refusalneedle')], { stopReason: 'refusal' }),
  ], { rootMessageId: 'u' })]
  const sources = { ...byId(source), liveReplyId: () => 'a2' }
  for (const needle of ['preamble', 'thinking', 'tool', 'template', 'hiddenbranch', 'attachment', 'streaming', 'refusal']) {
    assert.equal((await search(source, `${needle}needle`, sources)).results.length, 0, needle)
  }
  const title = (await search(source, 'title', sources)).results[0]
  assert.equal(title.message, undefined)
  for (const [needle, id] of [['questionneedle', 'u'], ['FINALNEEDLE', 'a']]) {
    assert.equal((await search(source, needle, sources)).results[0].message.id, id)
  }
  assert.equal(matchesHistorySearchMessage(source[0].messages[1], 'finalneedle'), true)
  assert.equal(matchesHistorySearchMessage(source[0].messages[4], 'streamingneedle', 'a2'), false)
})

test('empty queries never read; pages scan a single detail at a time and resume in ordered batches', async () => {
  const sessions = Array.from({ length: 53 }, (_, i) => session(`s${i}`, 'title', [user('u', 'common')], { updatedAt: 100 - i }))
  const reads = []
  let reading = false
  const sources = {
    ...byId(sessions),
    readSession: async (id) => {
      assert.equal(reading, false)
      reads.push(id)
      reading = true
      await Promise.resolve()
      reading = false
      return sessions.find((session) => session.id === id)
    },
  }
  assert.equal((await search(sessions, '', sources)).results.length, 0)
  assert.deepEqual(reads, [])
  const signal = new AbortController().signal
  const first = await searchHistoryPage(sessions, 'common', 0, signal, sources)
  assert.equal(first.next, 50)
  assert.deepEqual(first.results.map((row) => row.sessionId), sessions.slice(0, 50).map(({ id }) => id))
  assert.equal(reads.length, 50)
  const second = await searchHistoryPage(sessions, 'common', first.next, signal, sources)
  assert.equal(second.next, null)
  assert.deepEqual(second.results.map((row) => row.sessionId), ['s50', 's51', 's52'])
  assert.equal(reads.length, 53)
})

test('prefers valid in-memory detail even when it appears after IndexedDB read starts', async () => {
  const stored = session('session', 'title', [user('u', 'old')])
  const latest = { ...stored, messages: [user('u', 'latest')] }
  let cached = { ...stored, updatedAt: -1 }
  let reads = 0
  const sources = {
    ...byId([stored]),
    cachedSession: () => cached,
    readSession: async () => { reads++; cached = latest; return stored },
  }
  assert.equal((await search([stored], 'latest', sources)).results[0].message.id, 'u')
  assert.equal(reads, 1)
  assert.equal((await search([stored], 'old', sources)).results.length, 0)
  assert.equal(reads, 1)
})

test('failed or missing session details produce a distinct partial-read error', async () => {
  const sessions = ['old', 'missing', 'good'].map((id) => session(id, id === 'old' ? 'test' : '', [user('u', 'test')]))
  const sources = {
    ...byId(sessions),
    readSession: async (id) => {
      if (id === 'old') throw new Error('private storage error content')
      return id === 'good' ? sessions[2] : undefined
    },
  }
  const result = await search(sessions, 'test', sources)
  assert.equal(result.readError, true)
  assert.deepEqual(result.results.map((row) => [row.sessionId, row.message?.id]), [['old', undefined], ['good', 'u']])
  assert.equal(JSON.stringify(result).includes('private storage error content'), false)
  assert.equal((await search([sessions[2]], 'no match')).readError, false)
})

test('cancellation during a pending read ignores its result and reads no subsequent session', async () => {
  const sessions = [session('a', '', [user('u', 'match')]), session('b', '', [])]
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const reads = []
  const controller = new AbortController()
  const result = searchHistoryPage(sessions, 'match', 0, controller.signal, {
    ...byId(sessions),
    readSession: (id) => { reads.push(id); return pending },
  })
  controller.abort()
  release(sessions[0])
  await assert.rejects(result, { name: 'AbortError' })
  assert.deepEqual(reads, ['a'])
})
