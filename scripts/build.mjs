// Cross-platform build: no POSIX rm/environment-assignment dependency on Windows.
import { writeFileSync } from 'node:fs'
import { dependencyNotices } from './notices.mjs'
process.env.NODE_ENV = 'production'
const { rspack } = await import('@rspack/core')
const { default: config } = await import('../rspack.config.ts')
const compiler = rspack(config)
compiler.run((error, stats) => {
  if (error) console.error(error.message)
  else console.log(stats.toString({ colors: process.stdout.isTTY, assets: true, chunks: false, modules: false }))
  compiler.close((closeError) => {
    if (closeError) console.error(closeError.message)
    if (error || closeError || stats?.hasErrors()) process.exitCode = 1
    else {
      try {
        const notices = dependencyNotices()
        writeFileSync(new URL('../dist/THIRD_PARTY_NOTICES.txt', import.meta.url), notices, 'utf8')
        console.log(`Dependency notices: ${Buffer.byteLength(notices)} bytes`)
      } catch (noticeError) {
        console.error(noticeError.message)
        process.exitCode = 1
      }
    }
  })
})
