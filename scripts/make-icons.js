/**
 * 生成 PWA 图标。
 *
 * ## 素材怎么来
 *
 * 用**切好的透明立绘**（`resources/raw-cut/yuki-<slug>.png`）铺一层奶白底，
 * 而不是直接用 `设定图*.png` —— 设定图是「立绘 + 文字说明 + 表情差集 + 三视图」
 * 的排版图，任何裁剪都会把旁边的文字带进图标。
 *
 * 为什么铺奶白底而不是透明：图标要放进各种尺寸的圆形/方形遮罩里，
 * 透明背景在浅色桌面上会看不清轮廓。奶白（#fdf6f0）取自角色原图的背景色，
 * 观感自然，也和聊天窗里的立绘一致。
 *
 * ## 取景
 *
 * `jk` 那张（设定图的常服）站姿完整、配色最接近角色主视觉，
 * 拿它当图标。立绘本身是竖长条，居中偏下摆放 —— 头顶留白多一点，
 * 圆形遮罩裁下去才不会切到脸。
 *
 * 用法: node scripts/make-icons.js
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/*
 * 图标用哪张立绘。
 *
 * ## 为什么不用全身立绘了
 *
 * 原先是 `yuki-outfit-jk`（完整站姿）。但 favicon 在浏览器标签页里
 * 只有 **16~32px**，全身立绘缩到那个尺寸后就是一根糊掉的小竖条，
 * 完全认不出是谁。
 *
 * 换成 `yuki-heart`（比心的半身）并改用**头部特写**裁法：
 * 小尺寸下脸部仍可辨认，构图也更紧凑。
 *
 * 素材取自 `src/renderer/public/` 而不是 `resources/raw-cut/` ——
 * 那里是切好的成品（已去水印、统一高度），直接用最省事，
 * 也避免 make-icons 依赖「必须先跑过切图」这条隐式顺序。
 */
const SRC = join(ROOT, 'src', 'renderer', 'public', 'yuki-heart.png')
const OUT = join(ROOT, 'mobile')

/** 底色：角色原图的奶白，不铺主题色（绿底配她的配色很丑，用户反馈过） */
const BG = '#fdf6f0'

if (!existsSync(SRC)) {
  console.error(`✗ 找不到源立绘: ${SRC}`)
  console.error('  先跑 `node scripts/split-sheet.js` 切出 `resources/raw-cut/`。')
  process.exit(1)
}

/* maskable 要留更大边距 */
const TARGETS = [
  { size: 512, file: 'icon-512.png', pad: 0 },
  { size: 192, file: 'icon-192.png', pad: 0 },
  { size: 512, file: 'icon-maskable-512.png', pad: 0.13 },
]

mkdirSync(OUT, { recursive: true })

for (const t of TARGETS) {
  const inner = Math.round(t.size * (1 - t.pad * 2))

  /*
   * 裁法：**从头往下取方形**，而不是「整张缩到画布内」。
   *
   * `-resize ${inner}x${inner}^` 的 `^` 是「填满且保持比例」
   * （较短的边也撑满），再用 `-extent` 从**北（上）对齐**裁出正方形。
   * 立绘是 132x300 的竖长条，这样裁正好落在头和肩，正是 favicon 要的。
   *
   * 原来用 `-gravity south` + 缩小整张：那适合「完整站着」的构图，
   * 但用在这类头部素材上会把脸挤到中间一条缝里。
   */
  execFileSync('magick', [
    SRC,
    '-resize', `${inner}x${inner}^`,
    '-background', BG,
    '-gravity', 'north',
    '-extent', `${inner}x${inner}`,
    '-resize', `${t.size}x${t.size}`,
    '-strip',
    '-define', 'png:compression-level=9',
    join(OUT, t.file),
  ], { stdio: 'inherit' })

  console.log(`  ✓ ${t.file}  ${t.size}x${t.size}`)
}

console.log(`\n完成，共 ${TARGETS.length} 个图标 → ${OUT}`)
console.log(`素材: src/renderer/public/yuki-heart.png（头部特写裁法），底色 ${BG}`)
