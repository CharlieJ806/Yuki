/**
 * 把 resources/yuki/*.png 处理成桌宠可用的透明立绘。
 *
 * 源图特征（实测）：
 *   1. 2048x2048、纯色背景不透明（colorType=2，无 alpha）
 *   2. 背景色**每张略有差异**（253,249,238 ~ 254,255,241），
 *      所以必须逐张采样，不能写死一个颜色
 *   3. 角色外围有一圈白色描边贴纸
 *   4. 右下角有「豆包AI生成」水印，颜色与背景极接近（floodfill 抠不掉），
 *      但落在纯背景上，可直接抹掉那块矩形
 *
 * 关键：必须用「从四角 floodfill」而不是全局 -transparent ——
 * 高 fuzz 全局抠色会把白衬衫和皮肤一起抠穿（实测 fuzz 20% 时脸都透明了）。
 *
 * 用法: node scripts/prepare-yuki.js
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'resources', 'yuki')
const OUT = join(ROOT, 'resources', 'pet')
const WEB = join(ROOT, 'src', 'renderer', 'public')
const TMP = join(ROOT, '.tmp-yuki')

/**
 * 水印区域（2048 坐标系，`宽x高+X+Y` 格式，供 ImageMagick `-region` 用）。
 *
 * 「豆包AI生成」是**描边空心字**：只有一圈极淡的灰线（最深灰度约 200），
 * 字心就是背景色。所以按「浅色实心像素」去扫是找不到它的。
 *
 * 实测水印本体在 x 1691~2014、y 1936~2008，四边各留 8px 余量。
 * 旧值 `1620,1900 2047,2047` 是**罩错了地方**（盖的是水印上方的空白背景，
 * 加上当时那句 -draw 本身就没生效），所以水印一路留到了成品图里。
 *
 * 改这个值后务必跑 `node scripts/dewatermark.js --check` 复核。
 */
const WM_REGION = '339x88+1683+1928'

/**
 * 判断一张源图是否「纯白底立绘」。
 *
 * 取四边各 40px 的一圈像素，看均值与标准差：
 *   纯白底 → 均值高（>246）、标准差极小（<8）
 *   场景图 → 边缘有背景内容/渐变，标准差大（>30）
 *
 * 用途：加新素材时不用肉眼逐张判断，也避免「该抠的没抠」
 * （会留一片背景残渣）或「不该抠的抠了」（人飘在白底上）。
 * 只用于**提示**，最终以 OUTFIT_FILES 里的 scene 标记为准 ——
 * 有些图手工看更准，不该被启发式规则绑死。
 */
function looksLikeWhiteBackdrop(file) {
  try {
    const out = im([
      file,
      '-shave', '40x40',
      '-format', '%[fx:mean*255] %[fx:standard_deviation*255]',
      'info:',
    ]).trim()
    const [mean, sd] = out.split(/\s+/).map(Number)
    return { mean, sd, white: sd < 8 && mean > 246 }
  } catch {
    return null
  }
}

/** 动作名 -> 输出文件名。按前缀匹配，命中即用 */
const NAME_MAP = {
  /* 状态类：由工作/休息状态决定 */
  握拳: 'pose1',
  蹦跳: 'pose2',
  眨眼: 'pose3',
  站姿: 'pose4',

  /* 表情类：由互动触发 */
  害羞脸红: 'shy',
  生气鼓腮: 'angry',
  思考: 'think',
  睡觉: 'sleep',
  跳起来: 'jump',
  比心: 'heart',
  惊讶: 'surprise',
  无奈摊手: 'shrug',

  /* 生活化动作：让挂机时更像真人在旁边 */
  吃零食: 'snack',
  戴耳机: 'music',
  递咖啡: 'coffee',
  挥手再见: 'wave',
  打哈欠: 'yawn',
  竖大拇指: 'thumbsup',
}

