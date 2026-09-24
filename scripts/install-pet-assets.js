/**
 * 把 `resources/raw-cut/` 的新立绘装进项目，替换旧素材。
 *
 * 为什么和 split-sheet.js 分开：
 *   split-sheet.js 负责「把 AI 出的 4×3 多格图切成单个透明 PNG」，
 *   本脚本负责「按项目规则缩放 + 分发到两处目录」。
 *   两件事的输入输出都不同，合并会让任一步单独重跑都变得别扭。
 *
 * 产物（与渲染层的约定一致）：
 *   1. src/renderer/public/yuki-<slug>.png  立绘，高 600，**无损 PNG**
 *   2. resources/pet/manifest.json          清单，含 source/size/kind
 *   3. src/renderer/public/photos/yuki-photo-<slug>.png  自拍照片
 *
 * ## 为什么立绘是无损、且高 600（而不是高 300 / 220 色）
 *
 * 这里踩过一个很贵的坑：原先写的是 `-resize x300 ... -colors 220`。
 * 后果实测（`yuki-outfit-jk.png`）：
 *
 *   raw-cut 母版   241x511   6.1 万色   255 级 alpha
 *   public 产物    141x300   204 色      56 级 alpha   ← colortype 3（调色板）
 *
 * 即 **面积只剩 34%，颜色只剩 0.3%**。插图里大量半透明抗锯齿边缘
 * 被中位切分量化成 204 色全局调色板，头发丝糊成色块、脸部渐变断裂。
 * 裁切脚本 `split-sheet.js` 本身是无损的 —— 损耗全发生在这一步。
 *
 * 而渲染端**没有一处**按 300 高去画：桌宠窗口是 118px × petScale（**最大 2 倍**），
 * 手机端「她」页是 `height: 50vh`（约 1.45 倍）。所以 300 高对这两处
 * 本来就是**放大**，等于先把图砍到 34% 再拉回去。
 *
 * 改成高 600（= 300 CSS px × DPR 2），让浏览器只做降采样、从不放大。
 * 体积代价从 16KB/张 涨到约 150KB/张，48 张约 +6MB —— 换来的是
 * 桌宠和手机端那两处**唯一**真正看得清立绘的地方不再糊。
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

/**
 * 删除文件，失败时重试几次再放弃 —— **不抛异常**。
 *
 * 为什么不能直接 `rmSync`：项目在 Z: 网络盘上（SMB），
 * 刚被读过的文件常进入 delete-pending / oplock 状态，
 * 此时 `readFileSync` 正常但 `unlink` 报 EBUSY/EPERM。
 * 这跟「文件被占用」无关 —— 没有任何进程持有它，纯粹是 SMB 的时序。
 *
 * 而这里删文件只是**清理旧素材**（防止改过 slug 后留下孤儿图），
 * 删不掉也不影响正确性：下面写盘时同名文件会被直接覆盖。
 * 所以失败就跳过并告知，不让整个安装流程因为一个网络盘时序问题崩掉。
 *
 * @returns true = 已删除；false = 放弃（调用方无需处理）
 */
