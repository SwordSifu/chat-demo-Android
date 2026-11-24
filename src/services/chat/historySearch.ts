import { throwIfAborted } from '../../utils/abort.js'
import { getVisibleMessages } from './branches.js'
import type { Message, Session, SessionSummary } from './types.js'
import { buildReplyView } from './view.js'

export const HISTORY_SEARCH_DEBOUNCE_MS = 250
const PAGE_SIZE = 50
const SESSION_BATCH_SIZE = 8
const MESSAGE_BATCH_SIZE = 64
const EXCERPT_SIZE = 120

// Only fold ASCII letters, preserving both the literal query and UTF-16 offsets.
const foldAscii = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
export const historySearchQuery = (input: string) => (input.trim() ? foldAscii(input) : '')

export type HistorySearchExcerpt = { before: string; match: string; after: string }
export type HistorySearchResult = {
  sessionId: string
  title: HistorySearchExcerpt
  message?: { id: string; excerpt: HistorySearchExcerpt }
}

export type HistorySearchTarget = { sessionId: string; messageId: string; query: string }

// When cutting an excerpt, never split a surrogate pair.
const isInsidePair = (text: string, index: number) => {
  const hi = text.charCodeAt(index - 1)
  const lo = text.charCodeAt(index)
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff
}

const excerpt = (text: string, index: number, length: number): HistorySearchExcerpt => {
  if (index < 0) {
    let end = Math.min(text.length, EXCERPT_SIZE)
    if (isInsidePair(text, end)) {
      end--
    }
    return { before: text.slice(0, end), match: '', after: end < text.length ? '…' : '' }
  }
  const matchLength = Math.min(length, EXCERPT_SIZE)
  const context = EXCERPT_SIZE - matchLength
  let start = Math.max(0, Math.min(index - Math.floor(context / 2), text.length - EXCERPT_SIZE))
  let end = Math.min(text.length, start + EXCERPT_SIZE)
  if (isInsidePair(text, start)) {
    start++
  }
  if (isInsidePair(text, end)) {
    end--
  }
  const matchEnd = Math.min(index + matchLength, end)
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, index),
    match: text.slice(index, matchEnd),
    after: text.slice(matchEnd, end) + (end < text.length ? '…' : ''),
  }
}

const searchableText = (message: Message, liveReplyId?: string): string =>
  message.role === 'user'
    ? message.content
    : message.id === liveReplyId || message.stopReason === 'refusal'
      ? ''
      : (buildReplyView(message, false).answer?.text ?? '')

export const matchesHistorySearchMessage = (
  message: Message,
  query: string,
  liveReplyId?: string
) => Boolean(query) && foldAscii(searchableText(message, liveReplyId)).includes(query)

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const searchMessages = async (
  session: Session,
  query: string,
  signal: AbortSignal,
  liveReplyId?: string
): Promise<HistorySearchResult['message']> => {
  const path = getVisibleMessages(session)
  for (let i = path.length - 1; i >= 0; i--) {
    const message = path[i]
    const text = searchableText(message, liveReplyId)
    const index = foldAscii(text).indexOf(query)
    if (index >= 0) {
      return { id: message.id, excerpt: excerpt(text, index, query.length) }
    }
    if ((path.length - i) % MESSAGE_BATCH_SIZE === 0) {
      await yieldToUi()
      throwIfAborted(signal)
    }
  }
  return undefined
}

type SearchSources = {
  cachedSession: (id: string) => Session | undefined
  readSession: (id: string) => Promise<Session | undefined>
  liveReplyId: (id: string) => string | undefined
}

const isSameSession = (session: Session | undefined, summary: SessionSummary): session is Session =>
  session?.id === summary.id && session.createdAt === summary.createdAt

const currentCache = (summary: SessionSummary, sources: SearchSources) => {
  const session = sources.cachedSession(summary.id)
  return isSameSession(session, summary) && session.updatedAt === summary.updatedAt
    ? session
    : undefined
}

export type HistorySearchPage = {
  results: HistorySearchResult[]
  /** Next index in the ordered summary list, or null when exhausted. */
  next: number | null
  readError: boolean
}

/** Reads one detail at a time. Only bounded previews and IDs are retained between pages. */
export const searchHistoryPage = async (
  sessions: readonly SessionSummary[],
  query: string,
  from: number,
  signal: AbortSignal,
  sources: SearchSources
): Promise<HistorySearchPage> => {
  const results: HistorySearchResult[] = []
  let readError = false
  let cursor = from
  if (!query) {
    return { results, next: null, readError }
  }
  while (cursor < sessions.length && results.length < PAGE_SIZE) {
    throwIfAborted(signal)
    const summary = sessions[cursor++]
    const titleIndex = foldAscii(summary.title).indexOf(query)
    let message: HistorySearchResult['message']
    try {
      let session = currentCache(summary, sources)
      if (!session) {
        const stored = await sources.readSession(summary.id)
        throwIfAborted(signal)
        // The user may have opened this session while the read was pending.
        session = currentCache(summary, sources) ?? stored
      }
      if (isSameSession(session, summary)) {
        message = await searchMessages(session, query, signal, sources.liveReplyId(summary.id))
      } else {
        readError = true
      }
    } catch {
      throwIfAborted(signal)
      readError = true
    }
    throwIfAborted(signal)
    if (message || titleIndex >= 0) {
      results.push({
        sessionId: summary.id,
        title: excerpt(summary.title, titleIndex, query.length),
        ...(message && { message }),
      })
    }
    if ((cursor - from) % SESSION_BATCH_SIZE === 0 && cursor < sessions.length) {
      await yieldToUi()
    }
  }
  throwIfAborted(signal)
  return { results, next: cursor < sessions.length ? cursor : null, readError }
}
