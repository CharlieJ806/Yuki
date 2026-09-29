# 摸鱼桌宠 (desk-pet)

上班摸鱼用的桌面小挂件：**悬浮在桌面上的 Yuki** + 打卡 + 摸鱼收入实时统计 + AI 对话。
她会按时间自己换姿势换衣服，你摸她（悬停 / 单击 / 双击 / 长按 / 拖拽）有不同反应，
混熟了会主动找你说话。另有一份**手机端 PWA** —— 同一个她，换个壳接着陪你。

**功能** · 桌宠（24 动作 × 24 装扮，随亲密度解锁）· AI 对话（DeepSeek / 任意 OpenAI
兼容接口 / 本地 Ollama，流式回复、可发图）· 摸鱼统计（按真实日历算日薪）·
打卡（含漏打补卡，自动识别节假日与调休）· 图鉴（装扮 24 套 + 生活照 23 组）·
亲密度（5 档，关系变近后说话方式和行为真的会变）

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 壳 | Electron 38 + Tauri 2 | 双壳同构：同一份 JS 业务层跑两壳，Rust 只做系统边界 |
| 渲染 | Vue 3 + Vite 6 | 单份产物按 `?route=` 挂 5 个应用（pet/panel/chat/chatpet/petmenu） |
| 存储 | Electron `node:sqlite` / Tauri rusqlite 桥 | 两壳共用表结构，service 层全异步 |
| 立绘 | 切好的透明 PNG | 由 AI 多格图切分；无 3D、无骨骼 |
| 打包 | @electron/packager / tauri build | 绿色版目录（双击即用）或 NSIS 安装包 |

> Electron ≥ 37（Node 22+，`node:sqlite` 所需）；该要求只约束 Electron 壳。

## 快速开始

```bash
npm install
# npm 默认拦截依赖的 postinstall，Electron 二进制不会自动下载，必须先放行：
npm approve-scripts electron && npm approve-scripts esbuild && npm rebuild electron

npm run dev      # 开发（Vite HMR + Electron）
npm run pack     # 打包 → release/摸鱼桌宠-win32-x64/（双击即用）
npm test         # 冒烟 + 对话/SSE 测试
```

**AI 对话是可选的**：在「设置 → AI 对话」填 API Key
（[DeepSeek 平台](https://platform.deepseek.com) 申请，形如 `sk-xxx`），
或选「本地 Ollama」走 `http://127.0.0.1:11434/v1` 完全离线。
调试时不必用真 Key —— `node scripts/fake-llm.js 8788`，BaseURL 指向
`http://127.0.0.1:8788/v1` 即可。

**手机版**：`npm run mobile` 构建并预览；`dist-mobile/` 整体上传到任意静态托管
（**必须 https**，否则无法「添加到主屏幕」）。

## 目录

```
src/main/       Electron 主进程 + 业务服务层（窗口/托盘/IPC/SQLite/对话后端）
src/preload/    contextBridge 桥（window.desk）
src/shared/     两端共用纯逻辑（摸鱼算法/人设/互动/图鉴/时间感）
src/renderer/   Vue 3 桌面端
src-tauri/      Tauri 壳（Rust：窗口/托盘/SQL 桥/HTTP 代理）
mobile/         手机端 PWA（原生 JS，产物在 dist-mobile/）
resources/      素材源：AI 多格图、切好的立绘、照片原图（只放不改）
scripts/        切图 / 装素材 / 打包 / 出图 / 生成图标
docs/           设计文档（见下）
```

立绘与照片都是 **AI 出多格图 → 切分 → 无损导出**（`scripts/gen-*.js` → `split-sheet.js`
→ `install-pet-assets.js`），不是手绘，链路细节见设计文档。

## 文档

README 只做介绍。**每处「为什么这么写」的推理在 [docs/DESIGN.md](docs/DESIGN.md)** ——
窗口尺寸约束、缩放单向来源、拖拽为何交给系统、提示词顺序对缓存命中率的影响、
时间感注入、亲密度如何变成行为、立绘链路、打包踩过的 Windows 坑、数据同步方案等。

**改敏感区域前请先查那份文档**，里面记了不少「看起来能改、改了会坏」的地方。

## 安全边界

`contextIsolation: true`、`nodeIntegration: false`，渲染进程只能访问 preload 白名单的
`window.desk`；主进程 IPC 走 channel 白名单，无动态转发。
**不联网、不上传**，数据全部本地读写（数据库在 `%APPDATA%\desk-pet\desk-pet.db`），
API Key 只存在本机。
