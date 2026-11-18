import test from 'node:test'
import assert from 'node:assert/strict'
import { PcmResampler, encodePcmWav } from '../src/services/speech/pcm.ts'

test('48 kHz native PCM is downsampled to 16 kHz without retaining native-rate buffers', () => {
  const output = new PcmResampler(48000).process(new Float32Array(48000).fill(0.25))
  assert.equal(output.length, 16000)
  assert.ok(output.every((sample) => sample === 0.25))
})

test('44.1 kHz fractional resampling is identical across arbitrary chunk boundaries', () => {
  const input = Float32Array.from({ length: 44100 }, (_, index) => Math.sin(index / 15) * 0.5)
  const expected = new PcmResampler(44100).process(input)
  const resampler = new PcmResampler(44100)
  const pieces = []
  for (let offset = 0; offset < input.length; offset += 4096) pieces.push(resampler.process(input.subarray(offset, offset + 4096)))
  const actual = Float32Array.from(pieces.flatMap((piece) => [...piece]))
  assert.equal(expected.length, 16000)
  assert.deepEqual(actual, expected)
})

test('resampling remains exact at 16 kHz and handles 8/96/192 kHz devices', () => {
  for (const rate of [8000, 16000, 96000, 192000]) {
    const samples = new PcmResampler(rate).process(new Float32Array(rate).fill(0.1))
    assert.equal(samples.length, 16000)
    assert.ok(samples.every((sample) => Math.abs(sample - 0.1) < 1e-6))
  }
})

test('invalid resampling rates are rejected and non-finite PCM is silenced', () => {
  for (const rate of [0, NaN, Infinity, 7999, 192001]) assert.throws(() => new PcmResampler(rate), RangeError)
  const samples = new PcmResampler(16000).process(new Float32Array([NaN, Infinity, -Infinity, -3, 3]))
  assert.deepEqual([...samples], [0, 0, 0, -1, 1])
})

test('WAV output is mono 16-bit 16 kHz with correct header, length and clipping', async () => {
  const blob = encodePcmWav([new Float32Array([-1, 0, 1])], 3)
  const bytes = Buffer.from(await blob.arrayBuffer())
  assert.equal(bytes.length, 50)
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE')
  assert.equal(bytes.readUInt16LE(20), 1)
  assert.equal(bytes.readUInt16LE(22), 1)
  assert.equal(bytes.readUInt32LE(24), 16000)
  assert.equal(bytes.readUInt32LE(28), 32000)
  assert.equal(bytes.readUInt16LE(34), 16)
  assert.equal(bytes.readUInt32LE(40), 6)
  assert.equal(bytes.readInt16LE(44), -32768)
  assert.equal(bytes.readInt16LE(46), 0)
  assert.equal(bytes.readInt16LE(48), 32767)
})

test('WAV encoding caps output at 120 seconds', () => {
  const blob = encodePcmWav([], 16000 * 1000)
  assert.equal(blob.size, 44 + 16000 * 120 * 2)
})
