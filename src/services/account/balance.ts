export const BALANCE_URL = 'https://api.deepseek.com/user/balance'
export const TOP_UP_URL = 'https://platform.deepseek.com/top_up'
export const PLATFORM_URL = 'https://platform.deepseek.com/'
const balanceTtl = 60_000
const requestTimeout = 15_000

export type BalanceAmount = {
  currency: string
  total: string
  granted: string
  toppedUp: string
}

type BalanceData = { status: 'available' | 'insufficient'; amounts: readonly BalanceAmount[] }
type BalanceResult = BalanceData & { updatedAt?: number }
export type BalanceState = BalanceResult | {
  status: 'idle' | 'noKey' | 'loading' | 'authFailure' | 'offline' | 'connectionFailure'
}

const idle: BalanceState = { status: 'idle' }
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isDecimal = (value: unknown): value is string =>
  typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)

export const parseBalance = (value: unknown): BalanceData | null => {
  if (!isObject(value)) {
    return null
  }
  const { is_available, balance_infos } = value
  if (typeof is_available !== 'boolean' || !Array.isArray(balance_infos)) {
    return null
  }
  const amounts: BalanceAmount[] = []
  for (const row of balance_infos) {
    if (!isObject(row)) {
      return null
    }
    const { currency, total_balance, granted_balance, topped_up_balance } = row
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) ||
      !isDecimal(total_balance) || !isDecimal(granted_balance) || !isDecimal(topped_up_balance)) {
      return null
    }
    amounts.push({ currency, total: total_balance, granted: granted_balance, toppedUp: topped_up_balance })
  }
  return { status: is_available ? 'available' : 'insufficient', amounts }
}

export class BalanceStore {
  private state: BalanceState = idle
  private listeners = new Set<() => void>()
  private boundKey: string | null | undefined
  private pending: { controller: AbortController; promise: Promise<void> } | null = null
  private cached: { state: BalanceResult; until: number } | null = null

  private readonly send: (url: string, init: RequestInit) => Promise<Response>
  private readonly now: () => number
  private readonly isOffline: () => boolean

  constructor(
    send: BalanceStore['send'] = (url, init) => fetch(url, init),
    now = () => performance.now(),
    isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false,
  ) {
    this.send = send
    this.now = now
    this.isOffline = isOffline
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = () => this.state

  private publish(state: BalanceState) {
    if (this.state === state) {
      return
    }
    this.state = state
    this.listeners.forEach((listener) => listener())
  }

  invalidate = () => {
    this.boundKey = undefined
    this.cached = null
    const previous = this.pending
    this.pending = null
    previous?.controller.abort()
    this.publish(idle)
  }

  load = (key: string | null, force = false): Promise<void> => {
    if (key !== this.boundKey) {
      this.invalidate()
      this.boundKey = key
    }
    if (!key) {
      this.publish({ status: 'noKey' })
      return Promise.resolve()
    }
    if (this.pending) {
      return this.pending.promise
    }
    if (!force && this.cached && this.now() < this.cached.until) {
      this.publish(this.cached.state)
      return Promise.resolve()
    }
    this.cached = null
    if (this.isOffline()) {
      this.publish({ status: 'offline' })
      return Promise.resolve()
    }
    const controller = new AbortController()
    const promise = this.request(key, controller).then((state) => {
      // Stale response, even if fetch ignored abort.
      if (this.pending?.controller !== controller) {
        return
      }
      this.pending = null
      if (state.status === 'available' || state.status === 'insufficient') {
        this.cached = { state, until: this.now() + balanceTtl }
      }
      this.publish(state)
    })
    this.pending = { controller, promise }
    this.publish({ status: 'loading' })
    return promise
  }

  private async request(key: string, controller: AbortController): Promise<BalanceState> {
    const timer = setTimeout(() => controller.abort(), requestTimeout)
    try {
      const response = await this.send(BALANCE_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      })
      if (response.status === 401 || response.status === 403) {
        return { status: 'authFailure' }
      }
      if (response.status === 402) {
        return { status: 'insufficient', amounts: [] }
      }
      if (!response.ok) {
        return { status: 'connectionFailure' }
      }
      const balance = parseBalance(await response.json())
      return balance ? { ...balance, updatedAt: Date.now() } : { status: 'connectionFailure' }
    } catch {
      return { status: this.isOffline() ? 'offline' : 'connectionFailure' }
    } finally {
      clearTimeout(timer)
    }
  }
}

export const accountBalance = new BalanceStore()
