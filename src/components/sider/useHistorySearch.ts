import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { loadSession } from '../../services/chat/db.js'
import {
  HISTORY_SEARCH_DEBOUNCE_MS,
  historySearchQuery,
  searchHistoryPage,
  type HistorySearchPage,
  type HistorySearchResult,
} from '../../services/chat/historySearch.js'
import { useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { useSettings } from '../../services/settings.js'
import { useMobileSider } from './mobileSiderState.js'

const { getState, subscribe } = useChatStore
const sources = {
  cachedSession: (id: string) => {
    const { sessionCache } = getState()
    return Object.hasOwn(sessionCache, id) ? sessionCache[id] : undefined
  },
  readSession: loadSession,
  liveReplyId: (id: string) => {
    const { streaming } = getState()
    return Object.hasOwn(streaming, id) ? streaming[id].replyId : undefined
  },
}

type Job = {
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | undefined
  sessions: SessionSummary[]
  query: string
  page: HistorySearchPage | null
  loading: boolean
}

export const useHistorySearch = (mobile: boolean) => {
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const importing = useChatStore((state) => state.importingHistory)
  const [input, setInput] = useState('')
  const [composing, setComposing] = useState(false)
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState<HistorySearchPage | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const jobRef = useRef<Job | null>(null)
  const query = historySearchQuery(input)

  const cancel = useCallback(() => {
    const job = jobRef.current
    if (job) {
      clearTimeout(job.timer)
      job.controller.abort()
      jobRef.current = null
    }
  }, [])

  const clearResults = useCallback(() => {
    cancel()
    setPage(null)
    setLoadingMore(false)
  }, [cancel])

  const refresh = useCallback(() => {
    clearResults()
    setRevision((value) => value + 1)
  }, [clearResults])

  useLayoutEffect(
    () =>
      mobile
        ? useMobileSider.subscribe((state) => {
            if (!state.open) {
              cancel()
            } else {
              // The drawer may reopen before its exit animation unmounts the search UI.
              clearResults()
              setInput('')
              setComposing(false)
            }
          })
        : useSettings.subscribe((state) => {
            if (state.siderCollapsed) {
              cancel()
            }
          }),
    [cancel, clearResults, mobile]
  )

  useLayoutEffect(
    () =>
      subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          clearResults()
          setInput('')
          setComposing(false)
          return
        }
        if (!jobRef.current) {
          return
        }
        // Token deltas live outside this store. Invalidate on edits, branch switches,
        // title/order/stream changes, not merely because a cache entry loaded/evicted.
        if (
          state.sessions !== previous.sessions ||
          state.streaming !== previous.streaming ||
          (state.sessionCache !== previous.sessionCache &&
            Object.keys(state.sessionCache).some(
              (id) =>
                Object.hasOwn(previous.sessionCache, id) &&
                previous.sessionCache[id].messages !== state.sessionCache[id].messages
            ))
        ) {
          refresh()
        }
      }),
    [clearResults, refresh]
  )

  const loadPage = useCallback(async (job: Job, from: number) => {
    if (job.loading || job.controller.signal.aborted) {
      return
    }
    job.loading = true
    setLoadingMore(from > 0)
    const next = await searchHistoryPage(
      job.sessions,
      job.query,
      from,
      job.controller.signal,
      sources
    ).catch(() => null)
    if (jobRef.current !== job || job.controller.signal.aborted) {
      return
    }
    job.loading = false
    setLoadingMore(false)
    job.page = {
      results: [...(job.page?.results ?? []), ...(next?.results ?? [])],
      next: next?.next ?? null,
      readError: Boolean(job.page?.readError || !next || next.readError),
    }
    setPage(job.page)
  }, [])

  useLayoutEffect(() => {
    if (!query || !ready || importing || composing || getState().importingHistory ||
        (mobile && !useMobileSider.getState().open)) {
      return
    }
    const job: Job = {
      controller: new AbortController(),
      timer: undefined,
      sessions: getState().sessions,
      query,
      page: null,
      loading: false,
    }
    jobRef.current = job
    job.timer = setTimeout(() => void loadPage(job, 0), HISTORY_SEARCH_DEBOUNCE_MS)
    return cancel
  }, [cancel, composing, importing, loadPage, mobile, query, ready, revision])

  return {
    input,
    active: Boolean(query) && !importing,
    disabled: importing,
    page,
    initError: !ready && initError,
    loadingMore,
    updateInput(value: string) {
      if (getState().importingHistory) {
        return
      }
      if (historySearchQuery(value) !== query) {
        clearResults()
      }
      setInput(value)
    },
    startComposition() {
      clearResults()
      setComposing(true)
    },
    endComposition() {
      setComposing(false)
    },
    loadMore() {
      const job = jobRef.current
      if (job && job.page?.next != null) {
        void loadPage(job, job.page.next)
      }
    },
    refresh,
    queryForResult(result: HistorySearchResult) {
      const job = jobRef.current
      return job?.page?.results.includes(result) ? job.query : undefined
    },
  }
}
