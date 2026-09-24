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
   * 服饰立绘由 build.js 注入（占位符 __OUTFIT_FILES__）。
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
})

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
