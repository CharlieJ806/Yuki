/**
 * 用 Electron 打开手机端界面（开发预览用）。
 *
 * ## 为什么需要这个脚本
 *
 * 手机端（`dist-mobile/`）是 PWA，靠 ES module + Service Worker 跑，
 * 所以**不能用 `file://` 直接打开** —— 浏览器会以跨域为由拒绝加载
 * 模块脚本。必须先起一个 http 服务。
 *
 * 手动做要两步（`python -m http.server` + 开浏览器），而且浏览器
 * 里看到的带地址栏/标签栏，不是真实观感。这个脚本一次做完：
 *   1. 起一个本地静态服务（只服务 dist-mobile）
 *   2. 用 Electron 开一个手机尺寸的窗口指向它
 *
 * ## 用法
 *
 *   node scripts/open-mobile.js            430x900（常见手机尺寸）
 *   node scripts/open-mobile.js 390x844    自定义尺寸（iPhone 14 逻辑分辨率）
 *   node scripts/open-mobile.js --debug    额外开 CDP 调试端口（调试用）
 *
 * 发布给非开发者用的话，跑 `npm run pack:mobile` 打成 exe（双击即用）。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DIST = join(ROOT, 'dist-mobile')

/*
 * `--debug` 开 CDP（Chrome DevTools Protocol）调试端口。
 * 用途：从外部连进页面做调试（读 IndexedDB、看运行态）——
 * 那是浏览器按源隔离的数据，只能从页面内部访问。
 */
const DEBUG = process.argv.includes('--debug')
const DEBUG_PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 9333

/* 尺寸从命令行取，默认常见手机（约 iPhone 12/13 的逻辑分辨率） */
/* 跳过 -- 开头的参数，否则 `--debug` 会被当成尺寸 */
const sizeArg = process.argv.slice(2).find((a) => !a.startsWith('--') && /^\d+x\d+$/.test(a)) ?? '430x900'
const [wArg, hArg] = sizeArg.split('x')
const WIDTH = Number(wArg) || 430
const HEIGHT = Number(hArg) || 900

/**
 * 静态文件服务的 MIME 表。
 *
 * 只需要覆盖产物里实际会出现的类型 —— 少写一个（比如 manifest）
 * 会让浏览器按纯文本处理，PWA 的「添加到主屏幕」就失效。
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/*
 * 端口从 8902 起找一个能用的。
 * 写死一个端口的话，上次没关干净就会「开了窗口但白屏」——
 * 用户很难想到是端口冲突。
 */
async function pickPort(start = 8902) {
  const { createServer: probe } = await import('node:net')
  for (let p = start; p < start + 20; p++) {
    const free = await new Promise((res) => {
      const s = probe()
      s.once('error', () => res(false))
      s.once('listening', () => s.close(() => res(true)))
      s.listen(p, '127.0.0.1')
    })
    if (free) return p
  }
  throw new Error(`从 ${start} 起 20 个端口都被占了`)
}

const server = createServer(async (req, res) => {
  try {
    /*
     * 路径必须**归一化后再拼接**，否则 `..` 能读到 dist 外面 ——
     * 虽然是本机预览、风险有限，但这是基本卫生。
     */
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const rel = normalize(urlPath).replace(/^([/\\])+/, '')
    let file = join(DIST, rel || 'index.html')

    /* 目录 → 找 index.html */
    try {
      const st = await stat(file)
      if (st.isDirectory()) file = join(file, 'index.html')
    } catch {
      /* 不存在就当 404 处理（下面 readFile 会抛） */
    }

    const body = await readFile(file)
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      /* SW 必须允许跨源脚本加载的调试；其余不缓存，改完刷新即见 */
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404')
  }
})

const port = await pickPort()
await new Promise((r) => server.listen(port, '127.0.0.1', r))
const url = `http://127.0.0.1:${port}/index.html`
console.log(`静态服务已起：${url}`)
console.log(`产物目录：${DIST}`)

/*
 * 用项目自己的 electron（devDependency）。
 * 从 node 进程调 electron 的 .cmd 会比较绕，用 createRequire 解析
 * 出真正的入口脚本路径，再用 child_process 起一个独立进程。
 */
const require = createRequire(import.meta.url)
let electronPath
try {
  electronPath = require('electron')
} catch {
  console.error('找不到 electron —— 先跑 `npm install`')
  server.close()
  process.exit(1)
}

const { spawn } = await import('node:child_process')
const launcher = join(ROOT, '.tmp-open-mobile.cjs')
const { writeFile } = await import('node:fs/promises')
await writeFile(
  launcher,
  `const { app, BrowserWindow } = require('electron')
${DEBUG ? `app.commandLine.appendSwitch('remote-debugging-port', '${DEBUG_PORT}')` : ''}
app.whenReady().then(() => {
  const w = new BrowserWindow({
    width: ${WIDTH},
    height: ${HEIGHT},
    title: 'desk · 手机端预览',
    autoHideMenuBar: true,
  })
  w.loadURL(${JSON.stringify(url)})
})
app.on('window-all-closed', () => app.quit())
`,
  'utf8',
)

console.log(`Electron 窗口 ${WIDTH}x${HEIGHT} 启动中…`)
if (DEBUG) console.log(`调试端口已开：http://127.0.0.1:${DEBUG_PORT}`)
const child = spawn(electronPath, [launcher], { stdio: 'inherit', cwd: ROOT })

child.on('exit', async () => {
  const { unlink } = await import('node:fs/promises')
  await unlink(launcher).catch(() => {})
  server.close()
  console.log('窗口已关闭，预览结束。')
  process.exit(0)
})
