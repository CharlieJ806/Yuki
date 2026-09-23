/**
 * 开发启动器：先拉起 Vite dev server，再用 DESK_DEV_URL 启动 Electron。
 * 生产走 `npm start`（先 vite build 再 electron .）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import electron from 'electron'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const server = await createServer({ configFile: join(ROOT, 'vite.config.js') })
await server.listen()
const { port } = server.config.server
const url = `http://localhost:${port}/`
console.log(`[dev] renderer ready at ${url}`)

const child = spawn(electron, ['.'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DESK_DEV_URL: url },
})

child.on('close', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill()
  })
}
