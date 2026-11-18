import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync } from 'fflate'
import { ArchiveError, openArchive, readEntry } from '../src/services/chat/history/zipReader.ts'

const encoder = new TextEncoder()

test('ZIP directory spans bounded blocks, and continuing the same iterator does not reread it', async () => {
  const prefix = '目录/'.repeat(1300)
  const source = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [
    `${prefix}file-${i}.json`, encoder.encode(`内容 ${i}`),
  ]))
  const zip = zipSync(source, { level: 0 })
  const end = new DataView(zip.buffer, zip.byteOffset + zip.byteLength - 22, 22)
  const directory = end.getUint32(16, true)
  const reads = []
  class CountedFile extends File {
    slice(start, end) {
      reads.push([start, end])
      return super.slice(start, end)
    }
  }
  const archive = await openArchive(new CountedFile([zip], 'fixture.zip'))
  assert.equal(archive.total, 40)
  const preflightScans = reads.filter(([start]) => start >= directory).length
  assert.ok(preflightScans >= 2 && preflightScans <= 5)
  assert.ok(reads.every(([start, end]) => end - start <= 256 * 1024))
  let index = 0
  for await (const entry of archive.entries) {
    assert.equal(entry.path, `${prefix}file-${index}.json`)
    assert.equal(await (await readEntry(entry)).text(), `内容 ${index++}`)
  }
  assert.equal(index, 40)
  assert.equal(reads.filter(([start]) => start >= directory).length, preflightScans)
})

test('ZIP payload still checks CRC after opening the reusable directory', async () => {
  const zip = zipSync({ 'sample.txt': encoder.encode('synthetic') }, { level: 0 })
  zip[30 + 'sample.txt'.length] ^= 1
  const { entries } = await openArchive(new File([zip], 'fixture.zip'))
  const { value } = await entries.next()
  await assert.rejects(readEntry(value), ArchiveError)
})

test('ZIP cancellation stops the shared reader between entries', async () => {
  const zip = zipSync({ 'first.txt': encoder.encode('1'), 'second.txt': encoder.encode('2') })
  const controller = new AbortController()
  const { entries } = await openArchive(new File([zip], 'fixture.zip'), controller.signal)
  const { value } = await entries.next()
  assert.equal(await (await readEntry(value)).text(), '1')
  controller.abort()
  await assert.rejects(entries.next(), { name: 'AbortError' })
})
