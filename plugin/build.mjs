// dsh-yh-olap-workstation 构建脚本：把 src/client/ 打成单个 DSH client bundle。
// 产物 dist/client.js 是一个 classic script，materialize 时：
//   window.__ModuleLoader__.load({ id: 'dsh-yh-olap-workstation', factory(require) { ... } })
// react / react-dom 由 DSH 浏览器 seed 模块表提供，故标记为 external（factory 的 require 解析）。
//
// 用法：npm install && npm run build
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, 'src', 'client', 'index.js')
const OUT = join(HERE, 'dist', 'client.js')
const PKG = JSON.parse(await readFile(join(HERE, 'package.json'), 'utf8'))
const ID = PKG.name

const BANNER = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(ID)},
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;`

const FOOTER = `    return module.exports
  }
})
`

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120'],
  external: ['react', 'react-dom'],
  loader: { '.css': 'text' },
  legalComments: 'none',
  minify: true,
  charset: 'utf8',
  logLevel: 'warning',
})

const js = result.outputFiles[0].text
await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, BANNER + js + FOOTER, 'utf8')
console.log(`built ${OUT} (${(Buffer.byteLength(js) / 1024).toFixed(1)} KiB)`)
