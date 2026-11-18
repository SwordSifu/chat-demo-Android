import assert from 'node:assert/strict'
import test from 'node:test'
import { DiagnosticBuffer, sanitizeEvent } from '../src/services/diagnosticsCore.ts'

const events = [
  'app.start', 'app.error', 'app.rejection', 'app.background',
  'audio.permission.request', 'audio.permission.granted', 'audio.permission.error',
  'audio.context.ready', 'audio.context.state', 'audio.context.error',
  'audio.capture.start', 'audio.capture.stop', 'audio.capture.cancel',
  'audio.capture.empty', 'audio.capture.stall', 'audio.capture.limit',
  'voice.start', 'voice.stop', 'voice.cancel', 'voice.error',
  'asr.start', 'asr.success', 'asr.error', 'asr.cancel',
  'api.start', 'api.response', 'api.error', 'api.cancel', 'logs.export',
  'native.start', 'native.permission.request', 'native.permission.result',
  'native.permission.cancel', 'native.lifecycle.pause', 'native.lifecycle.stop',
  'native.lifecycle.resume', 'native.renderer.gone', 'native.bridge.error', 'native.webview',
]
const numberKeys = [
  'durationMs', 'elapsedMs', 'inputRate', 'outputRate', 'frames', 'samples',
  'bytes', 'status', 'count', 'androidSdk', 'webViewMajor',
]
const booleanKeys = [
  'granted', 'pending', 'crashed', 'enabled', 'secureContext', 'mediaAvailable', 'audioAvailable',
]
const enums = {
  api: ['models', 'messages', 'files', 'asr', 'tts', 'unknown'],
  method: ['GET', 'POST', 'DELETE', 'OTHER'],
  contextState: ['running', 'suspended', 'interrupted', 'closed', 'unknown'],
  errorName: [
    'Error', 'TypeError', 'RangeError', 'DOMException', 'AbortError', 'NotAllowedError',
    'NotFoundError', 'NotReadableError', 'SecurityError', 'NotSupportedError',
    'InvalidStateError', 'OverconstrainedError', 'TimeoutError', 'NativeError', 'ApiError',
    'SecurityException', 'IllegalArgumentException', 'IllegalStateException', 'JSONException',
    'IOException', 'GeneralSecurityException', 'RuntimeException', 'Exception', 'unknown',
  ],
  apiKind: ['http', 'network', 'protocol', 'interrupted', 'stream', 'abort', 'unknown'],
  reason: [
    'user', 'background', 'unmount', 'limit', 'start_failure', 'no_samples',
    'stalled', 'timeout', 'permission_denied', 'other',
  ],
  source: ['js', 'native'],
}
const input = (details = {}, event = 'app.error', t = 1) => ({ t, event, details })
const fullDetails = () => ({
  ...Object.fromEntries(numberKeys.map((key) => [key, 1e12])),
  ...Object.fromEntries(booleanKeys.map((key) => [key, true])),
  ...Object.fromEntries(Object.entries(enums).map(([key, values]) => [key, values[0]])),
})

test('accepts every specified JS/native event but no free-form event names', () => {
  for (const event of events) assert.deepEqual(sanitizeEvent(input({}, event)), input({}, event))
  for (const event of ['', 'constructor', '__proto__', 'toString', 'api.start.secret',
    'app.error: sk-test-private', 'App.Start', 'app.start\n', 'message', 'https://secret.example']) {
    assert.equal(sanitizeEvent(input({}, event)), null, event)
  }
})

test('accepts numeric bounds without coercion; drops negative/nonfinite/oversized values', () => {
  for (const key of numberKeys) {
    for (const value of [0, 0.5, 1, 48_000, 1e12]) {
      assert.deepEqual(sanitizeEvent(input({ [key]: value })).details, { [key]: value })
    }
    for (const value of [-1, NaN, Infinity, -Infinity, 1e12 + 1, '42', true, null, {}, [], 1n]) {
      assert.deepEqual(sanitizeEvent(input({ [key]: value })).details, {}, key)
    }
  }
})

test('boolean fields only admit literal true and false', () => {
  for (const key of booleanKeys) {
    for (const value of [true, false]) {
      assert.deepEqual(sanitizeEvent(input({ [key]: value })).details, { [key]: value })
    }
    for (const value of [0, 1, 'true', 'false', null, [], {}]) {
      assert.deepEqual(sanitizeEvent(input({ [key]: value })).details, {}, key)
    }
  }
})

test('string fields only admit their own exact enum, never truncated/redacted arbitrary strings', () => {
  for (const [key, values] of Object.entries(enums)) {
    for (const value of values) {
      assert.deepEqual(sanitizeEvent(input({ [key]: value })).details, { [key]: value })
    }
    for (const value of ['', 'toString', '__proto__', 'constructor', 'sk-private',
      'Error: secret transcript', `${values[0]} extra`, `${values[0]}\n`,
      values[0].toLowerCase() === values[0] ? values[0].toUpperCase() : values[0].toLowerCase(),
      1, null, {}, ['unknown']]) {
      if (!values.includes(value)) assert.deepEqual(sanitizeEvent(input({ [key]: value })).details, {}, key)
    }
  }
})

