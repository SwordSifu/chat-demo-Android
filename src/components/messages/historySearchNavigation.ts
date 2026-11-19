import { createContext } from 'react'
import type { HistorySearchTarget } from '../../services/chat/historySearch.js'

export const HistorySearchNavigation = createContext<{
  target: HistorySearchTarget | null
  finish: (target: HistorySearchTarget) => void
} | null>(null)
