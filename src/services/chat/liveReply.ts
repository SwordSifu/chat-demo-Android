import { useCallback, useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'
import type { AssistantMessage, Session } from './types.js'

// Only the row being generated subscribes. Metadata and the saved message tree do not
// change for each batch of tokens. At a storage/export boundary we compose a snapshot.
const liveReplies = createStore<ReadonlyMap<string, AssistantMessage>>(() => new Map())
const subscribeIdle = () => () => {}

export const useLiveReply = (sessionId: string, messageId: string, streaming: boolean) => {
  const snapshot = useCallback(() => {
    const reply = streaming ? liveReplies.getState().get(sessionId) : undefined
    return reply?.id === messageId ? reply : undefined
  }, [sessionId, messageId, streaming])
  return useSyncExternalStore(streaming ? liveReplies.subscribe : subscribeIdle, snapshot)
}

export const liveRepliesSnapshot = liveReplies.getState

export const publishLiveReply = (sessionId: string, reply: AssistantMessage) => {
  liveReplies.setState((replies) =>
    replies.get(sessionId) === reply ? replies : new Map(replies).set(sessionId, reply), true)
}

export const clearLiveReply = (sessionId: string) => {
  liveReplies.setState((replies) => {
    if (!replies.has(sessionId)) { return replies }
    const next = new Map(replies)
    next.delete(sessionId)
    return next
  }, true)
}

/** The saved tree owns links; overlay content must not overwrite them. */
export const withLiveReply = (session: Session, reply: AssistantMessage | undefined): Session => {
  if (!reply) { return session }
  const index = session.messages.findIndex(
    (message) => message.id === reply.id && message.role === 'assistant'
  )
  const stored = session.messages[index]
  if (!stored || stored === reply) { return session }
  const messages = session.messages.slice()
  messages[index] = { ...reply, parentId: stored.parentId, selectedChildId: stored.selectedChildId }
  return { ...session, messages }
}
