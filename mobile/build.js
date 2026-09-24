/**
 * 手机端构建 —— 把桌面端的 shared 模块「借」过来，产出一个自包含的目录。
 *
 * 为什么需要这一步：
 * 手机端刻意**不复制**人设/时间感知/多模态那套逻辑，而是直接引用
 * `src/shared/*` —— 保证两端行为一致，改一处两边都生效。
 * 但部署到域名时只能上传 mobile/ 这一个目录，
 * 而 `../src/shared/` 在部署后不存在（会 404）。
 *
 * 所以构建时把它们复制进 `mobile/vendor/`，
 * 并把 chat.js 里的引用路径改写成 `./vendor/*`。
 * 源文件仍是唯一真相，这里只产出部署副本。
 *
 * 用法: node mobile/build.js
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SHARED = join(ROOT, 'src', 'shared')
const DIST = join(ROOT, 'dist-mobile')

/*
 * 手机端真正用到的 shared 模块（按依赖顺序）。
 *
 * 刻意**不打包 interactions.js** —— 它装的是桌宠互动、服饰、亲密度那套，
 * 手机端没有桌宠，用不到。少一个文件就少一份首屏下载。
 * （将来手机端要加亲密度之类的功能，再把它加回来即可。）
 */
const MODULES = ['content.js', 'moyu.js', 'interactions.js', 'outfitStories.js', 'videoStories.js', 'photoStories.js', 'photoMessage.js', 'chatBackground.js', 'tapLines.js', 'chatter.js', 'dayInfo.js', 'holidays.js', 'gallery.js']

/* 需要一起打包进产物的手机端文件 */
const APP_FILES = [
  'index.html',
  'style.css',
  'app.js',
  'chat.js',
  'storage.js',
  'sw.js',
  'manifest.webmanifest',
  /*
   * yuki-avatar.png 不在这里 —— 它是 install-pet-assets.js 的产物，
   * 从渲染端 public/ 复制（见下面「头像」一段）。
   * 早先它是 mobile/ 下的一份手工副本，结果改了生成逻辑后
   * 产物里还是旧图（用户实测：左上角头像没变）。副本会和真相源脱节。
   */
  /*
   * 图标由 scripts/make-icons.js 生成到 mobile/。
   * 它们的真相源是立绘（yuki-heart.png），所以改了立绘或裁剪参数后
   * **必须重跑 make-icons.js** —— 下面有一步检查会提醒。
   */
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  /*
   * Cloudflare Pages 的响应头配置。
   * 它必须出现在**构建输出目录**里才会生效，所以随产物一起复制。
   * （其它托管商忽略这个文件，无害。）
   */
  '_headers',
]

/* ---------- 1. 把 shared 模块摊到 vendor/ ---------- */

/* 先确认要借的模块都在，缺一个就中止（避免产出半成品） */
for (const f of MODULES) {
  if (!existsSync(join(SHARED, f))) {
    console.error(`✗ 缺少 shared 模块: ${join(SHARED, f)}`)
    process.exit(1)
  }
}

/*
 * shared 模块之间也有互引（interactions.js → content.js），
 * 它们在同一目录下，相对路径原样有效，不用改写。
 *
 * 注意：**不能改写 mobile/chat.js 本身**。那样开发时（直接起静态服务器
 * 看 mobile/ 目录）会因为 ./vendor/ 还没生成而加载失败，
 * 等于把开发版本弄坏了。所以只在产出副本时替换路径。
 */
