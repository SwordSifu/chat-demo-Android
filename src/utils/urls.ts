/** API / 导入归档中的外链不可信；只允许绝对 HTTP(S)，不解析为本地页面地址。 */
export const getSafeExternalUrl = (value: string): string | undefined => {
  const url = value.trim()
  // URL() 会忽略部分控制字符、修复反斜杠等，先拒绝有歧义的输入。
  const hasControl = Array.from(url).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x20 || code === 0x7f
  })
  if (!/^https?:\/\//i.test(url) || hasControl || url.includes('\\')) {
    return undefined
  }
  try {
    const parsed = new URL(url)
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return undefined
    }
    return parsed.href
  } catch {
    return undefined
  }
}
