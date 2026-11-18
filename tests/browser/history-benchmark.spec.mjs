import { expect, test } from '@playwright/test'
import { historyFixture, pickHistoryFixture } from './history-fixture.mjs'

for (const [name, fixture] of Object.entries({ many: { count: 600 }, long: { count: 1, turns: 425 }, picture: { picture: true } })) {
  test(`synthetic history benchmark: ${name}`, async ({ page }) => {
    test.skip(process.env.HISTORY_BENCH !== '1', 'Opt-in timing run; not a device-performance assertion')
    const zip = historyFixture(fixture)
    await page.addInitScript(() => {
      window.DeepSeekAndroid = { onmessage: null, postMessage(raw) {
        const { id, action } = JSON.parse(raw)
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, ok: true, value: action === 'getKey' ? 'sk-test-only' : null }) }))
      } }
    })
    await page.goto('/')
    await page.getByRole('button', { name: '打开边栏', exact: true }).click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: '数据管理' }).click()
    await pickHistoryFixture(page, zip)
    await page.evaluate(() => {
      const now = () => performance.now()
      const stats = { slices: 0, stageTxMs: 0, stageTransactions: 0, longTasks: [], maxDelayMs: 0 }
      window.__historyBench = stats
      const slice = File.prototype.slice
      File.prototype.slice = function (...args) {
        if (this.name === 'bench.zip') { stats.slices++; stats.lastSlice = now() }
        return Reflect.apply(slice, this, args)
      }
      const tx = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (names, ...options) {
        const result = Reflect.apply(tx, this, [names, ...options])
        const keys = typeof names === 'string' ? [names] : [...names]
        if (options[0] === 'readwrite' && keys.includes('sessionsStaging') && keys.includes('sessionSummaries')) {
          stats.commitStart = now()
          result.addEventListener('complete', () => { stats.commitEnd = now() })
        } else if (options[0] === 'readwrite' && keys.some((key) => key.endsWith('Staging'))) {
          const start = now()
          if (keys.length === 2) stats.stageStart ??= start
          result.addEventListener('complete', () => { stats.stageTransactions++; stats.stageTxMs += now() - start })
        }
        return result
      }
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) stats.longTasks.push({ start: entry.startTime, ms: entry.duration })
      })
      observer.observe({ entryTypes: ['longtask'] })
      window.__historyBenchStop = () => { clearInterval(timer); observer.disconnect() }
      let last = now()
      const timer = setInterval(() => {
        const time = now()
        stats.maxDelayMs = Math.max(stats.maxDelayMs, time - last - 16)
        last = time
      }, 16)
      document.addEventListener('click', (event) => {
        if (event.target.closest('button')?.innerText === '确认导入') stats.start = now()
      }, true)
    })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await expect(page.getByText(`已导入 ${fixture.count ?? 2} 个对话`, { exact: true })).toBeVisible({ timeout: 20_000 })
    await page.evaluate(() => { window.__historyBench.visible = performance.now() })
    await page.keyboard.press('Escape')
    const session = page.getByText('合成会话 0', { exact: true }).last()
    if (!(await session.isVisible())) await page.getByRole('button', { name: '打开边栏', exact: true }).click()
    await page.evaluate(() => {
      document.addEventListener('click', (event) => {
        if (event.target.textContent?.trim() === '合成会话 0') window.__historyBench.open = performance.now()
      }, true)
    })
    await session.click()
    const answer = `合成回答 0-${(fixture.turns ?? 1) - 1}`
    await expect(page.getByText(answer, { exact: !fixture.turns })).toBeVisible({ timeout: 15_000 })
    const stats = await page.evaluate(() => {
      const s = window.__historyBench
      window.__historyBenchStop()
      const ms = (n) => Math.round(n)
      return { slices: s.slices, preflightMs: ms(s.stageStart - s.start), parseAndStageMs: ms(s.commitStart - s.stageStart), stageTransactions: s.stageTransactions, stageTxMs: ms(s.stageTxMs), commitMs: ms(s.commitEnd - s.commitStart), clickToVisibleMs: ms(s.visible - s.start), firstOpenMs: ms(performance.now() - s.open), importLongTasksMs: s.longTasks.filter((t) => t.start >= s.start && t.start < s.commitEnd).map((t) => t.ms), maxDelayMs: ms(s.maxDelayMs) }
    })
    expect(stats.firstOpenMs).not.toBeNaN()
    console.log(JSON.stringify({ benchmark: name, bytes: zip.length, ...stats }))
  })
}
