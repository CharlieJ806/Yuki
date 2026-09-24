# AGENTS.md — 摸鱼桌宠 (desk-pet)

上班摸鱼用的桌面挂件：透明置顶桌宠 + 打卡 + 摸鱼收入统计 + AI 对话。Electron 38 + Vue 3 + Vite 6 + `node:sqlite`（零外部存储依赖）。单仓库含两端：桌面版在 `src/`，手机 PWA 在 `mobile/`。桌宠动画走纯 2D 路线（立绘切图；3D 方案已移除，2D 可动关节调研见 README「桌宠动画」章）。

**`README.md`（约 1200 行）是本项目的完整决策记录**——每个设计都有踩坑因果。改任何敏感区域前，先读 README 对应章节，不要凭直觉回退已有做法。

**Tauri 2 迁移已完成（Phase 0-5），寄生式为终态**：Rust 只做系统边界（窗口/托盘/缩放/定位、`db.rs` 通用 SQL 桥、`http_proxy.rs` HTTP 代理），业务逻辑留 JS——同一份 JS 业务层跑 Electron 与 Tauri 两种壳，双路线并行。业务层不做 Rust 化：Phase 7 曾执行后退役（性能账单无可下沉重 + 蓝图闸门未触发），全量实现备份在 `backup/phase7-full-rust` 分支，理由与恢复方式见 `TAURI_MIGRATION.md`「当前进度」。动 `src-tauri/` 或渲染层桥接前先读蓝图「当前进度」（含迁移铁律）。

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
src/renderer/        单份构建产物，main.js 按 ?route=pet|panel|chat 挂三个应用
```

- 分层方向：`store ← service ← index.js(IPC)`；新增业务逻辑放 service，别塞进 index.js。
- 安全面：`contextIsolation: true` / `nodeIntegration: false`，IPC 全走 `ipcMain.handle` + channel 白名单，无动态转发；保持现状。
- Vite 别名：`@shared` → `src/shared`，`@` → `src/renderer`。
- 数据库在 `%APPDATA%\desk-pet\desk-pet.db`；所有业务表带 `updatedAt/deletedAt/syncState` 同步字段，新增表保持该约定。

## 硬规则（README 有完整因果，禁止回退）

- **窗口只用 `hide()` 不销毁**；任何改动不能让用户失去找回入口（托盘单击兜底 `restoreAnyWindow()`）。
- **`petScale` 唯一真相来源是 `settings.petScale`**，渲染层用 computed 派生；三条修改路径统一走 `applyPetScale()` 并广播。
- **桌宠拖拽用 `-webkit-app-region: drag`**，禁止「mousemove + setPosition」——事件会断流拖不动；交互元素须显式 `no-drag`。
- 节假日 API（timor.tech）**必须带 User-Agent**，否则返回 Cloudflare 页。
- 提示词顺序必须「稳定在前、易变在后」（token 差 50 倍）；改对话/人设/表情先读 README「AI 对话」整章。
- `scripts/build.js` 已处理三个 Windows 打包坑（TEMP 网络盘、Defender 锁 exe、旧进程占用 EPERM），动打包前先读它的注释。
- Electron 必须 ≥ 37（`node:sqlite` 需要 Node 22+）。

## 工具纪律

- 改既有文件一律用 Write/Edit 工具；**禁止 node -e / fs.writeFileSync 脚本批量改文件，禁止 heredoc 写文件**——Git Bash 控制台的编码与转义层会悄悄写坏内容，且出错难以察觉。
- 同机不要同时跑 Electron 版与 Tauri 版（托盘、单实例、调试端口互相干扰）。

## 手机版（mobile/）

- 与桌面共享 `src/shared` 逻辑，**数据各自独立**（IndexedDB；注意 mobile/README「两个已知的 IndexedDB 陷阱」）。
- 无后端直连 LLM：依赖接口回 CORS 头（DeepSeek 实测可以）；换 API 不回 CORS 头就必须加中转。
- 改了 `src/shared` 的人设/时段表后，手机端要重新 `node mobile/build.js` 才生效。
- 部署走私有仓库 + Cloudflare Pages，见 `mobile/DEPLOY.md`。

## 本机环境（用户机器，区别于原作者）

- 本机**无系统代理**（README 里「出网必须走系统代理」是原作者机器的情况）；需要代理出网时绑 `127.0.0.1:10808`
- 显示缩放 200%（dpr=2）：涉及屏幕坐标的测试脚本必须按物理像素换算
- 仓库 origin 为 `CharlieJ806/Yuki`，作者会持续推更新——同步后先看 README/接口差异再继续本地改造
