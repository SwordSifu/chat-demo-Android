import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { accountBalance, PLATFORM_URL, TOP_UP_URL, type BalanceState } from '../../services/account/balance.js'
import { localUsage } from '../../services/account/usage.js'
import { useSettings, type Locale } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import styles from './AccountSettings.module.css'

type AccountCopy = Record<'balance' | 'refresh' | 'total' | 'granted' | 'toppedUp' | 'topUp' | 'platform' |
  'updatedAt' | 'usage' | 'today' | 'last30' | 'input' | 'output' | 'cacheHits' | 'usageScope' | 'keyReset' |
  'clear' | 'confirmClear' | 'confirmText' | 'cancel', string> & {
  statuses: Record<BalanceState['status'], string>
}

const copy: Record<Locale, AccountCopy> = {
  'zh-CN': {
    balance: 'DeepSeek 账户余额',
    refresh: '刷新余额',
    updatedAt: '更新时间',
    clear: '清空本机用量',
    confirmClear: '确认清空',
    confirmText: '确定清空本机 Token 统计？不会影响账户余额或官方账单。',
    cancel: '取消',
    total: '总余额',
    granted: '赠送余额',
    toppedUp: '充值余额',
    topUp: '前往官方充值',
    platform: '打开官方开放平台',
    usage: '本机 Token 用量',
    today: '今天',
    last30: '最近 30 天（含今天）',
    input: '输入 Token',
    output: '输出 Token',
    cacheHits: '其中缓存命中',
    usageScope: '按本机日期统计，仅计入本应用正常结束且返回有效用量的聊天请求。不含语音、其他设备或估算数据，不等同于官方账单。',
    keyReset: '更换或删除 API Key 后，本机 Token 统计会清空。',
    statuses: {
      idle: '请刷新以查询余额。',
      noKey: '添加 API Key 后可查询余额。',
      loading: '正在查询余额…',
      available: '余额可用于 API 调用。',
      insufficient: '余额不足，可能无法调用 API。',
      authFailure: 'API Key 鉴权失败，请检查设置。',
      offline: '设备离线，无法查询余额。',
      connectionFailure: '无法查询余额，请检查网络或稍后重试。',
    },
  },
  'en-US': {
    balance: 'DeepSeek account balance',
    refresh: 'Refresh balance',
    updatedAt: 'Updated',
    clear: 'Clear local usage',
    confirmClear: 'Confirm clear',
    confirmText: 'Clear local token totals? This does not affect your balance or official bill.',
    cancel: 'Cancel',
    total: 'Total balance',
    granted: 'Granted balance',
    toppedUp: 'Topped-up balance',
    topUp: 'Top up on DeepSeek',
    platform: 'Open DeepSeek Platform',
    usage: 'Local token usage',
    today: 'Today',
    last30: 'Last 30 days (including today)',
    input: 'Input tokens',
    output: 'Output tokens',
    cacheHits: 'Of which, cache hits',
    usageScope: 'Uses this device’s calendar and counts only chats in this app that finish normally and report valid usage. Excludes speech, other devices, and estimates; not an official bill.',
    keyReset: 'Changing or deleting the API key clears local token usage.',
    statuses: {
      idle: 'Refresh to check your balance.',
      noKey: 'Add an API key to check your balance.',
      loading: 'Checking balance…',
      available: 'Balance is sufficient for API calls.',
      insufficient: 'Insufficient balance. API calls may not work.',
      authFailure: 'Authentication failed. Check your API key.',
      offline: 'You are offline. Balance is unavailable.',
      connectionFailure: 'Could not check your balance. Check your connection or try again later.',
    },
  },
}

// Keep the windows current if Settings is left open across local midnight or backgrounded.
const useCalendarTick = () => {
  const [, setTick] = useState(0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      setTick((tick) => tick + 1)
      const now = new Date()
      const tomorrow = new Date(now)
      tomorrow.setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, Math.max(tomorrow.getTime() - now.getTime(), 1))
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
}

