import clsx from 'clsx'
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  IconCloseOutline16,
  IconGlobeLanguageOutline14,
  IconPaperclipOutline16,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
} from '../base/icons.js'
import { setSearch, setThinking, useSettings } from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconButton } from '../base/IconButton.js'
import { Tooltip } from '../base/Tooltip.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { isAndroid, releaseCapturedPhoto, retainCapturedPhoto } from '../../platform/android.js'
import { registerBackHandler } from '../../platform/back.js'
import { ACCEPT, useUploads } from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { Spectrum } from './Spectrum.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  const android = isAndroid()
  const [panelOpen, setPanelOpen] = useState(false)
  const panelId = useId()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t])

  const acceptFiles = (files: File[], capturedPhoto?: string) => {
    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {
      releaseCapturedPhoto(capturedPhoto)
      return
    }
    const error = addDraftFiles(sessionId, files, useSettings.getState().apiKey ?? '', capturedPhoto)
    if (error) {
      releaseCapturedPhoto(capturedPhoto)
      showToast(error)
    }
  }
  const acceptCapture = async (file: File) => {
    try {
      await retainCapturedPhoto(file.name)
    } catch {
      releaseCapturedPhoto(file.name)
      if (wrapperRef.current) {
        showToast({ key: 'attachmentCaptureUnavailable' })
      }
      return
    }
    if (!wrapperRef.current || useChatStore.getState().activeId !== sessionId) {
      releaseCapturedPhoto(file.name)
      return
    }
    acceptFiles([file], file.name)
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        retryDraftAttachment(sessionId, id, useSettings.getState().apiKey ?? '')
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 转写结果插入到光标处，并把光标移到插入内容之后 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'
  const showPanel = android && panelOpen && !importingHistory && voice.status === 'idle'
  useEffect(() => {
    if (importingHistory || voice.status !== 'idle') {
      setPanelOpen(false)
    }
  }, [importingHistory, voice.status])
  useEffect(() => {
    if (!showPanel) {
      return
    }
    const close = () => setPanelOpen(false)
    const unregister = registerBackHandler(() => {
      close()
      return true
    })
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) {
        close()
      }
    }
    document.addEventListener('pointerdown', outside, true)
    return () => {
      unregister()
      document.removeEventListener('pointerdown', outside, true)
    }
  }, [showPanel])
  const openPicker = (input: HTMLInputElement | null) => {
    setPanelOpen(false)
    if (ensureApiKey()) {
      input?.click()
    }
  }

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady

  const send = () => {
    if (
      useChatStore.getState().importingHistory ||
      voice.status !== 'idle' ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
    ) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!ensureApiKey() || !sendMessage(sessionId)) {
      return
    }
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  return (
    <div
      ref={wrapperRef}
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      onKeyDown={(event) => {
        if (showPanel && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setPanelOpen(false)
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      {!showPanel ? <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} /> : null}
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
          placeholder={t('chatInputPlaceholderChat')}
          rows={2}
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
            }
          }}
        />
        {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
        <div className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      <div className={styles.functionRow}>
        {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
        <div ref={togglesRef} className={styles.toggles}>
          <Tooltip content={t('deactivatedThinkTooltip')}>
            <button
              type="button"
              className={clsx(styles.toggle, thinking && styles.selected)}
              aria-label={t('thinkingSwitch')}
              aria-pressed={thinking}
              onClick={() => setThinking(!thinking)}
            >
              <IconThinkOutline14 />
              <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
            </button>
          </Tooltip>
          <Tooltip content={t('deactivatedSearchTooltip')}>
            <button
              type="button"
              className={clsx(styles.toggle, search && styles.selected)}
              aria-label={t('search')}
              aria-pressed={search}
              onClick={() => setSearch(!search)}
            >
              <IconGlobeLanguageOutline14 />
              <span className={styles.toggleLabel}>{t('search')}</span>
            </button>
          </Tooltip>
        </div>
        <div className={styles.right}>
          <VoiceButton
            status={voice.status}
            disabled={!voice.available}
            seconds={voice.seconds}
            onClick={() => {
              if (
                voice.status !== 'idle' ||
                (!useChatStore.getState().importingHistory && ensureApiKey())
              ) {
                void voice.toggle()
              }
            }}
          />
          <IconButton
            size="m"
            tone="primary"
            icon={android ? showPanel ? <IconCloseOutline16 /> : <AttachmentIcon kind="plus" /> : <IconPaperclipOutline16 />}
            tooltip={t(android ? (showPanel ? 'attachmentClose' : 'attachmentOpen') : 'uploadFile')}
            disabled={importingHistory || (android && voice.status !== 'idle')}
            aria-expanded={android ? showPanel : undefined}
            aria-controls={showPanel ? panelId : undefined}
            onClick={() => {
              if (android) {
                if (!showPanel) {
                  textareaRef.current?.blur()
                }
                setPanelOpen(!showPanel)
              } else {
                openPicker(fileInputRef.current)
              }
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          {streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                stopReadAloud()
                stopReply(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              aria-disabled={!canSend}
              onClick={send}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
      {android ? (
        <>
          <input ref={galleryInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => {
            acceptFiles(Array.from(event.currentTarget.files ?? []))
            event.currentTarget.value = ''
          }} />
          <input ref={cameraInputRef} type="file" accept="image/jpeg" capture="environment" hidden onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) {
              void acceptCapture(file)
            }
          }} />
        </>
      ) : null}
      {showPanel ? (
        <div id={panelId} role="group" aria-label={t('attachmentOpen')} className={styles.attachmentPanel}>
          <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
          <div className={styles.attachmentActions}>
            <button type="button" onClick={() => openPicker(cameraInputRef.current)}>
              <AttachmentIcon kind="camera" />{t('attachmentCamera')}
            </button>
            <button type="button" onClick={() => openPicker(galleryInputRef.current)}>
              <AttachmentIcon kind="gallery" />{t('attachmentGallery')}
            </button>
            <button type="button" onClick={() => openPicker(fileInputRef.current)}>
              <IconPaperclipOutline16 />{t('attachmentFiles')}
            </button>
          </div>
        </div>
      ) : null}
      {dragging ? <DragMask /> : null}
    </div>
  )
}

const AttachmentIcon = ({ kind }: { kind: 'plus' | 'camera' | 'gallery' }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'plus' ? <path d="M12 5v14M5 12h14" /> : kind === 'camera' ? (
      <><path d="M4 7h4l1.5-2h5L16 7h4a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" /><circle cx="12" cy="13" r="3" /></>
    ) : (
      <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="15.5" cy="8.5" r="1.5" /><path d="m3 16 5-4 7 7 3-3 3 3" /></>
    )}
  </svg>
)
