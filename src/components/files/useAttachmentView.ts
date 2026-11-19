import { useEffect, useMemo, useState } from 'react'
import { isAndroid } from '../../platform/android.js'
import { loadFile } from '../../services/chat/db.js'
import {
  getAttachmentViewMime,
  isAttachmentThumbnail,
  loadAttachmentView,
  type AttachmentView,
} from '../../utils/attachmentPreview.js'

/** 草稿传 File，消息传 IndexedDB 原件 ID。undefined 为加载中，null 为原件不可用。 */
export const useAttachmentView = (source: File | string, name: string) => {
  const android = isAndroid()
  // 用请求对象区分 A → B → A，不复用上一轮已释放的地址。
  const request = useMemo(() => ({ source, name, android }), [source, name, android])
  const [state, setState] = useState<{ request: typeof request; view: AttachmentView | null }>()
  useEffect(() => {
    const controller = new AbortController()
    const { source, name, android } = request
    const loadOriginal = () => (typeof source === 'string' ? loadFile(source) : source)
    void loadAttachmentView(loadOriginal, name, android, controller.signal).then((view) => {
      if (!controller.signal.aborted) {
        setState({ request, view })
      }
    })
    return () => controller.abort()
  }, [request])

  return {
    view: state?.request === request ? state.view : undefined,
    image: isAttachmentThumbnail(getAttachmentViewMime(name)),
  }
}
