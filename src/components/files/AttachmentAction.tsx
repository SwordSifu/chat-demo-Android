import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { isSaveCancelled, saveBlob } from '../../platform/android.js'
import type { AttachmentView } from '../../utils/attachmentPreview.js'
import { Button } from '../base/Button.js'
import { IconPhotoErrorFill20 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './AttachmentAction.module.css'

export const AttachmentImage = ({ url, name }: { url: string; name: string }) => {
  const [failedUrl, setFailedUrl] = useState<string>()
  return failedUrl === url ? (
    <span className={styles.failedImage} role="img" aria-label={name}>
      <IconPhotoErrorFill20 />
    </span>
  ) : (
    <img src={url} alt={name} onError={() => setFailedUrl(url)} />
  )
}

const OriginalAttachmentImage = ({ file, name }: { file: Blob; name: string }) => {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    const source = URL.createObjectURL(file)
    setUrl(source)
    return () => URL.revokeObjectURL(source)
  }, [file])
  return url ? <AttachmentImage url={url} name={name} /> : null
}

/** Android 打开大图和保存都使用原件，不读取缩略图。 */
export const AttachmentAction = ({ name, view }: { name: string; view: AttachmentView }) => {
  const t = useTranslate()
  const [openView, setOpenView] = useState<AttachmentView>()
  const [saving, setSaving] = useState(false)
  const pendingSave = useRef(false)

  if ('url' in view) {
    const action = view.action === 'tab'
      ? { target: '_blank', rel: 'noopener noreferrer' }
      : { download: name }
    return <a className={styles.action} href={view.url} aria-label={name} {...action} />
  }
  const saveOriginal = async () => {
    if (pendingSave.current) {
      return
    }
    pendingSave.current = true
    setSaving(true)
    try {
      await saveBlob(view.file, name)
    } catch (error) {
      if (!isSaveCancelled(error)) {
        showToast(error instanceof Error ? error.message : String(error))
      }
    } finally {
      pendingSave.current = false
      setSaving(false)
    }
  }

  return (
    <>
      <button
        className={styles.action}
        type="button"
        aria-label={name}
        aria-haspopup={view.action === 'preview' ? 'dialog' : undefined}
        disabled={view.action === 'save' && saving}
        onClick={() => (view.action === 'preview' ? setOpenView(view) : void saveOriginal())}
      />
      {view.action === 'preview' && openView === view ? (
        <Modal
          title={name}
          closable
          onClose={() => setOpenView(undefined)}
          mainClassName={styles.preview}
          footer={
            <Button size="s" disabled={saving} onClick={() => void saveOriginal()}>
              {t('exportAllDownload')}
            </Button>
          }
        >
          <OriginalAttachmentImage file={view.file} name={name} />
        </Modal>
      ) : null}
    </>
  )
}
