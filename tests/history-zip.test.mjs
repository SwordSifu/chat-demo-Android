import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import { zipSync, strToU8, strFromU8, unzipSync } from 'fflate'
import { historyFixture } from './browser/history-fixture.mjs'

// Exercise the real format/CRC/path readers. Substitute only the persistence and UI boundaries.
const root = new URL('../src/', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return next(specifier.replace(/\.js$/, '.ts'), context)
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === `${root}services/chat/db.ts`) return { format: 'module', shortCircuit: true, source: `
      export const addStagingSessions = (...args) => globalThis.archiveStaging.sessions(...args)
      export const saveStagingFiles = (...args) => globalThis.archiveStaging.files(...args)
      export const updateStagingFileTypes = (...args) => globalThis.archiveStaging.types(...args)
    ` }
    if (url === `${root}i18n/index.ts`) return { format: 'module', shortCircuit: true, source: 'export const translate = key => key' }
    if (url.startsWith(root) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }),
    }
    return next(url, context)
  },
})
const { ArchiveError, openArchive, readEntry } = await import('../src/services/chat/history/zipReader.ts')
const { checkArchiveFormat, importArchive } = await import('../src/services/chat/history/importArchive.ts')
const { writeArchive } = await import('../src/services/chat/history/zipWriter.ts')
hook.deregister()

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

const session = (n) => `chat_sessions/bench-${n}.json`
const original = (n, suffix = 'pic') => `chat_sessions/bench-${n}_files/${suffix}`
const json = (value) => strToU8(JSON.stringify(value))
const base = (count) => unzipSync(historyFixture({ count }))
const attach = (entries, n, id, path) => {
  const data = JSON.parse(strFromU8(entries[session(n)]))
  data.messages[0].fragments.push({ type: 'FILE', files: [{
    id, file_name: 'photo', file_size: 3, token_usage: null, inserted_at: data.inserted_at,
    export_path: path, is_image: true, width: null, height: null,
  }] })
  entries[session(n)] = json(data)
}
const fixture = (entries, level = 0) => new File([zipSync(entries, { level })], 'synthetic.zip')
const staging = () => {
  const result = { batches: [], fileBatches: [], stored: new Map(), targeted: [] }
  globalThis.archiveStaging = {
    sessions: (sessions) => { result.batches.push(sessions) },
    files(files) {
      result.fileBatches.push(files.length)
      for (const file of files) result.stored.set(file.id, file.blob)
    },
    types(types, ids) { result.targeted.push([new Map(types), new Set(ids)]) },
  }
  return result
}

test('large archive batches sessions and images, reports real counts, and targets only referenced MIME', async () => {
  const entries = base(70)
  for (let i = 0; i < 17; i++) {
    attach(entries, i, `id-${i}`, original(i))
    entries[original(i)] = Uint8Array.of(0xff, 0xd8, 0xff)
  }
  // A single original larger than the 4 MiB budget is written by itself.
  attach(entries, 17, 'large', original(17))
  entries[original(17)] = new Uint8Array(5 * 1024 * 1024)
  entries[original(17)].set(strToU8('GIF89a'))
  // No original: metadata must survive, but no MIME backfill is needed.
  attach(entries, 18, 'absent', null)
  const result = staging()
  const progress = []
  const zip = fixture(entries)
  await importArchive(await checkArchiveFormat(zip), undefined, (...counts) => progress.push(counts))
  assert.deepEqual(result.batches.map((batch) => batch.length), [32, 32, 6])
  assert.deepEqual(result.fileBatches, [16, 1, 1])
  assert.equal(result.stored.get('large').size, 5 * 1024 * 1024)
  assert.equal(result.stored.get('large').type, 'image/gif')
  assert.deepEqual(result.targeted[0][1], new Set(Array.from({ length: 18 }, (_, i) => `bench-${i}`)))
  assert.equal(result.batches.flat()[18].messages[0].files[0].isImage, true)
  assert.deepEqual(progress[0], [1, 90, 0, 70])
  assert.deepEqual(progress.at(-1), [90, 90, 70, 70])
  assert.ok(progress.every(([read, , staged], i) => !i || (read >= progress[i-1][0] && staged >= progress[i-1][2])))
})

