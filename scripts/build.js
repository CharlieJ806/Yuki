/**
 * 打包脚本 —— 产出可双击运行的 Electron 绿色版。
 *
 * 流程：vite build（渲染层）→ @electron/packager（Electron 运行时 + 源码）
 *      → 复制到交付区 → 压缩 zip
 *
 * 用法: node scripts/build.js
 *
 * ## 产物（两种形态，同一次打包的同一份内容）
 *
 *   release/摸鱼桌宠-win32-x64/摸鱼桌宠.exe      散装目录 —— **双击即用**
 *   release/electron/desk-pet-electron-<版本>-win-x64-portable.zip   分发用压缩包
 *
 * 散装目录是主要交付形态（拿到就能跑，不必先解压）；zip 给需要分发/传输的场合。
 * 两者都在交付区，用户按需取用。
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
/* 运行时版本从实装包读，不硬编码 —— 硬编码过的文件名在依赖声明升级后
   静默 miss，缓存查找失效回退联网下载（网络不通直接挂） */
const ELECTRON_VERSION = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version
/*
 * OUT_DIR 是**打包暂存区**（`.tmp-release/`，gitignored，在 release/ 之外）。
 *
 * 为什么暂存区不放 release/ 里：pack:installer 链里 makensis 要从这里
 * 读文件，而 build.js 先跑且会重写交付目录；放在 release/ 内会出现
 * 「边交付边消失」。打包完会复制到交付区 `release/摸鱼桌宠-win32-x64/`，
 * 暂存区本身只是中间产物，可随手删除。
 */
const WORK_DIR = join(ROOT, '.tmp-release')
const OUT_DIR = join(WORK_DIR, 'desk-pet-win-x64')
const DIST_DIR = join(RELEASE, 'electron')
const PORTABLE_ZIP = join(DIST_DIR, `desk-pet-electron-${VERSION}-win-x64-portable.zip`)

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
 * 清掉**已废弃的旧产物**。
 *
 * 交付区里同时提供三种形态：
 *   - `摸鱼桌宠-win32-x64/`  散装目录，双击 `摸鱼桌宠.exe` 即用（最直接）
 *   - `electron/*.zip`       绿色版压缩包（分发用，体积小）
 *   - `electron/*setup.exe`  安装器（pack:installer 产出）
 * 外加 `README.txt`（使用说明）与 `tauri/`（Tauri 侧由 collect-release 归集）。
 *
 * 这里只删**确定已被取代**的东西：
 *   - `使用说明.txt`  旧的文件名，内容与 `README.txt` 相同且已停更
 *     （CI 也只上传 README.txt）；留两个名字会让人以为版本不同。
 *   - `手机端启动器-win32-x64/`  已移到项目根的 `release-mobile/`
 *     （它是本地便利产物，不随 Release 上传，混在交付区会让
 *     「该发哪些文件」变含糊）。
 *
 * 用**明确名单**而不是白名单：白名单要求穷举「所有合法产物」，
 * 一改布局就会把当前正在用的产物误删 —— 这正是上一版踩的坑
 * （它把散装目录当成「旧布局」清掉了，而那恰是最常用的双击入口）。
 */
for (const stale of ['使用说明.txt', '手机端启动器-win32-x64']) {
  const p = join(RELEASE, stale)
  if (!existsSync(p)) continue
  /* 走 removeOutDir：这两个都在交付区里，程序没退干净时会被锁住 */
  removeOutDir(p)
  console.log(`  -> 清掉已废弃产物: ${stale}`)
}

/*
 * 清掉旧版本的归集产物（release/electron/）：release.yml 按
 * release/electron/* 全量上传，旧版 zip/setup 混在里面会被当成
 * 新版本一起发布。
 */
