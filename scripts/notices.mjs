import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Keep original license/notice texts for the installed runtime dependency graph.
// Includes type-only runtime declarations conservatively; no third-party code is modified.
export function dependencyNotices() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const seen = new Map()
  function findPackage(name, from) {
    let current = from
    for (;;) {
      const manifest = path.join(current, 'node_modules', name, 'package.json')
      if (fs.existsSync(manifest)) return fs.realpathSync(path.dirname(manifest))
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
  function visit(name, from, optional = false) {
    const directory = findPackage(name, from)
    if (!directory) {
      if (optional) return
      throw new Error(`Cannot find dependency license metadata: ${name}`)
    }
    if (seen.has(directory)) return
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    seen.set(directory, pkg)
    for (const dependency of Object.keys(pkg.dependencies || {})) visit(dependency, directory)
    for (const dependency of Object.keys(pkg.optionalDependencies || {})) visit(dependency, directory, true)
  }
  for (const name of Object.keys(rootPackage.dependencies)) visit(name, root)
  visit('@swc/helpers', root)
  const texts = ['THIRD-PARTY NOTICES\n\nThis is a conservative superset of web runtime dependencies. Original license terms follow.\n\nAndroid native container uses AndroidX WebKit 1.12.1 and its AndroidX / Kotlin dependencies, Copyright The Android Open Source Project / JetBrains contributors, Apache License 2.0. Full Apache 2.0 terms are included below (also used by @swc/helpers).\n\nOriginal DeepSeek chat-demo: https://github.com/deepseek-ai/chat-demo (MIT; see adjacent LICENSE).\n']
  for (const [directory, pkg] of [...seen].sort((a, b) => `${a[1].name}@${a[1].version}`.localeCompare(`${b[1].name}@${b[1].version}`))) {
    const licenses = fs.readdirSync(directory).filter((name) => /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(name))
    texts.push(`\n${'='.repeat(72)}\n${pkg.name}@${pkg.version}\nDeclared license: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license || 'See package distribution')}\n`)
    for (const license of licenses) {
      const file = path.join(directory, license)
      if (fs.statSync(file).isFile()) texts.push(`\n--- ${license} ---\n${fs.readFileSync(file, 'utf8')}\n`)
    }
  }
  return texts.join('')
}
