import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { rspack } from '@rspack/core'
import { historyFixture } from '../tests/browser/history-fixture.mjs'

// node scripts/benchmark-history-implementations.mjs <android-v1.0.10-dir> <upstream-v0.1.4-dir>
// Same production ZIP reader and IndexedDB code in fresh Edge contexts; excludes app UI and network.
const [baseline, upstream] = process.argv.slice(2)
assert.ok(baseline && upstream, 'Specify both baseline checkout directories')
const root = fileURLToPath(new URL('..', import.meta.url))
const output = await mkdtemp(path.join(tmpdir(), 'chat-history-bench-'))
const versions = [
  { name: 'android-1.0.10', source: baseline },
  { name: 'upstream-0.1.4', source: upstream, upstream: true },
  { name: 'merged', source: root },
].map((version) => ({ ...version, output: path.join(output, version.name) }))

function compile({ source, output }) {
  const services = path.resolve(source, 'src/services/chat')
  const compiler = rspack({
    mode: 'production',
    entry: {
      db: { import: path.join(services, 'db.ts'), library: { name: 'benchDb', type: 'var' } },
      archive: { import: path.join(services, 'history/importArchive.ts'), library: { name: 'benchArchive', type: 'var' } },
    },
    output: { path: output, filename: '[name].js' },
    resolve: { extensionAlias: { '.js': ['.ts', '.js'] }, modules: ['node_modules', path.join(root, 'node_modules')] },
    plugins: [new rspack.DefinePlugin({ __API_ORIGIN__: JSON.stringify('https://no-api.invalid') })],
    module: { rules: [{ test: /\.ts$/, loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' } } }] },
  })
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => compiler.close((closeError) => {
      const reason = error || closeError || (stats?.hasErrors() && new Error(stats.toString({ all: false, errors: true })))
      if (reason) reject(reason)
      else resolve()
    }))
  })
}

async function measure(browser, version, zip, expectedCount) {
  const page = await browser.newPage()
  try {
    await page.route('http://history-bench.test/**', (route) => route.request().url().endsWith('/sample.zip')
      ? route.fulfill({ body: zip, contentType: 'application/zip' })
      : route.fulfill({ body: '<!doctype html><html lang="zh"><title>ZIP benchmark</title></html>', contentType: 'text/html' }))
    await page.goto('http://history-bench.test/')
    await page.addScriptTag({ path: path.join(version.output, 'db.js') })
    await page.addScriptTag({ path: path.join(version.output, 'archive.js') })
    const result = await page.evaluate(async (upstream) => {
      const { checkArchiveFormat, importArchive } = window.benchArchive
      const { clearStaging, commitStaging } = window.benchDb
      const blob = await (await fetch('/sample.zip')).blob()
      let slices = 0
      let sliceBytes = 0
      class CountedFile extends File {
        slice(...args) {
          const part = super.slice(...args)
          slices++
          sliceBytes += part.size
          return part
        }
      }
      const file = new CountedFile([blob], 'sample.zip')
      const now = () => performance.now()
      const start = now()
      const source = await checkArchiveFormat(file)
      const preflightMs = now() - start
      await clearStaging()
      let stageTransactions = 0
      const transaction = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (names, mode, ...options) {
        const keys = typeof names === 'string' ? [names] : [...names]
        if (mode === 'readwrite' && keys.some((key) => key.endsWith('Staging'))) stageTransactions++
        return transaction.call(this, names, mode, ...options)
      }
      const parseStart = now()
      await importArchive(upstream ? file : source)
      const parseAndStageMs = now() - parseStart
      const staged = stageTransactions
      const commitStart = now()
      const summaries = await commitStaging()
      return { slices, sliceBytes, stageTransactions: staged, preflightMs, parseAndStageMs,
        importMs: preflightMs + parseAndStageMs, commitMs: now() - commitStart, count: summaries.length }
    }, !!version.upstream)
    assert.equal(result.count, expectedCount)
    return result
  } finally {
    await page.close()
  }
}

let browser
try {
  for (const version of versions) await compile(version)
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' })
  console.log(`Headless Chromium ${browser.version()}; median of 5 measured runs after a warm-up per version`)
  for (const [name, sample] of Object.entries({
    many: { count: 600 }, long: { count: 1, turns: 425 }, picture: { picture: true },
  })) {
    const zip = historyFixture(sample)
    const results = new Map(versions.map(({ name }) => [name, []]))
    for (let i = -1; i < 5; i++) {
      for (let j = 0; j < versions.length; j++) {
        const version = versions[(i + j + versions.length) % versions.length]
        const result = await measure(browser, version, zip, sample.count ?? 2)
        if (i >= 0) results.get(version.name).push(result)
      }
    }
    for (const [version, runs] of results) {
      const metrics = Object.fromEntries(Object.keys(runs[0]).map((key) => [
        key, Math.round(runs.map((run) => run[key]).sort((a, b) => a - b)[2]),
      ]))
      console.log(JSON.stringify({ sample: name, zipBytes: zip.length, version, ...metrics }))
    }
  }
} finally {
  try { await browser?.close() } finally { await rm(output, { recursive: true, force: true }) }
}
