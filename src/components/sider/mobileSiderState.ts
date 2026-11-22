import { create } from 'zustand'

export const MOBILE_SIDER_ID = 'mobile-sider'
export const MOBILE_SIDER_TRIGGER = 'mobile-sider-trigger'

export const hasSiderBlockingOverlay = () => Boolean(document.querySelector(
  `[aria-modal="true"]:not(#${MOBILE_SIDER_ID}), [role="menu"]`
))
export const useMobileSider = create(() => ({ open: false }))

const setOpen = (open: boolean) => useMobileSider.setState((state) => state.open === open ? state : { open })

export const openMobileSider = () => setOpen(true)
export const closeMobileSider = () => setOpen(false)
