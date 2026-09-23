# 部署到 Cloudflare Pages

用**私有 GitHub 仓库 + Cloudflare Pages**：源码不公开，产物公开。

---

## 一、先确认本地能构建

```bash
node mobile/build.js
```

应当看到 `✓ 构建完成 → dist-mobile`。

这个命令**不依赖 `npm install`** —— `mobile/build.js` 只用 Node 内置模块，
所以 Cloudflare 上构建也很快（不用跑 255MB 的 node_modules）。

---

## 二、推到 GitHub 私有仓库

如果还没建仓库：

```bash
cd Z:/Files/Apps/desk
git init
git add -A
git commit -m "feat: 摸鱼桌宠 + 手机版 PWA"
```

在 GitHub 上新建一个 **Private** 仓库（不要勾 README/gitignore），然后：

```bash
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

**首次推送约 102MB**（含 `resources/yuki/` 的 35 张源立绘）。会慢一点，属正常。

> `.gitignore` 已排除 `release/`（322MB 打包产物）和 `node_modules/`。

---

## 三、Cloudflare Pages 配置

Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** →
**Connect to Git** → 选你的私有仓库。

授权时如果看不到私有仓库，点 **Configure GitHub App** 把该仓库加入授权列表。

构建配置这样填：

| 项 | 值 |
|---|---|
| **Production branch** | `main` |
| **Framework preset** | `None` |
| **Build command** | `node mobile/build.js` |
| **Build output directory** | `dist-mobile` |
| **Root directory** | （留空） |

环境变量不用加。Node 版本默认即可（需要 ≥18；构建脚本用了 `node:` 协议导入）。

点 **Save and Deploy**。首次构建约 1-2 分钟。

---

## 四、绑定你的域名

部署成功后：

Pages 项目 → **Custom domains** → **Set up a custom domain** → 填你的域名。

按提示在域名 DNS 里加记录：

- 域名托管在 Cloudflare → 自动加好，直接生效
- 域名在别处 → 加一条 `CNAME` 指向 `<项目名>.pages.dev`

**等证书签发**（通常几分钟）。

---

## 五、手机上安装

用手机浏览器打开你的域名，然后：

- **iOS Safari**：分享按钮 → 「添加到主屏幕」
- **Android Chrome**：菜单 → 「添加到主屏幕」/「安装应用」

装好后图标会出现在桌面，点开是全屏的（没有浏览器地址栏）。

---

## 六、首次使用要填配置

打开后会**自动弹出设置面板**（没配置时主动引导），填三项：

| 项 | 值 |
|---|---|
| 接口地址 | `https://api.deepseek.com` |
| API Key | 你的 `sk-...` |
| 模型 | `deepseek-flash` |

点「测试连接」确认通了，再点「保存」。

**API Key 只存在手机本地**（IndexedDB），不经过 Cloudflare、也不经过任何第三方 ——
请求是手机浏览器直连 DeepSeek 的。

---

## 常见问题

**Q：改了代码，手机上还是旧的？**

三层缓存，**顺序排查**：

1. **Service Worker**：现在是自动更新的（注册时 `updateViaCache:'none'`
   + 主动 `update()`，接管后自动重载页面）。正常**重开一次**即可。
2. **Cloudflare 边缘缓存**：这是最隐蔽的一层。
   静态资源默认会被缓存，响应头里 `cf-cache-status: HIT` 就是命中缓存。
   排查方法：`curl -I <url>` 看 `cf-cache-status` 与 `Age`。
   **本项目已处理**：会变的资源（图标、头像）带 `?v=<构建版本>`，
   换版本即换 URL，绕过缓存；不带的则设为 `no-cache`。
3. **浏览器本地缓存**：前三层都没问题才怀疑它。

**关于「清除站点数据」**：那是最后手段，且会**连对话记录一起删掉**。
设置面板里有「导出备份 / 导入备份」—— 清之前先导出一份。
另外页面会申请持久化存储（`navigator.storage.persist`），
避免浏览器在磁盘紧张时自己回收数据。

**Q：改了图标/头像，线上没变？**

它们的 URL **不带内容哈希**，`_headers` 里已设为 `no-cache`。
但 Cloudflare 可能仍持有旧副本，此时给它加个查询串手动绕过：

```bash
curl -I "https://<你的域名>/icon-512.png?v=1"   # 看是否 REVALIDATED
```

正解是让构建注入版本串（`index.html` 与 `manifest` 里的 `__ASSET_VER__`）——
本项目已这样做，每次构建自动换版本。

**Q：部署后打不开 / 白屏？**

按 F12 看 Console：

- `Failed to resolve module specifier` → `dist-mobile/vendor/` 没生成，检查构建命令
- `404` → 输出目录填错，应为 `dist-mobile`（不是 `mobile`）

**Q：能「添加到主屏幕」但打开是浏览器页面？**

必须通过 **https** 访问。`http://` 或 IP 直连下 Service Worker 不启用，就没有 App 形态。

**Q：怎么更新？**

```bash
git add -A && git commit -m "更新" && git push
```

Cloudflare 检测到推送会自动重新构建部署。

---

## 为什么不直接托管 `mobile/` 目录

`mobile/chat.js` 引用的是 `../src/shared/*`（为了和桌面版共用一套人设/时间感知逻辑，
零复制）。部署时上传的只有 `dist-mobile/`，那个相对路径不存在 ——
所以 `mobile/build.js` 会把 shared 模块复制进 `dist-mobile/vendor/`
并改写引用路径。这是构建步骤存在的原因。