/** Mount only when the balance/usage Settings tab is selected. */
export const AccountSettings = () => {
  const locale = useSettings((state) => state.locale)
  const hasKey = useSettings((state) => !!state.apiKey)
  const balance = useSyncExternalStore(accountBalance.subscribe, accountBalance.getSnapshot)
  useSyncExternalStore(localUsage.subscribe, localUsage.getRevision)
  useEffect(() => {
    void accountBalance.load(useSettings.getState().apiKey)
  }, [])
  useCalendarTick()
  const { today, last30 } = localUsage.getTotals()
  const [confirmReset, setConfirmReset] = useState(false)
  const t = copy[locale]
  const status = hasKey ? balance.status : 'noKey'
  const result = hasKey && (balance.status === 'available' || balance.status === 'insufficient') ? balance : null
  const balanceHeading = useId()
  const usageHeading = useId()
  const resetLabel = useId()
  const format = new Intl.NumberFormat(locale)

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby={balanceHeading}>
        <div className={styles.headingRow}>
          <h3 id={balanceHeading}>{t.balance}</h3>
          <Button variant="outlined" size="m" disabled={!hasKey || status === 'loading'}
            onClick={() => void accountBalance.load(useSettings.getState().apiKey, true)}>{t.refresh}</Button>
        </div>
        <p role="status" className={styles.details}>{t.statuses[status]}</p>
        {result?.updatedAt === undefined ? null : (
          <p className={styles.details}>{t.updatedAt}{': '}
            <time dateTime={new Date(result.updatedAt).toISOString()}>
              {new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(result.updatedAt)}
            </time>
          </p>
        )}
        <div className={styles.cards}>
          {result?.amounts.map((amount, index) => (
            <div className={styles.card} key={`${amount.currency}-${index}`}>
              <h4>{amount.currency}</h4>
              <dl>
                <dt>{t.total}</dt><dd>{amount.total}</dd>
                <dt>{t.granted}</dt><dd>{amount.granted}</dd>
                <dt>{t.toppedUp}</dt><dd>{amount.toppedUp}</dd>
              </dl>
            </div>
          ))}
        </div>
        <div className={styles.links}>
          <a href={TOP_UP_URL} target="_blank" rel="noopener noreferrer">{t.topUp}</a>
          <a href={PLATFORM_URL} target="_blank" rel="noopener noreferrer">{t.platform}</a>
        </div>
      </section>
      <section className={styles.section} aria-labelledby={usageHeading}>
        <h3 id={usageHeading}>{t.usage}</h3>
        <p className={styles.details}>{t.usageScope}</p>
        <div className={styles.cards}>
          {([[t.today, today], [t.last30, last30]] as const).map(([label, totals]) => (
            <div className={styles.card} key={label}>
              <h4>{label}</h4>
              <dl>
                <dt>{t.input}</dt><dd>{format.format(totals.inputTokens)}</dd>
                <dt>{t.output}</dt><dd>{format.format(totals.outputTokens)}</dd>
                <dt>{t.cacheHits}</dt><dd>{format.format(totals.cacheHitTokens)}</dd>
              </dl>
            </div>
          ))}
        </div>
        <p className={styles.details}>{t.keyReset}</p>
        {confirmReset ? (
          <div className={styles.clearRow} role="group" aria-labelledby={resetLabel}>
            <p id={resetLabel} className={styles.details}>{t.confirmText}</p>
            <Button variant="outlined" size="m" onClick={() => setConfirmReset(false)}>{t.cancel}</Button>
            <Button variant="dangerOutlined" size="m" onClick={() => {
              localUsage.reset()
              setConfirmReset(false)
            }}>{t.confirmClear}</Button>
          </div>
        ) : (
          <div className={styles.clearRow}>
            <Button variant="outlined" size="m" onClick={() => setConfirmReset(true)}>{t.clear}</Button>
          </div>
        )}
      </section>
    </div>
  )
}
