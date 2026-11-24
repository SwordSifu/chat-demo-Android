import { throwIfAborted } from '../../../utils/abort.js'
import * as db from '../db.js'
import type { Session } from '../types.js'
import { BackupError, fail } from './errors.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import { ArchiveError, isZipFile, openArchive, readEntry, skipEntry, type ArchiveEntry } from './zipReader.js'

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of entry.stream) {
    text += decoder.decode(chunk, { stream: true })
  }
  text += decoder.decode()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/** 预检与正式读取绑定同一 File、目录和读取窗口；失败时不打断正在生成的回答。 */
export const checkArchiveFormat = async (file: File, signal?: AbortSignal) => {
  throwIfAborted(signal)
  const isZip = await isZipFile(file)
  throwIfAborted(signal)
  if (!isZip) {
    fail('backupUnrecognized')
  }
  try {
    const archive = await openArchive(file, signal)
    const manifest = await archive.entries.next()
    if (manifest.done || manifest.value.path !== MANIFEST_PATH) {
      return fail('backupUnrecognized')
    }
    checkManifest(await readJson(manifest.value))
    throwIfAborted(signal)
    return archive
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
}

const MAX_SESSIONS = 32
const MAX_SESSION_BYTES = 2 * 1024 * 1024
const MAX_IMAGES = 16
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

type Progress = (read: number, total: number, stagedSessions: number, totalSessions: number) => void

/** 先按物理顺序验证归属与布局，再以会话为单位读取正文、批量暂存。调用方负责替换和清理。 */
export const importArchive = async (
  archive: Awaited<ReturnType<typeof checkArchiveFormat>>,
  signal?: AbortSignal,
  onProgress?: Progress
): Promise<void> => {
  throwIfAborted(signal)
  const totalSessions = archive.countEntries((path) => parseSessionPath(path) !== null)
  let processed = 1 // manifest 已通过预检
  let staged = 0
  let lastReport = performance.now()
  const report = (force = false) => {
    throwIfAborted(signal)
    const now = performance.now()
    if (force || now - lastReport >= 100) {
      onProgress?.(processed, archive.total, staged, totalSessions)
      lastReport = now
      throwIfAborted(signal)
    }
  }
  report(true)

  let images: db.StoredFile[] = []
  let imageBytes = 0
  const flushImages = async () => {
    if (!images.length) {
      return
    }
    throwIfAborted(signal)
    await db.saveStagingFiles(images)
    images = []
    imageBytes = 0
  }
  let sessions: Session[] = []
  let sessionBytes = 0
  const flushSessions = async () => {
    if (!sessions.length) {
      return
    }
    throwIfAborted(signal)
    await db.addStagingSessions(sessions)
    staged += sessions.length
    sessions = []
    sessionBytes = 0
    report()
  }

  // 同一 ID 在不同目录可以有不同原件。不论按哪个会话先读取，物理位置最早的引用原件获选。
  const firstOffset = new Map<string, number>()
  const types = new Map<string, string>()
  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (entry.offset >= (firstOffset.get(id) ?? Infinity)) {
      return skipEntry(entry)
    }
    if (imageBytes + entry.size > MAX_IMAGE_BYTES) {
      await flushImages()
    }
    const blob = await readEntry(entry, imageType)
    images.push({ id, blob })
    imageBytes += blob.size
    firstOffset.set(id, entry.offset)
    types.set(id, blob.type)
    if (images.length >= MAX_IMAGES || imageBytes >= MAX_IMAGE_BYTES) {
      await flushImages()
    }
  }

  try {
    const groups = new Map<string, { json: ArchiveEntry; files: ArchiveEntry[] }>()
    let indexEntry: ArchiveEntry | undefined
    let current: string | undefined
    for await (const entry of archive.entries) {
      throwIfAborted(signal)
      const id = parseSessionPath(entry.path)
      if (entry.path === USER_PATH && !current && !indexEntry) {
        await skipEntry(entry)
        processed++
        report()
      } else if (id !== null && !indexEntry && !groups.has(id)) {
        groups.set(id, { json: entry, files: [] })
        current = id
      } else if (entry.path === INDEX_PATH && !indexEntry) {
        indexEntry = entry
      } else {
        const owner = /^chat_sessions\/([^/]+)_files\//.exec(entry.path)?.[1]
        const group = owner === undefined ? undefined : groups.get(owner)
        if (!group || (!indexEntry && owner !== current)) {
          return fail('backupIncomplete')
        }
        group.files.push(entry)
      }
    }
    if (!indexEntry) {
      return fail('backupIncomplete')
    }

    const fileSessions = new Map<string, Set<string>>()
    for (const [id, { json, files }] of groups) {
      throwIfAborted(signal)
      if (sessionBytes + json.size > MAX_SESSION_BYTES) {
        await flushSessions()
      }
      const local = toLocalSession(readSessionFile(await readJson(json)))
      if (local.session.id !== id) {
        fail('backupIncomplete')
      }
      processed++
      report()
      for (const file of files) {
        const ref = local.images.get(file.path)
        await (ref === undefined ? skipEntry(file) : saveImage(file, ref))
        processed++
        report()
      }
      for (const message of local.session.messages) {
        if (message.role !== 'user') {
          continue
        }
        for (const attachment of message.files) {
          let references = fileSessions.get(attachment.id)
          if (!references) {
            references = new Set()
            fileSessions.set(attachment.id, references)
          }
          references.add(id)
        }
      }
      sessions.push(local.session)
      sessionBytes += json.size
      if (sessions.length >= MAX_SESSIONS || sessionBytes >= MAX_SESSION_BYTES) {
        await flushSessions()
      }
    }
    await flushImages()
    await flushSessions()
    throwIfAborted(signal)
    const index = readSessionIndex(await readJson(indexEntry))
    const listed = new Set(index.map((entry) => entry.id))
    if (
      listed.size !== index.length ||
      listed.size !== groups.size ||
      [...listed].some((id) => !groups.has(id))
    ) {
      fail('backupIncomplete')
    }

    const targets = new Set<string>()
    for (const [id, type] of types) {
      if (type) {
        for (const sessionId of fileSessions.get(id) ?? []) {
          targets.add(sessionId)
        }
      }
    }
    if (targets.size) {
      await db.updateStagingFileTypes(types, targets, signal)
    }
    processed++ // index；包括所有跳过的原件在内，每个条目都已完成 CRC 校验。
    report(true)
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
}