test('duplicate image IDs use the earliest physical payload even when grouped reads reverse the order', async () => {
  const entries = base(4)
  attach(entries, 0, 'shared', original(0))
  attach(entries, 1, 'shared', original(1))
  attach(entries, 2, 'shared', null)
  entries[original(1)] = strToU8('GIF89a physical winner')
  entries[original(0)] = Uint8Array.of(0xff, 0xd8, 0xff)
  // The first central-directory record need not describe the first physical file.
  const zip = zipSync(entries, { level: 1 })
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const start = view.getUint32(zip.length - 22 + 16, true)
  const records = []
  for (let pos = start; pos < zip.length - 22;) {
    const length = 46 + [28, 30, 32].reduce((sum, field) => sum + view.getUint16(pos + field, true), 0)
    records.push(zip.slice(pos, pos + length))
    pos += length
  }
  let cursor = start
  for (const record of records.reverse()) { zip.set(record, cursor); cursor += record.length }
  const result = staging()
  await importArchive(await checkArchiveFormat(new File([zip], 'reordered.zip')))
  assert.equal(result.stored.size, 1)
  assert.equal(await result.stored.get('shared').text(), 'GIF89a physical winner')
  assert.deepEqual(result.targeted, [[new Map([['shared', 'image/gif']]), new Set(['bench-0', 'bench-1', 'bench-2'])]])
})

test('pre-index image must follow its owning session; foreign export_path is rejected', async () => {
  const entries = base(2)
  const idx = entries['chat_session_index.json']
  delete entries['chat_session_index.json']
  entries[original(0)] = Uint8Array.of(1)
  entries['chat_session_index.json'] = idx
  staging()
  await assert.rejects(importArchive(await checkArchiveFormat(fixture(entries))), { key: 'backupIncomplete' })
  const foreign = base(2)
  attach(foreign, 0, 'borrowed', original(1))
  foreign[original(1)] = Uint8Array.of(0xff, 0xd8, 0xff)
  await assert.rejects(importArchive(await checkArchiveFormat(fixture(foreign))), { key: 'backupInvalidFiles' })
  const valid = base(2)
  attach(valid, 0, 'own', original(0))
  const interleaved = { 'manifest.json': valid['manifest.json'], [session(0)]: valid[session(0)], [original(0)]: Uint8Array.of(0x42, 0x4d), ...valid }
  const result = staging()
  await importArchive(await checkArchiveFormat(fixture(interleaved)))
  assert.equal(result.stored.get('own').type, 'image/bmp')
})

test('even an unreferenced attachment with corrupt CRC rejects the import', async () => {
  const entries = base(1)
  entries[original(0)] = strToU8('unique ignored payload')
  const zip = Buffer.from(zipSync(entries, { level: 0 }))
  const pos = zip.indexOf('unique ignored payload')
  assert.ok(pos > 0)
  zip[pos] ^= 1
  staging()
  await assert.rejects(importArchive(await checkArchiveFormat(new File([zip], 'ignored.zip'))), { key: 'backupIncomplete' })
})

test('legacy signal cancels a large payload inside its next 512 KiB window', async () => {
  const entries = base(1)
  attach(entries, 0, 'large', original(0))
  entries[original(0)] = new Uint8Array(3 * 1024 * 1024)
  const signal = { aborted: false }
  let reads = 0
  class CancelFile extends File {
    slice(start, end) {
      if (start === 512 * 1024) { signal.aborted = true; reads++ }
      return super.slice(start, end)
    }
  }
  const file = new CancelFile([zipSync(entries, { level: 0 })], 'cancel.zip')
  const result = staging()
  await assert.rejects(importArchive(await checkArchiveFormat(file, signal), signal), { name: 'AbortError' })
  assert.equal(reads, 1)
  assert.deepEqual(result.fileBatches, [])
})

test('many small entries share bounded payload windows instead of a File.slice per header', async () => {
  const files = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`items/${i}`, new Uint8Array(256)]))
  const zip = zipSync(files, { level: 0 })
  const directory = new DataView(zip.buffer, zip.byteOffset + zip.length - 22, 22).getUint32(16, true)
  const reads = []
  class CountedFile extends File {
    slice(start, end) { reads.push([start, end]); return super.slice(start, end) }
  }
  const { entries } = await openArchive(new CountedFile([zip], 'small-entries.zip'))
  const preflightReads = reads.length
  for await (const entry of entries) for await (const chunk of entry.stream) assert.equal(chunk.byteLength, 256)
  assert.equal(reads.length - preflightReads, Math.ceil(directory / (512 * 1024)))
  assert.ok(reads.every(([start, end]) => end - start <= 512 * 1024))
})

test('streamed ZIP validates data descriptors even for a skipped original', async () => {
  const entries = base(1)
  entries[original(0)] = strToU8('ignored original')
  const blob = await writeArchive(Object.entries(entries).map(([name, bytes]) => ({ name, blob: new Blob([bytes]) })))
  staging()
  await importArchive(await checkArchiveFormat(new File([blob], 'valid-stream.zip')))
  const zip = Buffer.from(await blob.arrayBuffer())
  const descriptor = zip.indexOf('ignored original') + 'ignored original'.length
  assert.equal(zip.readUInt32LE(descriptor), 0x08074b50)
  zip[descriptor + 4] ^= 1
  await assert.rejects(importArchive(await checkArchiveFormat(new File([zip], 'bad-stream.zip'))), { key: 'backupIncomplete' })
})
