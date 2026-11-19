import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'

// Use the real chat store with an in-memory stand-in for the persistence boundary.
const sourceRoot = new URL('../src/', import.meta.url).href
const dbUrl = `${sourceRoot}services/chat/db.ts`
const dbKey = Symbol.for('chat-cache-store-test-db')
const persisted = new Map()
let pendingSave
let saves = 0
const reads = []
let requestDelete
let requestLoad
let failedSaves = 0
globalThis[dbKey] = {
  loadSession(id) {
    reads.push(id)
    return id === 'loading' ? new Promise((resolve) => { requestLoad = resolve }) : Promise.resolve(persisted.get(id))
  },
  saveSession(session) {
    saves++
    if (pendingSave) return pendingSave
    persisted.set(session.id, session)
    return Promise.resolve()
  },
  deleteSession: () => new Promise((resolve) => { requestDelete = resolve }),
  reportStorageError: () => () => { failedSaves++ },
}
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot)) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(url)) return next(url.href, context)
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === dbUrl) {
      return { format: 'module', shortCircuit: true, source: `
        const db = globalThis[Symbol.for('chat-cache-store-test-db')]
        export const {loadSession, saveSession, deleteSession, reportStorageError} = db
      ` }
    }
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return {
        format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }),
      }
    }
    return next(url, context)
  },
})
globalThis.__API_ORIGIN__ = 'https://api.example.test'
const store = await import('../src/services/chat/store.ts').finally(() => {
  hook.deregister()
  delete globalThis.__API_ORIGIN__
})
const { useChatStore, clearInactiveSessionCache, renameSession, removeSession, retrySaveSessions, selectSession } = store
const tick = () => new Promise((resolve) => setImmediate(resolve))

const record = (id) => ({ id, title: id, rootMessageId: null, messages: [], createdAt: 1, updatedAt: 1 })
const details = () => Object.keys(useChatStore.getState().sessionCache).sort()

test('cache cleanup preserves active, streaming, loaded-but-unsaved, and deleting sessions', async () => {
  const ids = ['active', 'streaming', 'unsaved', 'saved', 'deleting']
  const sessions = ids.map(record)
  for (const session of sessions) persisted.set(session.id, session)
  useChatStore.setState({
    activeId: 'active', ready: true, importingHistory: false,
    sessions, sessionCache: Object.fromEntries(sessions.map((session) => [session.id, session])),
    streaming: { streaming: { controller: new AbortController(), replyId: 'reply' } },
  })
  let rejectSave
  pendingSave = new Promise((_, reject) => { rejectSave = reject })
  renameSession('unsaved', 'Not written yet')
  const removal = removeSession('deleting')
  await tick()

  assert.equal(clearInactiveSessionCache(), 1)
  assert.deepEqual(details(), ['active', 'deleting', 'streaming', 'unsaved'])
  assert.equal(useChatStore.getState().sessions.length, 5)
  assert.equal(saves, 1, 'cleanup itself must not save or delete data')
  assert.equal(persisted.get('saved').title, 'saved')

  rejectSave(new Error('Synthetic quota failure'))
  await tick()
  assert.equal(failedSaves, 1)
  assert.equal(clearInactiveSessionCache(), 0)
  assert.equal(useChatStore.getState().sessionCache.unsaved.title, 'Not written yet')
  assert.equal(persisted.get('unsaved').title, 'unsaved')
  pendingSave = undefined
  retrySaveSessions()
  await tick()
  assert.equal(persisted.get('unsaved').title, 'Not written yet')
  assert.equal(clearInactiveSessionCache(), 1)

  useChatStore.setState({ importingHistory: true, streaming: {} })
  assert.equal(clearInactiveSessionCache(), 0)
  assert.deepEqual(details(), ['active', 'deleting', 'streaming'])
  useChatStore.setState({ importingHistory: false })
  requestDelete()
  assert.equal(await removal, true)
  assert.equal(clearInactiveSessionCache(), 1)
  selectSession('saved')
  await tick()
  assert.deepEqual(reads, ['saved'])
  assert.equal(useChatStore.getState().sessionCache.saved.title, 'saved')
})

test('cleanup cannot invalidate a pending session load when the user switches away', async () => {
  const loading = record('loading')
  useChatStore.setState({ sessions: [record('active'), loading], sessionCache: { active: record('active') }, activeId: 'active' })
  selectSession('loading')
  selectSession('active')
  assert.equal(clearInactiveSessionCache(), 0)
  requestLoad(loading)
  await tick()
  assert.equal(useChatStore.getState().sessionCache.loading?.id, 'loading')
  assert.equal(clearInactiveSessionCache(), 1)
  assert.deepEqual(details(), ['active'])
})
