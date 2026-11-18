import { strToU8, zipSync } from 'fflate'

function image() {
  const width = 1536
  const height = 1536
  const bytes = new Uint8Array(54 + width * height * 3)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setUint32(18, width, true)
  view.setUint32(22, height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  let seed = 1234
  for (let i = 54; i < bytes.length; i++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    bytes[i] = seed
  }
  return bytes
}

export function historyFixture({ count = 2, turns = 1, picture = false, badIndex = false } = {}) {
  const json = (value) => strToU8(JSON.stringify(value))
  const files = { 'manifest.json': json({ export_format_version: 3 }) }
  const attachment = picture ? image() : null
  const path = 'chat_sessions/bench-0_files/bench-image_photo.bmp'
  const summaries = []
  for (let i = 0; i < count; i++) {
    const time = new Date(Date.UTC(2026, 0, 1, 0, 0, count - i)).toISOString()
    const messages = []
    const message = (id, parent, role, fragments) => ({
      id, parent_id: parent, role, fragments, status: 'FINISHED', thinking_enabled: false,
      search_enabled: false, accumulated_token_usage: 0, inserted_at: time,
    })
    for (let j = 0; j < turns; j++) {
      const id = 2 * j + 1
      const prompt = [{ type: 'REQUEST', content: `合成提问 ${i}-${j}` }]
      if (attachment && i === 0 && j === 0) prompt.push({ type: 'FILE', files: [{
        id: 'bench-image', file_name: 'photo.bmp', file_size: attachment.length,
        token_usage: null, inserted_at: time, export_path: path, is_image: true,
        width: 1536, height: 1536,
      }] })
      messages.push(message(id, j === 0 ? null : id - 1, 'USER', prompt))
      messages.push(message(id + 1, id, 'ASSISTANT', [{ type: 'RESPONSE', content: `合成回答 ${i}-${j}${turns > 20 ? ' 长对话的非私人测试文本。'.repeat(18) : ''}` }]))
    }
    if (turns === 1 && i === 0) messages.push(message(3, 1, 'ASSISTANT', [{ type: 'RESPONSE', content: '替代回答' }]))
    const summary = { id: `bench-${i}`, title: `合成会话 ${i}`, pinned: false, inserted_at: time, updated_at: time }
    summaries.push({ ...summary, message_count: messages.length })
    files[`chat_sessions/${summary.id}.json`] = json({ ...summary, current_message_id: turns * 2, messages })
  }
  files['chat_session_index.json'] = json(badIndex ? [] : summaries)
  if (attachment) files[path] = attachment
  return Buffer.from(zipSync(files, { level: 1 }))
}

export async function pickHistoryFixture(page, zip) {
  await page.route('**/synthetic-history.zip', (route) => route.fulfill({ body: zip, contentType: 'application/zip' }))
  await page.locator('input[type=file][accept*=".zip"]').evaluate(async (input) => {
    const response = await fetch('/synthetic-history.zip')
    const data = new DataTransfer()
    data.items.add(new File([await response.blob()], 'bench.zip', { type: 'application/zip' }))
    input.files = data.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
