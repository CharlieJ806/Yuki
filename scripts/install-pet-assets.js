/**
 * 把 `resources/raw-cut/` 的新立绘装进项目，替换旧素材。
 *
 * 为什么和 split-sheet.js 分开：
 *   split-sheet.js 负责「把 AI 出的 4×3 多格图切成单个透明 PNG」，
 *   本脚本负责「按项目规则缩放 + 分发到两处目录」。
 *   两件事的输入输出都不同，合并会让任一步单独重跑都变得别扭。
 *
 * 产物（与渲染层的约定一致）：
 *   1. resources/pet/yuki-<slug>.png   母版，高 300，PNG 压到 220 色
 *   2. src/renderer/public/yuki-<slug>.png  同一张（渲染层直接吃）
 *   3. resources/pet/manifest.json      清单，含 source/size/kind
 *   4. src/renderer/public/photos/yuki-photo-<slug>.png  自拍照片（横向，宽 720）
 *
 * ## 自拍照片为什么也在这里装
 *
 * 「解锁装扮时她发来一张照片」需要每个 slug 都有对应照片，
 * 与立绘**一一对应**。分开两个脚本会出现「立绘装了但照片忘了装」，
 * 表现为解锁弹窗里图片 404 —— 而这类遗漏只有真跑一遍才发现。
 * 放同一个脚本里，`--dry` 一次就能看到两侧是否齐全。
 *
 * 用法：
 *   node scripts/install-pet-assets.js            正式安装
 *   node scripts/install-pet-assets.js --dry      只报告不写盘
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'resources', 'raw-cut')
const PET = join(ROOT, 'resources', 'pet')
const WEB = join(ROOT, 'src', 'renderer', 'public')
const TMP = join(ROOT, '.tmp-install')

const DRY = process.argv.includes('--dry')

/** 动作类 slug：这些不带 outfit- 前缀 */
const ACTIONS = new Set([
  'angry', 'clap', 'coffee', 'cry', 'heart', 'jump', 'laugh', 'music',
  'nod', 'pose1', 'pose2', 'pose3', 'pose4', 'read', 'shrug', 'shy',
  'sleep', 'snack', 'stretch', 'surprise', 'think', 'thumbsup', 'wave', 'yawn',
])

/**
 * 头像取哪一张。
 *
 * 换过一轮：原先用 `heart`（比心），但它和 favicon 撞了构图 ——
 * 顶栏头像和浏览器标签图标长得一样，看着像重复。
 * 现在头像用 `pose2`（笑着的正面），favicon 留 `heart` 的比心。
 */
const AVATAR_SLUG = 'pose2'
const AVATAR_SIDE = 128

/**
 * 自拍照片源目录（由 `gen-photos.js` 生成、`split-sheet.js` 切出）。
 * 与立绘同用一个切图输出目录 —— 文件名前缀不同（`yuki-photo-`），不会混。
 */
const PHOTO_PREFIX = 'yuki-photo-'
/**
 * 照片导出尺寸。
 *
 * 显示端最大 210px（手机）/ 240px（桌面），2x 屏要 420~480px。
 * 竖图 3:4、横图 4:3，**按长边统一缩**才能保证两种方向都够清晰：
 *   - 竖图长边是高 → 传高度
 *   - 横图长边是宽 → 传宽度
 * 这里用 ImageMagick 的 `>`（只缩不放）配合长边 640：
 * 源图长边 512，640 不会放大，实际保持原尺寸。
 */
const PHOTO_LONG_SIDE = 640

/** ImageMagick 封装；没有 magick 就退回 convert */
function im(args) {
  const bin = process.platform === 'win32' ? 'magick' : 'magick'
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error('需要 ImageMagick（magick 命令）。Windows 装法：winget install ImageMagick.ImageMagick')
    }
    throw e
  }
}

