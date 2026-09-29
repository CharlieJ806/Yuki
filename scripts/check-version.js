/**
 * 版本一致性校验 —— 版本号散在四处（package.json / tauri.conf.json /
 * Cargo.toml / installer.nsi），纯手工同步。bump 提交自称「三处同步」
 * 却漏了 Cargo.toml，crate 版本静默漂移过一次（0.1.0 vs 0.2.0）。
 * 发版 tag 只读 package.json，错版产物会照常上 Release —— 所以挂进
 * npm test，任何一处不同步都在提交前暴露。
 *
 * 用法: node scripts/check-version.js（无参数；不一致时 exit 1）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const confVersion = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).version
const cargoVersion =
  /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(ROOT, 'src-tauri', 'Cargo.toml'), 'utf8'))?.[1] ?? null
const nsiVersion =
  /^!define\s+VERSION\s+"([^"]+)"/m.exec(readFileSync(join(ROOT, 'scripts', 'installer.nsi'), 'utf8'))?.[1] ?? null

const sources = [
  ['package.json', pkgVersion],
  ['src-tauri/tauri.conf.json', confVersion],
  ['src-tauri/Cargo.toml', cargoVersion],
  ['scripts/installer.nsi', nsiVersion],
]

const bad = sources.filter(([, v]) => v !== pkgVersion)
if (bad.length) {
  console.error(`✗ 版本号不一致（基准 package.json = ${pkgVersion}）：`)
  for (const [name, v] of bad) console.error(`    ${name} = ${v ?? '(解析失败)'}`)
  process.exit(1)
}
console.log(`✓ 版本一致：${sources.map(([n, v]) => `${n}=${v}`).join(' ')}`)