const chatSrc = readFileSync(join(HERE, 'chat.js'), 'utf8')
const chatDeploy = chatSrc.replace(/from '\.\.\/src\/shared\//g, "from './vendor/")
if (chatDeploy === chatSrc) {
  console.warn('⚠ chat.js 里没有找到 ../src/shared/ 引用，路径改写可能已失效')
}

/*
 * app.js 同样引用了 shared（图鉴故事 / 服饰表）。
 *
 * 这里踩过一个坑：最初只改写了 chat.js，漏了 app.js。
 * 结果页面上线后**看起来完全正常**（HTML/CSS 都对），
 * 但 app.js 的 import 解析失败，整个应用一行都没跑 ——
 * 表现为「界面在，但一直停在初始占位符上，也不报错」。
 * 所以两个文件都要改写，缺一不可。
 */
const appSrc = readFileSync(join(HERE, 'app.js'), 'utf8')
let appDeploy = appSrc.replace(/from '\.\.\/src\/shared\//g, "from './vendor/")
if (appDeploy === appSrc) {
  console.warn('⚠ app.js 里没有找到 ../src/shared/ 引用，路径改写可能已失效')
}

/*
 * storage.js 同样要改写 —— 它引用了 shared/gallery.js 的键名表。
 *
 * 这是同一个坑的第三次：前两次是 app.js 和 chat.js。
 * 规律很清楚 —— **任何引用 shared 的 mobile 源文件都必须进这张清单**，
 * 漏一个就整个应用加载失败（界面在、无报错、一行不跑）。
 * 下面的构建后自检会兜住这类遗漏。
 */
const storageSrc = readFileSync(join(HERE, 'storage.js'), 'utf8')
const storageDeploy = storageSrc.replace(/from '\.\.\/src\/shared\//g, "from './vendor/")
if (storageDeploy === storageSrc) {
  console.warn('⚠ storage.js 里没有找到 ../src/shared/ 引用，路径改写可能已失效')
}

/*
 * 给立绘 URL 注入版本串。
 *
 * 立绘是静态资源却没有内容 hash，浏览器会长期缓存 ——
 * 改了图（如这次去水印）老用户看到的还是旧图。
 * 用构建时间做版本串，每次构建即换 URL，强制刷新。
 */
const OUTFIT_VER = Date.now().toString(36)
const beforeVer = appDeploy
appDeploy = appDeploy.replace(/__OUTFIT_VER__/g, OUTFIT_VER)
if (appDeploy === beforeVer) {
  console.warn('⚠ app.js 里没有找到 __OUTFIT_VER__ 占位符，立绘缓存可能无法失效')
}

/*
 * 图标新鲜度检查。
 *
 * 图标是从立绘生成的派生资源，立绘一变、或改了裁剪参数，
 * 图标就该重出 —— 但「记得重跑」靠不住（avatar 就吃过这个亏：
 * 改了生成逻辑、产物里还是旧图）。
 * 这里比时间戳，源头更新就提醒。
 */
{
  const iconSrc = join(ROOT, 'src', 'renderer', 'public', 'yuki-heart.png')
  const iconOut = join(HERE, 'icon-512.png')
  if (existsSync(iconSrc) && existsSync(iconOut)) {
    const srcT = statSync(iconSrc).mtimeMs
    const outT = statSync(iconOut).mtimeMs
    if (srcT > outT) {
      console.warn('⚠ icon-512.png 比源立绘 yuki-heart.png 旧，请重跑: node scripts/make-icons.js')
    }
  }
}

/* ---------- 2. 产出可部署目录 ---------- */

rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })

/*
 * 改写过的文件直接写内容（不能先 copy 再覆盖，容易漏）；
 * 其余原样复制。
 */
const REWRITTEN = {
  'chat.js': () => chatDeploy,
  'app.js': () => appDeploy,
  'storage.js': () => storageDeploy,
}

for (const f of APP_FILES) {
  const src = join(HERE, f)
  if (!existsSync(src)) {
    console.warn(`⚠ 跳过缺失文件: ${f}`)
    continue
  }
  if (REWRITTEN[f]) writeFileSync(join(DIST, f), REWRITTEN[f](), 'utf8')
  else copyFileSync(src, join(DIST, f))
}
/*
 * index.html / manifest 注入资源版本串。
 *
 * 图标与头像在 Cloudflare 上会被边缘缓存（改了图但线上还是旧的），
 * 带 ?v= 后换版本即换 URL，绕过一切缓存。
 */
for (const f of ['index.html', 'manifest.webmanifest']) {
  const p = join(DIST, f)
  if (!existsSync(p)) continue
  const src = readFileSync(p, 'utf8')
  const out = src.replace(/__ASSET_VER__/g, OUTFIT_VER)
  if (out === src) {
    console.warn(`⚠ ${f} 里没有找到 __ASSET_VER__ 占位符`)
  }
  writeFileSync(p, out, 'utf8')
}

/* 部署副本用改写后的 chat.js / app.js 覆盖 */
writeFileSync(join(DIST, 'chat.js'), chatDeploy, 'utf8')
writeFileSync(join(DIST, 'app.js'), appDeploy, 'utf8')

mkdirSync(join(DIST, 'vendor'), { recursive: true })
for (const f of MODULES) copyFileSync(join(SHARED, f), join(DIST, 'vendor', f))

/*
 * 服饰立绘：图鉴和顶部立绘都要用。
 * 从渲染端的 public/ 复制到产物 outfits/ —— 单一真相源仍在桌面端，
 * 避免两处各存一份图将来不一致（改一张图要改两个地方的那种坑）。
 */
const OUTFIT_SRC = join(ROOT, 'src', 'renderer', 'public')
const outfits = readdirSync(OUTFIT_SRC).filter((f) => /^yuki-outfit-[a-z-]+\.png$/.test(f))
mkdirSync(join(DIST, 'outfits'), { recursive: true })
for (const f of outfits) copyFileSync(join(OUTFIT_SRC, f), join(DIST, 'outfits', f))
console.log(`✓ 打包 ${outfits.length} 张服饰立绘 → outfits/ (版本 ${OUTFIT_VER})`)

/*
 * 头像：**从渲染端 public/ 复制**，不在 mobile/ 下留副本。
 *
 * 它是 install-pet-assets.js 生成的（取 heart 那张的头部特写），
 * 真相源在 src/renderer/public/yuki-avatar.png。
 * 之前 mobile/ 下有一份手工副本，改生成逻辑后没同步，
 * 产物里一直是旧图 —— 这类「两份文件各自维护」的坑必须消灭掉。
 */
const AVATAR_SRC = join(OUTFIT_SRC, 'yuki-avatar.png')
if (existsSync(AVATAR_SRC)) {
  copyFileSync(AVATAR_SRC, join(DIST, 'yuki-avatar.png'))
  console.log('✓ 打包头像 → yuki-avatar.png（取自 src/renderer/public）')
} else {
  console.warn('⚠ 找不到 src/renderer/public/yuki-avatar.png，产物将缺少头像')
}

/*
 * 动作立绘：顶部立绘要在她「穿什么」和「在干什么」之间交替，
 * 所以这 18 张也得进产物（之前只有服饰，动作一个都没上）。
 */
const actionFiles = readdirSync(OUTFIT_SRC).filter(
  (f) => /^yuki-(pose\d|[a-z]+)\.png$/.test(f) && !f.startsWith('yuki-outfit-') && f !== 'yuki-avatar.png',
)
mkdirSync(join(DIST, 'poses'), { recursive: true })
for (const f of actionFiles) copyFileSync(join(OUTFIT_SRC, f), join(DIST, 'poses', f))
console.log(`✓ 打包 ${actionFiles.length} 张动作立绘 → poses/`)

/*
 * 自拍照片：解锁装扮时弹出的「她发来的照片」。
 *
 * 预缓存：每张约 200-400KB，24 张合计约 7MB —— 偏大。
 * 但它们**按需加载**（解锁到那一套才显示），且解锁后
 * 浏览器会自然缓存，所以不放进 SW 的预缓存清单，
 * 否则首次安装要白等好几秒。
 */
const PHOTO_SRC = join(OUTFIT_SRC, 'photos')
let photos = []
if (existsSync(PHOTO_SRC)) {
  photos = readdirSync(PHOTO_SRC).filter((f) => /^yuki-photo-[a-z0-9-]+\.png$/.test(f)).sort()
  mkdirSync(join(DIST, 'photos'), { recursive: true })
  for (const f of photos) copyFileSync(join(PHOTO_SRC, f), join(DIST, 'photos', f))
  console.log(`✓ 打包 ${photos.length} 张自拍照片 → photos/`)
}

/*
 * 生活照（`photos/life/`）—— 不绑装扮的日常照片。
 *
 * 单独一个子目录：命名空间和服饰照片不同（生活照是 `gNN-N.png`），
 * 混在 `photos/` 根下会和「装扮 slug」看混。
 * 早先这里打的是独立的「聊天背景图」目录，但那个类目只有一张占位图、
 * 也没素材 —— 现在背景直接用她发过的照片，不需要单独目录了。
 *
 * **不预缓存**：和服饰照片同理，按需加载即可（一张 500KB 上下）。
 */
const LIFE_SRC = join(PHOTO_SRC, 'life')
let lifePhotos = []
if (existsSync(LIFE_SRC)) {
  lifePhotos = readdirSync(LIFE_SRC).filter((f) => /^g\d{2}-\d+\.png$/.test(f)).sort()
  mkdirSync(join(DIST, 'photos', 'life'), { recursive: true })
  for (const f of lifePhotos) copyFileSync(join(LIFE_SRC, f), join(DIST, 'photos', 'life', f))
  console.log(`✓ 打包 ${lifePhotos.length} 张生活照 → photos/life/`)
}

/*
 * 角色设定图（高中 / 大学）。
 *
 * 真相源在 `src/renderer/public/character/`。手机端设置页同样要看，
 * 所以一起进产物 —— 两张共约 400KB，相对立绘可以忽略。
 */
const PROFILE_SRC = join(OUTFIT_SRC, 'character')
let profiles = []
if (existsSync(PROFILE_SRC)) {
  profiles = readdirSync(PROFILE_SRC).filter((f) => /^yuki-profile-\d+-[a-z]+\.png$/.test(f)).sort()
  mkdirSync(join(DIST, 'character'), { recursive: true })
  for (const f of profiles) copyFileSync(join(PROFILE_SRC, f), join(DIST, 'character', f))
  console.log(`✓ 打包 ${profiles.length} 张角色设定图 → character/`)
} else {
  console.warn('⚠ 找不到 src/renderer/public/character/，产物将缺少角色设定图')
}

/*
 * 「她」页的背景图（场景空镜：书桌 / 玄关 / 地铁 / 便利店）。
 *
 * 真相源在 `src/renderer/public/bg/`。四张共约 1.2MB —— 不小，
 * 但它们是**立绘页的底图**，打开那一页就要看到，没法按需加载
 * （没有背景会让整页只有渐变，观感差很多）。
 */
const BG_SRC = join(OUTFIT_SRC, 'bg')
let petBgs = []
if (existsSync(BG_SRC)) {
  petBgs = readdirSync(BG_SRC).filter((f) => /^[a-z]+\.png$/.test(f)).sort()
  mkdirSync(join(DIST, 'bg'), { recursive: true })
  for (const f of petBgs) copyFileSync(join(BG_SRC, f), join(DIST, 'bg', f))
  console.log(`✓ 打包 ${petBgs.length} 张立绘页背景 → bg/`)
} else {
  console.warn('⚠ 找不到 src/renderer/public/bg/，立绘页将没有背景图')
}

/*
 * 视频资源：从渲染端 public/videos/ 复制到产物 videos/。
 * 含 .mp4 与抽好的首帧 .jpg（封面）。
 */
const VIDEO_SRC = join(ROOT, 'src', 'renderer', 'public', 'videos')
let videos = []
if (existsSync(VIDEO_SRC)) {
  videos = readdirSync(VIDEO_SRC).filter((f) => /^[a-z0-9-]+\.(mp4|jpg)$/.test(f)).sort()
  mkdirSync(join(DIST, 'videos'), { recursive: true })
  for (const f of videos) copyFileSync(join(VIDEO_SRC, f), join(DIST, 'videos', f))
  console.log(`✓ 打包 ${videos.filter((f) => f.endsWith('.mp4')).length} 段视频 + ${videos.filter((f) => f.endsWith('.jpg')).length} 张封面`)
}

/*
 * Service Worker 注入版本号与立绘清单。
 *
 * sw.js 是**唯一会让其它所有改动失效的文件**：它是 cache-first，
 * 缓存名不变就永远返回旧文件。所以它的版本必须跟着构建走，
 * 立绘清单也要在这里生成（预缓存后图鉴能离线打开）。
 */
const swSrc = readFileSync(join(HERE, 'sw.js'), 'utf8')
const outfitEntries = outfits.map((f) => `  './outfits/${f}',`).join('\n')
/* 动作立绘都很小（约 16KB/张），预缓存后离线也能正常显示她 */
const poseEntries = actionFiles.map((f) => `  './poses/${f}',`).join('\n')
/*
 * 视频**不进预缓存**：7 段合计约 5MB，全塞进 install 会让首次安装
 * 明显变慢。它们按需加载 —— 聊天里真解锁了才去下，之后自然进缓存。
 * 封面图很小（约 60KB/张），可以一起预缓存，让图鉴秒开。
 */
const videoPosters = videos.filter((f) => f.endsWith('.jpg')).map((f) => `  './videos/${f}',`).join('\n')
/* 设定图很小（两张共约 400KB），直接预缓存 —— 设置页离线也要能看 */
const profileEntries = profiles.map((f) => `  './character/${f}',`).join('\n')
/*
 * 全量下载清单（供首次打开的「资源下载」界面用）。
 *
 * 和 SHELL 的区别：SHELL 只放「不装就没法用」的底子（2.6MB），
 * 这里把所有资源都列上（34MB），让用户**一次性下完、之后完全离线**。
 * 分母、进度、跳过都由前端控制，SW 只负责按清单拉。
 */
const bgEntries = petBgs.map((f) => `  './bg/${f}',`).join('\n')
const photoEntries = photos.map((f) => `  './photos/${f}',`).join('\n')
const lifeEntries = lifePhotos.map((f) => `  './photos/life/${f}',`).join('\n')
/*
 * 视频本体（约 10MB）—— 这里**列进全量清单**，但**不进 SHELL**。
 * 用户在首次下载界面点了「下载全部」才会拉；跳过的就按需加载。
 */
const videoBodies = videos.filter((f) => f.endsWith('.mp4')).map((f) => `  './videos/${f}',`).join('\n')

/*
 * 全部用 `replaceAll`：这些占位符在 SHELL 和 FULL_LIST 里**各出现一次**
 * （两个清单都要同样的立绘/照片列表）。用 replace 只会替换第一处，
 * 剩下那份留在产物里 —— 而它是**语法错误**，整个 SW 直接不注册。
 */
let swDeploy = swSrc
  .replace(/__CACHE_VER__/g, OUTFIT_VER)
  .replaceAll('  __OUTFIT_FILES__', outfitEntries)
  .replaceAll('  __POSE_FILES__', poseEntries)
  .replaceAll('  __PROFILE_FILES__', profileEntries)
  .replaceAll('  __VIDEO_POSTERS__', videoPosters)
  .replaceAll('  __BG_FILES__', bgEntries)
  .replaceAll('  __PHOTO_FILES__', photoEntries)
  .replaceAll('  __LIFE_PHOTO_FILES__', lifeEntries)
  .replaceAll('  __VIDEO_FILES__', videoBodies)
if (swDeploy === swSrc) {
  console.warn('⚠ sw.js 里没有找到占位符，缓存版本不会更新')
}
/*
 * 残留占位符 = 产物里是 `__XXX__` 这种裸标识符，SW 会**语法错误、
 * 整个不注册**（fetch 拦截、离线、缓存全失效），而且控制台只报一行
 * 难懂的 "Unexpected identifier"。这里直接拦下来。
 */
{
  const leftover = swDeploy.match(/__[A-Z_]+__/g)
  if (leftover) {
    console.error(`✗ sw.js 里残留未替换的占位符: ${[...new Set(leftover)].join(', ')}`)
    console.error('  检查 build.js 的注入是否覆盖了所有出现位置（SHELL 与 FULL_LIST 各一份）。')
    process.exit(1)
  }
}
writeFileSync(join(DIST, 'sw.js'), swDeploy, 'utf8')
console.log(`✓ 注入 Service Worker 版本 ${OUTFIT_VER} + ${outfits.length} 张服饰 / ${actionFiles.length} 张动作 / ${profiles.length} 张设定图预缓存`)
console.log(`✓ 全量下载清单：${petBgs.length} 背景 / ${photos.length + lifePhotos.length} 照片 / ${videos.filter((f) => f.endsWith('.mp4')).length} 视频`)

console.log(`✓ 打包 ${MODULES.length} 个 shared 模块 → vendor/`)

/*
 * 构建后自检：产物里**不能残留 `../src/` 这类源码路径**。
 *
 * 这个坑踩过三次（app.js / chat.js / storage.js）。症状极具迷惑性：
 * 界面渲染正常、控制台不报 JS 错，但模块图加载失败、整个应用一行不跑。
 * 与其靠人记得往 REWRITTEN 里加文件，不如构建时直接扫一遍。
 */
{
  const offenders = []
  for (const f of readdirSync(DIST)) {
    if (!f.endsWith('.js')) continue
    if (f === 'sw.js') continue
    const txt = readFileSync(join(DIST, f), 'utf8')
    if (/from '\.\.\/src\//.test(txt)) offenders.push(f)
  }
  if (offenders.length) {
    console.error(`✗ 产物里有源码路径引用（部署后必然 404）: ${offenders.join(', ')}`)
    console.error('  把对应文件加进 build.js 的 REWRITTEN 里做路径改写。')
    process.exit(1)
  }
  console.log('✓ 产物无源码路径残留')
}
console.log(`\n✓ 构建完成 → ${DIST}`)
console.log('  把这个目录整体上传到任意静态托管即可（GitHub Pages / Vercel / 自己的服务器）')
console.log('  注意：必须是 https，否则浏览器不允许「添加到主屏幕」')
