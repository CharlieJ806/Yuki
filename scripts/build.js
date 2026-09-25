/**
 * 打包脚本 —— 产出免安装的单文件 exe。
 *
 * 流程：vite build（渲染层）→ @electron/packager（Electron 运行时 + 源码）
 *      → rcedit 元信息 → 生成桌面快捷方式脚本
 *
 * 用法: node scripts/build.js
 * 产物: release/摸鱼桌宠-win32-x64/摸鱼桌宠.exe
 */
import { packager } from '@electron/packager'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, cpSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = join(ROOT, 'release')
const APP_NAME = '摸鱼桌宠'
/* 分发层统一英文规范名（产品显示层保持中文）：{产品}-{形态}-{版本}-{架构} */
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
/*
 * OUT_DIR 是暂存区（.tmp-release/，gitignored，在 release/ 之外）：绿色版交付物
 * 只有 zip，散装目录绝不能出现在交付区。放 release 外面还有个顺序原因——
 * pack:installer 链里 makensis 要从暂存区读文件，而 build.js 先跑且会压缩，
 * 暂存区放 release/ 内会「边交付边消失」。产物每次全量覆盖，可随手删除。
 */
const WORK_DIR = join(ROOT, '.tmp-release')
const OUT_DIR = join(WORK_DIR, 'desk-pet-win-x64')
const DIST_DIR = join(RELEASE, 'electron')
const PORTABLE_ZIP = join(DIST_DIR, `desk-pet-${VERSION}-win-x64-portable.zip`)

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32', ...opts })
}

/* ---------- 1. 构建渲染层 ---------- */
console.log('\n[1/5] 构建渲染层 (vite build)...')
run(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'build'])
if (!existsSync(join(ROOT, 'dist', 'index.html'))) throw new Error('vite build 未产出 dist/index.html')

/* ---------- 2. 清理旧产物 ---------- */
console.log('\n[2/5] 清理旧产物...')

/*
 * 删除旧产物时最常遇到的失败不是权限问题，而是「旧版程序还在运行」——
 * exe / asar 被占用，rmSync 抛的是 EPERM 原始堆栈，看不出真正原因。
 * 实测这个坑每次打包都要踩一遍，所以这里把 EPERM/EBUSY 翻译成人话，
 * 并顺手列出占用进程，用户不用自己猜。
 */
function removeOutDir(dir) {
  if (!existsSync(dir)) return
  try {
    rmSync(dir, { recursive: true, force: true })
    return
  } catch (err) {
    const locked = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES'
    if (!locked) throw err

    console.error(`\n✗ 无法清理旧产物：${dir}`)
    console.error('  目录被占用，最常见的原因是「摸鱼桌宠」还在运行。')

    /* 尽量把进程列出来，比让用户去任务管理器翻强 */
    const procs = listAppProcesses()
    if (procs.length) {
      console.error('\n  检测到正在运行的相关进程：')
      for (const p of procs) console.error(`    · PID ${p.pid}  ${p.name}`)
    }

    console.error('\n  请先退出程序（右键桌宠 → 退出摸鱼桌宠，或托盘图标右键 → 退出），再重新运行 npm run pack。\n')
    process.exit(1)
  }
}

/** 找出正在跑的相关进程；查不到就返回空数组，不影响主流程 */
function listAppProcesses() {
  try {
    /*
     * 用 PowerShell 的 Get-Process 而不是 tasklist：后者在部分系统上
     * 中文进程名会乱码，这里要的是能读的名字。
     *
     * 两个已经踩过的坑：
     * 1. 必须显式把输出编码设成 UTF-8。Windows PowerShell 5.1 默认按控制台
     *    代码页（本机 GBK）输出，Node 按 UTF-8 解码就得到一串乱码
     *    （实测显示成 `��������`），提示反而比原始报错更难懂。
     * 2. 语句之间要用换行分隔，不能用 `;` 拼接 ——
     *    `A; B | Select ... | ConvertTo-Json` 里的 `|` 只作用于 B，
     *    于是 ConvertTo-Json 变成独立语句、Select-Object 退回表格输出，
     *    解析必然失败（实测表现为「检测不到任何进程」）。
     *
     * 失败一律吞掉 —— 列不出进程也不能让打包本身挂掉。
     */
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      `Get-Process | Where-Object { $_.ProcessName -like '*${APP_NAME}*' -or $_.ProcessName -eq 'electron' } | Select-Object Id,ProcessName | ConvertTo-Json -Compress`,
    ].join('\n')
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    }).trim()
    if (!out) return []
    const parsed = JSON.parse(out)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.map((r) => ({ pid: r.Id, name: r.ProcessName }))
  } catch {
    return []
  }
}

removeOutDir(OUT_DIR)
for (const dir of [RELEASE, WORK_DIR, DIST_DIR]) mkdirSync(dir, { recursive: true })

