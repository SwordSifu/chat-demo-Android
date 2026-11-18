/** Stateful area-average resampling; chunk boundaries never reset the fractional position. */
export class PcmResampler {
  private sum = 0
  private covered = 0
  private readonly ratio: number

  constructor(inputRate: number, outputRate = 16000) {
    if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000 ||
      !Number.isFinite(outputRate) || outputRate < 8000 || outputRate > 48000) {
      throw new RangeError('Unsupported PCM sample rate')
    }
    this.ratio = inputRate / outputRate
  }

  process(input: Float32Array): Float32Array {
    const output = new Float32Array(Math.ceil((input.length + this.covered) / this.ratio) + 1)
    let written = 0
    for (const value of input) {
      const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
      let remaining = 1
      while (remaining > 1e-9) {
        const take = Math.min(remaining, this.ratio - this.covered)
        this.sum += sample * take
        this.covered += take
        remaining -= take
        if (this.covered >= this.ratio - 1e-9) {
          output[written++] = this.sum / this.ratio
          this.sum = 0
          this.covered = 0
        }
      }
    }
    return output.slice(0, written)
  }
}

/** Inputs are already mono 16 kHz. No original microphone-rate buffers are retained. */
export const encodePcmWav = (chunks: Float32Array[], length: number, sampleRate = 16000): Blob => {
  const samples = Math.max(0, Math.min(Math.floor(length), sampleRate * 120))
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i))
    }
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  let written = 0
  for (const chunk of chunks) {
    for (const value of chunk) {
      if (written >= samples) {
        break
      }
      const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
      view.setInt16(44 + written++ * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
