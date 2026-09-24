/**
 * Service Worker —— 让 PWA 能安装、能离线打开。
 *
 * 缓存策略刻意分两类：
 *   - 应用外壳（HTML/CSS/JS/图标）：cache-first，保证秒开且离线可用
 *   - 对话接口（api.deepseek.com）：**完全不碰**
 *
 * 第二条是关键：对话请求绝不能进缓存，否则会拿到旧回复；
 * 而且流式响应（SSE）本来也无法被 Cache API 正确处理。
 *
 * ## 版本号必须随构建变化（这是踩过的坑）
 *
 * 原来是写死的 `yuki-mobile-v1` + 纯 cache-first —— 于是**改动永远到不了
 * 用户手里**：缓存里有 app.js 就一直返回旧的，服务器更新了什么都不知道。
 * 表现是「后台改了一堆，手机上还是老样子」，排查方向也容易被带偏
 * （以为是代码没生效，实际是文件根本没换）。
 *
 * 现在版本由 build.js 注入（占位符 __CACHE_VER__）：改任何文件 → 新版本 →
 * install 装新缓存、activate 删旧缓存，用户下次打开就是新的。
 */
const CACHE = 'yuki-mobile-__CACHE_VER__'

/* 应用外壳：首次安装就预缓存，保证断网也能打开界面 */
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './storage.js',
  './chat.js',
  './manifest.webmanifest',
  './yuki-avatar.png',
  './icon-192.png',
  './icon-512.png',
  /*
   * 服饰立绘由 build.js 注入（见 build.js 的 outfitEntries）。
   * 它们体积占大头但数量固定，预缓存后图鉴和顶部立绘都能离线秒开。
   */
  __OUTFIT_FILES__
  /* 动作立绘（约 16KB/张）：顶部立绘交替要用，离线也得能显示 */
  __POSE_FILES__
  /* 角色设定图（高中/大学，约 200KB/张）：设置页要看，数量固定就一起缓存 */
  __PROFILE_FILES__
  /*
   * 视频封面（约 60KB/张）可预缓存，让图鉴秒开。
   * 视频本体**不预缓存** —— 7 段约 5MB，会拖慢首次安装；
   * 它们按需加载，解锁时下过一次自然进缓存。
   */
  __VIDEO_POSTERS__
]

/*
 * 全量资源清单（含上面 SHELL 里的，外加**首次安装不预缓存**的照片、视频、
 * 聊天背景）。给「首次打开的资源下载界面」用。
 *
 * 为什么和 SHELL 分开：
 *   SHELL 是「不装就没法用」的底子（34MB 里的 2.6MB），跟着 install 走，
 *   装完就能离线开界面。
 *   而剩下那 31MB（照片/视频/背景）**用到才下** —— 首次安装如果要等全量，
 *   用户会盯着白屏等几十秒，还可能以为卡死。
 *
 * 所以把它做成**用户可见、可跳过**的一次性下载：界面告知要下多少、
 * 进度多少、可以「先用着，回头再下」。
 */
const FULL_LIST = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './storage.js',
  './chat.js',
  './manifest.webmanifest',
  './yuki-avatar.png',
  './icon-192.png',
  './icon-512.png',
  __OUTFIT_FILES__
  __POSE_FILES__
  __PROFILE_FILES__
  __VIDEO_POSTERS__
  __BG_FILES__
  __PHOTO_FILES__
  __LIFE_PHOTO_FILES__
  __VIDEO_FILES__
]

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      /* 单个文件失败不该让整个安装挂掉（图标可能还没生成） */
      Promise.allSettled(SHELL.map((u) => c.add(u))),
    ).then(() => self.skipWaiting()),
  )
})

/*
 * 页面发现新版本时会让 SW 立即接管，不去等所有标签页关闭。
 * 移动端用户很少主动关标签页，不这样处理的话新 SW 会一直停在 waiting。
 */
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting()
  if (e.data?.type === 'DOWNLOAD_ALL') downloadAll(e)
})

/*
 * 把 FULL_LIST 全量拉进缓存，边下边报进度。
 *
 * 设计要点：
 *   ① **不 await Promise.all** —— 那样只有「全下完」和「全没下」两种状态，
 *      界面没法显示进度。这里一张一张来，每张完事就 postMessage。
 *   ② **失败不中断** —— 某张图挂了（弱网、临时 404）不该让剩下 190 张
 *      全不下。记下失败数，最后一起报给界面。
 *   ③ **用 cache.add 而不是 fetch+put** —— add 会自己做 Response 校验
 *      （非 2xx 会 reject），省掉手写 res.ok 判断。
 *   ④ 已经有缓存的**跳过**（cache.match 命中就不重下）—— 这样「跳过过
 *      一次、后来又点下载」不会把 30MB 重下一遍。
 */
async function downloadAll(e) {
  const port = e.ports?.[0]
  const post = (msg) => { try { port?.postMessage(msg) } catch { /* 页面已关 */ } }

  const cache = await caches.open(CACHE)

  /* 先摸清哪些真需要下 —— 界面进度条的分母用「实际要下的数量」，
     否则跳过部分后进度条会停在半路（分母含已缓存的）。 */
  const todo = []
  for (const url of FULL_LIST) {
    try {
      if (await cache.match(url)) continue
    } catch { /* match 失败就当需要下 */ }
    todo.push(url)
  }

  post({ type: 'START', total: todo.length })

  let done = 0
  const failed = []
  for (const url of todo) {
    try {
      await cache.add(url)
    } catch {
      failed.push(url)
    }
    done++
    post({ type: 'PROGRESS', done, total: todo.length, failed: failed.length })
  }

  post({ type: 'DONE', total: todo.length, failed: failed.length })
}

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      /*
       * 接管后，把**仍然开着的旧页面**刷一遍。
       *
       * 不做这一步的话：新 SW 已经装好、缓存也换了，但用户眼前那个页面
       * 还是旧 HTML + 旧 JS 跑出来的 —— 而它引用的资源刚刚被新缓存替换，
       * 于是出现「CSS 新版 + HTML 旧版」这类版本错配：布局塌、按钮全失效。
       * 与其让用户自己琢磨怎么强刷，不如主动重载一次。
       */
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => {
        for (const c of clients) {
          /* 只刷同源的窗口，且避免重复刷 */
          if (new URL(c.url).origin === self.location.origin) {
            c.navigate(c.url).catch(() => {})
          }
        }
      }),
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)

  /* 只处理同源的 GET；跨域（API）和写请求一律放行，不缓存 */
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return

  /*
   * 导航请求（打开页面）走 network-first。
   *
   * index.html 决定加载哪个版本的 JS/CSS，它一旦被缓存住，
   * 后面所有更新都进不来。所以宁可多一次网络往返，也不要
   * 拿旧的 HTML —— 断网时再回落缓存。
   */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(e.request, copy))
          }
          return res
        })
        .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match('./index.html'))),
    )
    return
  }

  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit
      return fetch(e.request)
        .then((res) => {
          /* 顺带把新拿到的外壳资源塞进缓存 */
          if (res.ok && res.type === 'basic') {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(e.request, copy))
          }
          return res
        })
        .catch(() => {
          throw new Error('offline')
        })
    }),
  )
})
