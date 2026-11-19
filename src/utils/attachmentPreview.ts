const SVG_MIME = 'image/svg+xml'
const PDF_MIME = 'application/pdf'
const DOWNLOAD_MIME = 'application/octet-stream'
const MAX_SVG_THUMBNAIL_BYTES = 256 * 1024

const VIEW_MIME_BY_EXT = new Map([
  ['png', 'image/png'],
  ['apng', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['jpe', 'image/jpeg'],
  ['jfif', 'image/jpeg'],
  ['pjp', 'image/jpeg'],
  ['pjpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['dib', 'image/bmp'],
  ['ico', 'image/x-icon'],
  ['cur', 'image/x-icon'],
  ['avif', 'image/avif'],
  ['avifs', 'image/avif'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['svg', SVG_MIME],
  ['pdf', PDF_MIME],
])

/** 预览与上传分类无关，仅信任文件名末尾的扩展名。 */
export const getAttachmentViewMime = (name: string) => {
  const dot = name.lastIndexOf('.')
  return (dot > 0 && VIEW_MIME_BY_EXT.get(name.slice(dot + 1).toLowerCase())) || DOWNLOAD_MIME
}

export const isAttachmentThumbnail = (mime: string) => mime.startsWith('image/')

export type AttachmentView = { thumbnail: string | null } & (
  | { action: 'tab' | 'download'; url: string }
  | { action: 'preview' | 'save'; file: Blob }
)

const readSvgThumbnail = async (blob: Blob, signal: AbortSignal): Promise<string | null> => {
  const reader = new FileReader()
  const abort = () => reader.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await new Promise<string | null>((resolve) => {
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = reader.onabort = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** 原件可能来自草稿或 IndexedDB；组件通过 signal 释放其关联的资源。 */
export const loadAttachmentView = async (
  loadOriginal: () => Blob | undefined | Promise<Blob | undefined>,
  name: string,
  android: boolean,
  signal: AbortSignal
): Promise<AttachmentView | null> => {
  const objectUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob)
    signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once: true })
    return url
  }

  try {
    if (signal.aborted) {
      return null
    }
    const original = await loadOriginal()
    if (signal.aborted || !original) {
      return null
    }
    const mime = getAttachmentViewMime(name)
    const typed = original.slice(0, original.size, mime)
    const vector = mime === SVG_MIME
    const raster = !vector && isAttachmentThumbnail(mime)
    // SVG 只作为 img 的 data: 缩略图，不以应用同源的 SVG URL 暴露给导航。
    const thumbnail = raster
      ? objectUrl(typed)
      : vector && typed.size <= MAX_SVG_THUMBNAIL_BYTES
        ? await readSvgThumbnail(typed, signal).catch(() => null)
        : null
    if (signal.aborted) {
      return null
    }
    if (android) {
      return { thumbnail, action: raster ? 'preview' : 'save', file: typed }
    }
    if (raster || mime === PDF_MIME) {
      return { thumbnail, action: 'tab', url: thumbnail ?? objectUrl(typed) }
    }
    // 下载与 SVG 缩略图分离；原件字节不变，下载 URL 使用惰性 MIME。
    const download = vector ? original.slice(0, original.size, DOWNLOAD_MIME) : typed
    return { thumbnail, action: 'download', url: objectUrl(download) }
  } catch {
    return null
  }
}
