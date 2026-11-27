import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const root = new URL('../src/', import.meta.url).href
const hook = registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')
    ? specifier.replace(/\.js$/, '.ts') : specifier, context)
} })
const { captureReplyUsage, getReplyUsage, pricePeriodAt, readReplyUsage } = await import('../src/services/account/replyUsage.ts')
hook.deregister()

const at = (date) => Date.parse(`${date}+08:00`)
const receipt = (input, hit, output, creation = 0) => ({
  input_tokens: input, cache_read_input_tokens: hit, cache_creation_input_tokens: creation, output_tokens: output,
})
const sample = (replyUsage, extra) => ({ status: 'done', model: 'deepseek-flash', replyUsage, ...extra })
const offPeak = at('2026-11-27T22:22:45')

test('both screenshot examples match exact CNY totals and omit zero categories', () => {
  const one = getReplyUsage(sample(captureReplyUsage(receipt(11830, 7424, 1526, 1), 'deepseek-flash', 'DeepSeek-V4.1-Flash-1017', offPeak)))
  assert.equal(one.totalCost, '0.01808348')
  assert.equal(one.totalTokens, 20781)
  assert.equal(one.contextLimit, 1_000_000)
  assert.deepEqual(one.rows, [
    { kind: 'hit', tokens: 7424, rate: '0.02', amount: '0.00014848' },
    { kind: 'miss', tokens: 11831, rate: '1', amount: '0.011831' },
    { kind: 'output', tokens: 1526, rate: '4', amount: '0.006104' },
  ])
  const two = getReplyUsage(sample(captureReplyUsage(receipt(60, 0, 98), 'deepseek-flash', undefined, offPeak)))
  assert.equal(two.totalCost, '0.000452')
  assert.deepEqual(two.rows.map(row => row.kind), ['miss', 'output'])
})

test('uses Beijing boundary times, weekends, known holidays and a bounded validity window', () => {
  for (const time of ['08:59:59', '12:00:00', '13:59:59', '18:00:00']) {
    assert.equal(pricePeriodAt(at(`2026-11-27T${time}`)), 'offPeak')
  }
  for (const time of ['09:00:00', '11:59:59', '14:00:00', '17:59:59']) {
    assert.equal(pricePeriodAt(at(`2026-11-27T${time}`)), 'peak')
  }
  assert.equal(pricePeriodAt(at('2026-11-28T10:00:00')), 'offPeak')
  assert.equal(pricePeriodAt(at('2027-02-08T10:00:00')), 'offPeak')
  assert.equal(pricePeriodAt(at('2027-02-15T10:00:00')), 'peak')
  assert.equal(pricePeriodAt(at('2028-01-01T10:00:00')), undefined)
  assert.equal(pricePeriodAt(NaN), undefined)
  const pro = captureReplyUsage(receipt(1, 1, 1), 'deepseek-flash', 'deepseek-v4-pro-0813', at('2026-11-27T09:00:00'))
  assert.deepEqual(pro.price, { period: 'peak', hit: 30, miss: 900, output: 2700 })
})

test('distinguishes missing receipts, unknown pricing, real zero and legacy totals', () => {
  const unknown = captureReplyUsage(receipt(1, 1, 1), 'deepseek-flash', 'future-model', offPeak)
  assert.equal(getReplyUsage(sample(unknown)).model, 'future-model')
  assert.equal(getReplyUsage(sample(unknown)).totalCost, undefined)
  assert.equal(getReplyUsage(sample(unknown)).contextLimit, undefined)
  assert.equal(captureReplyUsage(receipt(-1, 0, 2), 'deepseek-flash', undefined, offPeak), undefined)
  assert.equal(captureReplyUsage(receipt(Number.MAX_SAFE_INTEGER, 0, 1), 'deepseek-flash', undefined, offPeak), undefined)
  assert.equal(getReplyUsage(sample(undefined, { usage: receipt(60, 0, 0) })).totalTokens, undefined)
  assert.equal(getReplyUsage(sample(undefined, { usage: receipt(60, 0, 1) })).totalTokens, 61)
  assert.equal(getReplyUsage(sample(undefined, { usage: receipt(60, 0, 1) })).totalCost, undefined)
  const total = getReplyUsage(sample(undefined, { archiveContextTokens: 23 }))
  assert.equal(total.totalTokens, 23)
  assert.deepEqual(total.rows, [])
  const zero = captureReplyUsage(receipt(0, 0, 0), 'deepseek-flash', undefined, offPeak)
  assert.equal(getReplyUsage(sample(zero)).totalCost, '0')
  assert.equal(getReplyUsage(sample(zero, { status: 'stopped' })).totalCost, undefined)
  assert.deepEqual(readReplyUsage({ ...zero, model: '<fake>', price: { ...zero.price, hit: 1.5 } }), { hit: 0, miss: 0, output: 0, contextLimit: 1_000_000 })
})
