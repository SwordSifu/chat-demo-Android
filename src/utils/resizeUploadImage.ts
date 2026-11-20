// Files API 图片长边上限，单位为像素。
const MAX_IMAGE_EDGE = 4096

const readUploadImage = async (blob: Blob, signal?: AbortSignal) => {
  signal?.throwIfAborted()
  const image = new Image()
  const url = URL.createObjectURL(blob)
  const stop = () => image.removeAttribute('src')
  signal?.addEventListener('abort', stop, { once: true })
  try {
    image.src = url
    await image.decode()
    signal?.throwIfAborted()
    const { naturalWidth: width, naturalHeight: height } = image
    return width && height ? { image, width, height, longestEdge: Math.max(width, height) } : null
  } catch {
    signal?.throwIfAborted()
    return null
  } finally {
    signal?.removeEventListener('abort', stop)
    URL.revokeObjectURL(url)
  }
}

/** 复用旧 file_id 前，只检查本地原图尺寸，不编码或修改原件。 */
export const isUploadImageOversized = async (blob: Blob, signal?: AbortSignal) => {
  const dimensions = await readUploadImage(blob, signal)
  return dimensions === null ? null : dimensions.longestEdge > MAX_IMAGE_EDGE
}

/** 上限内返回原文件，超限生成缩小的上传副本；null 表示无法确认尺寸。 */
export const resizeUploadImage = async (file: File, signal?: AbortSignal): Promise<File | null> => {
  const dimensions = await readUploadImage(file, signal)
  signal?.throwIfAborted()
  if (!dimensions) {
    return null
  }
  const { image, width, height, longestEdge } = dimensions
  if (longestEdge <= MAX_IMAGE_EDGE) {
    return file
  }

  const scale = MAX_IMAGE_EDGE / longestEdge
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  try {
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Cannot resize image')
    }
    // 动图缩小时以上传时绘制的一帧为准；本地仍保留整个原文件。
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const type = file.type === 'image/jpeg' || file.type === 'image/webp' ? file.type : 'image/png'
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('Cannot encode image'))),
        type,
        1
      )
    })
    signal?.throwIfAborted()
    // 浏览器可能回退到 PNG，以实际编码确定扩展名。
    const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type.slice('image/'.length)
    const name = file.name.replace(/\.[^.]*$/, '') + '.' + extension
    return new File([blob], name, { type: blob.type, lastModified: file.lastModified })
  } finally {
    canvas.width = canvas.height = 0
  }
}
