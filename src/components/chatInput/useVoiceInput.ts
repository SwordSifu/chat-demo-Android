import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslationMessage } from '../../i18n/index.js'
import { transcribe } from '../../services/api/speech.js'
import { ApiError } from '../../services/api/client.js'
import { diagnostic, diagnosticError } from '../../services/diagnostics.js'
import { isAndroid } from '../../platform/android.js'
import { startRecording, type Recording } from '../../services/speech/recorder.js'
import { useSettings } from '../../services/settings.js'
import { showToast } from '../base/toastState.js'

export type VoiceInputStatus = 'idle' | 'preparing' | 'recording' | 'transcribing'

/**
 * 录音依赖 getUserMedia，只在安全上下文可用（HTTPS、localhost、file://）。
 * 普通 HTTP 页面上直接禁用入口，避免点击后必然失败。
 */
const AVAILABLE = typeof window === 'undefined' || window.isSecureContext

const describeRecordingError = (error: unknown): TranslationMessage => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { key: 'voiceInputPermissionDenied' }
    }
    if (error.name === 'NotFoundError') {
      return { key: 'voiceInputNoDevice' }
    }
    if (error.name === 'NotReadableError') {
      return { key: 'voiceInputDeviceBusy' }
    }
    if (error.name === 'NotSupportedError') {
      return { key: 'voiceInputUnsupported' }
    }
  }
  return { key: 'voiceInputCaptureFailed' }
}

const describeTranscriptionError = (error: unknown): TranslationMessage => {
  if (error instanceof ApiError) {
    if (error.status === 401) { return { key: 'apiKeyInvalidRetry' } }
    if (error.status === 402) { return { key: 'insufficientBalance' } }
    if (error.status === 429) { return { key: 'rateLimited' } }
    if (error.kind === 'network') { return { key: 'commonNetworkErrorToast' } }
    if (error.status) { return { key: 'voiceInputAsrHttpFailed', params: { status: error.status } } }
  }
  return { key: 'voiceInputFailed' }
}

/**
 * 语音输入（oneshot）：点击开始录音，再次点击结束并转写，结果交给 onText 填入输入框。
 * 转写中再次点击取消。录满 120 秒自动结束。
 */
export const useVoiceInput = (onText: (text: string) => void) => {
  const [status, setStatus] = useState<VoiceInputStatus>('idle')
  /** 本次录音已录秒数，只在录音中递增 */
  const [seconds, setSeconds] = useState(0)
  const recordingRef = useRef<Recording | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const operationRef = useRef(0)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const cancelOperation = useCallback(() => {
    operationRef.current++
    recordingRef.current?.cancel()
    recordingRef.current = null
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  const cancel = useCallback((reason: 'user' | 'background' = 'user') => {
    if (recordingRef.current || controllerRef.current) { diagnostic('voice.cancel', { reason }) }
    cancelOperation()
    setStatus('idle')
  }, [cancelOperation])

  const finish = useCallback(async () => {
    const recording = recordingRef.current
    if (!recording) {
      // 仍在等待麦克风授权时也允许取消；迟到的录音对象会立即释放。
      cancel()
      return
    }
    const operation = operationRef.current
    recordingRef.current = null
    let controller: AbortController | null = null
    try {
      let audio: Blob | null
      try {
        audio = await recording.stop()
      } finally {
        recording.cancel()
      }
      if (operationRef.current !== operation) {
        return
      }
      if (!audio) {
        showToast({ key: 'voiceInputNoAudio' })
        return
      }
      diagnostic('voice.stop', { bytes: audio.size })
      controller = new AbortController()
      controllerRef.current = controller
      setStatus('transcribing')
      const text = await transcribe(useSettings.getState().apiKey ?? '', audio, controller.signal)
      if (controller.signal.aborted || operationRef.current !== operation) {
        return
      }
      if (text.trim()) {
        onTextRef.current(text.trim())
      } else {
        showToast({ key: 'voiceInputEmpty' })
      }
    } catch (error) {
      if (!controller?.signal.aborted) { diagnosticError('voice.error', error) }
      if (operationRef.current === operation && !controller?.signal.aborted) {
        showToast(describeTranscriptionError(error))
      }
    } finally {
      if (operationRef.current === operation) {
        controllerRef.current = null
        setStatus('idle')
      }
    }
  }, [cancel])

  const toggle = useCallback(async () => {
    if (!AVAILABLE) {
      return
    }
    if (status === 'recording') {
      await finish()
      return
    }
    if (status === 'transcribing' || status === 'preparing') {
      cancel()
      return
    }
    const operation = ++operationRef.current
    const controller = new AbortController()
    controllerRef.current = controller
    setStatus('preparing')
    diagnostic('voice.start')
    try {
      const recording = await startRecording(() => {
        if (operationRef.current === operation) {
          showToast({ key: 'voiceInputLimitReached' })
          void finish()
        }
      }, {
        signal: controller.signal,
        onStall: () => {
          if (operationRef.current === operation) {
            showToast({ key: 'voiceInputCaptureFailed' })
            cancel()
          }
        },
      })
      if (operationRef.current !== operation) {
        recording.cancel()
        return
      }
      recordingRef.current = recording
      setStatus('recording')
    } catch (error) {
      if (!controller.signal.aborted) { diagnosticError('voice.error', error) }
      if (operationRef.current === operation && !controller.signal.aborted) {
        controllerRef.current = null
        setStatus('idle')
        showToast(describeRecordingError(error))
      }
    }
  }, [status, finish, cancel])

  useEffect(() => {
    if (status !== 'recording') {
      return
    }
    const startedAt = Date.now()
    setSeconds(0)
    // 半秒刷新一次，让显示的秒数与实际录音时长保持一致
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => cancelOperation, [cancelOperation])
  useEffect(() => {
    const onBackground = () => {
      cancel('background')
    }
    const onVisibility = () => {
      // Android permission dialogs can hide/pause WebView without leaving the Activity.
      // Native onStop is authoritative there; ordinary browser tabs still stop on hidden.
      if (document.hidden && !isAndroid()) {
        onBackground()
      }
    }
    window.addEventListener('android-background', onBackground)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('android-background', onBackground)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [cancel])

  /** 当前录音的频谱分析节点，未录音时为 null */
  const getAnalyser = useCallback(() => recordingRef.current?.analyser ?? null, [])

  return { status, seconds, getAnalyser, toggle, cancel, available: AVAILABLE }
}
