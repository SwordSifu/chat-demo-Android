import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../i18n/index.js'
import type { HistorySearchResult, HistorySearchTarget } from '../services/chat/historySearch.js'
import { HistorySearchNavigation } from '../components/messages/historySearchNavigation.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel, useSearchPanel } from '../components/search/searchPanelState.js'
import { handleAndroidBack, registerBackHandler } from '../platform/back.js'
import { isAndroid } from '../platform/android.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider, useMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider } from '../components/sider/MobileSider.js'
import { Sider } from '../components/sider/Sider.js'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const mainRef = useRef<HTMLElement>(null)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)
  const [searchTarget, setSearchTarget] = useState<HistorySearchTarget | null>(null)
  const finishSearchNavigation = useCallback((target: HistorySearchTarget) => {
    setSearchTarget((current) => (current === target ? null : current))
  }, [])
  const historySearchNavigation = useMemo(
    () => ({ target: searchTarget, finish: finishSearchNavigation }),
    [searchTarget, finishSearchNavigation]
  )

  usePreventPageScroll(isMobile)

  // A pending jump belongs only to this activation, not to a later retry, import, or return.
  useLayoutEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (
          state.activeId === previous.activeId &&
          state.importingHistory === previous.importingHistory &&
          state.sessionLoadErrors === previous.sessionLoadErrors
        ) {
          return
        }
        setSearchTarget((target) => {
          if (
            target &&
            (state.importingHistory ||
              state.activeId !== target.sessionId ||
              state.sessionLoadErrors[target.sessionId] === true)
          ) {
            return null
          }
          return target
        })
      }),
    []
  )

  const openSearchResult = useCallback(
    ({ sessionId, message }: HistorySearchResult, query: string) => {
      const state = useChatStore.getState()
      if (state.importingHistory) {
        return
      }
      if (!state.sessions.some((summary) => summary.id === sessionId)) {
        showToast({ key: 'historySearchSessionUnavailable', type: 'error' })
        return
      }
      selectSession(sessionId)
      const current = useChatStore.getState()
      setSearchTarget(
        message &&
          current.activeId === sessionId &&
          !current.importingHistory &&
          current.sessionLoadErrors[sessionId] !== true
          ? { sessionId, messageId: message.id, query }
          : null
      )
      closeMobileSider()
    },
    []
  )

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])
  useEffect(() => {
    if (!isAndroid()) {
      return
    }
    const unregister = registerBackHandler(() => {
      if (useSearchPanel.getState().entry) {
        closeSearchPanel()
        return true
      }
      if (useMobileSider.getState().open) {
        closeMobileSider()
        return true
      }
      return false
    })
    window.__deepseekAndroidBack = handleAndroidBack
    window.__deepseekAndroidBackground = () => window.dispatchEvent(new Event('android-background'))
    const onBackground = () => stopReadAloud()
    const onVisibility = () => {
      if (document.hidden) {
        onBackground()
      }
    }
    window.addEventListener('android-background', onBackground)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      unregister()
      delete window.__deepseekAndroidBack
      delete window.__deepseekAndroidBackground
      window.removeEventListener('android-background', onBackground)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat()
    // 首次打开先在设置里输入 API Key
    ensureApiKey()
  }, [])

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {!isMobile && !siderCollapsed ? <Sider onSearchResult={openSearchResult} /> : null}
        <main ref={mainRef} className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <HistorySearchNavigation.Provider value={historySearchNavigation}>
                <SessionView
                  session={session}
                  streaming={streaming}
                  siderCollapsed={siderCollapsed}
                />
              </HistorySearchNavigation.Provider>
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
        {isMobile ? <MobileSider mainRef={mainRef} onSearchResult={openSearchResult} /> : null}
      </div>
      <SettingsDialog />
      <Toast />
    </>
  )
}
