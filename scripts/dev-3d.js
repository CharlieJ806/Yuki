/**
 * 仅用于 3D 可行性验证的浏览器预览服务。
 *
 * 为什么不直接 `npm run dev`：那会拉起 Electron 桌宠窗（340x700 透明置顶、
 * 鼠标穿透），验证 3D 时需要键盘交互和滚轮，在桌宠窗里做试验很别扭。
 * 这里只跑 Vite dev server，用普通浏览器打开验证台。
 *
 *   node scripts/dev-3d.js            # 打开 http://localhost:5199/?route=pet3d
 *   node scripts/dev-3d.js --open
 */
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const server = await createServer({ configFile: join(ROOT, 'vite.config.js') })
await server.listen()

const { port } = server.config.server
const url = `http://localhost:${port}/?route=pet3d`
console.log(`[dev-3d] 验证台就绪：${url}`)
console.log('[dev-3d] 把 Meshy 导出的 .glb 直接拖进页面即可。按 Ctrl+C 退出。')

if (process.argv.includes('--open')) {
  const cmd = platform() === 'win32' ? 'cmd' : platform() === 'darwin' ? 'open' : 'xdg-open'
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url]
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await server.close()
    process.exit(0)
  })
}
