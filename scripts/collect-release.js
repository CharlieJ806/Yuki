/**
 * Tauri 侧产物归集到 release/tauri/（Electron 侧由 build.js / installer.nsi
 * 直接产出到位，不经本脚本）。
 *
 * 前置产物（npx tauri build）：
 *   src-tauri/target/release/app.exe                       绿色单 exe
 *   src-tauri/target/release/bundle/nsis/*-setup.exe       安装包
 *
 * 归集 = 改名拷贝成英文规范名。重命名是必须的：Tauri 打包器产物名跟随
 * productName（中文「摸鱼桌宠」），分发层统一英文 desk-pet-*。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = join(ROOT, 'release')
const TAURI_TARGET = join(ROOT, 'src-tauri', 'target', 'release')
const APP_NAME = '摸鱼桌宠'
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const NSIS_DIR = join(TAURI_TARGET, 'bundle', 'nsis')

function mustExist(p, hint) {
  if (!existsSync(p)) {
    console.error(`✗ 缺少产物：${p}\n  ${hint}`)
    process.exit(1)
  }
}

mustExist(join(TAURI_TARGET, 'app.exe'), '先跑 npx tauri build')

const DIST = join(RELEASE, 'tauri')
mkdirSync(DIST, { recursive: true })
const portable = join(DIST, `desk-pet-${VERSION}-x64-portable.exe`)
const setup = join(DIST, `desk-pet-setup-${VERSION}.exe`)

/* 绿色单 exe：改名不影响运行（资产按自身路径解析） */
copyFileSync(join(TAURI_TARGET, 'app.exe'), portable)
console.log(`✓ ${portable}`)

/* 安装包：打包器按 productName 产出中文名，归集成规范英文名 */
const setupSource = readdirSync(NSIS_DIR)
  .filter((f) => f.endsWith('-setup.exe'))
  .map((f) => join(NSIS_DIR, f))
  .sort((a, b) => a.localeCompare(b))
  .pop()
mustExist(setupSource, '先跑 npx tauri build（NSIS bundle）')
copyFileSync(setupSource, setup)
console.log(`✓ ${setup}（源：${setupSource}）`)

console.log('\n归集完成：release/tauri/ 就绪。')
