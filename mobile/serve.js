/**
 * 手机端本地预览服务器 —— 零依赖，监听局域网。
 *
 * 用途：在手机上试效果，**不用先部署**。
 * 手机和电脑连同一个 WiFi，浏览器打开 http://<电脑IP>:8899 即可。
 *
 * 为什么不用 npx serve：默认只绑 localhost，手机连不上；
 * 而且临时装的依赖过期就没了。这个文件用 Node 内置 http 写死，
 * 也顺便帮我们装上正确的 MIME（ES 模块要求 application/javascript，
 * 服务器给错类型浏览器会拒绝加载）。
 *
 * 注意：这是**开发预览**用的。正式用请把 dist-mobile/ 部署到 https 域名 ——
 * 只有 https 才能「添加到主屏幕」（Service Worker 的安全要求）。
 *
 * 用法: node mobile/serve.js [port]
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', 'dist-mobile')
const PORT = Number(process.argv[2]) || 8899

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    let path = decodeURIComponent(url.pathname)
    if (path === '/' || path.endsWith('/')) path += 'index.html'

    /* 防目录穿越：规范化后必须仍在 ROOT 内 */
    const filePath = normalize(join(ROOT, path))
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden')
      return
    }

    const s = await stat(filePath)
    if (!s.isFile()) {
      res.writeHead(404).end('not found')
      return
    }

    const body = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      /*
       * Service Worker 和缓存必须禁掉，否则改完代码手机还在跑旧的。
       * 这是本地调试最容易踩的坑 —— 明明改了却没生效。
       */
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    })
    res.end(body)
  } catch (err) {
    if (err?.code === 'ENOENT') res.writeHead(404).end('not found')
    else {
      res.writeHead(500).end('server error')
      console.error('[mobile-serve]', err?.message ?? err)
    }
  }
})

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)

  console.log(`\n手机端预览服务已启动（目录: ${ROOT}）\n`)
  console.log(`  本机:   http://localhost:${PORT}`)
  for (const ip of ips) console.log(`  手机:   http://${ip}:${PORT}   ← 手机连同一个 WiFi 打开这个`)
  console.log('\n  注意：局域网 http 无法「添加到主屏幕」（需要 https）。')
  console.log('        正式用请把 dist-mobile/ 部署到你的域名。\n')
})