/**
 * 服饰源文件 -> slug。
 *
 * **按完整文件名精确匹配，不用前缀 + 「同款去重」**。
 *
 * 曾经的错误做法：`便服 (2).png` 之类被前缀规则归成同一套 `casual`，
 * 然后「取序号最小的当代表」把其余丢掉 —— 我以为它们是同款多版本。
 * 实际逐张比对（RMSE 6000~14000）和目视确认后发现：
 * 它们是**完全不同的 5 套衣服**（白色针织裙 / 红外套制服 / 荷叶边裙 /
 * 白上衣黑裙 / 深色制服），丢掉等于白扔 9 张素材。
 *
 * 所以现在一张图一个 slug，名字按实际款式起。
 * 新增素材时如果忘了登记，脚本会明确报错（而不是静默丢弃）——
 * 静默丢弃正是上次出问题的原因。
 */
const OUTFIT_FILES = {
  '便服.png': { slug: 'casual', label: '便服' },
  '便服 (2).png': { slug: 'casual-red', label: '红外套' },
  '便服 (3).png': { slug: 'casual-lace', label: '荷边裙' },
  '便服 (4).png': { slug: 'casual-mono', label: '黑白裙' },
  '便服 (5).png': { slug: 'casual-dark', label: '深色制服' },
  '睡衣 (1).png': { slug: 'pajamas', label: '睡裙' },
  '睡衣 (2).png': { slug: 'pajamas-black', label: '黑吊带' },
  '睡衣 (3).png': { slug: 'pajamas-pink', label: '粉吊带' },
  '睡衣 (4).png': { slug: 'pajamas-bodysuit', label: '连体衣' },
  '睡衣 (5).png': { slug: 'pajamas-shorts', label: '短睡裙' },
  '居家清凉睡衣.png': { slug: 'homewear', label: '居家清凉' },
  '吊带.png': { slug: 'camisole', label: '吊带' },
  '长裙.png': { slug: 'longskirt', label: '长裙' },
  '旗袍.png': { slug: 'qipao', label: '旗袍' },
  '修女.png': { slug: 'nun', label: '修女' },
  '沙滩泳装.png': { slug: 'swimsuit', label: '泳装' },
  'cosplay.png': { slug: 'cosplay', label: 'cosplay' },
  /* 第二批素材 */
  'jk.png': { slug: 'jk', label: 'JK 制服' },
  '偶像风格.png': { slug: 'idol', label: '偶像风格' },
  '女仆.png': { slug: 'maid', label: '女仆' },
  '女仆装.png': { slug: 'maid-two', label: '女仆装' },
  '小妈长裙.png': { slug: 'stepmom', label: '小妈长裙' },

  /*
   * 下面五张是**带背景的场景图**，不抠背景（见主流程的 outfit-scene 分支）。
   *
   * 判断依据不是「四角是不是白的」—— 那样判会错：
   * 清纯校园四角是纯白，但画面里有咖啡馆桌椅。
   *
   * 可靠判据是**四边像素的均值与标准差**（见 checkSceneHeuristic）：
   *   纯白底 → 均值 >246、标准差 <8
   *   场景图 → 均值 <216、标准差 >30（有渐变/内容）
   * 实测 9 张新图分得很干净，没有落中间地带的。
   *
   * 场景图抠掉背景后人都飘在白底上，反而比原图难看得多。
   */
  '清纯校园.png': { slug: 'campus', label: '清纯校园', scene: true },
  '校园偶像.png': { slug: 'campus-idol', label: '校园偶像', scene: true },
  '实习面试.png': { slug: 'interview', label: '实习面试', scene: true },
  'ol制服.png': { slug: 'ol', label: 'OL 制服', scene: true },
}

/** 查这张源图属于哪套服饰；不是服饰则返回 null */
/** 查这张源图属于哪套服饰；不是服饰则返回 null（含 scene 标记） */
function outfitEntryOf(base) {
  return OUTFIT_FILES[`${base}.png`] ?? null
}

const BG_FUZZ = '12%'

function im(args) {
  return execFileSync('magick', args, { encoding: 'utf8' })
}

