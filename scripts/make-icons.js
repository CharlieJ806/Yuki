/**
 * 生成 PWA 图标（用**原始素材的奶白底**，不抠透明）。
 *
 * ## 为什么不用扣好的透明立绘
 *
 * 之前是「取透明立绘 → 铺主题色底」，但绿底配她的配色很难看
 * （用户明确反馈：扣出来一个绿背景太丑了）。
 * 原始素材本身就是**奶白渐变底**，直接用它观感自然得多 ——
 * 而且省掉抠图，边缘也不会有毛边。
 *
 * ## 裁剪要点
 *
 * 1. **去掉右下角「豆包AI生成」水印**：它是浅灰描边空心字，
 *    在奶白底上很不明显，但放大后一眼能看到。
 * 2. **居中以脸为准，不是以内容 bbox 为准**：
 *    水印在右下角会把 bbox 整体拉向右下（实测偏右 223px），
 *    按 bbox 居中的话人会被推向左上。
 *    实测这张原图的脸中心 x=1008（画布中心 1024），本来就近乎居中。
 *
 * 用法: node scripts/make-icons.js
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
/*
 * 用原始素材（2048x2048、奶白底），而不是抠好的透明立绘。
 * 抠图版适合放在聊天界面（需要透明），但做图标时奶白底更好看。
 */
const SRC = join(ROOT, 'resources', 'yuki', '比心，双手比心或挥手.png')
const OUT = join(ROOT, 'mobile')

if (!existsSync(SRC)) {
  console.error(`✗ 找不到源图: ${SRC}`)
  process.exit(1)
}

/*
 * 水印区域（2048 坐标系，实测）。
 * 「豆包AI生成」是描边空心字，字心就是背景色，所以按
 * 「浅色实心像素」去扫是找不到的。
 */
const WM_REGION = '380x120+1660+1910'

/*
 * 图标取景（2048 坐标系）。
 *
 * 内容实测 y 106-1993（高 1888）—— 要**装下全身**，正方形边长至少 1900，
 * 否则会切在膝盖附近（试过 1400/1500/1600，都在小腿处切掉，很难看）。
 *
 * 水平位置对齐**脸中心**（实测 x=1008），不是内容 bbox 中心：
 * 水印在右下角会把 bbox 拉向右下 223px，按 bbox 居中她会被推向左边。
 */
const SIDE = 1900
const LEFT = Math.max(0, Math.min(2048 - SIDE, 1008 - Math.round(SIDE / 2)))
const TOP = 100

/* maskable 要留更大边距：安卓圆形遮罩的安全区只有中间 80% */
const TARGETS = [
  { size: 512, file: 'icon-512.png', pad: 0.02 },
  { size: 192, file: 'icon-192.png', pad: 0.02 },
  { size: 512, file: 'icon-maskable-512.png', pad: 0.13 },
]

mkdirSync(OUT, { recursive: true })

for (const t of TARGETS) {
  const inner = Math.round(t.size * (1 - t.pad * 2))
  /*
   * 一条 magick 完成：抹水印 → 裁剪 → 缩放 → 居中贴到画布。
   *
   * 抹水印用「区域 + 指定颜色填充」：把水印区填成背景色。
   * 不做成透明 —— 图标要保留奶白底，透明会在 PNG 里留窟窿。
   */
  execFileSync('magick', [
    SRC,
    /* 水印区填成纯白（和周围背景一致） */
    '-fill', 'white',
    '-draw', `rectangle 1660,1910 ${1660 + 380},${1910 + 120}`,
    /* 裁剪取景 */
    '-crop', `${SIDE}x${SIDE}+${LEFT}+${TOP}`,
    '+repage',
    '-resize', `${inner}x${inner}`,
    /* 底色沿用图的背景色，边缘不会有色差 */
    '-background', 'white',
    '-gravity', 'center',
    '-extent', `${t.size}x${t.size}`,
    '-strip',
    '-define', 'png:compression-level=9',
    join(OUT, t.file),
  ], { stdio: 'inherit' })

  console.log(`  ✓ ${t.file}  ${t.size}x${t.size}`)
}

console.log(`\n完成，共 ${TARGETS.length} 个图标 → ${OUT}`)
console.log('提示：这版用奶白底原图，不抠透明、不铺主题色。')
