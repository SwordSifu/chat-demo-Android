import { initializeAndroid, isAndroid, saveNativeApiKey } from './platform/android.js'
import { setupDiagnostics, synchronizeNativeDiagnostics, diagnosticError } from './services/diagnostics.js'

setupDiagnostics()
void initializeAndroid()
  .then(() => {
    const bootstrap = import('./bootstrap.js')
    // Secure initialization gates startup; the optional diagnostics RPC does not.
    if (isAndroid()) {
      void synchronizeNativeDiagnostics().catch((error) => diagnosticError('native.bridge.error', error))
    }
    return bootstrap
  })
  .catch((error) => {
    diagnosticError('app.error', error, { reason: 'start_failure' })
    // Fail closed if secure storage/bridge fails. Do not silently fall back to a plaintext key.
    const root = document.getElementById('root') ?? document.body
    const message = document.createElement('p')
    message.textContent = '无法初始化安全存储或应用资源。请重试；如仍失败，请更新 Android System WebView。'
    const retry = document.createElement('button')
    retry.textContent = '重试 / Retry'
    retry.onclick = () => window.location.reload()
    root.replaceChildren(message, retry)
    if (isAndroid()) {
      const reset = document.createElement('button')
      reset.textContent = '仅清除已保存的 API Key（保留会话）'
      let confirmed = false
      reset.onclick = () => {
        if (!confirmed) {
          confirmed = true
          reset.textContent = '再次点击确认清除 API Key'
          return
        }
        reset.disabled = true
        void saveNativeApiKey(null).then(() => {
          localStorage.removeItem('chat-demo:api-key')
          window.location.reload()
        }).catch(() => {
          reset.disabled = false
          reset.textContent = '清除失败，请重试'
        })
      }
      root.append(reset)
    }
  })
