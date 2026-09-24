/**
 * 打包「手机端启动器」—— 一个双击即用的 exe。
 *
 * ## 它做什么
 *
 * 双击后：起本地静态服务 → 开一个手机尺寸的窗口加载 `dist-mobile/`。
 * 就是把 `scripts/open-mobile.js` 包成 exe，省掉「先 npm run mobile」。
 *
 * ## 为什么不是把 dist-mobile 塞进 asar
 *
 * 手机端产物（35MB，含视频和照片）**必须留在磁盘上外置** ——
 * 打进 asar 后 `file://` 无法直接服务 PWA 的 ES module 与 Service Worker，
 * 所以启动器仍是「起 http 服务 + 开窗口」的模式，
 * 只是把这一步藏进 exe，用户不用碰命令行。
 *
 * ## 产物
 *
 *   release/mobile-launcher-win32-x64/手机端启动器.exe
 *
 * 首次运行会在 exe 同级目录找 `dist-mobile/`；找不到就提示先构建。
 * 也可以直接把这个目录连同 `dist-mobile/` 一起拷给别人。
 */
import { packager } from '@electron/packager'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'release')
const STAGE = join(ROOT, '.tmp-launcher')

/* 启动器只需一个极小的 main 进程，不依赖 Electron 之外的任何包 */
const MAIN_SRC = `const { app, BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { readFile, stat } = require('node:fs/promises')
const { extname, join, normalize } = require('node:path')
const { existsSync } = require('node:fs')

/*
 * 手机端产物位置。
 *
 * 优先找 exe 同级目录（发行版：用户把 dist-mobile 和 exe 放一起），
 * 再找上级目录（开发时：exe 在 release/xxx/ 下，产物在项目根的 dist-mobile/）。
 */
function findDist() {
  const candidates = [
    join(process.resourcesPath, '..', 'dist-mobile'),
    join(app.getAppPath(), '..', 'dist-mobile'),
    join(app.getAppPath(), '..', '..', 'dist-mobile'),
    process.cwd() + '/dist-mobile',
  ]
  return candidates.find((p) => existsSync(join(p, 'index.html'))) || null
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

app.whenReady().then(async () => {
  const dist = findDist()
  if (!dist) {
    const { dialog } = require('electron')
    dialog.showErrorBox(
      '找不到手机端产物',
      '请先把 dist-mobile/ 放在本程序同级目录，\\n或在项目里跑一次：npm run mobile',
    )
    app.quit()
    return
  }

  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      const rel = normalize(urlPath).replace(/^([/\\\\])+/, '')
      let file = join(dist, rel || 'index.html')
      try {
        const st = await stat(file)
        if (st.isDirectory()) file = join(file, 'index.html')
      } catch {}
      const body = await readFile(file)
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      res.end(body)
    } catch {
      res.writeHead(404); res.end('404')
    }
  })

  /* 端口冲突就往上找 —— 写死会在上次没关干净时白屏 */
  const { createServer: probe } = require('node:net')
  let port = 0
  for (let p = 8902; p < 8922; p++) {
    const free = await new Promise((r) => {
      const s = probe()
      s.once('error', () => r(false))
      s.once('listening', () => s.close(() => r(true)))
      s.listen(p, '127.0.0.1')
    })
    if (free) { port = p; break }
  }
  if (!port) {
    const { dialog } = require('electron')
    dialog.showErrorBox('启动失败', '8902~8921 端口都被占用了')
    app.quit()
    return
  }
  await new Promise((r) => server.listen(port, '127.0.0.1', r))

  const w = new BrowserWindow({
    width: 430,
    height: 900,
    title: 'desk · 手机端',
    autoHideMenuBar: true,
  })
  w.loadURL('http://127.0.0.1:' + port + '/index.html')
})

app.on('window-all-closed', () => app.quit())
`

/* ---------- 执行 ---------- */

if (!existsSync(join(ROOT, 'dist-mobile', 'index.html'))) {
  console.error('缺少 dist-mobile/ —— 先跑：npm run mobile')
  process.exit(1)
}

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })

writeFileSync(
  join(STAGE, 'package.json'),
  JSON.stringify({ name: 'desk-mobile-launcher', version: '1.0.0', main: 'main.cjs' }, null, 2),
)
writeFileSync(join(STAGE, 'main.cjs'), MAIN_SRC)

console.log('打包「手机端启动器」…')
await packager({
  dir: STAGE,
  out: OUT,
  name: '手机端启动器',
  platform: 'win32',
  arch: 'x64',
  asar: true,
  overwrite: true,
  prune: true,
  ignore: [/^\/\.gitignore$/],
})

/*
 * 把产物一并放进发行目录 —— 用户拷一个文件夹就能用，
 * 不用自己去别处找 dist-mobile。
 */
const outDir = join(OUT, '手机端启动器-win32-x64')
const distSrc = join(ROOT, 'dist-mobile')
const distDst = join(outDir, 'dist-mobile')
if (existsSync(outDir)) {
  rmSync(distDst, { recursive: true, force: true })
  console.log('复制 dist-mobile/ 到发行目录…')
  const { cpSync } = await import('node:fs')
  cpSync(distSrc, distDst, { recursive: true })
}

rmSync(STAGE, { recursive: true, force: true })

console.log('\n========================================')
console.log(' 打包完成')
console.log('========================================')
console.log(' 双击运行:  手机端启动器-win32-x64\\手机端启动器.exe')
console.log(' （dist-mobile/ 已一并放进该目录，整个文件夹拷走即可用）')