for (const f of readdirSync(DIST_DIR)) {
  if (f.startsWith('desk-pet-') && !f.includes(`-${VERSION}-`) && !f.includes(`-${VERSION}.`)) {
    rmSync(join(DIST_DIR, f), { force: true })
    console.log(`  -> 清理旧版产物: ${f}`)
  }
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
  const wanted = `electron-v${ELECTRON_VERSION}-win32-x64.zip`
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
      /*
       * `release-mobile/` 必须单独列 —— `^\/release($|\/)` 的锚点紧跟在
       * `release` 之后，**匹配不到 `release-mobile`**。
       *
       * 踩过：重构打包脚本时新增了这个顶级产物目录，只加进了 .gitignore，
       * 漏了这里。后果是手机端启动器（200MB）整个被塞进 app.asar ——
       * asar 从 44.8MB 涨到 369.8MB，绿色版 zip 从 174MB 涨到 305MB，
       * 而**打包过程一声不吭**（packager 的 ignore 漏配不会报错）。
       *
       * 顺带说明为什么这类漏配很隐蔽：产物目录平时是空的或不存在，
       * 本地连打几次都正常；只有「刚跑过 pack:mobile 再跑 pack」才会暴露。
       */
      /^\/release-mobile($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.gitignore$/,
      /^\/node_modules($|\/)/,
      /^\/src-tauri($|\/)/,
      /*
       * 临时/工作目录一律不进产物。
       *
       * 原来逐个列名单（`.tmp-yuki` / `.mimosa` / `.zcode`），
       * 于是每新增一个临时文件都要记得回来加一条 —— 必然漏。
       * 实测漏过 `.tmp-open-mobile.cjs` 与 `.tmp-release/`（打包暂存目录，
       * 里面还嵌着上一轮的 asar），两个都被打进了交付产物。
       * 改成按前缀兜住：`^/\.` 已排除 .git/.gitignore，
       * 其余点开头的一律视为本地工作产物。
       */
      /^\/\./,
      /^\/mobile($|\/)/,
      /^\/dist-mobile($|\/)/,
      /^\/resources($|\/)/,
      /^\/scripts($|\/)/,
      /*
       * 设计文档不进产物 —— 它随仓库分发（给人看），不必塞进 exe。
       * 早先 README 在仓库根，靠下面那条正则排除；现在推理移到了
       * `docs/DESIGN.md`，必须一并排除，否则 1.5MB 文档白占体积。
       */
      /^\/docs($|\/)/,
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

/*
 * fuse 加固：关掉 RunAsNode / 命令行 inspect / NODE_OPTIONS。
 * DESK_DEBUG_PORT 门控只管「应用自己开的调试口」，挡不住外部拿
 * `--remote-debugging-port` 或 ELECTRON_RUN_AS_NODE=1 直接启动 exe ——
 * 后者等价于把渲染层交给任意本地进程（CDP 一开即全权控制）。
 * 打包即加固：这里失败就终止，不允许未加固的产物悄悄出包。
 */
console.log('\n[4/5b] 翻转 Electron fuses...')
{
  const { flipFuses, FuseV1Options, FuseVersion } = await import('@electron/fuses')
  await flipFuses(exePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  })
  console.log(`  -> fuses 已加固: ${exePath}`)
}

/* 使用说明放到 release 根（copyFileSync 覆盖旧版；cpSync 在本机会被实时
   防护干扰出假错误，见上方 copyTree 注释） */
copyFileSync(join(ROOT, 'scripts', 'release-readme.txt'), join(RELEASE, 'README.txt'))

/*
 * 把暂存区复制到交付区 —— **散装目录是主要交付形态**：
 * 解压好的目录直接放 `release/摸鱼桌宠-win32-x64/`，双击 `摸鱼桌宠.exe` 就跑，
 * 不需要先解压。zip 是「分发用」的压缩版，两者并存。
 *
 * 顺序：先复制，再压缩。压缩读的是交付区的目录（热数据已在页缓存里，
 * 比重读暂存区快），而且复制完就可以把暂存区留到 pack:installer 用。
 */
const DELIVER_APP_DIR = join(RELEASE, `${APP_NAME}-win32-x64`)
console.log(`  -> 复制到交付区: ${APP_NAME}-win32-x64/`)
/*
 * 必须走 removeOutDir，不能裸 rmSync。
 *
 * 这一步删的是**程序自己正在跑的那个目录** —— 用户多半是刚双击了上一版
 * exe 来试功能，进程还活着，exe/asar 就被锁着，裸 rmSync 抛的是
 * 一坨带乱码的原始 EPERM 堆栈（路径里的中文按控制台代码页打印，更没法看），
 * 完全看不出「你得先退出程序」。
 * removeOutDir 才会把它翻译成人话并列出占用进程的 PID。
 */
removeOutDir(DELIVER_APP_DIR)
copyTree(OUT_DIR, DELIVER_APP_DIR)
const deliveredExe = join(DELIVER_APP_DIR, basename(exePath))
if (!existsSync(deliveredExe)) {
  throw new Error(`交付区缺少可执行文件: ${deliveredExe}`)
}
console.log(`  -> 双击即用: ${join(`${APP_NAME}-win32-x64`, basename(deliveredExe))}`)

/* ---------- 5. 压缩绿色版 ---------- */
console.log('\n[5/5] 压缩绿色版 zip...')
/*
 * Compress-Archive 带 -Path <目录>（不带 \*），zip 内含 desk-pet-win-x64/
 * 单层文件夹，解压不散一地。暂存区保留在 .tmp-release/（installer.nsi 要从
 * 这里取文件），不进 release/ 交付区。
 *
 * ## 为什么要重试 + 校验
 *
 * 本机实时防护会锁住刚写盘的未签名 exe/dll，`Compress-Archive` 遇到
 * 「文件被占用」时报 `PermissionDenied`（实测 `vulkan-1.dll`），
 * **但它仍然退出码 0** —— 于是脚本一路打印「打包完成」，
 * 交付区里却是个空目录 / 半个 zip。这种「报成功实则啥也没有」
 * 比直接失败危险得多：CI 会照常上传一个坏包。
 *
 * 所以这里两件事缺一不可：
 *   ① 失败重试（给防护扫描留时间，与上面等文件锁同一个套路）
 *   ② **校验产物真的存在且非空** —— 不信任 ExitCode
 */
const zipStep = () => {
  /* 先删干净：半成品 zip 会让下面的体积校验误判为成功 */
  rmSync(PORTABLE_ZIP, { force: true })
  try {
    /* 从**交付区**压缩，保证 zip 内容与散装目录逐字节一致
       （两者都来自同一次打包，不存在「zip 是旧的」这种坑） */
    run('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${DELIVER_APP_DIR}' -DestinationPath '${PORTABLE_ZIP}' -Force -ErrorAction Stop`,
    ])
  } catch (e) {
    /* -ErrorAction Stop 让它变成非零退出，从而被 execFileSync 抛出 */
    console.warn(`  ! zip 失败（${e.message.split('\n')[0]}），将重试`)
  }
  if (!existsSync(PORTABLE_ZIP)) return 0
  return readFileSync(PORTABLE_ZIP).length
}

const MIN_ZIP_BYTES = 10 * 1024 * 1024 /* 绿色版实测 ~180MB，10MB 只是「明显不对劲」的下限 */
let zipBytes = 0
for (let attempt = 1; attempt <= 3 && zipBytes < MIN_ZIP_BYTES; attempt++) {
  if (attempt > 1) {
    console.log(`  -> 第 ${attempt} 次尝试压缩…`)
    await delay(3000)
  }
  zipBytes = zipStep()
  if (zipBytes > 0 && zipBytes < MIN_ZIP_BYTES) {
    console.warn(`  ! zip 只有 ${(zipBytes / 1048576).toFixed(1)}MB，明显偏小`)
  }
}
if (zipBytes < MIN_ZIP_BYTES) {
  throw new Error(
    `绿色版 zip 压缩失败（产物 ${zipBytes} 字节，期望 ≥ ${MIN_ZIP_BYTES / 1048576}MB）。\n` +
      `  最常见原因：实时防护锁住刚写盘的 exe/dll。可先把项目目录加入排除项再重试。`,
  )
}
console.log(`  -> zip 就绪 ${(zipBytes / 1048576).toFixed(1)}MB`)

console.log(`
========================================
 打包完成
========================================
 双击即用:   ${APP_NAME}-win32-x64\\${APP_NAME}.exe
 绿色版 zip: ${join('electron', `desk-pet-electron-${VERSION}-win-x64-portable.zip`)}
`)
