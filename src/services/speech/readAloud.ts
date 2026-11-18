import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'
import { synthesize, TTS_SAMPLE_RATE } from '../api/speech.js'
import { useSettings } from '../settings.js'

/**
 * 朗读：同一时间只读一条回复。
 * 请求 TTS 的裸 PCM 流，边收边用 AudioContext 按顺序排程播放，首帧到达即出声。
 * 状态：loading（已请求、未出声）→ playing → 结束回到 idle。
 */
export type ReadAloudStatus = 'idle' | 'loading' | 'playing'

type ReadAloudState = {
  /** 正在朗读的回复 id */
  messageId: string | null
  status: ReadAloudStatus
}

export const useReadAloud = create<ReadAloudState>(() => ({ messageId: null, status: 'idle' }))

/** 首帧前多缓冲一点，减少网络抖动造成的断续 */
const START_DELAY = 0.1

let current: { controller: AbortController; context: AudioContext } | null = null

const finish = (controller: AbortController) => {
  if (current?.controller !== controller) {
    return
  }
  void current.context.close().catch(() => {})
  current = null
  useReadAloud.setState({ messageId: null, status: 'idle' })
}

/** 停止当前朗读（发送、停止生成、切换会话等场景调用） */
export const stopReadAloud = () => {
  if (current) {
    const { controller } = current
    controller.abort()
    finish(controller)
  }
}

/** 16-bit 小端 PCM 转成 Float32；奇数字节留到下一段 */
const toFloat32 = (bytes: Uint8Array) => {
  const samples = new Float32Array(bytes.length >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return samples
}

export const describeReadAloudError = (error: unknown): TranslationMessage | string => {
  if (error instanceof ApiError && error.kind === 'protocol') {
    return error.message
  }
  // 400 表示这段正文服务端无法合成，与其余失败区分开
  if (error instanceof ApiError && error.status === 400) {
    return { key: 'ttsUnavailable' }
  }
  switch (classifyApiError(error)) {
    case 'unauthorized':
      return { key: 'apiKeyInvalidRetry' }
    case 'insufficientBalance':
      return { key: 'insufficientBalance' }
    case 'rateLimited':
      return { key: 'rateLimited' }
    default:
      return { key: 'ttsFailed' }
  }
}

/**
 * 开始朗读一条回复的正文；同一条正在朗读时调用等于停止。
 * 必须在点击事件中同步调用：AudioContext 需要用户手势才能出声。
 */
export const toggleReadAloud = (
  messageId: string,
  text: string,
  onError: (error: unknown) => void
) => {
  const reading = useReadAloud.getState().messageId
  stopReadAloud()
  if (reading === messageId) {
    return
  }
  const controller = new AbortController()
  let context: AudioContext
  let resumed: Promise<void>
  try {
    context = new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
    resumed = context.resume()
  } catch (error) {
    onError(error)
    return
  }
  current = { controller, context }
  useReadAloud.setState({ messageId, status: 'loading' })
  // 音色在开始朗读时读取，设置中切换后下一次朗读生效
  const { apiKey, ttsVoice } = useSettings.getState()

  void (async () => {
    let nextTime = 0
    let scheduled = false
    let eof = false
    let rest = new Uint8Array(0)
    const sources = new Set<AudioBufferSourceNode>()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const cancelReader = () => { void reader?.cancel().catch(() => {}) }
    try {
      await resumed
      if (controller.signal.aborted) {
        return
      }
      const stream = await synthesize(apiKey ?? '', text, ttsVoice, controller.signal)
      reader = stream.getReader()
      controller.signal.addEventListener('abort', cancelReader, { once: true })
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        const bytes = new Uint8Array(rest.length + value.length)
        bytes.set(rest)
        bytes.set(value, rest.length)
        const samples = toFloat32(bytes)
        rest = bytes.slice(samples.length * 2)
        if (samples.length === 0) {
          continue
        }
        // Split large network frames and cap scheduled audio to about 3.5 seconds.
        // Backpressure prevents fast downloads from retaining an entire long reply as AudioBuffers.
        for (let offset = 0; offset < samples.length; offset += TTS_SAMPLE_RATE) {
          while (nextTime - context.currentTime > 2.5) {
            if (controller.signal.aborted) {
              return
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 50))
          }
          if (controller.signal.aborted) {
            return
          }
          const frame = samples.subarray(offset, offset + TTS_SAMPLE_RATE)
          const buffer = context.createBuffer(1, frame.length, TTS_SAMPLE_RATE)
          buffer.copyToChannel(frame, 0)
          const source = context.createBufferSource()
          source.buffer = buffer
          source.connect(context.destination)
          sources.add(source)
          // Install before playback; EOF can arrive after the last source has already ended.
          source.onended = () => {
            sources.delete(source)
            source.disconnect()
            if (eof && sources.size === 0) {
              finish(controller)
            }
          }
          nextTime = Math.max(nextTime, context.currentTime + (scheduled ? 0 : START_DELAY))
          source.start(nextTime)
          nextTime += buffer.duration
          scheduled = true
          if (useReadAloud.getState().status === 'loading') {
            useReadAloud.setState({ status: 'playing' })
          }
        }
      }
      eof = true
      if (sources.size === 0) {
        finish(controller)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        finish(controller)
        onError(error)
      }
    } finally {
      controller.signal.removeEventListener('abort', cancelReader)
      if (!eof) {
        await reader?.cancel().catch(() => {})
      }
      reader?.releaseLock()
    }
  })()
}