function hasMagick() {
  try {
    execFileSync('magick', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function main() {
  if (!existsSync(SRC)) {
    console.error(`找不到切图结果目录：${SRC}`)
    console.error('先运行 split-sheet.js 把 4 张多格图切成 PNG。')
    process.exit(1)
  }
  if (!hasMagick()) {
    console.error('未找到 ImageMagick 的 magick 命令。')
    console.error('Windows: winget install ImageMagick.ImageMagick')
    process.exit(1)
  }

  /*
   * 只取立绘，**排除照片**（`yuki-photo-*`）。
   * 照片和立绘共用同一个切图输出目录，正则若不排除照片，
   * 它们会被当成「名叫 photo-jk 的服饰」，manifest 里多出一堆脏条目。
   */
  const files = readdirSync(SRC)
    .filter((f) => /^yuki-[a-z0-9-]+\.png$/.test(f) && !f.startsWith(PHOTO_PREFIX))
    .sort()
  if (!files.length) {
    console.error(`${SRC} 里没有 yuki-*.png`)
    process.exit(1)
  }

  /* slug -> 源文件 */
  const items = files.map((f) => {
    const slug = f.replace(/^yuki-/, '').replace(/\.png$/, '')
    return { slug, file: f, src: join(SRC, f), kind: ACTIONS.has(slug) ? 'action' : 'outfit' }
  })

  /* 未登记的动作 slug 直接中止 —— 静默丢弃正是上次出问题的原因 */
  const unmapped = items.filter((it) => it.kind === 'action' && !ACTIONS.has(it.slug))
  if (unmapped.length) {
    console.error('以下 slug 未在 ACTIONS 里登记：')
    unmapped.forEach((it) => console.error('  ' + it.slug))
    process.exit(1)
  }

  console.log(`找到 ${items.length} 张：${items.filter((i) => i.kind === 'action').length} 动作 / ${items.filter((i) => i.kind === 'outfit').length} 服饰`)
  console.log(DRY ? '（--dry：不写盘）\n' : '')

  if (!DRY) {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    mkdirSync(PET, { recursive: true })
    mkdirSync(WEB, { recursive: true })
    /*
     * 清掉旧立绘，避免被移除的 slug（casual/homewear/…）留下孤儿文件。
     *
     * 只清 `WEB`（运行期真正读的那份）—— `resources/pet/` 只放
     * `manifest.json`（见下面写文件处），不放图了。
     */
    for (const dir of [WEB]) {
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) {
        if (/^yuki-[a-z0-9-]+\.png$/.test(f)) rmSync(join(dir, f))
      }
    }
    /*
     * 顺手清掉 `resources/pet/` 下可能残留的旧图。
     * 防止升级前跑过旧版脚本的人留着 48 张无人读的重复文件。
     */
    if (existsSync(PET)) {
      for (const f of readdirSync(PET)) {
        if (/^yuki-[a-z0-9-]+\.png$/.test(f)) rmSync(join(PET, f))
      }
    }
  }

  const manifest = {}
  const rows = []

  for (const it of items) {
    const tmp = join(TMP, `${it.slug}.png`)
    if (!DRY) {
      /*
       * 统一缩到高 300、PNG 压到 220 色。
       * 渲染层按 300 高排版，尺寸不一致会导致立绘跳动，
       * 所以这个高度是约定值，改之前先确认 UI 侧。
       */
      im([it.src, '-resize', 'x300', '-strip', '-define', 'png:compression-level=9', '-colors', '220', tmp])
      /*
       * **只写 WEB**（`src/renderer/public/`）—— 那是渲染层真正读的。
       *
       * 早先还往 `resources/pet/` 复制一份「母版」，但全库没有任何
       * 运行期代码读它（曾误以为它是母版存档，实际就是同一张图的
       * 第二个副本，48 张逐字节相同）。留着只会让人以为改这边生效。
       */
      copyFileSync(tmp, join(WEB, `yuki-${it.slug}.png`))
      const dims = im(['identify', '-format', '%wx%h', tmp]).trim()
      manifest[it.slug] = { source: it.file, size: dims, bg: 'none', kind: it.kind }
      rows.push({ slug: it.slug, dims, kind: it.kind })

      /* 头像：从 AVATAR_SLUG 那张裁 128x128 */
      if (it.slug === AVATAR_SLUG) {
        const avatar = join(WEB, 'yuki-avatar.png')
        im([tmp, '-resize', `${AVATAR_SIDE}x${AVATAR_SIDE}^`, '-gravity', 'north',
          '-extent', `${AVATAR_SIDE}x${AVATAR_SIDE}`, '-strip', avatar])
      }
    } else {
      rows.push({ slug: it.slug, dims: '(dry)', kind: it.kind })
    }
  }

  if (!DRY) {
    writeFileSync(join(PET, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    rmSync(TMP, { recursive: true, force: true })
  }

  /* 角色设定图（高中 / 大学）—— 不是轮换素材，单独走一条路 */
  installProfileSheets(rows)

  /* 自拍照片 —— 每套装扮一张，解锁时展示 */
  installPhotos(rows)

  console.log('产物（resources/pet/ 与 src/renderer/public/）:')
  for (const r of rows) {
    console.log(`  yuki-${r.slug.padEnd(24)} ${r.dims.padEnd(9)} ${r.kind}`)
  }
  console.log(`\n完成，共 ${rows.length} 张${DRY ? '（未写盘）' : ''}。`)
}

/**
 * 装自拍照片。
 *
 * 一套装扮对应一张照片，`slug` 必须能对上 `OUTFITS` ——
 * 解锁时前端按 `photos/yuki-photo-<slug>.png` 取图，
 * 缺哪张就在弹窗里显示空图（用户看不到「她发来的照片」）。
 *
 * 所以这里**双向校验**：
 *   - 切图目录里有多余的照片（slug 不在 OUTFITS 里）→ 报出来
 *   - OUTFITS 里的 slug 缺照片 → 也报出来（但不中止：
 *     照片可以分批生成，缺的会退化成用立绘兜底）
 *
 * 尺寸：源图是 512 见方的格子，缩到 720 宽 ——
 * 电话屏幕上弹窗最大也就 400dp 宽，720 足够 2x 清晰度，
 * 再大只是白占体积（一张 1MB+ 的自拍没必要）。
 */
function installPhotos(rows) {
  const OUT_PHOTOS = join(WEB, 'photos')
  const RES_PHOTOS = join(ROOT, 'resources', 'photos')

  const all = existsSync(SRC)
    ? readdirSync(SRC).filter((f) => f.startsWith(PHOTO_PREFIX) && f.endsWith('.png')).sort()
    : []

  if (!all.length) {
    console.log('\n（没有照片：切图目录里找不到 yuki-photo-*.png）')
    return
  }

  /*
   * 切图产物分两类：
   *   - `yuki-photo-<slug>.png`  某套装扮的自拍 —— 解锁时展示
   *   - `yuki-photo-scene-N.png` 空镜（4×4 网格多出来的格子）——
   *     不绑装扮，日后可当聊天背景
   *
   * 分开处理，否则空镜会被当成「名叫 scene-1 的装扮」，
   * 在缺照片清单里刷一堆噪音。
   */
  /*
   * 两类非装扮照片：
   *   - `scene-N`  早先的空镜命名
   *   - `free-N`   不指定服装的自由穿搭格
   * 它们不绑装扮，不该进「缺照片清单」，否则永远报缺 8 套。
   */
  const isExtra = (slug) => /^(scene|free)-\d+$/.test(slug)
  /*
   * 一套装扮可以有多张照片：`<slug>.png`（第 1 张）、`<slug>-2.png`…
   * 比较「缺哪些装扮」时要用**去掉序号的基础名**，
   * 否则 `jk-2` 会被当成一套叫「jk-2」的装扮，报缺。
   */
  const baseSlug = (slug) => (/^(scene|free)-\d+$/.test(slug) ? slug : slug.replace(/-\d+$/, ''))
  const found = []
  const scenes = []

  for (const f of all) {
    const slug = f.replace(PHOTO_PREFIX, '').replace(/\.png$/, '')
    ;(isExtra(slug) ? scenes : found).push(baseSlug(slug))
    if (DRY) continue
    mkdirSync(RES_PHOTOS, { recursive: true })
    mkdirSync(OUT_PHOTOS, { recursive: true })
    const outName = `yuki-photo-${slug}.png`
    copyFileSync(join(SRC, f), join(RES_PHOTOS, outName))
    im([
      join(SRC, f),
      /* 长边缩到 640（`>` 保证不放大）：竖横两种比例都覆盖 */
      '-resize', `${PHOTO_LONG_SIDE}x${PHOTO_LONG_SIDE}>`,
      '-strip',
      '-define', 'png:compression-level=9',
      '-colors', '220',
      join(OUT_PHOTOS, outName),
    ])
  }

  console.log(`\n照片 ${found.length + scenes.length} 张 -> src/renderer/public/photos/`)
  const uniqFound = [...new Set(found)]
  console.log(`  装扮照片 ${uniqFound.length} 套：${uniqFound.join(', ')}`)
  if (scenes.length) console.log(`  自由穿搭 ${scenes.length} 张：${scenes.join(', ')}`)

  /*
   * 缺哪套会退化成立绘，点名出来便于补齐。
   * 注意 `rows` 里的 slug 来自文件名（带 `outfit-` 前缀），
   * 而照片 slug 不带 —— 比较前要剥掉，否则永远对不上、24 套全被报缺。
   */
  const outfitSlugs = rows
    .filter((r) => r.kind === 'outfit')
    .map((r) => r.slug.replace(/^outfit-/, ''))
  const lack = outfitSlugs.filter((s) => !uniqFound.includes(s))
  if (lack.length) {
    console.log(`  ⚠ ${lack.length} 套装扮还没有照片（解锁时会用立绘兜底）：`)
    console.log(`    ${lack.join(', ')}`)
  }
}

/**
 * 装角色设定图。
 *
 * 与立绘不同：这两张是**给人看的资料图**（高中 / 大学两个阶段的完整设定），
 * 不参与动作/服饰轮换，所以不缩到 300 高，而是压到 700px、200 色 ——
 * 细节（校徽、发饰、三视图）要看得清，但没必要留 1.2MB 的原图。
 */
function installProfileSheets(rows) {
  const PAIRS = [
    { from: '设定图1.png', to: 'yuki-profile-1-highschool.png' },
    { from: '设定图2.png', to: 'yuki-profile-2-university.png' },
  ]
  const SRC_NEW = join(ROOT, 'resources', 'yuki-new')
  const RES_CHAR = join(ROOT, 'resources', 'character')
  const PUB_CHAR = join(WEB, 'character')

  const found = []
  for (const p of PAIRS) {
    const src = join(SRC_NEW, p.from)
    if (!existsSync(src)) continue
    found.push(p)
    if (!DRY) {
      mkdirSync(RES_CHAR, { recursive: true })
      mkdirSync(PUB_CHAR, { recursive: true })
      /* 母版留原图，UI 用压缩版 */
      copyFileSync(src, join(RES_CHAR, p.to))
      im([src, '-resize', '700x700', '-strip', '-define', 'png:compression-level=9', '-colors', '200', join(PUB_CHAR, p.to)])
    }
  }
  if (found.length) {
    console.log(`\n角色设定图 ${found.length} 张 -> src/renderer/public/character/`)
    found.forEach((p) => console.log(`  ${p.to}  <-  ${p.from}`))
  }
}

main()
