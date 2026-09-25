/**
 * makensis 定位包装器：NSIS 安装器不把自己加进 PATH（裸调 makensis
 * 必然「不是内部或外部命令」），这里按顺序找——
 *   1. MAKENSIS 环境变量（显式指定）
 *   2. 常见安装位置（Program Files / Program Files (x86) / 用户级 Programs）
 *   3. PATH 兜底（有人手动配过）
 * 找到后统一追加 /INPUTCHARSET UTF8：脚本是无 BOM 的 UTF-8，不加这个
 * makensis 会按 ANSI 代码页读，中文 define 直接 Bad text encoding。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const candidates = [
  ...(process.env.MAKENSIS ? [process.env.MAKENSIS] : []),
  join(process.env['ProgramFiles(x86)'] ?? '', 'NSIS', 'makensis.exe'),
  join(process.env.ProgramFiles ?? '', 'NSIS', 'makensis.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'NSIS', 'makensis.exe'),
  'makensis',
]

for (const candidate of candidates) {
  if (candidate !== 'makensis' && !existsSync(candidate)) continue
  try {
    execFileSync(candidate, ['/INPUTCHARSET', 'UTF8', ...args], { stdio: 'inherit' })
    process.exit(0)
  } catch (err) {
    if (err.code === 'ENOENT') continue /* 这一路径没有 makensis，找下一处 */
    /* 找到了但编译失败：真实错误已经通过 stdio: inherit 打给用户，照常退出 */
    process.exit(err.status ?? 1)
  }
}

console.error('✗ 未找到 makensis：请安装 NSIS（winget install NSIS.NSIS），')
console.error('  或用 MAKENSIS 环境变量指定 makensis.exe 的完整路径。')
process.exit(1)
