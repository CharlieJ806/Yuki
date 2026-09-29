# AGENTS.md — 摸鱼桌宠 (desk-pet)

上班摸鱼用的桌面挂件：透明置顶桌宠 + 打卡 + 摸鱼收入统计 + AI 对话。Electron 38 + Vue 3 + Vite 6 + `node:sqlite`（零外部存储依赖）。单仓库含两端：桌面版在 `src/`，手机 PWA 在 `mobile/`。桌宠动画走纯 2D 路线（立绘切图；3D 方案已移除，2D 可动关节调研见 docs/DESIGN.md「桌宠动画」章）。

**`docs/DESIGN.md` 是本项目的完整决策记录**（约 1500 行）——每个设计都有踩坑因果。改任何敏感区域前，先读该文档对应章节，不要凭直觉回退已有做法。README 只做项目介绍。

**Tauri 2 迁移已完成（Phase 0-5），寄生式为终态**：Rust 只做系统边界（窗口/托盘/缩放/定位、`db.rs` 通用 SQL 桥、`http_proxy.rs` HTTP 代理），业务逻辑留 JS——同一份 JS 业务层跑 Electron 与 Tauri 两种壳，双路线并行。业务层不做 Rust 化：Phase 7 曾执行后退役（性能账单无可下沉重 + 蓝图闸门未触发），全量实现已归档、未随仓库发布，理由见 `TAURI_MIGRATION.md`「当前进度」。动 `src-tauri/` 或渲染层桥接前先读蓝图「当前进度」（含迁移铁律）。

## 命令

```bash
npm install
npm approve-scripts electron && npm approve-scripts esbuild && npm rebuild electron
# ↑ 本机 npm 拦截 postinstall，不放行则 electron 二进制没下载，electron . 直接报错

npm run smoke        # 冒烟测试（核心算法 + 数据层，node 直跑，无测试框架）
npm test             # smoke + chat-test（SSE 解析/错误翻译）
npm run dev          # Vite HMR + Electron 联动
npm run dev:web      # 仅 Vite dev server（Tauri 开发用）
npm run pack         # 打包免安装 exe 到 release/
node scripts/fake-llm.js 8788   # 无 API Key 调试对话（BaseURL 填 http://127.0.0.1:8788/v1）
```

无 lint / typecheck（纯 JS 未配置）；提交前验证 = `npm test` + `npm run build`（动了 `src-tauri/` 再加 `cargo test`）。无头验证真实 Electron 窗：`DESK_DEBUG_PORT=9222 npm run dev`。无头验证 Tauri 版：`npx tauri build --no-bundle` 后 `DESK_DEBUG_PORT=9224 ./src-tauri/target/release/app.exe`（CDP 9224；不设 env 则调试端口关闭，这是安全默认，勿回退）。

## 架构边界

```
src/main/index.js    主进程：窗口/托盘/IPC —— 只有这层能碰 electron
src/main/service.js  业务服务层 ─┐
src/main/chat.js     对话后端    ├─ 三者禁止 import electron（smoke 测试靠这点在 Node 直跑）
src/main/store.js    SQLite 数据层┘
src/shared/*.js      纯函数，桌面与手机两端共享（mobile 直接 import，零复制）
src/preload/index.cjs contextBridge，只暴露 window.desk 白名单
src/renderer/        单份构建产物，main.js 按 ?route=pet|panel|chat|chatpet|petmenu 挂五个应用
```

- 分层方向：`store ← service ← index.js(IPC)`；新增业务逻辑放 service，别塞进 index.js。
- 安全面：`contextIsolation: true` / `nodeIntegration: false`，IPC 全走 `ipcMain.handle` + channel 白名单，无动态转发；保持现状。
- Vite 别名：`@shared` → `src/shared`，`@` → `src/renderer`。
- 数据库在 `%APPDATA%\desk-pet\desk-pet.db`；所有业务表带 `updatedAt/deletedAt/syncState` 同步字段，新增表保持该约定。

## 硬规则（docs/DESIGN.md 有完整因果，禁止回退）

