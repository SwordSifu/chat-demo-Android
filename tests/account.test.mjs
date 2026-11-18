import assert from 'node:assert/strict'
import test from 'node:test'
import { BALANCE_URL, BalanceStore, parseBalance } from '../src/services/account/balance.ts'
import { LocalUsageStore, parseChatTokenUsage, USAGE_STORAGE_KEY } from '../src/services/account/usage.ts'

const usd = { currency: 'USD', total_balance: '12345678901234567890.0400', granted_balance: '0.0400', topped_up_balance: '12345678901234567890.00' }
const cny = { currency: 'CNY', total_balance: '-0.010', granted_balance: '0', topped_up_balance: '-0.010' }
const reply = (available = true, balance_infos = [usd, cny]) => ({ is_available: available, balance_infos })
const response = (status, json = reply()) => new Response(JSON.stringify(json), { status })

function controlledBalance() {
  const calls = []
  let now = 0
  let offline = false
  const store = new BalanceStore((url, init) => new Promise((resolve, reject) => {
    calls.push({ url, init, resolve, reject })
  }), () => now, () => offline)
  return { store, calls, advance: (ms) => { now += ms }, setOffline: (value) => { offline = value } }
}

test('balance parses distinct currencies with their exact monetary strings and server availability', () => {
  assert.deepEqual(parseBalance(reply(false)), {
    status: 'insufficient', amounts: [
      { currency: 'USD', total: '12345678901234567890.0400', granted: '0.0400', toppedUp: '12345678901234567890.00' },
      { currency: 'CNY', total: '-0.010', granted: '0', toppedUp: '-0.010' },
    ],
  })
  for (const invalid of [null, [], reply(true, [null]), reply(true, [{ ...usd, total_balance: 100 }]),
    reply(true, [{ ...usd, total_balance: '1e20' }]), reply(true, [{ ...usd, currency: '<script>' }])]) {
    assert.equal(parseBalance(invalid), null)
  }
})

test('balance only requests on demand, dedupes across refreshes, caches 60 seconds, and supports manual bypass', async () => {
  const { store, calls, advance } = controlledBalance()
  assert.equal(store.getSnapshot().status, 'idle')
  await store.load(null)
  assert.equal(store.getSnapshot().status, 'noKey')
  assert.equal(calls.length, 0)
  const first = store.load('sk-fake-one')
  assert.equal(store.getSnapshot().status, 'loading')
  assert.equal(first, store.load('sk-fake-one', true))
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, BALANCE_URL)
  assert.equal(init.method, 'GET')
  assert.equal(init.headers.Authorization, 'Bearer sk-fake-one')
  assert.equal(init.credentials, 'omit')
  assert.equal(init.cache, 'no-store')
  assert.equal(init.redirect, 'error')
  assert.equal(init.referrerPolicy, 'no-referrer')
  assert.equal(init.body, undefined)
  calls[0].resolve(response(200))
  await first
  advance(59_999)
  await store.load('sk-fake-one')
  assert.equal(calls.length, 1)
  advance(1)
  const expired = store.load('sk-fake-one')
  assert.equal(calls.length, 2)
  calls[1].resolve(response(200))
  await expired
  const forced = store.load('sk-fake-one', true)
  assert.equal(calls.length, 3)
  calls[2].resolve(response(200, reply(false)))
  await forced
  assert.equal(store.getSnapshot().status, 'insufficient')
})

test('changing/removing a key invalidates cache, aborts and ignores stale results even if fetch ignores abort', async () => {
  const { store, calls } = controlledBalance()
  const old = store.load('sk-fake-one')
  const current = store.load('sk-fake-two')
  assert.equal(calls[0].init.signal.aborted, true)
  calls[0].resolve(response(200))
  await old
  assert.equal(store.getSnapshot().status, 'loading')
  await store.load(null)
  assert.equal(calls[1].init.signal.aborted, true)
  calls[1].resolve(response(200))
  await current
  assert.equal(store.getSnapshot().status, 'noKey')
  const next = store.load('sk-fake-one')
  calls[2].resolve(response(200, reply(false)))
  await next
  store.invalidate()
  assert.equal(store.getSnapshot().status, 'idle')
  const afterReset = store.load('sk-fake-one')
  assert.equal(calls.length, 4)
  calls[3].resolve(response(200))
  await afterReset
})