/*
 * 清掉历史遗留的启动器和杂物。
 * 早期版本会生成 创建桌面快捷方式.vbs / 启动.bat，现在只保留 exe 一个入口，
 * 不删的话旧文件会一直留在 release 里，用户不知道该点哪个。
 */
for (const stale of ['创建桌面快捷方式.vbs', '启动.bat', 'debug.log']) {
  rmSync(join(RELEASE, stale), { force: true })
}

/*
 * Electron 打包会在临时目录里 patch 运行时再 rename 一次。
 * 本机 TEMP 指向网络盘（Z:\TEMP），rename 会 EPERM，必须落到本地磁盘。
 */
const LOCAL_TEMP = join(process.env.LOCALAPPDATA ?? process.env.USERPROFILE ?? '.', 'Temp', 'deskbuild')
mkdirSync(LOCAL_TEMP, { recursive: true })
process.env.TEMP = LOCAL_TEMP
process.env.TMP = LOCAL_TEMP

/* ---------- 3. 打包 ---------- */
console.log('\n[3/5] 打包 Electron 应用...')

/*
 * 复用已下载的 Electron 运行时 zip，绕开局域网不稳导致的重新下载。
 * @electron/get 的缓存布局是 <cacheRoot>/<urlHash>/electron-v<ver>-<platform>-<arch>.zip，
 * 这里按版本号把对应目录找出来，直接把 cacheRoot 指到那个 hash 目录。
 */
function findElectronCache() {
  const base = process.env.ELECTRON_CACHE || join(process.env.LOCALAPPDATA ?? '', 'electron', 'Cache')
  if (!existsSync(base)) return null
  const wanted = `electron-v38.8.6-win32-x64.zip`
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(base, entry.name, wanted)
    if (existsSync(candidate)) return { root: base, hint: candidate }
  }
  return null
}

const cache = findElectronCache()
if (!cache) {
  console.warn('  ! 未找到 Electron 缓存 zip，将尝试联网下载（网络不通会失败）')
} else {
  console.log(`  -> 使用缓存: ${cache.hint}`)
}

/*
 * electronZipDir 指向「直接放着 electron-v<ver>-win32-x64.zip 的目录」时，
 * packager 完全跳过下载与校验和请求（本机访问 github 不稳，必须走这条路）。
 */
const zipDir = join(LOCAL_TEMP, 'electron-zip')
if (cache) {
  if (existsSync(zipDir)) rmSync(zipDir, { recursive: true, force: true })
  mkdirSync(zipDir, { recursive: true })
  cpSync(cache.hint, join(zipDir, basename(cache.hint)))
  console.log(`  -> 准备离线运行时: ${join(zipDir, basename(cache.hint))}`)
}
const zipDirOpt = cache ? { electronZipDir: zipDir } : {}

/**
 * 打包一次。
 *
 * Windows Defender 会把「刚解压出来的 electron.exe」短暂加锁，而 packager 的收尾
 * 动作正是把解压目录 rename 成最终目录，于是稳定 EPERM。对策是挂 afterExtract 钩子：
 * 解压完成后先「试 rename 到旁边再改回来」直到锁释放，再交给 packager 收尾。
 */
