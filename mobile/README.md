# Yuki 手机版（PWA）

和桌面版**各自独立运行**的另一端：手机浏览器打开就能聊，
不依赖电脑开机，数据存在手机本地。

## 怎么用

**方式一：部署到你的域名（推荐，可「添加到主屏幕」）**

```bash
node mobile/build.js        # 产出 dist-mobile/
```

把 `dist-mobile/` 整个上传到任意静态托管（GitHub Pages / Vercel / Cloudflare Pages
/ 自己的服务器）。手机打开该地址 → 浏览器菜单 → 「添加到主屏幕」。

> **必须 https**。Service Worker（离线缓存 + 可安装）只在安全上下文启用，
> 局域网 http 下浏览器会把它当成普通网页。

**方式二：本地预览（试效果用，不用先部署）**

```bash
node mobile/serve.js        # 监听 0.0.0.0:8899
```

手机连同一个 WiFi，打开终端里提示的
`http://<电脑IP>:8899` 即可。这种 http 方式**不能**添加到主屏幕，仅用于预览。

## 首次配置

打开后会直接弹出设置面板（没配置时自动引导），填三项：

| 项 | 值 |
|---|---|
| 接口地址 | `https://api.deepseek.com` |
| API Key | 你的 `sk-...` |
| 模型 | `deepseek-flash`（要能看图就填这个） |

**API Key 只存在手机本地**（IndexedDB），不会经过任何第三方服务器 ——
请求由手机浏览器直连 DeepSeek。

## 为什么能直连（不用中转服务器）

实测 DeepSeek 接口会回 CORS 头：

```
access-control-allow-origin: <回显你的 Origin>
access-control-allow-headers: authorization,content-type
access-control-allow-methods: POST
```

所以浏览器 `fetch` 不会被同源策略拦截，**不需要任何后端**。
（有些 API 不返回这些头，那种就必须中转；DeepSeek 可以。）

## 与桌面版的关系

**共享同一套业务逻辑，零复制**：

```
mobile/chat.js  ──import──▶  ../src/shared/moyu.js      （人设 / 时间感知 / 时段）
                            ../src/shared/content.js    （多模态 / 内容块）
                            ../src/shared/interactions.js（台词 / 服饰 / 亲密度）
```

改桌面端的人设或时段表，手机端**同步生效**（重新 build 即可）。

**但数据各自独立**：

| | 桌面版 | 手机版 |
|---|---|---|
| 存储 | `%APPDATA%\desk-pet\desk-pet.db`（SQLite） | IndexedDB |
| 对话记录 | 各自一份 | 各自一份 |
| 亲密度 | 各自累计 | 各自累计 |

这是刻意的：两端互不依赖，断网/关机都不影响另一端。
代价是记录不互通 —— 要同步需要额外的合并方案。

**手机端没有的东西**：桌宠悬浮窗、挂机冒泡、打卡、摸鱼收入统计。
这些依赖桌面环境（透明置顶窗口、常驻进程），移动 OS 不支持。

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | 界面结构 |
| `style.css` | 样式（移动优先、适配安全区） |
| `app.js` | DOM 与交互（无框架，省运行时） |
| `storage.js` | IndexedDB 存储层 |
| `chat.js` | 对话引擎（直连 API、SSE 解析） |
| `sw.js` | Service Worker（离线缓存） |
| `manifest.webmanifest` | PWA 元信息（可安装） |
| `build.js` | 产出可部署目录 |
| `serve.js` | 本地预览服务器 |

## 两个已知的 IndexedDB 陷阱

写存储层时踩到并修掉了，记在这里避免重犯：

**1. 事务会在 await 时自动提交**

```js
// ✗ 错的：await 之后事务已提交，objectStore 抛 InvalidStateError
const t = db.transaction(['messages','sessions'], 'readwrite')
t.objectStore('messages').put(msg)
const s = await getSession(sessionId)      // ← 这里事务就提交了
t.objectStore('sessions').put(...)

// ✓ 对的：先把要读的读出来，再开写事务，事务内不做 await
const session = await getSession(sessionId)
await tx(['messages','sessions'], 'readwrite', (t) => {
  t.objectStore('messages').put(msg)
  if (session) t.objectStore('sessions').put(...)
})
```

**2. 删除要先查后删，不能边查边删**（同上原因）

## 注意

- 清浏览器数据会**一并清掉**对话记录和设置（换设备不通用）
- 设置页有「清空本机数据」按钮，会重置到初始状态