test('timestamps accept actual epoch milliseconds independently of the detail-number cap', () => {
  const now = Date.now()
  assert.ok(now > 1e12)
  for (const t of [0, 0.5, now, Number.MAX_SAFE_INTEGER]) {
    assert.equal(sanitizeEvent(input({}, 'app.start', t)).t, t)
  }
  for (const t of [-1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '123', null, {}]) {
    assert.equal(sanitizeEvent({ t, event: 'app.start', details: {} }), null)
  }
  assert.equal(sanitizeEvent({ event: 'app.start' }), null)
})

test('invalid containers are rejected or reduced to an empty details record', () => {
  for (const value of [undefined, null, true, 1, 'app.start', [], () => {}]) {
    assert.equal(sanitizeEvent(value), null)
  }
  for (const details of [undefined, null, 1, true, 'private', [], () => {}]) {
    assert.deepEqual(sanitizeEvent({ t: 1, event: 'app.start', details }).details, {})
  }
})

test('does not retain secrets, URLs, audio, arbitrary message fields or top-level extras', () => {
  const secret = 'sk-test-PRIVATE-DO-NOT-KEEP'
  const forbidden = [
    'message', 'stack', 'url', 'headers', 'body', 'apiKey', 'transcript', 'audio',
    'text', 'path', 'filename', 'authorization', 'prompt', 'response', 'error', 'value',
  ]
  const details = Object.fromEntries(forbidden.map((key) => [key, secret]))
  details.headers = { Authorization: `Bearer ${secret}` }
  details.audio = new Uint8Array([1, 2, 3])
  details.body = { text: 'PRIVATE CHAT', transcript: 'PRIVATE VOICE' }
  details.errorName = `${secret}: Error`
  details.api = 'https://private.example/v1'
  details.status = secret
  details.reason = secret.repeat(50_000)
  details.count = 2
  const raw = { ...input(details), apiKey: secret, stack: 'PRIVATE STACK', toJSON: () => secret }
  const buffer = new DiagnosticBuffer()
  buffer.record(raw.event, raw.details, raw.t)
  assert.deepEqual(buffer.snapshot(), [input({ count: 2 })])
  assert.deepEqual(sanitizeEvent(raw), input({ count: 2 }))
  assert.ok(!buffer.serialize().includes(secret))
  assert.ok(!buffer.serialize().includes('PRIVATE'))
})

test('own data properties only: inherited/prototype-pollution fields and getters cannot enter logs', () => {
  const inherited = Object.create({ t: 1, event: 'app.start', details: { count: 1 } })
  assert.equal(sanitizeEvent(inherited), null)
  const details = Object.assign(Object.create({ count: 99, granted: true, errorName: 'Error' }), { status: 200 })
  let getterCalls = 0
  Object.defineProperty(details, 'frames', { get() { getterCalls++; throw new Error('PRIVATE') } })
  const clean = sanitizeEvent(input(details))
  assert.deepEqual(clean, input({ status: 200 }))
  assert.equal(getterCalls, 0)
  const top = { t: 1, details: {} }
  Object.defineProperty(top, 'event', { get() { getterCalls++; return 'app.start' } })
  assert.equal(sanitizeEvent(top), null)
  assert.equal(getterCalls, 0)
  const pollution = JSON.parse('{"t":1,"event":"app.error","details":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"count":1}}')
  assert.deepEqual(sanitizeEvent(pollution), input({ count: 1 }))
  assert.equal(Object.prototype.polluted, undefined)
})

test('revoked or hostile proxies fail closed without throwing or calling toJSON', () => {
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  assert.equal(sanitizeEvent(revoked.proxy), null)
  const hostile = new Proxy(input(), { getOwnPropertyDescriptor() { throw new Error('PRIVATE') } })
  assert.equal(sanitizeEvent(hostile), null)
  const details = { count: 1, toJSON() { throw new Error('PRIVATE') } }
  assert.deepEqual(sanitizeEvent(input(details)), input({ count: 1 }))
})

test('record clones input; sanitizeEvent and snapshot never expose internal mutable records', () => {
  const details = { count: 1, granted: true, source: 'js' }
  const buffer = new DiagnosticBuffer()
  buffer.record('app.start', details, 1)
  details.count = 999
  details.message = 'PRIVATE'
  const first = buffer.snapshot()
  first[0].event = 'PRIVATE'
  first[0].details.count = 888
  first[0].details.message = 'PRIVATE'
  first.push(input({ message: 'PRIVATE' }))
  assert.deepEqual(buffer.snapshot(), [input({ count: 1, granted: true, source: 'js' }, 'app.start')])
  const raw = input({ count: 2 })
  const clean = sanitizeEvent(raw)
  raw.details.count = 7
  assert.equal(clean.details.count, 2)
  const empty = new DiagnosticBuffer()
  empty.snapshot().push(input())
  assert.equal(empty.serialize(), '[]')
})

