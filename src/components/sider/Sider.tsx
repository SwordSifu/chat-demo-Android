import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCloseOutline16,
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import type {
  HistorySearchExcerpt,
  HistorySearchResult,
} from '../../services/chat/historySearch.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import { useHistorySearch } from './useHistorySearch.js'
import styles from './Sider.module.css'

type OpenSearchResult = (result: HistorySearchResult, query: string) => void

const Highlight = ({ value }: { value: HistorySearchExcerpt }) => (
  <>
    {value.before}
    {value.match ? <mark>{value.match}</mark> : null}
    {value.after}
  </>
)

/** 展开的侧边栏：名称与收起按钮、开启新对话、搜索、按时间分组的会话列表和设置。 */
export const Sider = ({
  mobile = false,
  onSearchResult,
}: {
  mobile?: boolean
  onSearchResult: OpenSearchResult
}) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const search = useHistorySearch(mobile)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <IconButton
          size={mobile ? 'xl' : 'm'}
          icon={mobile ? <IconCloseOutline16 /> : <IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.historySearch}>
        <IconSearchOutline16 />
        <input
          role="searchbox"
          aria-label={t('historySearch')}
          placeholder={t('historySearch')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          value={search.input}
          disabled={search.disabled}
          onChange={(event) => search.updateInput(event.target.value)}
          onCompositionStart={search.startComposition}
          onCompositionEnd={search.endComposition}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return
            }
            if (event.key === 'Escape' && search.input) {
              event.stopPropagation()
              search.updateInput('')
            } else if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
          }}
        />
        {search.input && !search.disabled ? (
          <button
            type="button"
            className={styles.historySearchClear}
            aria-label={t('historySearchClear')}
            onClick={() => search.updateInput('')}
          >
            <IconCloseOutline16 />
          </button>
        ) : null}
      </div>
      <div className={styles.listWrap}>
        {search.active ? (
          <div className={styles.list} key="search">
            {search.initError ? (
              <div className={styles.historySearchStatus} role="alert">
                {t('sessionListLoadFailed')}
              </div>
            ) : search.page ? (
              <>
                <ul className={styles.historyResults} aria-label={t('historySearchResults')}>
                  {search.page.results.map((result) => (
                    <li key={result.sessionId}>
                      <button
                        type="button"
                        className={styles.historyResult}
                        aria-current={result.sessionId === activeId ? 'true' : undefined}
                        onClick={() => {
                          const query = search.queryForResult(result)
                          if (query) {
                            onSearchResult(result, query)
                          }
                        }}
                      >
                        <span className={styles.historyResultTitle}>
                          {result.title.before || result.title.match || result.title.after ? (
                            <Highlight value={result.title} />
                          ) : (
                            t('untitledChat')
                          )}
                        </span>
                        {result.message ? (
                          <span className={styles.historyResultExcerpt}>
                            <Highlight value={result.message.excerpt} />
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
                {search.page.readError ? (
                  <div className={styles.historySearchStatus} role="alert">
                    {t('historySearchReadError')}{' '}
                    <Button variant="outlined" size="s" onClick={search.refresh}>
                      {t('retry')}
                    </Button>
                  </div>
                ) : !search.page.results.length ? (
                  <div className={styles.historySearchStatus} role="status">
                    {t('historySearchEmpty')}
                  </div>
                ) : null}
                {search.page.next !== null ? (
                  <Button
                    variant="outlined"
                    size="m"
                    disabled={search.loadingMore}
                    onClick={search.loadMore}
                  >
                    {t(search.loadingMore ? 'historySearchLoading' : 'historySearchMore')}
                  </Button>
                ) : null}
              </>
            ) : (
              <div className={styles.historySearchStatus} role="status">
                {t('historySearchLoading')}
              </div>
            )}
          </div>
        ) : (
          <div className={styles.list} key="sessions">
            {groups.map((group) => (
              <div key={group.key} className={styles.section}>
                <div className={styles.sectionHeader}>{group.label}</div>
                {group.sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={session.id === activeId}
                    onDelete={() => setDeleting(session)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}