/** 采样四角，取出现次数最多的颜色作为背景色 */
function detectBackground(file) {
  const corners = ['0,0', '2047,0', '0,2047', '2047,2047']
  const colors = corners.map((c) =>
    im([file, '-format', `%[pixel:p{${c}}]`, 'info:']).trim(),
  )
  const tally = new Map()
  for (const c of colors) tally.set(c, (tally.get(c) ?? 0) + 1)
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

/**
 * 从中文名映射到短英文 slug。
 *
 * 返回 `{ slug, kind }`，kind 为 'action' | 'outfit' | 'unknown'。
 * 服饰走独立命名空间，否则序号兜底规则会覆盖动作立绘。
 */
function slugOf(filename) {
  const base = filename.replace(/\.png$/i, '')

  /* 服饰优先判断：整名精确匹配，不能用前缀（否则不同款式会被归成一套） */
  const outfit = outfitEntryOf(base)
  if (outfit) {
    /*
     * 带背景的场景图走独立 kind：它们不抠背景，
     * 处理路径和普通立绘不同（见主流程里的 isScene 分支）。
     */
    return {
      slug: `outfit-${outfit.slug}`,
      kind: outfit.scene ? 'outfit-scene' : 'outfit',
    }
  }

  for (const [key, slug] of Object.entries(NAME_MAP)) {
    if (base.startsWith(key)) return { slug, kind: 'action' }
  }

  /* 老图 yuki (1).png 之类 */
  const m = /\((\d+)\)/.exec(base)
  if (m) return { slug: `pose${m[1]}`, kind: 'unknown' }
  return { slug: base.replace(/[^\w-]/g, '_').slice(0, 24), kind: 'unknown' }
}

function run(label, fn) {
  process.stdout.write(`  ${label} ... `)
  try {
    const r = fn()
    process.stdout.write('ok\n')
    return r
  } catch (err) {
    process.stdout.write(`FAIL (${err.message.slice(0, 80)})\n`)
    throw err
  }
}

/** 头像取哪一张（比心最适合当头像） */
const AVATAR_SLUG = 'heart'

/*
 * 头像裁剪（源图 168x300 坐标系）。
 *   AVATAR_SIDE    方形边长，130 时脸占画面约一半，20px 小圆下也认得出
 *   AVATAR_FACE_CX 脸的水平中心（实测），用它当裁剪轴才能让脸居中
 */
const AVATAR_SIDE = 130
const AVATAR_FACE_CX = 85

/* ---------- 主流程 ---------- */

if (!existsSync(SRC)) {
  console.error(`找不到源图目录: ${SRC}`)
  process.exit(1)
}
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
mkdirSync(OUT, { recursive: true })
mkdirSync(WEB, { recursive: true })

const sources = readdirSync(SRC).filter((f) => /\.png$/i.test(f)).sort()
if (sources.length === 0) {
  console.error('resources/yuki 里没有 png')
  process.exit(1)
}

/*
 * 不再对服饰做「同款去重」：实测那 9 张序号图是不同款式，去重等于丢素材。
 * 但必须保证每张源图都被登记过 —— 静默丢弃正是上次出问题的原因，
 * 所以遇到没映射的名字直接中止，让人当场发现。
 */
const unmapped = sources.filter((f) => {
  const base = f.replace(/\.png$/i, '')
  const { kind } = slugOf(f)
  /* 动作走 NAME_MAP，服饰走 OUTFIT_FILES；两者都没命中且无序号 => 未登记 */
  return kind === 'unknown' && !/\((\d+)\)/.test(base)
})
if (unmapped.length) {
  console.error(`\n以下源图没有登记到 NAME_MAP / OUTFIT_FILES，无法确定用途：`)
  for (const f of unmapped) console.error(`  · ${f}`)
  console.error(`\n请在 scripts/prepare-yuki.js 里补上映射后重跑。`)
  process.exit(1)
}

console.log(`找到 ${sources.length} 张源图\n`)

const results = []
const manifest = {}

for (const [i, file] of sources.entries()) {
  const { slug, kind } = slugOf(file)
  const src = join(SRC, file)
  console.log(`[${i + 1}/${sources.length}] ${file} -> ${slug} (${kind})`)

  const bg = run('采样背景色', () => detectBackground(src))
  const isScene = kind === 'outfit-scene'
  const cut = join(TMP, `cut-${slug}.png`)
  const erased = join(TMP, `erase-${slug}.png`)
  const trimmed = join(TMP, `trim-${slug}.png`)
  const full = join(OUT, `yuki-${slug}.png`)
  const webImg = join(WEB, `yuki-${slug}.png`)
  const avatar = join(OUT, `avatar-${slug}.png`)
  const webAvatar = join(WEB, 'yuki-avatar.png')

  /*
   * 场景图（ol制服、小妈长裙）**不抠背景** —— 它们自带氛围光，
   * 抠掉之后人就飘在白底上，反而不如原图好看。
   * 只按内容裁掉四周多余空白，保留构图。
   */
  if (isScene) {
    run('裁掉四周空白（保留原背景）', () => {
      im([src, '-alpha', 'set', '-trim', '+repage', trimmed])
    })
  } else {
    run('抠背景（四角 floodfill，保留白衣与肤色）', () => {
      im([
        src,
        '-alpha', 'set',
        '-fuzz', BG_FUZZ,
        '-fill', 'none',
        '-draw', 'alpha 0,0 floodfill',
        '-draw', 'alpha 2047,0 floodfill',
        '-draw', 'alpha 0,2047 floodfill',
        '-draw', 'alpha 2047,2047 floodfill',
        cut,
      ])
    })

    /*
     * 抹除右下角水印。
     *
     * 这里原先写的是 `-alpha set -fill none -draw "rectangle ..."` ——
     * 那个写法**会把整张图清空**（实测清空后整图 alpha 均值 = 1），
     * 而不是只清矩形区域。因为它不报错，所以一直没人发现，
     * 直到水印叠在白色卡片上被肉眼看见。
     *
     * 正确做法是限定 `-region` 后只对 alpha 通道求值：
     * 实测水印区 alpha→0、无关区 alpha 保持 1。
     */
    run('抹除右下角水印', () => {
      im([
        cut,
        '-alpha', 'set',
        '-region', WM_REGION,
        '-channel', 'A', '-evaluate', 'set', '0', '+channel',
        '+region',
        erased,
      ])
    })

    run('裁掉四周空白', () => {
      im([erased, '-trim', '+repage', trimmed])
    })
  }

  const dims = run('导出立绘（高 300，透明）', () => {
    im([trimmed, '-resize', 'x300', '-strip', '-define', 'png:compression-level=9', '-colors', '220', full])
    return im([full, '-format', '%wx%h', 'info:']).trim()
  })

  /*
   * 只为指定那张生成头像，避免一堆没人用的文件。
   *
   * 旧做法是「取上 60% 再居中」—— 结果是整个人上半身塞进方框，
   * 脸只占很小一块。在手机上它显示成约 20px 的小圆，根本看不清是谁。
   *
   * 现在按**头部**取：以脸中心为水平轴，竖向覆盖「头顶 → 下巴下方」，
   * 让脸占据画面主要位置。脸的位置是实测的（heart 这张：
   * x 中心 85、下巴 y≈102），不是按比例估的 —— 估的会因人而异。
   */
  if (slug === AVATAR_SLUG) {
    run('导出对话框头像（头部特写，128 方形）', () => {
      /* dims 是 '宽x高' 字符串（上一步导出立绘时拿到的） */
      const fullW = Number(String(dims).split('x')[0]) || AVATAR_SIDE
      const side = Math.min(AVATAR_SIDE, fullW)
      const left = Math.max(
        0,
        Math.min(fullW - side, Math.round(AVATAR_FACE_CX - side / 2)),
      )
      im([
        full, '-crop', `${side}x${side}+${left}+0`, '+repage',
        '-resize', '128x128', '-strip',
        avatar,
      ])
    })
  }

  run('复制到渲染目录', () => {
    im([full, '-strip', webImg])
  })
  if (slug === AVATAR_SLUG) {
    run('复制头像到渲染目录', () => {
      im([avatar, '-strip', webAvatar])
    })
  }

  manifest[slug] = { source: file, size: dims, bg, kind }
  results.push({ slug, file, dims, kind })
  console.log('')
}

rmSync(TMP, { recursive: true, force: true })

/* 写一份清单，便于查漏与前端引用 */
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

console.log('产物（resources/pet/ 与 src/renderer/public/）:')
for (const r of results) {
  console.log(`  yuki-${r.slug.padEnd(10)} ${r.dims.padEnd(9)} <- ${r.file}`)
}
console.log(`\n完成，共 ${results.length} 张。`)
