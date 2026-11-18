import { diagnostic, diagnosticError } from '../diagnostics.js'
import { encodePcmWav, PcmResampler } from './pcm.js'

export const SAMPLE_RATE = 16000
export const MAX_SECONDS = 120
const BUFFER_SIZE = 4096

export type Recording = {
  stop: () => Promise<Blob | null>
  cancel: () => void
  analyser: AnalyserNode
}

type Options = { signal?: AbortSignal; onStall?: () => void }
const abortError = () => new DOMException('Recording cancelled', 'AbortError')

/** Start with the device's native rate under the user gesture, then downsample PCM to 16 kHz. */
export const startRecording = async (onLimit: () => void, { signal, onStall }: Options = {}): Promise<Recording> => {
  if (signal?.aborted) { throw abortError() }
  if (typeof AudioContext !== 'function' || !navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('Audio capture unavailable', 'NotSupportedError')
  }
  let context: AudioContext | undefined
  let stream: MediaStream | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let processor: ScriptProcessorNode | undefined
  let analyser: AnalyserNode | undefined
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  let limitTimer: ReturnType<typeof setTimeout> | undefined
  let resumeTimer: ReturnType<typeof setTimeout> | undefined
  let released = false
  let limited = false
  let frames = 0
  let length = 0
  let startedAt = 0
  let phase: 'permission' | 'context' = 'context'
  const chunks: Float32Array[] = []
  let rejectAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  // Every branch consumes this promise; this extra handler also covers abort between await points.
  void aborted.catch(() => {})

  const release = () => {
    if (released) { return }
    released = true
    clearTimeout(stallTimer)
    clearTimeout(limitTimer)
    clearTimeout(resumeTimer)
    signal?.removeEventListener('abort', onAbort)
    if (processor) { processor.onaudioprocess = null }
    for (const node of [processor, analyser, source]) {
      try { node?.disconnect() } catch { /* Continue releasing the microphone. */ }
    }
    for (const track of stream?.getTracks() ?? []) { track.stop() }
    if (context) {
      context.onstatechange = null
      void context.close().catch((error) => diagnosticError('audio.context.error', error))
    }
  }
  const onAbort = () => {
    release()
    chunks.length = 0
    rejectAbort?.(abortError())
  }
  const reachLimit = () => {
    if (limited || released) { return }
    limited = true
    diagnostic('audio.capture.limit', { samples: length, frames })
    onLimit()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    // Creating/resuming after awaiting permission can lose activation; forcing 16 kHz also
    // stalls some WebView/audio backends. Keep the native context rate and convert ourselves.
    context = new AudioContext()
    const resume = context.resume()
    void resume.catch(() => {})
    phase = 'permission'
    diagnostic('audio.permission.request')
    const media = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    // getUserMedia has no AbortSignal. Stop a late stream even if permission resolves after cancellation.
    void media.then((late) => {
      if (released || signal?.aborted) {
        for (const track of late.getTracks()) { track.stop() }
      }
    }, () => {})
    stream = await Promise.race([media, aborted])
    if (released || signal?.aborted) { throw abortError() }
    phase = 'context'
    diagnostic('audio.permission.granted', { granted: true })
    const timeout = new Promise<never>((_resolve, reject) => {
      resumeTimer = setTimeout(() => reject(new DOMException('Audio context did not resume', 'TimeoutError')), 5000)
    })
    await Promise.race([resume, aborted, timeout])
    clearTimeout(resumeTimer)
    if (released || signal?.aborted) { throw abortError() }
    const resampler = new PcmResampler(context.sampleRate, SAMPLE_RATE)
    source = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1)
    analyser = context.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.2
    diagnostic('audio.context.ready', { inputRate: context.sampleRate, outputRate: SAMPLE_RATE, contextState: context.state })
    context.onstatechange = () => {
      diagnostic('audio.context.state', { contextState: context?.state })
    }
    processor.onaudioprocess = (event) => {
      if (limited || released) { return }
      frames++
      const pcm = resampler.process(event.inputBuffer.getChannelData(0))
      const remaining = MAX_SECONDS * SAMPLE_RATE - length
      const chunk = pcm.length > remaining ? pcm.slice(0, remaining) : pcm
      if (chunk.length > 0) {
        chunks.push(chunk)
        length += chunk.length
      }
      if (length >= MAX_SECONDS * SAMPLE_RATE) { reachLimit() }
    }
    source.connect(analyser)
    analyser.connect(processor)
    // The output is silent, but a destination connection is necessary to keep callbacks running.
    processor.connect(context.destination)
    startedAt = performance.now()
    diagnostic('audio.capture.start', { inputRate: context.sampleRate, outputRate: SAMPLE_RATE })
    stallTimer = setTimeout(() => {
      if (!released && length === 0) {
        diagnostic('audio.capture.stall', { frames, samples: length, contextState: context?.state, reason: 'stalled' })
        release()
        onStall?.()
      }
    }, 5000)
    // Bound wall time too: a suspended audio clock must not record indefinitely.
    limitTimer = setTimeout(reachLimit, MAX_SECONDS * 1000)
    return {
      stop: async () => {
        release()
        diagnostic(length === 0 ? 'audio.capture.empty' : 'audio.capture.stop', {
          frames, samples: length, durationMs: Math.round(performance.now() - startedAt),
          inputRate: context?.sampleRate, outputRate: SAMPLE_RATE,
        })
        const audio = length === 0 ? null : encodePcmWav(chunks, length, SAMPLE_RATE)
        chunks.length = 0 // Do not retain Float32 PCM while the WAV is being uploaded.
        return audio
      },
      cancel: () => {
        if (!released) {
          diagnostic('audio.capture.cancel', { frames, samples: length })
          release()
          chunks.length = 0
        }
      },
      analyser,
    }
  } catch (error) {
    if (!signal?.aborted) {
      diagnosticError(phase === 'permission' ? 'audio.permission.error' : 'audio.context.error', error)
    }
    release()
    chunks.length = 0
    throw error
  }
}
