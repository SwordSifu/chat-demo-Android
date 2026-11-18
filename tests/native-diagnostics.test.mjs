import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sanitizeEvent } from '../src/services/diagnosticsCore.ts'

test('Android WebRTC audio declares both runtime capture and normal routing permissions only', () => {
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
  const permissions = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map((match) => match[1]).sort()
  assert.deepEqual(permissions, [
    'android.permission.INTERNET',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.RECORD_AUDIO',
  ])
  assert.ok(!manifest.includes('android.permission.WRITE_SETTINGS'))
})

// Cross-language contract: an independently passing Java logger must not emit wire names
// that the frontend silently strips. Read the actual compiled-source enum, not copied mocks.
test('all actual Java diagnostic event wire names survive the frontend privacy schema', () => {
  const source = readFileSync(new URL('../android/app/src/main/java/net/deepseek/chat/DiagnosticBuffer.java', import.meta.url), 'utf8')
  const block = /enum Event\s*\{([\s\S]*?)final String wire/.exec(source)
  assert.ok(block, 'native event wire enum exists')
  const names = [...block[1].matchAll(/[A-Z_]+\("([^"]+)"\)/g)].map((match) => match[1])
  assert.equal(names.length, 9)
  for (const event of names) {
    assert.ok(event.startsWith('native.'), event)
    const item = sanitizeEvent({ t: Date.now(), event, details: { granted: true, status: 1 } })
    assert.equal(item?.event, event, `native event would be lost during export: ${event}`)
    assert.equal(item?.details.status, 1)
  }
})
