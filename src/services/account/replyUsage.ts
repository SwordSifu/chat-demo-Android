import type { AssistantMessage } from '../chat/types.js'
import { parseChatTokenUsage } from './usage.js'

const kinds = ['hit', 'miss', 'output'] as const
type Kind = (typeof kinds)[number]
type Period = 'peak' | 'offPeak'
type RateCard = { period: Period; hit: number; miss: number; output: number }
export type ReplyUsage = {
  model?: string
  hit: number
  miss: number
  output: number
  price?: RateCard
  contextLimit?: number
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const modelName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)

/** Optional metadata in our ZIP extension; malformed entries do not invalidate a chat. */
export const readReplyUsage = (value: unknown): ReplyUsage | undefined => {
  if (!object(value)) {
    return undefined
  }
  const { hit, miss, output, price, contextLimit, model } = value
  if (!count(hit) || !count(miss) || !count(output) || !count(hit + miss + output)) {
    return undefined
  }
  const checkedPrice = object(price) ? readPrice(price) : undefined
  return {
    hit, miss, output,
    ...(modelName(model) ? { model } : {}),
    ...(count(contextLimit) && contextLimit > 0 && contextLimit <= 100_000_000 ? { contextLimit } : {}),
    ...(checkedPrice ? { price: checkedPrice } : {}),
  }
}

function readPrice({ hit, miss, output, period }: Record<string, unknown>): RateCard | undefined {
  return (period === 'peak' || period === 'offPeak') && count(hit) && count(miss) && count(output) &&
    hit <= 1_000_000 && miss <= 1_000_000 && output <= 1_000_000 ? { period, hit, miss, output } : undefined
}

// Official CNY per million, in fen. Verified against the 2026-11-27 rate card.
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
const peak = {
  flash: { hit: 4, miss: 200, output: 800 },
  pro: { hit: 30, miss: 900, output: 2700 },
}
const familyFor = (model?: string) => {
  switch (model?.toLowerCase()) {
    case 'deepseek-flash':
    case 'deepseek-v4-flash':
    case 'deepseek-v4-flash-vision-exp':
    case 'deepseek-v4.1-flash':
    case 'deepseek-v4.1-flash-1017':
      return 'flash'
    case 'deepseek-v4-pro':
    case 'deepseek-v4-pro-0813':
      return 'pro'
    default:
      return undefined
  }
}

// Official 2027 holiday periods. The rate card explicitly keeps weekends off-peak,
// including makeup days; no holidays remain in the covered part of 2026.
// https://www.gov.cn/zhengce/content/202611/content_7085101.htm
const holidays2027 = [[101, 103], [205, 213], [403, 405], [501, 505], [609, 609], [915, 915], [1001, 1007]]
export function pricePeriodAt(requestTime: number): Period | undefined {
  if (!Number.isFinite(requestTime)) {
    return undefined
  }
  const china = new Date(requestTime + 8 * 3_600_000)
  const year = china.getUTCFullYear()
  const day = (china.getUTCMonth() + 1) * 100 + china.getUTCDate()
  if ((year !== 2026 || day < 1127) && year !== 2027) {
    return undefined
  }
  const weekday = china.getUTCDay()
  const hour = china.getUTCHours()
  const holiday = year === 2027 && holidays2027.some(([from, through]) => day >= from && day <= through)
  return !holiday && weekday >= 1 && weekday <= 5 &&
    ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)) ? 'peak' : 'offPeak'
}

export function captureReplyUsage(
  raw: unknown, requestModel: string, responseModel: string | undefined, requestTime: number
): ReplyUsage | undefined {
  const usage = parseChatTokenUsage(raw)
  if (!usage || !count(usage.inputTokens + usage.outputTokens)) {
    return undefined
  }
  const model = responseModel ?? requestModel
  const family = familyFor(model)
  const period = pricePeriodAt(requestTime)
  const card = family && period ? peak[family] : undefined
  const factor = period === 'peak' ? 1 : 0.5
  return {
    ...(modelName(model) ? { model } : {}),
    hit: usage.cacheHitTokens,
    miss: usage.inputTokens - usage.cacheHitTokens,
    output: usage.outputTokens,
    ...(family ? { contextLimit: 1_000_000 } : {}),
    ...(card && period ? { price: { period, hit: card.hit * factor, miss: card.miss * factor, output: card.output * factor } } : {}),
  }
}

/** Exact decimals: 1 fen per million tokens = 10⁻⁸ yuan per token. */
const decimal = (value: bigint, places: number): string => {
  const digits = value.toString().padStart(places + 1, '0')
  const fraction = digits.slice(-places).replace(/0+$/, '')
  return digits.slice(0, -places) + (fraction ? `.${fraction}` : '')
}

type Row = { kind: Kind; tokens: number; rate?: string; amount?: string }
type ReplyUsageView = { model?: string; totalTokens?: number; rows: Row[]; totalCost?: string; contextLimit?: number; period?: Period }

export function getReplyUsageSnapshot(reply: AssistantMessage): ReplyUsage | undefined {
  if (reply.status !== 'done') {
    return undefined
  }
  const saved = readReplyUsage(reply.replyUsage)
  if (saved) {
    return saved
  }
  // Older builds stored usage from message_start as well as message_delta. A nonzero
  // output proves this isn't the initial receipt. Do not retroactively price it.
  return reply.usage?.output_tokens ? captureReplyUsage(reply.usage, reply.model ?? '', undefined, NaN) : undefined
}

export function getReplyUsage(reply: AssistantMessage): ReplyUsageView {
  const fallback = { model: reply.model ?? undefined, rows: [] }
  const snapshot = getReplyUsageSnapshot(reply)
  if (!snapshot) {
    return { ...fallback, totalTokens: reply.status === 'done' && count(reply.archiveContextTokens) && reply.archiveContextTokens > 0 ? reply.archiveContextTokens : undefined }
  }
  const { price, contextLimit } = snapshot
  const totalTokens = snapshot.hit + snapshot.miss + snapshot.output
  let cost = 0n
  const rows = kinds.flatMap((kind): Row[] => {
    const tokens = snapshot[kind]
    if (tokens === 0 && (totalTokens !== 0 || kind !== 'output')) {
      return []
    }
    if (!price) {
      return [{ kind, tokens }]
    }
    const amount = BigInt(tokens) * BigInt(price[kind])
    cost += amount
    return [{ kind, tokens, rate: decimal(BigInt(price[kind]), 2), amount: decimal(amount, 8) }]
  })
  return {
    model: snapshot.model ?? fallback.model, rows, totalTokens, contextLimit,
    ...(price ? { period: price.period, totalCost: decimal(cost, 8) } : {}),
  }
}