- **窗口只用 `hide()` 不销毁**；任何改动不能让用户失去找回入口（托盘单击兜底 `restoreAnyWindow()`）。
- **`petScale` 唯一真相来源是 `settings.petScale`**，渲染层用 computed 派生；三条修改路径统一走 `applyPetScale()` 并广播。
- **桌宠窗 / 菜单窗 / 立绘小窗尺寸 = 内容驱动贴合**：渲染层 ResizeObserver 量内容 → 壳层按锚点重设窗口 —— `pet_refit` 与 `pet_menu_resize` 按**右下角**锚定，`chatpet:resize` 按**底边**锚定（立绘站在窗口底部、换装面板在它上方展开，所以内容变高时窗口向上长，改顶边会让她的脚上下跳）；**禁止在壳层手写尺寸公式**（建窗初值除外：Tauri `scale.rs pet_size` / Electron `petSize` 仅首帧猜测）。注意 `chatpet:resize` **目前只有 Electron 侧**（Tauri 缺 `chatpet_resize` 命令，`window.desk.resizeChatPet?.()` 静默 no-op），补齐前别以为两端一致。右键菜单/面板等常驻 UI 一律独立小窗，禁止塞回桌宠窗；把手在 Tauri 下走 `startDragging`（CSS drag 会吞右键），禁改回纯 CSS。
- **桌宠位置持久化以右下角锚点为真值（`petPosition.v=4`：顶角+当时尺寸，恢复按锚点−建窗尺寸，两壳同式）**——顶角直存会把贴合位移当用户拖拽，位置每次重启漂移；禁改回纯顶角存档。建窗尺寸优先用存档尺寸（首启才用 petSize/pet_size 猜测），且放置后须按锚点补偿系统最小窗宽钳制（实测 96 宽被钳到 131，右缘 +35/次重启）。
- **桌宠拖拽用 `-webkit-app-region: drag`**，禁止「mousemove + setPosition」——事件会断流拖不动；交互元素须显式 `no-drag`。
- 节假日 API（timor.tech）**必须带 User-Agent**，否则返回 Cloudflare 页。
- 提示词顺序必须「稳定在前、易变在后」（token 差 50 倍）；改对话/人设/表情先读 docs/DESIGN.md「AI 对话」整章。
- `scripts/build.js` 已处理三个 Windows 打包坑（TEMP 网络盘、Defender 锁 exe、旧进程占用 EPERM），动打包前先读它的注释；打包后 fuse 加固在 build.js 内翻转（失败即终止），**不许绕过或关闭**。
- Electron 必须 ≥ 37（`node:sqlite` 需要 Node 22+）；`engines` 锁 `>=22.13`（node:sqlite 免 flag 的实际门槛）。
- **schema 变更必须走版本迁移**：改 `db-schema.js` 时递增 `SCHEMA_VERSION` 并在 store.js / store-bridge.js 的 ensureSchema 两处同步加迁移段（幂等、显式事务、失败 ROLLBACK）——只改 SCHEMA 不写迁移，存量库必挂。
- **偷偷摸摸模式（studyDisguise）伪装在数据出口**：金额/文案转换只发生在 service.getState + `shared/disguise.js` 词汇表；**组件禁止新写 `studyDisguise ? A : B`**，新可见文案先登记词汇表（smoke 锁伪装态不得含 摸鱼/已赚/¥）。
- **`chatApiKey` 脱敏口径**：Key 原文只在 settings 表与 `settings:getFull` 通道存在；state 快照、`session:settings` 及一切广播/新通道必须剥掉 Key。
- **Tauri 自定义命令不经 ACL**（capabilities 只管 plugin 命令）：新增涉 db/网络/系统状态的 command 必须在入口 `ensure_pet_window` 收权，否则对全部 webview 开放。
- **新增业务表四处同步**：`pendingChanges()` 与 `markSynced()` 白名单在 store.js / store-bridge.js 各一份，漏收的表接云同步后会静默丢数据。
- **版本号四处一处不少**（package.json / tauri.conf.json / Cargo.toml / installer.nsi）：`scripts/check-version.js` 挂在 npm test 里，bump 版本用它的输出确认。

## 工具纪律

- 改既有文件一律用 Write/Edit 工具；**禁止 node -e / fs.writeFileSync 脚本批量改文件，禁止 heredoc 写文件**——Git Bash 控制台的编码与转义层会悄悄写坏内容，且出错难以察觉。
- 同机不要同时跑 Electron 版与 Tauri 版（托盘、单实例、调试端口互相干扰）。

## 手机版（mobile/）

- 与桌面共享 `src/shared` 逻辑，**数据各自独立**（IndexedDB；注意 mobile/README「两个已知的 IndexedDB 陷阱」）。
- 无后端直连 LLM：依赖接口回 CORS 头（DeepSeek 实测可以）；换 API 不回 CORS 头就必须加中转。
- 改了 `src/shared` 的人设/时段表后，手机端要重新 `node mobile/build.js` 才生效。
- 部署走私有仓库 + Cloudflare Pages，见 `mobile/DEPLOY.md`。

## 本机环境差异（按开发机实际情况调整）

- 机器间网络环境不同：docs/DESIGN.md 里「出网必须走系统代理」只对部分机器成立；需要代理出网时把请求绑到本机代理端口
- 高分屏（显示缩放 200%，dpr=2）：涉及屏幕坐标的测试脚本必须按物理像素换算
- 合并他人/上游更新后，先看 docs/DESIGN.md 与接口差异再继续开发