async function runPackager(attempt) {
  const stage = join(LOCAL_TEMP, `stage${attempt}`)
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  const out = await packager({
    dir: ROOT,
    out: stage,
    name: APP_NAME,
    platform: 'win32',
    arch: 'x64',
    overwrite: true,
    asar: true,
    prune: true,
    /*
     * tmpdir:false 跳过「mkdtemp 出 tmp-* 再把模板 rename 上去」的流程，
     * 那一步在 Windows 上是 rename 到已存在目录，会稳定报 EPERM。
     */
    tmpdir: false,
    /* exe 元数据齐全是杀软启发式的基本盘：无描述/无公司的 exe 是重点扫描对象 */
    appVersion: VERSION,
    appCopyright: `Copyright © ${new Date().getFullYear()} Yuki`,
    win32metadata: {
      FileDescription: '摸鱼桌宠 —— 桌面悬浮小挂件 + 打卡 + 摸鱼收入统计',
      CompanyName: 'Yuki',
      ProductName: APP_NAME,
    },
    afterExtract: [
      async ({ buildPath }) => {
        await waitForRenameReady(buildPath)
      },
    ],
    /*
     * ignore 必须穷尽「仓库里一切非运行时内容」。曾经只排 5 条，
     * src-tauri/（含 target/ 的 12GB Rust 构建产物）、node_modules、.tmp-yuki/
     * 调试探针和 TAURI_MIGRATION.md 等内部文档全被打进 app.asar。
     * 运行时只需要 src/ + dist/ + package.json：主进程零外部 npm 依赖
     * （只有 electron 与 node: 内建），node_modules 可整体排除——
     * 将来引入第一个生产依赖时，记得把 node_modules 那条收窄。
     */
    ignore: [
      /^\/release($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.gitignore$/,
      /^\/node_modules($|\/)/,
      /^\/src-tauri($|\/)/,
      /^\/\.tmp-yuki($|\/)/,
      /^\/\.mimosa($|\/)/,
      /^\/\.zcode($|\/)/,
      /^\/mobile($|\/)/,
      /^\/dist-mobile($|\/)/,
      /^\/resources($|\/)/,
      /^\/scripts($|\/)/,
      /^\/dist\/assets\/.*\.map$/,
      /^\/(README|AGENTS|TAURI_MIGRATION|FIX_PLAN|README_AUDIT|REVIEW_FINDINGS|AUTOSTART_PLAN|PACKAGING_PLAN)\.md$/,
      /^\/package-lock\.json$/,
    ],
    ...zipDirOpt,
  })
  return out[0]
}

/**
 * 等到目录可以被 rename 为止。
 * 做法：反复尝试 rename 到同级的临时名再改回来；能改回来说明锁已释放。
 */
async function waitForRenameReady(dirPath, maxWaitMs = 120_000) {
  const parent = dirname(dirPath)
  const probe = join(parent, `rename-probe-${Date.now()}`)
  const started = Date.now()
  let attempt = 0
  while (Date.now() - started < maxWaitMs) {
    attempt++
    try {
      await rename(dirPath, probe)
      await rename(probe, dirPath)
      if (attempt > 1) console.log(`  -> 文件锁已释放（等待 ${Math.round((Date.now() - started) / 1000)}s）`)
      return true
    } catch {
      if (attempt === 1) console.log('  -> 等待杀毒软件释放文件锁...')
      await delay(3000)
    }
  }
  console.warn('  ! 等待超时，继续尝试打包')
  return false
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

const MAX_ATTEMPTS = 4
let stagedAppDir = null
for (let attempt = 1; attempt <= MAX_ATTEMPTS && !stagedAppDir; attempt++) {
  try {
    stagedAppDir = await runPackager(attempt)
  } catch (err) {
    const isLock = err?.code === 'EPERM' || err?.code === 'EBUSY'
    if (!isLock || attempt === MAX_ATTEMPTS) throw err
    const wait = 20 * attempt
    console.log(`  ! 文件被占用（通常是杀毒软件扫描 electron.exe），${wait}s 后重试 (${attempt}/${MAX_ATTEMPTS - 1})...`)
    await new Promise((r) => setTimeout(r, wait * 1000))
  }
}
console.log(`  -> 暂存 ${stagedAppDir}`)

console.log('  -> 复制到 release/ ...')
/* OUT_DIR 已在 [2/4] 删掉且之后没有重建，这里不需要再删一次。
 * 不用 cpSync：实测本机对「含 200MB 未签名 exe 的整树」跑 cpSync 会被
 * 实时防护直接终止 node 进程（exit 9、无堆栈）；逐文件 copyFileSync
 * 反而稳定通过。逐文件还能顺带跳过被锁文件的重试逻辑。 */
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) copyTree(s, d)
    else copyFileSync(s, d)
  }
}
copyTree(stagedAppDir, OUT_DIR)
rmSync(dirname(stagedAppDir), { recursive: true, force: true })

const appDir = OUT_DIR

/* ---------- 4. 精简产物 ---------- */
console.log('\n[4/5] 整理产物...')

/* 找到可执行文件实际名字（packager 会按 name 重命名 exe） */
const exeCandidates = [join(appDir, `${APP_NAME}.exe`), join(appDir, 'electron.exe')]
const exePath = exeCandidates.find(existsSync)
if (!exePath) throw new Error(`未找到可执行文件，已查找: ${exeCandidates.join(', ')}`)

/* 使用说明放到 release 根（copyFileSync 覆盖旧版；cpSync 在本机会被实时
   防护干扰出假错误，见上方 copyTree 注释） */
copyFileSync(join(ROOT, 'scripts', 'release-readme.txt'), join(RELEASE, 'README.txt'))

/* ---------- 5. 压缩绿色版 ---------- */
console.log('\n[5/5] 压缩绿色版 zip...')
/* Compress-Archive 带 -Path <目录>（不带 \*），zip 内含 desk-pet-win-x64/
   单层文件夹，解压不散一地。暂存区保留在 .tmp-release/（installer.nsi 要从
   这里取文件），不进 release/ 交付区。 */
run('powershell', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${OUT_DIR}' -DestinationPath '${PORTABLE_ZIP}' -Force`,
])

console.log(`
========================================
 打包完成
========================================
 绿色版 zip:  ${join('electron', `desk-pet-${VERSION}-win-x64-portable.zip`)}
`)
