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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
/* 旧版本产物一并清掉：release.yml 按 release/tauri/* 全量上传，
   混入旧版会照发（bundle/nsis 不清理，这里必须兜一道） */
for (const f of readdirSync(DIST)) {
  if (f.startsWith('desk-pet-') && !f.includes(`-${VERSION}-`) && !f.includes(`-${VERSION}.`)) {
    rmSync(join(DIST, f), { force: true })
    console.log(`✓ 清理旧版产物: ${f}`)
  }
}
const portable = join(DIST, `desk-pet-tauri-${VERSION}-x64-portable.exe`)
const setup = join(DIST, `desk-pet-tauri-setup-${VERSION}.exe`)

/* 绿色单 exe：改名不影响运行（资产按自身路径解析） */
copyFileSync(join(TAURI_TARGET, 'app.exe'), portable)
console.log(`✓ ${portable}`)

/* 安装包：打包器按 productName 产出中文名，归集成规范英文名。
   按当前版本精确挑选而不是字典序取末位——bundle/nsis 不清理、旧版产物
   会积累，而 localeCompare 不识别数字（0.2.10 < 0.2.9），跨 .9→.10 边界
   会把旧 exe 改名成新版本交付。 */
const wanted = `-${VERSION}-setup.exe`
const setupFile = readdirSync(NSIS_DIR).find((f) => f.endsWith('-setup.exe') && f.includes(wanted))
const setupSource = setupFile ? join(NSIS_DIR, setupFile) : null
mustExist(setupSource, `先跑 npx tauri build（NSIS bundle，需含 *${wanted}，旧版产物请清理）`)
copyFileSync(setupSource, setup)
console.log(`✓ ${setup}（源：${setupSource}）`)

console.log('\n归集完成：release/tauri/ 就绪。')
