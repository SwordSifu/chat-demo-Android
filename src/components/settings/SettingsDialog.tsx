import clsx from 'clsx'
import { clearWebViewCache, isAndroid, isSaveCancelled, saveBlob } from '../../platform/android.js'
import { useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { clearDiagnostics, diagnosticArchive, diagnosticsEnabled, setDiagnosticLogging, subscribeDiagnostics } from '../../services/diagnostics.js'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
  type ImportProgress,
} from '../../services/chat/backup.js'
import { useIsMobile } from '../../app/viewport.js'
import { clearInactiveSessionCache, selectSession, useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setLocale,
  setLocation,
  setSafetyCheck,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { AccountSettings } from './AccountSettings.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、清缓存、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
  { value: 'account', label: 'settingDialogAsideAccountOptionLabel', icon: null },
]

const SettingsContent = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyImport.file !== null || historyDelete.busy || replacingHistory
  const cacheCleanup = useCacheCleanup(historyBusy)
  const dataBusy = historyBusy || cacheCleanup.phase === 'running'
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyImport.busy && !historyImport.file && !historyDelete.busy && cacheCleanup.canClose()) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <SafetyCheckSetting />
              <TtsVoiceSetting />
              <LocationSetting />
            </>
          ) : section === 'account' ? (
            <AccountSettings />
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
              <ImportHistory historyImport={historyImport} disabled={dataBusy} />
              <ExportHistory disabled={dataBusy} />
              <SettingCell
                label={t('cacheCleanupTitle')}
                description={t(cacheCleanup.android ? 'cacheCleanupAndroidScope' : 'cacheCleanupBrowserScope')}
                status={cacheCleanup.appStatus}
                secondaryStatus={cacheCleanup.nativeStatus}
                action={
                  <Button variant="outlined" size="m" className={styles.cellButton}
                    disabled={dataBusy || cacheCleanup.phase !== 'idle'} onClick={cacheCleanup.open}>
                    {t('cacheCleanupAction')}
                  </Button>
                }
              />
              <DiagnosticsSettings disabled={dataBusy} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={dataBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      {historyImport.file || historyImport.progress ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
      {cacheCleanup.phase !== 'idle' ? <CacheCleanupConfirm cleanup={cacheCleanup} disabled={historyBusy} /> : null}
    </>
  )
}

const CacheCleanupConfirm = ({ cleanup, disabled }: {
  cleanup: ReturnType<typeof useCacheCleanup>
  disabled: boolean
}) => {
  const t = useTranslate()
  const busy = cleanup.phase === 'running'
  return (
    <Modal
      title={t('cacheCleanupConfirmTitle')}
      onClose={cleanup.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={busy}>
          <Button variant="outlined" autoFocus disabled={busy} onClick={cleanup.cancel}>
            {t('cancel')}
          </Button>
          <Button disabled={disabled || busy} onClick={() => void cleanup.confirm()}>
            {t(busy ? 'cacheCleanupRunning' : 'cacheCleanupAction')}
          </Button>
        </div>
      }
    >
      {t(cleanup.android ? 'cacheCleanupAndroidScope' : 'cacheCleanupBrowserScope')}{' '}
      {t('cacheCleanupPreservation')}
    </Modal>
  )
}

const useCacheCleanup = (historyBusy: boolean) => {
  type Phase = 'idle' | 'confirming' | 'running'
  const [phase, setPhase] = useState<Phase>('idle')
  const phaseRef = useRef<Phase>('idle')
  const [appStatus, setAppStatus] = useState<Status>(null)
  const [nativeStatus, setNativeStatus] = useState<Status>(null)
  const android = isAndroid()
  const transition = (next: Phase) => {
    phaseRef.current = next
    setPhase(next)
  }
  const blockedByHistory = () => historyBusy || useChatStore.getState().importingHistory

  const confirm = async () => {
    if (phaseRef.current !== 'confirming' || blockedByHistory()) {
      return
    }
    // Consume this confirmation before any store update or native RPC can run.
    transition('running')
    setAppStatus(null)
    setNativeStatus(null)
    try {
      const count = clearInactiveSessionCache()
      setAppStatus({ key: 'cacheCleanupAppResult', params: { count } })
      if (android) {
        try {
          await clearWebViewCache()
          setNativeStatus({ key: 'cacheCleanupNativeResult' })
        } catch {
          setNativeStatus({ key: 'cacheCleanupNativeError', error: true })
        }
      }
    } catch {
      setAppStatus({ key: 'cacheCleanupAppError', error: true })
    } finally {
      transition('idle')
    }
  }

  return {
    phase,
    android,
    appStatus,
    nativeStatus,
    canClose: () => phaseRef.current !== 'running',
    open: () => {
      if (phaseRef.current === 'idle' && !blockedByHistory()) {
        transition('confirming')
      }
    },
    cancel: () => {
      if (phaseRef.current === 'confirming') {
        transition('idle')
      }
    },
    confirm,
  }
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const DiagnosticsSettings = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const enabled = useSyncExternalStore(subscribeDiagnostics, diagnosticsEnabled)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const run = async (action: 'toggle' | 'export' | 'clear') => {
    if (busy) { return }
    setBusy(true)
    setStatus(null)
    try {
      if (action === 'toggle') {
        await setDiagnosticLogging(!enabled)
      } else if (action === 'clear') {
        await clearDiagnostics()
        setStatus({ key: 'diagnosticsCleared' })
      } else {
        const { blob, name } = await diagnosticArchive()
        await saveBlob(blob, name)
        setStatus({ key: 'diagnosticsExported' })
      }
    } catch (error) {
      if (!isSaveCancelled(error)) { setStatus({ key: 'diagnosticsFailed', error: true }) }
    } finally {
      setBusy(false)
    }
  }
  return <>
    <SettingCell label={t('diagnosticsLogging')} description={t('diagnosticsDescription')} status={null}
      action={<button type="button" role="switch" aria-checked={enabled}
        aria-label={t('diagnosticsLogging')} className={styles.safetySwitch} disabled={disabled || busy}
        onClick={() => void run('toggle')}><span className={styles.safetySwitchThumb} aria-hidden="true" /></button>} />
    <SettingCell label={t('diagnosticsTitle')} status={status}
      action={<div className={styles.diagnosticsActions}>
        <Button variant="outlined" size="m" disabled={disabled || busy} onClick={() => void run('export')}>{t('diagnosticsExport')}</Button>
        <Button variant="outlined" size="m" disabled={disabled || busy} onClick={() => void run('clear')}>{t('diagnosticsClear')}</Button>
      </div>} />
  </>
}

const SafetyCheckSetting = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.safetyCheck)
  const descriptionId = useId()
  return (
    <SettingCell
      label={t('settingsSafetyCheck')}
      description={t('settingsSafetyCheckDescription')}
      descriptionId={descriptionId}
      status={null}
      action={
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t('settingsSafetyCheck')}
          aria-describedby={descriptionId}
          className={styles.safetySwitch}
          onClick={() => setSafetyCheck(!enabled)}
        >
          <span className={styles.safetySwitchThumb} aria-hidden="true" />
        </button>
      }
    />
  )
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 确认后原地显示进度，正式保存只可等待完成。 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  const { progress, cancelling } = historyImport
  const progressId = useId()
  const reading = progress?.phase === 'reading' ? progress : null
  const progressText = cancelling
    ? t('historyImportCancelling')
    : reading
      ? t('historyImportReading', { completed: reading.completed, total: reading.total })
      : t(progress?.phase === 'saving' ? 'historyImportSaving' : 'historyImportChecking')

  return (
    <Modal
      title={t(progress ? 'historyImport' : 'historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.dismissConfirm}
      footer={
        progress ? (
          progress.phase !== 'saving' ? (
            <Button
              key="cancel-import"
              variant="outlined"
              size="m"
              autoFocus
              disabled={cancelling}
              onClick={historyImport.cancelImport}
            >
              {t('historyImportCancel')}
            </Button>
          ) : null
        ) : (
          <>
            <Button variant="outlined" size="m" autoFocus onClick={historyImport.dismissConfirm}>
              {t('cancel')}
            </Button>
            <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
              {t('historyImportConfirm')}
            </Button>
          </>
        )
      }
    >
      {progress ? (
        <div className={styles.importProgress}>
          <div id={progressId} role="status">{progressText}</div>
          <progress
            aria-labelledby={progressId}
            max={reading?.total || undefined}
            value={cancelling || !reading?.total ? undefined : reading.completed}
          />
        </div>
      ) : (
        <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
      )}
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  descriptionId,
  status,
  secondaryStatus,
  statusAction,
  action,
  className,
}: {
  label: string
  description?: string
  descriptionId?: string
  status: Status
  secondaryStatus?: Status
  statusAction?: ReactNode
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div
            id={descriptionId}
            className={clsx(styles.description, status?.error && styles.error)}
            aria-live="polite"
          >
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
        {secondaryStatus ? (
          <div className={clsx(styles.description, secondaryStatus.error && styles.error)} aria-live="polite">
            {t(secondaryStatus.key, secondaryStatus.params)}
          </div>
        ) : null}
        {statusAction}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后检查、读取，进入原子保存前才允许取消。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [latestId, setLatestId] = useState<string | null>(null)
  const operation = useRef<{ controller: AbortController; saving: boolean } | null>(null)

  const confirm = async () => {
    if (!file || operation.current) {
      return
    }
    const controller = new AbortController()
    const current = { controller, saving: false }
    operation.current = current
    setFile(null)
    setProgress({ phase: 'checking' })
    setStatus(null)
    setLatestId(null)
    try {
      const { count, latestId } = await importHistory(file, {
        signal: controller.signal,
        onProgress: (next) => {
          // Invalidate cancellation synchronously, before React paints the saving phase.
          current.saving = next.phase === 'saving'
          setProgress(next)
        },
      })
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
      setLatestId(latestId)
    } catch (error) {
      if (controller.signal.aborted && error instanceof Error && error.name === 'AbortError') {
        setStatus({ key: 'historyImportCancelled' })
      } else if (error instanceof Error && error.name === 'QuotaExceededError') {
        setStatus({ key: 'historyImportQuota', error: true })
      } else if (error instanceof BackupError) {
        setStatus({ key: 'historyImportBackupFailed', reason: error.key, error: true })
      } else {
        setStatus({ key: 'historyImportFailed', error: true })
      }
    } finally {
      operation.current = null
      setProgress(null)
      setCancelling(false)
    }
  }

  return {
    file,
    busy: progress !== null,
    progress,
    cancelling,
    status,
    latestId,
    select: (next: File) => {
      if (!operation.current) {
        setFile(next)
      }
    },
    dismissConfirm: () => {
      if (!operation.current) {
        setFile(null)
      }
    },
    cancelImport: () => {
      const current = operation.current
      if (current && !current.saving && !current.controller.signal.aborted) {
        setCancelling(true)
        current.controller.abort()
      }
    },
    confirm,
    viewImported: () => {
      if (latestId !== null && !operation.current) {
        selectSession(latestId)
        closeSettings()
      }
    },
  }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      statusAction={historyImport.latestId !== null ? (
        <Button
          variant="outlined"
          size="m"
          className={styles.importViewButton}
          disabled={disabled}
          onClick={historyImport.viewImported}
        >
          {t('historyImportView')}
        </Button>
      ) : null}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      await saveBlob(blob, name)
    } catch (error) {
      if (!isSaveCancelled(error)) {
        setStatus(errorStatus('historyExportFailed', error))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
