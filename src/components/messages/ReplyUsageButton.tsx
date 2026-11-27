import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getReplyUsage } from '../../services/account/replyUsage.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { useSettings } from '../../services/settings.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import styles from './ReplyUsageButton.module.css'

const rowLabels = {
  hit: 'replyUsageCacheHit',
  miss: 'replyUsageCacheMiss',
  output: 'replyUsageOutput',
} as const

const CoinIcon = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx={8} cy={8} r={6.5} stroke="currentColor" strokeWidth={1.25} />
    <path
      d="M6 5.2l2 2.4 2-2.4M6.2 7.8h3.6m-3.6 1.7h3.6M8 7.6v3.2"
      stroke="currentColor"
      strokeWidth={1.1}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const ReplyUsage = ({ message }: { message: AssistantMessage }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const { model, totalTokens, rows, totalCost, contextLimit, period } = getReplyUsage(message)
  const number = new Intl.NumberFormat(locale)
  const hasContext = totalTokens !== undefined && contextLimit !== undefined && contextLimit > 0
  const formatContext = (fraction: number) => fraction > 0 && fraction < 0.01
    ? t('replyUsageBelowOnePercent')
    : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(fraction)
  const usageNotice = totalTokens === undefined
    ? 'replyUsageIncomplete'
    : rows.length === 0
      ? 'replyUsageTotalOnly'
      : totalCost === undefined
        ? 'replyUsageUnknownPrice'
        : null

  return (
    <>
      <dl className={styles.details}>
        <dt>{t('replyUsageModel')}</dt>
        <dd>{model ?? t('replyUsageUnknownModel')}</dd>
        {period === undefined ? null : (
          <>
            <dt>{t('replyUsagePeriod')}</dt>
            <dd>{t(period === 'peak' ? 'replyUsagePeak' : 'replyUsageOffPeak')}</dd>
          </>
        )}
        {totalTokens === undefined ? null : (
          <>
            <dt>{t('replyUsageTotalTokens')}</dt>
            <dd data-testid="reply-usage-token-total">{number.format(totalTokens)}</dd>
          </>
        )}
        {hasContext ? (
          <>
            <dt>{t('replyUsageContext')}</dt>
            <dd data-testid="reply-usage-context">
              {t('replyUsageContextValue', {
                percent: formatContext(totalTokens / contextLimit),
                tokens: number.format(totalTokens),
                limit: number.format(contextLimit),
              })}
            </dd>
          </>
        ) : null}
      </dl>
      {rows.length === 0 ? null : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('replyUsageKind')}</th>
              <th scope="col">{t('replyUsageRate')}</th>
              <th scope="col">{t('replyUsageTokens')}</th>
              <th scope="col">{t('replyUsageAmount')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ kind, tokens, rate, amount }) => (
              <tr key={kind} data-testid="reply-usage-row" data-usage-kind={kind}>
                <th scope="row">{t(rowLabels[kind])}</th>
                <td>{rate ?? '—'}</td>
                <td>{number.format(tokens)}</td>
                <td>{amount ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dl className={styles.total}>
        <dt>{t('replyUsageTotalCost')}</dt>
        <dd data-testid="reply-usage-total">
          {totalCost === undefined ? '—' : t('replyUsageCurrency', { value: totalCost })}
        </dd>
      </dl>
      {usageNotice ? <p className={styles.notice}>{t(usageNotice)}</p> : null}
      <p className={styles.note}>{t('replyUsageEstimateNote')}</p>
    </>
  )
}

export const ReplyUsageButton = ({ message }: { message: AssistantMessage }) => {
  const t = useTranslate()
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  return (
    <>
      <IconButton
        className={styles.trigger}
        icon={<CoinIcon />}
        tooltip={t('replyUsage')}
        tooltipPlacement="bottom"
        data-testid="reply-usage-button"
        aria-haspopup="dialog"
        aria-expanded={!!trigger}
        onClick={(event) => setTrigger(event.currentTarget)}
      />
      {trigger ? (
        <Modal
          title={t('replyUsage')}
          presentation="sheet"
          testIdPrefix="reply-usage"
          returnFocusTo={trigger}
          closable
          onClose={() => setTrigger(null)}
        >
          <ReplyUsage message={message} />
        </Modal>
      ) : null}
    </>
  )
}
