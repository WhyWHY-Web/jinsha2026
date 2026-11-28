import {readFileSync} from 'node:fs'
import {gzipSync} from 'node:zlib'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const directory = fileURLToPath(new URL('../dist/',import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(directory,'.vite/manifest.json'),'utf8'))
const assets = new Set()
const visited = new Set()
function collect(key) {
  if (visited.has(key)) return
  visited.add(key)
  const chunk = manifest[key]
  assets.add(chunk.file)
  for (const file of chunk.css ?? []) assets.add(file)
  for (const dependency of chunk.imports ?? []) collect(dependency)
}
for (const [key,chunk] of Object.entries(manifest)) if (chunk.isEntry) collect(key)
const bytes = [...assets].reduce((sum,asset)=>sum+gzipSync(readFileSync(resolve(directory,asset))).length,0)
const kib = (bytes/1024).toFixed(1)
console.log(`首屏入口 JS/CSS gzip: ${kib} KiB`)
if (bytes>=200*1024) throw new Error('首屏入口超过 200 KiB gzip 预算')
for (const name of ['vendor-maplibre']) {
  const chunk = Object.values(manifest).find(chunk=>chunk.file.includes(name) && chunk.file.endsWith('.js'))
  if (chunk) console.log(`${name} 延迟模块 gzip: ${(gzipSync(readFileSync(resolve(directory,chunk.file))).length/1024).toFixed(1)} KiB`)
}
