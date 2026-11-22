import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { HistorySearchResult } from '../../services/chat/historySearch.js'
import {
  closeMobileSider,
  hasSiderBlockingOverlay,
  MOBILE_SIDER_ID,
  MOBILE_SIDER_TRIGGER,
  useMobileSider,
} from './mobileSiderState.js'
import { bindMobileSiderSwipe } from './mobileSiderSwipe.js'
import { Sider } from './Sider.js'
import styles from './Sider.module.css'

export const MobileSider = ({ mainRef, onSearchResult }: {
  mainRef: RefObject<HTMLElement>
  onSearchResult: (result: HistorySearchResult, query: string) => void
}) => {
  const t = useTranslate()
  const open = useMobileSider((state) => state.open)
  const [dragging, setDragging] = useState(false)
  const [retained, setRetained] = useState(false)
  const layerRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const maskRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef(false)
  const shown = open || dragging

  useLayoutEffect(() => {
    const drawer = drawerRef.current
    const main = mainRef.current
    if (!drawer || !main) {
      return
    }
    main.inert = open
    if (open) {
      drawer.inert = false
      drawer.removeAttribute('aria-hidden')
      drawer.focus({ preventScroll: true })
    } else {
      const active = document.activeElement
      if (wasOpenRef.current && (drawer.contains(active) || active === document.body)) {
        document.getElementById(MOBILE_SIDER_TRIGGER)?.focus({ preventScroll: true })
      }
      drawer.inert = true
      drawer.setAttribute('aria-hidden', 'true')
    }
    wasOpenRef.current = open
    return () => {
      main.inert = false
    }
  }, [mainRef, open])

  useLayoutEffect(() => {
    if (shown) {
      setRetained(true)
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRetained(false)
      return
    }
    // Fallback if a transition is skipped or cancelled (e.g. a theme change).
    const timer = window.setTimeout(() => setRetained(false), 300)
    return () => window.clearTimeout(timer)
  }, [shown])

  useEffect(() => {
    const layer = layerRef.current
    const drawer = drawerRef.current
    const mask = maskRef.current
    return layer && drawer && mask
      ? bindMobileSiderSwipe(layer, drawer, mask, setDragging)
      : undefined
  }, [])

  return (
    <div ref={layerRef} className={styles.drawerLayer} data-open={open || undefined}>
      <div ref={maskRef} className={styles.drawerMask} aria-hidden="true" onClick={closeMobileSider} />
      <div
        ref={drawerRef}
        id={MOBILE_SIDER_ID}
        className={styles.drawer}
        role="dialog"
        aria-modal={open || undefined}
        aria-label={t('mobileSiderTitle')}
        tabIndex={-1}
        onTransitionEnd={(event) => {
          if (!shown && event.target === event.currentTarget && event.propertyName === 'transform') {
            setRetained(false)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing &&
              event.currentTarget.contains(event.target as Node) && !hasSiderBlockingOverlay()) {
            event.stopPropagation()
            closeMobileSider()
          }
        }}
      >
        {shown || retained ? <Sider mobile onSearchResult={onSearchResult} /> : null}
      </div>
    </div>
  )
}