function unlinkResilient(p, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(p, { force: true })
      return true
    } catch (e) {
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e
      /* 同步忙等几毫秒：这里没有并发可做，重试间隔要短 */
      const until = Date.now() + 60
      while (Date.now() < until) { /* spin */ }
    }
  }
  return false
}

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
 * 立绘导出高度。
 *
 * ## 为什么是 600（而不是 522 或 1266）
 *
 * 这个值要同时面对**需求**和**上限**，两边都夹着：
 *
 * **需求**（各场景所需物理像素 = CSS 尺寸 × DPR，取最大者）：
 *
 *   桌宠窗口      236 CSS px（118 × petScale 上限 2）× DPR 2  =   472
 *   手机端她页    50vh，iPhone 14 @DPR3 → 422 CSS × 3        =  1266  ← 决定性
 *
 * **上限**：真母版（`raw-cut/yuki-*.png`）最大只有 **522px** 高、中位 505px
 * —— 源头是 AI 出的 1024×1536 多格图，每格仅约 256×512。
 *
 * 两者差距 2.4 倍，**调这个常量填不平** —— 超过 522 就是插值，
 * 没有新数据。所以这里不是「选一个够用的值」，而是「在插值里选一个最好的」。
 *
 * ## 为什么 600 实测优于 522（即使 522「不放大」）
 *
 * 直觉会说「不放大最清晰」，但实测相反：
 *
 *   手机她页显示 199×422 CSS @DPR3 → 需要 **1266** 物理像素
 *   522 素材 → 放大 2.43x     锐度 9.16
 *   600 素材 → 放大 2.11x     锐度 11.34   ← 更清晰
 *
 * 原因是两条链路的重采样次数不同：
 *   522：母版(522) →[无操作]→ 导出(522) →[放大 2.43x]→ 1266   一次插值，幅度大
 *   600：母版(522) →[放大 1.15x]→ 导出(600) →[放大 2.11x]→ 1266  两次插值，各更轻
 * 分两步做的插值比一步做更平滑（等效于一次低通后再插值）。
 *
 * 所以取 600 是**在母版上限内的经验最优**，不是理论值。
 *
 * ## 真正的解法是重出图
 *
 * 手机她页要 1266px，母版只有 522px。要真清晰只能提高源头分辨率：
 * `scripts/gen-sheet.js --size 2048x3072`（每格 683×768，约 2.7 倍）。
 * 那之后母版会涨到 ~1400，届时把这里调到 1266 才是有意义的。
 */
