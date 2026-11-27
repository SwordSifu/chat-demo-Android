import clsx from 'clsx'
import { registerBackHandler } from '../../platform/back.js'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from './icons.js'
import { IconButton } from './IconButton.js'
import styles from './Modal.module.css'

/** 当前打开的弹窗，后打开的在末尾；叠放时 Esc 只关闭最上层 */
const openModals: object[] = []

const focusableControls = (dialog: HTMLElement) =>
  Array.from(dialog.querySelectorAll<HTMLElement>(
    'button, a[href], input, select, textarea, [contenteditable="true"], [tabindex]'
  )).filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') &&
    element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible')

/** 遮罩 + 居中卡片（sheet 在手机上贴底），Esc / 点遮罩关闭 */
export const Modal = ({
  title,
  children,
  footer,
  closable = false,
  className,
  mainClassName,
  presentation = 'dialog',
  returnFocusTo,
  testIdPrefix,
  onClose,
}: {
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 标题栏右侧显示关闭按钮 */
  closable?: boolean
  className?: string
  /** 内容区的 class */
  mainClassName?: string
  presentation?: 'dialog' | 'sheet'
  /** 启用弹窗焦点管理，关闭时还原到触发元素 */
  returnFocusTo?: HTMLElement
  testIdPrefix?: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const token = {}
    openModals.push(token)
    const unregisterBack = registerBackHandler(() => {
      onCloseRef.current()
      return true
    }, 10)
    const dialog = returnFocusTo ? dialogRef.current : null
    if (dialog) {
      (focusableControls(dialog)[0] ?? dialog).focus({ preventScroll: true })
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (openModals.at(-1) !== token) {
        return
      }
      if (event.key === 'Escape' && !event.isComposing) {
        if (dialog) {
          event.preventDefault()
        }
        onCloseRef.current()
      } else if (dialog && event.key === 'Tab') {
        const controls = focusableControls(dialog)
        const first = controls[0]
        const last = controls.at(-1)
        const active = document.activeElement
        if (!first || !last || active === dialog || !dialog.contains(active) ||
          (event.shiftKey ? active === first : active === last)) {
          event.preventDefault()
          const target = (event.shiftKey ? last : first) ?? dialog
          target.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      unregisterBack()
      const isTop = openModals.at(-1) === token
      openModals.splice(openModals.indexOf(token), 1)
      document.removeEventListener('keydown', onKeyDown)
      if (isTop && returnFocusTo?.isConnected) {
        returnFocusTo.focus({ preventScroll: true })
      }
    }
  }, [returnFocusTo])

  return createPortal(
    <div
      className={clsx(styles.overlay, presentation === 'sheet' && styles.sheetOverlay)}
      data-testid={testIdPrefix && `${testIdPrefix}-overlay`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          if (returnFocusTo) {
            event.preventDefault()
          }
          onClose()
        }
      }}
    >
      <div
        ref={dialogRef}
        className={clsx(styles.content, presentation === 'sheet' && styles.sheet, className)}
        data-testid={testIdPrefix && `${testIdPrefix}-dialog`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={returnFocusTo ? -1 : undefined}
      >
        <div className={styles.header}>
          <div id={titleId} className={styles.title}>
            {title}
          </div>
          {closable ? (
            <IconButton
              className={styles.close}
              tone="primary"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={onClose}
            />
          ) : null}
        </div>
        {children ? <div className={clsx(styles.main, mainClassName)}>{children}</div> : null}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}