test('count ring keeps only the newest 256 events and supplies a current timestamp by default', () => {
  const buffer = new DiagnosticBuffer()
  for (let i = 0; i < 1_000; i++) buffer.record('api.response', { status: 200, count: i }, i)
  assert.equal(buffer.snapshot().length, 256)
  assert.equal(buffer.snapshot()[0].t, 744)
  assert.equal(buffer.snapshot().at(-1).t, 999)
  assert.ok(buffer.serialize().length <= 65_536)
  const before = Date.now()
  buffer.record('app.start')
  assert.ok(buffer.snapshot().at(-1).t >= before)
  assert.ok(buffer.snapshot().at(-1).t <= Date.now())
  buffer.record('PRIVATE_EVENT', { count: 1 }, 1)
  assert.equal(buffer.snapshot().at(-1).event, 'app.start')
})

test('serialized character/UTF8 budget evicts whole oldest entries even below the count limit', () => {
  const buffer = new DiagnosticBuffer()
  for (let i = 0; i < 600; i++) buffer.record('native.permission.result', fullDetails(), i)
  const snapshot = buffer.snapshot()
  const serialized = buffer.serialize()
  assert.ok(snapshot.length > 0 && snapshot.length < 256)
  assert.ok(serialized.length <= 65_536)
  assert.equal(Buffer.byteLength(serialized, 'utf8'), serialized.length)
  assert.equal(snapshot.at(-1).t, 599)
  assert.equal(snapshot[0].t, 600 - snapshot.length)
  assert.deepEqual(JSON.parse(serialized), snapshot)
  assert.deepEqual(new DiagnosticBuffer(serialized).snapshot(), snapshot)
})

test('reload re-sanitizes mixed, contaminated history, not just newly recorded events', () => {
  const secret = 'PRIVATE-KEY-TRANSCRIPT'
  const serialized = JSON.stringify([
    null,
    input({ count: 2, message: secret, errorName: `${secret}: Error`, headers: { secret } }),
    input({ status: 200 }, 'made.up'),
    { t: -1, event: 'api.start', details: {} },
    input({ source: 'native', method: 'GET', audio: secret }, 'native.start', 2),
  ])
  const buffer = new DiagnosticBuffer(serialized)
  assert.deepEqual(buffer.snapshot(), [
    input({ count: 2 }), input({ method: 'GET', source: 'native' }, 'native.start', 2),
  ])
  assert.ok(!buffer.serialize().includes(secret))
  assert.deepEqual(new DiagnosticBuffer(buffer.serialize()).snapshot(), buffer.snapshot())
})

test('reload enforces ring limits independently of serialized input acceptance', () => {
  const history = Array.from({ length: 800 }, (_, i) => input({ count: i }, 'api.start', i))
  const serialized = JSON.stringify(history)
  assert.ok(serialized.length <= 128 * 1024)
  const buffer = new DiagnosticBuffer(serialized)
  assert.equal(buffer.snapshot().length, 256)
  assert.equal(buffer.snapshot()[0].t, 544)
  assert.equal(buffer.snapshot().at(-1).t, 799)
})

test('history rejects over 128 KiB including multi-byte text; exact byte boundary is accepted', () => {
  const one = JSON.stringify([input({ count: 1 })])
  const exact = one.padEnd(128 * 1024, ' ')
  assert.equal(new DiagnosticBuffer(exact).snapshot().length, 1)
  assert.deepEqual(new DiagnosticBuffer(`${exact} `).snapshot(), [])
  const unicode = JSON.stringify([input({ message: '汉'.repeat(50_000), count: 1 })])
  assert.ok(unicode.length < 128 * 1024)
  assert.ok(Buffer.byteLength(unicode, 'utf8') > 128 * 1024)
  assert.deepEqual(new DiagnosticBuffer(unicode).snapshot(), [])
})

test('malformed/nonarray/incorrectly typed stored values fail closed without retaining input', () => {
  for (const serialized of [undefined, null, 3, {}, '', '{', 'null', 'true', '{}',
    '{"events":[{"t":1,"event":"app.start"}]}', '["PRIVATE"]']) {
    const buffer = new DiagnosticBuffer(serialized)
    assert.deepEqual(buffer.snapshot(), [])
    assert.equal(buffer.serialize(), '[]')
  }
})

test('clear removes all events and resets both budgets for subsequent recording', () => {
  const buffer = new DiagnosticBuffer()
  for (let i = 0; i < 600; i++) buffer.record('api.response', fullDetails(), i)
  const staleSnapshot = buffer.snapshot()
  buffer.clear()
  assert.deepEqual(buffer.snapshot(), [])
  assert.equal(buffer.serialize(), '[]')
  staleSnapshot[0].details.message = 'PRIVATE'
  for (let i = 0; i < 256; i++) buffer.record('app.start', { count: i }, i)
  assert.equal(buffer.snapshot().length, 256)
  assert.equal(buffer.snapshot()[0].t, 0)
  assert.equal(buffer.snapshot().at(-1).t, 255)
  assert.ok(!buffer.serialize().includes('PRIVATE'))
})