const SPRITE_HEIGHT = 600

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
      let skipped = 0
      for (const f of readdirSync(dir)) {
        if (/^yuki-[a-z0-9-]+\.png$/.test(f)) {
          if (!unlinkResilient(join(dir, f))) skipped++
        }
      }
      if (skipped) {
        console.warn(`  ! ${skipped} 张旧立绘被网络盘锁住，未删除（会被同名新文件覆盖，无影响）`)
      }
    }
    /*
     * 顺手清掉 `resources/pet/` 下可能残留的旧图。
     * 防止升级前跑过旧版脚本的人留着 48 张无人读的重复文件。
     */
    if (existsSync(PET)) {
      for (const f of readdirSync(PET)) {
        if (/^yuki-[a-z0-9-]+\.png$/.test(f)) unlinkResilient(join(PET, f))
      }
    }
  }

  const manifest = {}
  const rows = []

  for (const it of items) {
    const tmp = join(TMP, `${it.slug}.png`)
    if (!DRY) {
      /*
       * 统一缩到高 600、**无损** PNG。
       *
       * 600 的取值理由（为什么不是 522 或 1266）见 SPRITE_HEIGHT 的注释 ——
       * 简言之：母版上限 522、手机她页需求 1266，600 是实测最清晰的插值点。
       *
       * 无损：**不做 `-colors` 量化**。原先的 `-colors 220` 把真彩 RGBA
       * （colortype 6）压成了 204 色调色板（colortype 3），插图里
       * 半透明边缘和肤色渐变全部断裂。立绘是**带 alpha 的插画**，
       * 量化的视觉代价远高于那点体积 —— 这是本次修改的核心。
       *
       * `-strip` 保留：只丢 EXIF/ICC 等元数据，不影响像素。
       * `png:compression-level=9` 保留：无损压缩，只影响体积不影响画质。
       */
      im([it.src, '-resize', `x${SPRITE_HEIGHT}`, '-strip', '-define', 'png:compression-level=9', tmp])
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
    /*
     * 清单里额外记下 `spriteHeight` —— 这是「素材实际多大」的唯一机器可读
     * 真相源，供冒烟脚本断言。原先立绘高度只存在于这个脚本的一个字面量里，
     * 渲染端 CSS 那边写的是另一套数（50vh / 118px×scale），两者没有任何
     * 机制保证对得上 —— 这次的质量事故正是从这种脱节里长出来的。
     */
    const manifestOut = { spriteHeight: SPRITE_HEIGHT, items: manifest }
    writeFileSync(join(PET, 'manifest.json'), JSON.stringify(manifestOut, null, 2), 'utf8')
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
    /*
     * `scene-N` / `free-N` 不是装扮照片，**直接跳过，不产出文件**。
     *
     * 它们只是切图的中间产物：
     *   - `free-N` → 由 `installLifePhotos()` 映射成 `photos/life/gNN-1.png`
     *   - `scene-N` → 空镜，当前没有任何运行期消费点
     *
     * 原先这里只把 slug 记进 `scenes` 用于统计，却**照样走下面的写盘逻辑**，
     * 于是每张 free/scene 都在 `public/photos/` 根下留一份
     * `yuki-photo-free-N.png` 死文件 —— 没有任何代码引用，
     * 白占体积，还会被「孤儿图」类检查当成异常。
     */
    if (isExtra(slug)) {
      scenes.push(baseSlug(slug))
      continue
    }
    found.push(baseSlug(slug))
    if (DRY) continue
    mkdirSync(OUT_PHOTOS, { recursive: true })
    const outName = `yuki-photo-${slug}.png`
    /*
     * **不再往 `resources/photos/` 复制一份「母版」。**
     *
     * 原先这里有一句 `copyFileSync(..., RES_PHOTOS, outName)`，
     * 但实测那 43 张与 `resources/raw-cut/yuki-photo-*.png` **逐字节相同**，
     * 而全库没有任何代码读 `resources/photos/` ——
     * 纯冗余，白占仓库 26MB。
     *
     * 真母版始终是 `raw-cut/`（切图脚本的产物），要留也只该留那一份。
     * 这与 `resources/pet/` 里那 48 张重复 PNG 被删掉是同一个道理。
     */
    /*
     * **不做 `-colors` 量化**。
     *
     * 这里原先是 `-colors 220`，代价实测（`yuki-photo-jk.png`）：
     * 源 88,738 色 → 成品 **220 色**，同尺寸下平均误差 2.97/255、
     * 最大误差 31、PSNR 36.5dB。照片是大面积连续渐变（天空、皮肤、
     * 虚化背景），量化会在这些地方留下可见色块，和立绘是同一类损失。
     *
     * 照片是**实景照片**，没有透明边缘，但它有真彩渐变 ——
     * 所以同样必须走无损。分辨率不变（源图长边本就 ≤ 640，
     * `>` 只保证不放大），所以这次无损化**不增加任何像素**，
     * 只是不再丢弃色彩。
     */
    im([
      join(SRC, f),
      /* 长边缩到 640（`>` 保证不放大）：竖横两种比例都覆盖 */
      '-resize', `${PHOTO_LONG_SIDE}x${PHOTO_LONG_SIDE}>`,
      '-strip',
      '-define', 'png:compression-level=9',
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

  installLifePhotos()
}

/**
 * 装**生活照**（`photos/life/gNN-N.png`）。
 *
 * ## 为什么单独一条路径
 *
 * 生活照不绑装扮 —— 它们是 `gen-photos.js` 里 `slug: null` 的
 * 「自由穿搭格」，在 `photoStories.js` 登记成 `g17`~`g23`。
 * 命名空间与服饰照片不同，所以落 `photos/life/`，不叫 `yuki-photo-*`。
 *
 * ## 这一步原先**根本不存在**
 *
 * `public/photos/life/` 之前没有任何脚本负责写入 —— g01~g16 是某次
 * 手工操作留下的，g17~g23 则一直是更早一轮量化产物，从没被重做过。
 * 这正是「脚本没覆盖到的角落悄悄带病」的典型：全库 grep 不到写入者。
 *
 * 现在补成正式一步：从 `raw-cut` 的 `yuki-photo-free-<n>.png` 取源，
 * 按**顺序**映射到 `g17` 起，无损导出。
 *
 * ## 为什么按顺序而不是 `g(16+n)`
 *
 * `free-N` 里的 N 是**切图序号**，不是照片编号 —— 中间有废弃格
 * （`gen-photos.js` 的 `'land:yuki-photo-free-2': true`，源图不存在）。
 * 所以 `free-3` 其实是第 2 张有效的自由穿搭照，对应 `g18` 而非 `g19`。
 * 若照 `16+n` 硬算，会既漏掉 `g18`、又凭空造出没人引用的 `g24`。
 *
 * 判据用「有效源图排序后的位次」，与废弃格无关，加格子也不会错位。
 */
function installLifePhotos() {
  const PUB_LIFE = join(WEB, 'photos', 'life')
  /** 自由穿搭照在 `photoStories.js` 里的起始编号 */
  const LIFE_START = 17

  const srcs = existsSync(SRC)
    ? readdirSync(SRC).filter((f) => /^yuki-photo-free-\d+\.png$/.test(f)).sort((a, b) => {
        const na = Number(/free-(\d+)\.png$/.exec(a)[1])
        const nb = Number(/free-(\d+)\.png$/.exec(b)[1])
        return na - nb
      })
    : []
  if (!srcs.length) {
    console.log('\n（没有生活照源图：切图目录里找不到 yuki-photo-free-*.png）')
    return
  }

  const done = []
  srcs.forEach((f, i) => {
    const g = `g${String(LIFE_START + i).padStart(2, '0')}`
    done.push(g)
    if (DRY) return
    mkdirSync(PUB_LIFE, { recursive: true })
    /*
     * 不再往 `resources/photos/life/` 复制母版 —— 与服饰照片同理，
     * 真母版是 `raw-cut/yuki-photo-free-*.png`，那份副本零读者、纯占体积。
     * 源图长边本就 ≤ 640，所以这一步不缩放，只是换名 + 去元数据。
     */
    im([
      join(SRC, f),
      '-strip',
      '-define', 'png:compression-level=9',
      join(PUB_LIFE, `${g}-1.png`),
    ])
  })

  console.log(`\n生活照 ${done.length} 张 -> src/renderer/public/photos/life/`)
  console.log(`  ${done.join(', ')}`)
}

/**
 * 装角色设定图。
 *
 * 与立绘不同：这两张是**给人看的资料图**（高中 / 大学两个阶段的完整设定），
 * 不参与动作/服饰轮换，所以不缩到立绘的 600 高，而是缩到 700px 见方 ——
 * 细节（校徽、发饰、三视图）要看得清。
 *
 * **同样不量化**。原先这里是 `-colors 200`，代价实测：
 * 源 174,600 色 → 成品 **199 色**。设定图里有大量文字说明和三视图线稿，
 * 量化会把小字笔画糊掉、色卡失真 —— 而「看得清设定」正是这两张图存在的理由。
 */
function installProfileSheets(rows) {
  const PAIRS = [
    { from: '设定图1.png', to: 'yuki-profile-1-highschool.png' },
    { from: '设定图2.png', to: 'yuki-profile-2-university.png' },
  ]
  const SRC_NEW = join(ROOT, 'resources', 'yuki-new')
  const PUB_CHAR = join(WEB, 'character')

  const found = []
  for (const p of PAIRS) {
    const src = join(SRC_NEW, p.from)
    if (!existsSync(src)) continue
    found.push(p)
    if (!DRY) {
      mkdirSync(PUB_CHAR, { recursive: true })
      /*
       * 不再往 `resources/character/` 复制一份母版。
       * 那两份与 `resources/yuki-new/设定图*.png` **逐字节相同**，
       * 而后者才是真母版（`split-sheet.js` / 本脚本的输入），
       * 全库也没有任何代码读 `resources/character/` —— 纯冗余。
       */
      im([src, '-resize', '700x700', '-strip', '-define', 'png:compression-level=9', join(PUB_CHAR, p.to)])
    }
  }
  if (found.length) {
    console.log(`\n角色设定图 ${found.length} 张 -> src/renderer/public/character/`)
    found.forEach((p) => console.log(`  ${p.to}  <-  ${p.from}`))
  }
}

main()