test('balance distinguishes auth, insufficient funds, offline and other failures without error content', async () => {
  const { store, calls, setOffline } = controlledBalance()
  for (const [status, expected] of [[401, 'authFailure'], [403, 'authFailure'], [402, 'insufficient'],
    [503, 'connectionFailure'], [200, 'connectionFailure']]) {
    const result = store.load('sk-fake-one', true)
    calls.at(-1).resolve(response(status, { message: 'never expose upstream or credential details' }))
    await result
    assert.equal(store.getSnapshot().status, expected)
  }
  const failed = store.load('sk-fake-one', true)
  calls.at(-1).reject(new TypeError('never expose raw errors'))
  await failed
  assert.deepEqual(store.getSnapshot(), { status: 'connectionFailure' })
  setOffline(true)
  const count = calls.length
  await store.load('sk-fake-one')
  assert.deepEqual(store.getSnapshot(), { status: 'offline' })
  assert.equal(calls.length, count)
})

const apiUsage = { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 11, cache_creation_input_tokens: 3 }
const usage = { inputTokens: 34, outputTokens: 4, cacheHitTokens: 11 }
const zero = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, requests: 0 }

test('Anthropic final usage keeps cache hits as a subset and rejects incomplete, malformed or unsafe counts', () => {
  assert.deepEqual(parseChatTokenUsage({ ...apiUsage, server_tool_use: { web_search_requests: 1 } }), usage)
  assert.deepEqual(parseChatTokenUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0 }), { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 })
  for (const invalid of [null, [], {}, { input_tokens: 20, output_tokens: 4 },
    { ...apiUsage, cache_creation_input_tokens: null }, { ...apiUsage, input_tokens: '20' },
    { ...apiUsage, output_tokens: -1 }, { ...apiUsage, output_tokens: 0.1 },
    { ...apiUsage, input_tokens: Number.MAX_SAFE_INTEGER }]) {
    assert.equal(parseChatTokenUsage(invalid), null)
  }
})

function usageFixture(start = new Date(2026, 9, 20, 23, 59)) {
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  let now = start
  const make = () => new LocalUsageStore(() => storage, () => now)
  return { store: make(), make, storage, setDate: (date) => { now = date } }
}

test('usage survives reload, uses local calendar buckets, and stores at most 30 dates', () => {
  const { store, make, storage, setDate } = usageFixture()
  for (let days = 0; days <= 30; days++) {
    setDate(new Date(2026, 9, 20 + days, 23, 59)) // Crosses November DST rollback in America/Los_Angeles.
    store.record(store.capture(), usage)
  }
  assert.equal(Object.keys(JSON.parse(storage.getItem(USAGE_STORAGE_KEY))).length, 30)
  const reloaded = make()
  const totals = reloaded.getTotals()
  assert.deepEqual(totals.today, { ...usage, requests: 1 })
  assert.deepEqual(totals.last30, { inputTokens: 1020, outputTokens: 120, cacheHitTokens: 330, requests: 30 })
  setDate(new Date(2026, 10, 20, 0, 0))
  assert.deepEqual(reloaded.getTotals().today, zero)
  assert.equal(reloaded.getTotals().last30.requests, 29)
})

test('usage reset removes storage, notifies observers and ignores completions from the old key generation', () => {
  const { store, make, storage } = usageFixture()
  let notified = 0
  const unsubscribe = store.subscribe(() => ++notified)
  const generation = store.capture()
  store.record(generation, usage)
  store.reset()
  store.record(generation, usage)
  assert.equal(notified, 2)
  assert.equal(storage.getItem(USAGE_STORAGE_KEY), null)
  assert.deepEqual(make().getTotals(), { today: zero, last30: zero })
  store.record(store.capture(), usage)
  assert.equal(notified, 3)
  unsubscribe()
  store.record(store.capture(), usage)
  assert.equal(notified, 3)
  assert.deepEqual(store.getTotals().today, { inputTokens: 68, outputTokens: 8, cacheHitTokens: 22, requests: 2 })
})

test('usage only persists sanitized in-window totals and tolerates blocked storage', () => {
  const { store, storage } = usageFixture()
  storage.setItem(USAGE_STORAGE_KEY, JSON.stringify({
    '2026-10-20': { ...usage, requests: 1, key: 'must-not-persist' },
    '2026-10-19': { ...usage, cacheHitTokens: 999, requests: 1 },
    '2026-10-21': { ...usage, requests: 1 },
    '2026-09-20': { ...usage, requests: 1 },
  }))
  store.record(store.capture(), usage)
  assert.deepEqual(JSON.parse(storage.getItem(USAGE_STORAGE_KEY)), {
    '2026-10-20': { inputTokens: 68, outputTokens: 8, cacheHitTokens: 22, requests: 2 },
  })
  const memoryOnly = new LocalUsageStore(() => { throw new Error('blocked') })
  memoryOnly.record(memoryOnly.capture(), usage)
  assert.deepEqual(memoryOnly.getTotals().today, { ...usage, requests: 1 })
  memoryOnly.reset()
  assert.deepEqual(memoryOnly.getTotals().today, zero)
})
