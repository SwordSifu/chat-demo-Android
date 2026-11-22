import { useSearchPanel } from '../search/searchPanelState.js'
import {
  closeMobileSider,
  hasSiderBlockingOverlay,
  MOBILE_SIDER_TRIGGER,
  openMobileSider,
  useMobileSider,
} from './mobileSiderState.js'

const EDGE_WIDTH = 32
const DIRECTION_SLOP = 8
const DIRECTION_RATIO = 1.35
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
const clamp = (position: number) => Math.max(0, Math.min(1, position))

const horizontalScroller = (target: Element, frame: Element) => {
  for (let node: Element | null = target; node && node !== frame; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) {
      return true
    }
  }
  return false
}

type Swipe = {
  id: number
  open: boolean
  x: number
  y: number
  drag?: {
    width: number
    origin: number
    position: number
    x: number
    time: number
    speed: number
  }
}

/** Listen only on the mobile frame. Vertical scrolling keeps its own native gesture. */
export const bindMobileSiderSwipe = (
  layer: HTMLDivElement,
  drawer: HTMLDivElement,
  mask: HTMLDivElement,
  setDragging: (dragging: boolean) => void
) => {
  const frame = layer.parentElement
  if (!frame) {
    return
  }
  let swipe: Swipe | undefined
  let raf = 0

  const draw = (position: number) => {
    drawer.style.transform = `translate3d(${(position - 1) * 100}%, 0, 0)`
    mask.style.opacity = String(position)
  }
  const finish = (cancelled: boolean) => {
    const current = swipe
    swipe = undefined
    const drag = current?.drag
    if (!current || !drag) {
      return
    }
    cancelAnimationFrame(raf)
    raf = 0
    draw(drag.position)
    // Commit the last dragged transform before handing it back to the CSS transition.
    getComputedStyle(drawer).transform
    delete layer.dataset.dragging
    drawer.style.removeProperty('transform')
    mask.style.removeProperty('opacity')
    setDragging(false)
    if (!cancelled) {
      const direction = current.open ? -1 : 1
      const travel = (drag.x - current.x) * direction
      const flick = travel >= 26 && drag.speed * direction >= 0.45 && performance.now() - drag.time < 85
      const farEnough = current.open ? drag.position <= 0.65 : drag.position >= 0.35
      if (flick || farEnough) {
        if (current.open) {
          closeMobileSider()
        } else {
          openMobileSider()
        }
      }
    }
  }
  const cancel = () => finish(true)

  const start = (event: TouchEvent) => {
    const touch = event.touches.item(0)
    if (event.touches.length !== 1 || !touch) {
      cancel()
      return
    }
    const target = event.target
    const { open } = useMobileSider.getState()
    const onTrigger = target instanceof Element && target.closest(`#${MOBILE_SIDER_TRIGGER}`)
    if (
      !(target instanceof Element) ||
      target.closest(EDITABLE) ||
      (window.visualViewport?.scale ?? 1) !== 1 ||
      useSearchPanel.getState().entry ||
      hasSiderBlockingOverlay() ||
      window.getSelection()?.isCollapsed === false ||
      (open
        ? !layer.contains(target)
        : !onTrigger &&
          (touch.clientX > EDGE_WIDTH || target.closest('button, a, [role="button"]'))) ||
      horizontalScroller(target, frame)
    ) {
      return
    }
    swipe = { id: touch.identifier, open, x: touch.clientX, y: touch.clientY }
  }

  const move = (event: TouchEvent) => {
    if (!swipe) {
      return
    }
    const touch = event.touches[0]
    if (event.touches.length !== 1 || !touch || touch.identifier !== swipe.id || !event.cancelable) {
      cancel()
      return
    }
    const dx = touch.clientX - swipe.x
    const dy = touch.clientY - swipe.y
    if (!swipe.drag) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DIRECTION_SLOP) {
        return
      }
      if (Math.abs(dx) < Math.abs(dy) * DIRECTION_RATIO) {
        if (Math.abs(dy) >= DIRECTION_SLOP) {
          cancel()
        }
        return
      }
      if (dx * (swipe.open ? -1 : 1) < DIRECTION_SLOP) {
        cancel()
        return
      }
      const bounds = drawer.getBoundingClientRect()
      if (!bounds.width) {
        cancel()
        return
      }
      const origin = clamp(1 + (bounds.left - layer.getBoundingClientRect().left) / bounds.width)
      swipe.drag = { origin, width: bounds.width, position: origin, x: swipe.x, time: performance.now(), speed: 0 }
      layer.dataset.dragging = ''
      setDragging(true)
    }
    event.preventDefault()
    const drag = swipe.drag
    const now = performance.now()
    drag.speed = (touch.clientX - drag.x) / Math.max(12, now - drag.time)
    drag.time = now
    drag.x = touch.clientX
    drag.position = clamp(drag.origin + dx / drag.width)
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0
        draw(drag.position)
      })
    }
  }

  const end = (event: TouchEvent) => {
    if (swipe && Array.from(event.changedTouches).some((touch) => touch.identifier === swipe?.id)) {
      if (swipe.drag && event.cancelable) {
        event.preventDefault()
      }
      finish(false)
    }
  }
  const onVisibility = () => {
    if (document.hidden) {
      cancel()
    }
  }
  // Abort an in-flight gesture on button/back actions or an Android lifecycle change.
  const unsubscribe = useMobileSider.subscribe(cancel)
  frame.addEventListener('touchstart', start, { passive: true })
  frame.addEventListener('touchmove', move, { passive: false })
  frame.addEventListener('touchend', end, { passive: false })
  frame.addEventListener('touchcancel', cancel, { passive: true })
  window.addEventListener('android-background', cancel)
  window.addEventListener('resize', cancel)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    unsubscribe()
    cancelAnimationFrame(raf)
    frame.removeEventListener('touchstart', start)
    frame.removeEventListener('touchmove', move)
    frame.removeEventListener('touchend', end)
    frame.removeEventListener('touchcancel', cancel)
    window.removeEventListener('android-background', cancel)
    window.removeEventListener('resize', cancel)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
