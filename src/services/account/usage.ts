export type ChatTokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
}

type Totals = ChatTokenUsage & { requests: number }
const empty = (): Totals => ({ inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, requests: 0 })
const daysToKeep = 30
export const USAGE_STORAGE_KEY = 'chat-demo:local-chat-usage:v1'

type UsageStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** DeepSeek's cumulative Anthropic message_delta usage, not the initial message_start usage. */
export const parseChatTokenUsage = (raw: unknown): ChatTokenUsage | null => {
  if (!isObject(raw)) {
    return null
  }
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = raw
  if (!isCount(input_tokens) || !isCount(output_tokens) || !isCount(cache_read_input_tokens) ||
    !isCount(cache_creation_input_tokens)) {
    return null
  }
  const inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
  return isCount(inputTokens)
    ? { inputTokens, outputTokens: output_tokens, cacheHitTokens: cache_read_input_tokens }
    : null
}

const isUsage = (value: unknown): value is ChatTokenUsage =>
  isObject(value) && isCount(value.inputTokens) && isCount(value.outputTokens) &&
  isCount(value.cacheHitTokens) && value.cacheHitTokens <= value.inputTokens

const dayKey = (day: Date) =>
  `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`

// Local calendar arithmetic: today plus the previous 29 dates, including across DST.
const dayKeys = (date: Date) => {
  const day = new Date(date)
  day.setHours(12, 0, 0, 0)
  return Array.from({ length: daysToKeep }, (_, offset) => {
    if (offset > 0) {
      day.setDate(day.getDate() - 1)
    }
    return dayKey(day)
  })
}

const add = (a: Totals, b: Totals): Totals | null => {
  const sum = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    requests: a.requests + b.requests,
  }
  return isUsage(sum) && isCount(sum.requests) ? sum : null
}

export class LocalUsageStore {
  private generation = 0
  private revision = 0
  private listeners = new Set<() => void>()
  private days: Record<string, Totals> | null = null

  private readonly storage: () => UsageStorage
  private readonly now: () => Date

  constructor(storage: () => UsageStorage = () => localStorage, now = () => new Date()) {
    this.storage = storage
    this.now = now
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getRevision = () => this.revision
  capture = () => this.generation

  private notify() {
    ++this.revision
    this.listeners.forEach((listener) => listener())
  }

  private read(keys: string[]) {
    if (this.days) {
      return this.days
    }
    const days: Record<string, Totals> = {}
    this.days = days
    try {
      const encoded = this.storage().getItem(USAGE_STORAGE_KEY)
      if (!encoded || encoded.length > 8_192) {
        return days
      }
      const raw: unknown = JSON.parse(encoded)
      if (!isObject(raw)) {
        return days
      }
      let sum = empty()
      for (const key of keys) {
        const row = raw[key]
        if (!isObject(row)) {
          continue
        }
        const requests = row.requests
        if (!isUsage(row) || !isCount(requests) || requests === 0) {
          continue
        }
        const sanitized = {
          inputTokens: row.inputTokens, outputTokens: row.outputTokens,
          cacheHitTokens: row.cacheHitTokens, requests,
        }
        const next = add(sum, sanitized)
        if (next) {
          days[key] = sanitized
          sum = next
        }
      }
    } catch { /* Storage unavailable or invalid; keep current-session data only. */ }
    return days
  }

  private summarize(date: Date) {
    const keys = dayKeys(date)
    const data = this.read(keys)
    const days: Record<string, Totals> = {}
    let last30 = empty()
    for (const key of keys) {
      if (data[key]) {
        days[key] = data[key]
        last30 = add(last30, data[key]) ?? last30
      }
    }
    const todayKey = keys[0]
    return { days, today: days[todayKey] ?? empty(), todayKey, last30 }
  }

  getTotals = () => {
    const { today, last30 } = this.summarize(this.now())
    return { today, last30 }
  }

  record = (generation: number, usage: ChatTokenUsage) => {
    if (generation !== this.generation || !isUsage(usage)) {
      return
    }
    const { today, todayKey, days, last30 } = this.summarize(this.now())
    const increment = { ...usage, requests: 1 }
    const updated = add(today, increment)
    if (!updated || !add(last30, increment)) {
      return
    }
    days[todayKey] = updated
    this.days = days
    try {
      this.storage().setItem(USAGE_STORAGE_KEY, JSON.stringify(days))
    } catch { /* A quota error must not interfere with a completed chat. */ }
    this.notify()
  }

  reset = () => {
    ++this.generation
    this.days = {}
    try {
      this.storage().removeItem(USAGE_STORAGE_KEY)
    } catch { /* Still invalidate all earlier work in this session. */ }
    this.notify()
  }
}

export const localUsage = new LocalUsageStore()
export const captureUsageGeneration = localUsage.capture
export const recordChatUsage = localUsage.record
