# Tauri 2 迁移方案

> 状态：方案 v3（执行中止于 Phase 5，寄生式为终态）。基线数据为 2026-09-23 实测（Electron 38，方法见 §8）。
> v3 修正：终态改回「寄生式永续」——Phase 7（业务层全量 Rust 化）执行至步骤 4 后整体退役，理由与备份分支见「当前进度」；v2 的「全量 Rust 终点」与 §0 决策闸门保留为历史记录，一切以「当前进度」节为准。
> Phase 0 spike 已于 2026-09-23 完成：5/5 通过，结论 GO（实测记录见 §4 Phase 0）。
> 上游同步：作者已在 a09a0e7 移除 3D 方案回到纯 2D（2D 可动关节调研见 README）——本方案的 3D 专项随之降级为平台能力验证记录，迁移结论不变；2D 可动关节仍是 webview 内渲染，不影响任何架构决策。
> 本文是迁移期间的执行蓝图；完成后关键决策回写 README，本文归档。

## 当前进度

**最后更新：2026-09-23（Phase 7 退役，寄生式为终态；Tauri 侧落地 Phase 0-5。全量 Rust 业务层实验备份在分支 `backup/phase7-full-rust`。验证基线：npm smoke 339 + chat-test 138、cargo test 19/19、双构建全绿。）**

- **路线决策（终版）**：Electron 与 Tauri **双路线长期并行**，Tauri 以**寄生式为稳态终点**——Rust 只做系统边界（窗口/托盘/缩放/定位、`db.rs` 通用 SQL 桥、`http_proxy.rs` HTTP 代理），业务逻辑（service/chat/store/moyu/interactions/content）**留 JS**，同一份 JS 业务层跑两种壳。
- **Phase 7 退役理由（勿无故重启）**：
  1. 性能账单显示业务层无可下沉重：渲染大头是 CSS 合成（Rust 接不了）；内存大头在 WebView2 进程树（与业务层语言无关，真正的杠杆是 set_shown 这类壳层工作）；SQLite 个人量级差异微秒级；最重的 JS 计算亚毫秒，移入 Rust 反而引入 IPC 往返（如面板 30s 刷新变 invoke）。
  2. §0 决策闸门三条（云同步 / 隐藏期后台任务 / mobile 转 Tauri）均未触发——按 §0 原规则「寄生式即为合理稳态」。
  3. 双路线并行下 Rust 业务层 = 与永生的 JS 层（Electron/mobile 在用）永久双实现：维护面翻倍、每次改动两侧同改 + fixtures 重生成；切片后两套状态机写同一 desk-pet.db 有数据漂移风险。
- **Phase 7 遗产（备份分支内容，恢复即用）**：moyu/interactions/content/chat 纯函数、store 全 surface、chat_net（SSE/错误翻译/abort）六模块 + fixtures 220 用例 + parity 对账 harness（gen-fixtures.mjs）。对账方法论（JS 真值源 → fixtures → Rust 重放）已验证有效（曾抓出 serde_json 浮点需 float_roundtrip、payday 时区方向、返回形态、`??` vs `||0`、UTF-16 计数五类差异）；闸门信号出现时 `git checkout backup/phase7-full-rust` 续做，届时只对真正受益面（同步层 diff/加密、后台任务）Rust 化，业务规则仍留 JS。
- **已完成**：Phase 0-5（详见 §4 各阶段实测结论与 REVIEW_FINDINGS P1-P8）；**Phase 5 打包发布**——
  - `tauri.conf.json`：bundle targets 收敛 `["nsis"]`；NSIS `installMode: currentUser`（免管理员）+ SimpChinese/English 双语言；`webviewInstallMode: downloadBootstrapper` 显式声明（老 Win10 无 WebView2 时安装器自动引导下载）；删除 beforeBuildCommand 里的 3D 遗物（`scripts/make-minimal-glb.mjs` 已删，spike 时代 GLB 验证不再需要）
  - 双产物实测：**portable exe 25.6MB**（目标 ≤30 达标，含 12MB 视频+1MB 立绘资源嵌入；对比 Electron 322MB）+ **NSIS 安装包 15.6MB**
  - 冒烟：portable exe 功能冒烟通过；NSIS `/S` 静默安装（currentUser，落 `%LOCALAPPDATA%\yuki-desk-pet\`）→ 安装版启动读取同一 DB → 卸载 `/S` 干净（快捷方式/程序全清），Defender 实时防护未拦截；WebView2 缓存目录（`%LOCALAPPDATA%\com.yuki.deskpet`）与用户 DB（`%APPDATA%\desk-pet`）按设计保留
  - Tauri 产物打包由 bundler 接管；旧 `scripts/build.js`（TEMP 网络盘/Defender 锁 exe/EPERM 三坑）继续服务 Electron 路线的 `npm run pack`（双路线并行，Electron 不退役）
- **Phase 5 踩坑**：NSIS 工具包首次从 GitHub 下载超时（本机无系统代理）——带 `HTTPS_PROXY=http://127.0.0.1:10808` 重跑即过，工具包缓存后不再需要。
- **待人工**：干净虚拟机（无 WebView2）的 downloadBootstrapper 安装路径；双击安装（非 /S）时 SmartScreen 的表现与规避（未签名 exe 常见提示，与 Electron 版同状）。
- **内存实测（修正 §1 预期，详见 REVIEW_FINDINGS P5）**：净驻留（仅 pet）~241MB（目标 140 未达）；pet+panel 可见 ~453MB；panel 隐藏后 ~305MB；全开 4 窗 ~735MB（目标 340，Electron 基线 395）。归因：GPU ~145MB 固定（两框架同付）+ WebView2 browser 进程 ~50MB 固定 + 每窗独立渲染进程成本，「渲染进程数不变」的 §8 假设不成立。磁盘/启动时间/安全面收益不变，迁移结论不变；全开态可用「隐藏窗延时销毁」（§8 预留）再压。
- **Phase 4 其他记录**：JS window.close() 僵尸态风险（P4，生产零调用）；dev 形态（直接 cargo build）IPC origin 坑（P6，验证一律用 `npx tauri build --no-bundle` 产物）；tauri/tauri-build 版本精确锁定且**不开 unstable**（P7：unstable 会改换 webview 宿主模型 WindowContent→WindowChild，破坏无边框可调窗边缘缩放）。

- **Phase 3 实现要点**：Rust `http_proxy.rs`（stream/once/abort，tokio watch 令牌池 + 共享 reqwest Client；`drain_complete_lines` 纯函数）；shared `bridge/transport.js`（注入点，默认全局 fetch）；chat.js 3 处 / holiday.js 1 处改走 transport，**parseSSE 零改动**；renderer `lib/tauri-transport.js`（Response-like 包装），service-host 启动最先安装。
- **Phase 3 关键设计（勿回退）**:
  1. **帧协议** `{event:'status'|'line'|'end'}`——status 帧必须先于数据行（chat.js 在消费 body 前就要读 `res.ok`，与 fetch 语义对齐）；line 是含尾 '\n' 的完整行；非流式调用（completeOnce/pingChat/holiday）也统一走流式命令 + JS 聚合 text()/json()，一条代码路径。
  2. **id 由 JS 生成、invoke 前挂好 abort 监听**——消除「等 streamId 返回窗口期 abort 丢失」的竞态。
  3. **abort 本地竞速**：signal.abort() 立即以 AbortError 拒绝（不等 Rust 回包），同时 invoke http_abort 让 Rust select 竞速退出；wholeText 聚合挂兜底 catch 防 unhandled rejection。
  4. loadSelfPortrait **不需要** Rust command——service-host 用相对路径 fetch dist 内立绘（public/ 随构建进 dist，asset protocol 可达）+ FileReader，已工作。
- **Phase 3 验证记录**：cargo test 19/19（+7：行切分中文跨块/粘包/CRLF、取消池生命周期）；npm test 全绿（smoke 339/339 + chat-test 138/138，chat-test 新增 Tauri transport 模拟节 9 用例：流式拼接/中文完整/429 翻译/ping 聚合/abort 竞速）；双构建全绿。OS 级（CDP 9224 + fake-llm 8788）：流式 18 行帧全达字节级一致；headers 等待期 abort 4ms 竞速退出且幂等；业务 chat:send 回复正确 + 8 次 chat-delta 逐字广播 + chat-done；chat:test（pingChat 聚合路径）pong；chat:diagnose 全链路自检 ok；**节假日真实公网拉取成功（holiday-2026 入库，Rust 代理带 UA）**；spike.html 三项 http 测试全绿。
- **Phase 3 环境事实（新会话注意）**：本执行环境对**会话中新 spawn 的监听进程网络隔离**（新起端口 TCP 通但 HTTP 不响应；早期启动的进程不受影响）——慢流靶子 slow-sse.mjs 因此不可达，「读流中途 abort」的业务级实测改由证据链覆盖：Rust 真实 select 取消（headers 期实测）+ JS 包装层竞速（chat-test）+ 同一 select 读流循环（单测）。待人工复验时一并补。
- **待人工复验**（累计）：托盘菜单点击动作与快照文案（自动化打不到托盘）；图鉴/亲密度/补卡/对话的 UI 交互层；**真实 DeepSeek Key 对话一轮 + 对话窗流式中断按钮实测**；托盘打卡在宿主就绪前秒级窗口期静默丢失（已有 pet 不在先重建兜底）。
- **迁移铁律（踩坑实录，违反即坏；新会话必读）**：
  1. **WebView2 的 additionalBrowserArgs 由第一个窗口决定，所有窗口必须完全一致**——不一致时后续窗口 `build()` 返回 Ok 但 webview 永不落地。Rust 建窗统一走 `windows::apply_debug_args`（env 单点控制调试端口）。
  2. **事件回调（托盘/页面加载/单实例）在主线程事件派发里，回调内直接 `build()`/窗口操作会死锁**。一律 `tauri::async_runtime::spawn`；窗口类 command 必须 `async fn`。
  3. **rusqlite `execute` 不允许多语句**——SCHEMA 等多语句 SQL 必须走 `execute_batch`（db.rs 对无参 SQL 自动分流）。
  4. **service 对外 surface 必须全 promise**——node:sqlite 同步 store 下，透传方法不 `async` 包一层，Electron 侧拿到裸值直接崩。
- **Phase 2 逐行对比审查（2026-09-23，基线 = 上游 3346723）结论**：
  - 六个纯逻辑文件（preload/chat/holiday/moyu/content/interactions）相对基线**零改动**（git 证明 SSE 解析、节假日抓取、摸鱼算法原样）。
  - store SQL：基线 31 条语句逐字一致（whitespace 归一化），1 条（settings 建表）移入 db-schema.js；行映射 6 函数逐字一致。
  - service.js 剥离 await/async 后词级 diff 共 166 片段，全部属于已知机械改造（默认参数体内解析/store 注入/注释）；无意外逻辑漂移。两处有意等价替换已注释（streak 节假日表预载、getAffinity 跟随显式 sid——后者修正了原版 getState(sid=X) 时亲密度仍读「最近会话」的潜在不一致）。
  - desk 方法面：preload 56 方法在 shim 全部存在且通道一致（窗口类为 snake_case command）。
  - 审查发现并修复 1 个真实缺口：create_pet 未读持久化 petScale（Electron 会读），缩放后重启热区错位——已修并实测闭环（写 1.3 重启精确恢复 442×910 逻辑）。
- **Phase 2 双视角逐行比对（2026-09-23）**：按业务数据层 / 外壳层+简化空间两个视角静态逐行比对，产出 `REVIEW_FINDINGS.md`：4 高 + 4 中 + 10 低 + 5 简化，已全部处置（20 修 / 2 记录为有意偏差 / 1 计划内）。要点：总线 15s 超时误伤流式对话、bus:ready 一次性广播导致后开窗口每次调用白等 20s（修后实测首调 35ms）、全窗销毁即整体退出击穿找回入口硬规则（改 RunEvent::ExitRequested 拦截，实测 Alt+F4 关桌宠应用存活、pet_quit 仍可退出）、WebView2 调试端口默认常开（收敛为 DESK_DEBUG_PORT env-only，spike 窗随之移入 Rust 创建）、Electron 壳补串行队列、补卡改单条多行 INSERT 消除事务卷入面、ShellState 冗余层删除等。Service.js 剥离 await/async 后词级 diff 共 166 片段全部为机械改造，无逻辑漂移。
- **下一步**：双路线维护期——功能开发落在共享 JS 层，Tauri 壳层同步验证；可选收尾项：README/AGENTS 双路线章节改写、本文归档。spike 验证窗与无调用方的 db_txn 事务命令已清理。切换前最后一轮人工复验清单见上。
- **复验方法**：仓库根 `npx tauri build --no-bundle`（exe 被旧进程占用时先 `taskkill //IM app.exe //F`）→ `DESK_DEBUG_PORT=9224 ./app.exe` 启动（调试端口默认关闭，H4 修复后必须显式设 env 才有 CDP）→ CDP 9224 断言（工具 `.tmp-yuki/cdp-act.mjs`；联调靶子 `node scripts/fake-llm.js 8788`，BaseURL 填 http://127.0.0.1:8788/v1，model 随意，127.0.0.1 免 Key）；Electron 回归 = `DESK_DEBUG_PORT=9223 npm run dev` + CDP 9223（同机勿双版本同时跑，共享 DB 有并发写风险）；Node 侧 `npm test` 必须全绿。
- **本机事实**：无系统代理（需要时绑 `127.0.0.1:10808`）；dpr=200%；vite dev server 仅绑 IPv6 localhost；本机屏幕 2880×1800 物理 / 1440×900 逻辑。

## 0. 决策摘要

**架构路线（v2）：终点是全量 Rust 后端；执行分两段。**
第一段（本方案 Phase 0-6，15 个工作日）：薄 Rust 宿主 + JS 业务层寄生常驻桌宠窗（下称「寄生式」），先上线拿到 Tauri 的确定性收益。第二段（Phase 7，上线稳定后启动）：业务层逐模块下沉 Rust，最终拆除总线与 JS 业务层。

| 维度 | 一次到位（大爆炸全量 Rust） | **两段式（选定）：寄生式 → Phase 7** |
|---|---|---|
| 首个可用 Tauri 版 | 第 4 周左右 | **第 15 个工作日** |
| 回归风险 | 集中：换壳+换核同时爆发 | **分散**：每段都是行为保持型迁移，可对照 Electron 基线逐项验证 |
| 过渡脚手架（async 化 + 总线，~2-3 天） | 不需要 | 需要，第二段拆除——这是保险费 |
| 两段总成本 vs 一次到位 | — | **≈ 一次到位 + 2-3 天**，换早收益 + 低风险 |
| 长期终态 | 全 Rust | 全 Rust（同一终点） |

**为什么不直接大爆炸**：换壳（Electron→Tauri）与换核（JS→Rust）是两次独立的等价重构。第一段与全量 Rust 的对应阶段共用 ~80% 的工作（Phase 0 spike、外壳、store 桥、transport 注入、拖拽迁移、打包、parity 清单全部共用）——store 桥正是 Rust 化的入口而非弯路。

**为什么终点定全量 Rust 而不是寄生式永续**（v2 修正的三个依据）：

1. **云同步在路线图上**：所有业务表带 `updatedAt/deletedAt/syncState`，`pendingChanges()/markSynced()` IPC 已就位。同步引擎需要**窗口全隐藏时也可靠运行的后台常驻**——这是 webview 宿主（寄生式）的弱项（Chromium 节流策略漂移、Evergreen 升级影响、webview 崩溃连坐业务层），是 Rust 宿主的强项。
2. **双真相税比初判小**：打卡/收入算法桌面独有（手机端不做摸鱼统计），Rust 化零重复；人设/服饰剧情/视频故事的主体是**数据**，抽 JSON 单源两端共读（这本身是笔好重构）。真正双份的只有提示词组装/时段上下文/触发判定，约 600-900 行，用 golden test 管住漂移（§11）。
3. **状态核受益于类型安全**：钱、亲密度、同步记账是正确性关键路径，Rust 的编译期保证长期降低缺陷率；且与 Tauri 框架的主 grain 一致（官方 IPC/插件生态都假定 Rust 侧逻辑）。

**保留的约束**：AI 内容（人设/触发规则/剧情）是本应用的差异点且高频迭代，这段循环必须保持最快——第二段中内容逻辑「数据化优先、双份+对账兜底」，不无脑全移植。

**决策闸门**（出现任一信号 → 启动 Phase 7；三条都否 → 寄生式即为合理稳态，第二段无限期推迟）：
确定做云同步 / 出现需要在窗口全隐藏时可靠运行的后台任务 / mobile 愿意转 Tauri mobile（单真相整体搬入 Rust）。

## 1. 目标与非目标

**目标**（验收指标见 §9，复测方法沿用 `.tmp-yuki/` 下的实测脚本）：

| 指标 | Electron 基线（实测） | Tauri 目标 |
|---|---|---|
| 驻留私有内存（仅桌宠） | 172 MB | ≤ 140 MB（**Phase 4 实测 ~241MB，未达**：WebView2 browser 进程 + GPU 固定开销，见 REVIEW_FINDINGS P5） |
| 全开私有内存（4 窗） | 395 MB | ≤ 340 MB（**实测 ~735MB，未达**；隐藏窗延时销毁可再压，panel 已藏态 ~305MB） |
| release 磁盘占用 | 322 MB | ≤ 30 MB |
| 冷启动到桌宠可见 | ~2 s | ≤ 1.2 s |
| 功能 parity | — | 回归清单（§7.3）100% 通过 |

注：性能指标均为 **2D 模式口径**（上游 a09a0e7 已移除 3D 方案，2D 成为唯一模式）。原「3D 专项」降级为平台能力记录：spike 已验证 WebView2 下 WebGL alpha 画布硬件加速可用——若未来 2D 可动关节路线引入 canvas/WebGL 渲染，该结论直接适用，无需重新 spike。

**非目标**：mobile/ 不动（PWA + Cloudflare Pages 照旧）；`src/shared` 的 API 与行为不变；暂不做 Tauri mobile 端与自动更新；不做 UI 改版；业务层下沉 Rust 属第二段（Phase 7），不在本期。

## 2. 目标架构（第一段，Phase 0-6；第二段终态见 Phase 7）

### 2.1 迁移前后对比

```
【迁移前 Electron】                          【迁移后 Tauri 2】
┌─ main 进程 (Node) ─────────┐              ┌─ Rust 宿主 ────────────────┐
│ index.js  窗口/托盘/IPC     │              │ 窗口管理 ×4 / 托盘 / 单实例  │
│ service.js 业务层          │              │ apply_pet_scale / 定位持久化 │
│ store.js  node:sqlite      │              │ rusqlite 桥 / http 流代理   │
│ chat.js + holiday.js       │              └──────────────┬──────────────┘
└────────┬───────────────────┘                     invoke（限 pet 窗 ACL）
    ipcMain.handle ×55                     ┌──────────────┴──────────────┐
┌────────┴───────────────────┐             │ pet 窗（常驻宿主）            │
│ 4 个渲染窗（window.desk）    │             │  service.js（async 化）      │
└────────────────────────────┘             │  store-bridge → rusqlite 桥  │
                                           │  chat.js（transport 注入）    │
                                           │  serviceBus 总线（req/res）   │
                                           ├─ panel / chat / chatpet 窗 ──┤
                                           │  desk-shim → 总线客户端       │
                                           └─────────────────────────────┘
```

### 2.2 五个关键设计决策

1. **业务层宿主 = pet 窗**。桌宠是本应用事实上的常驻单例（hide 不销毁 + 托盘 `restoreAnyWindow` 兜底重建），让 service 随它存活，不引入额外隐藏窗（省 ~30MB），无新增生命周期概念。pet 窗 webview 崩溃时 Rust 重建窗口 → service 重新挂载（现状 Electron 主进程崩溃则整个应用已死，不劣化）。
2. **Rust 不实现业务，只实现四类系统能力**：窗口/托盘/定位/单实例；`db_exec/db_select/db_txn`（rusqlite，`Mutex<Connection>` 串行化，天然单写者，**ACL 仅开放给 pet 窗**）；`http_stream/http_once/http_abort`（reqwest 流代理，带 User-Agent、绕开 CORS 不确定性）；`apply_pet_scale`。
3. **跨窗调用走自研轻量总线**（serviceBus，预计 ~120 行）：`bus:req / bus:res` 事件对 + requestId 关联 + 15s 超时。**流式对话不复用总线**——chat chunk 现在就走 `desk:event` 广播，语义不变。启动时序用 `bus:ready` 门控（panel/chat 打开时若宿主未就绪则等待）。
4. **IPC handlers 表抽成纯 JS 模块**（`ipc-handlers.js`）：现有 index.js 里 55 个 handler 的映射表几乎原样抽出。Electron 兼容期 `index.js` import 它注册到 `ipcMain.handle`；Tauri 期 pet 窗 import 它挂到 serviceBus。**同一张表双端复用**，是 parity 的基石。
5. **传输/解析解耦**：`chat.js` 与 `holiday.js` 的 `fetch` 换成可注入 transport（默认仍为全局 fetch，Node 测试零改动；Tauri 运行时注入 Rust 流代理的 Response-like 包装）。

### 2.3 保留不变的硬规则（映射到 Tauri 语义）

| 硬规则 | Tauri 落法 |
|---|---|
| 窗口只用 hide() 不销毁 + 托盘兜底找回 | 同语义：`window.hide()`；托盘单击 `restore_any_window()`；菜单文案随可见性重建（监听窗口事件） |
| petScale 单一真相 + 三路径统一 + 广播 | Rust 侧唯一 `apply_pet_scale()`；`pet_set_scale` command 内部先写设置再调它再广播，与现状逐步一致 |
| 拖拽必须系统级，禁止 setPosition 回写 | `data-tauri-drag-region`（同为系统级拖拽）。**语义差异**：Electron 按 DOM 祖先判定，Tauri 按「事件 target 自身带属性」判定——每个 drag/no-drag 注解要按 §5.4 核对表重审 |
| 节假日 API 必须带 User-Agent | http 代理在 Rust 侧统一注入 UA |
| 提示词「稳定在前易变在后」 | 纯 JS 复用，零改动 |
| 业务表带 updatedAt/deletedAt/syncState | SQL 原样搬进 store-bridge，零改动 |

## 3. 目标目录结构

```
src-tauri/                    # 新增：Rust 宿主
  src/
    main.rs                   # 入口、单实例插件、生命周期
    windows.rs                # 4 窗创建/规格/定位/工作区夹取/事件联动
    tray.rs                   # 托盘图标 + 动态菜单 + 单击兜底
    scale.rs                  # apply_pet_scale（唯一缩放路径）
    db.rs                     # rusqlite 桥（Mutex 串行 + 事务批）
    http_proxy.rs             # http_stream / http_once / http_abort
    position.rs               # petPosition 持久化 + 显示器工作区校验
  capabilities/pet.json       # db/http 仅授予 pet 窗
  tauri.conf.json
src/main/                     # 迁移期保留（Electron 兼容），切换后删除
  ipc-handlers.js             # ★新：从 index.js 抽出的 handlers 表（双端复用）
src/shared/                   # 不动
  bridge/
    store-bridge.js           # ★新：store 同 surface，async，invoke db 桥
    transport.js              # ★新：http transport 注入点 + Tauri 流包装
src/renderer/src/
  lib/desk-shim.js            # ★新：实现与 preload 完全相同的 window.desk 接口
  lib/service-bus.js          # ★新：总线宿主端（pet 窗）+ 客户端（其他窗）
  （stores/views/components 基本不动，仅拖拽注解迁移）
scripts/
  measure.ps1 / cdp-act.mjs   # ★已有（.tmp-yuki/）：内存/CDP 实测，迁入 scripts/
```

## 4. 分阶段计划

每阶段有硬验收线，不过不进下一阶段。Electron 版全程保持可运行（回滚保障）。

### Phase 0 — Spike（1 天，go/no-go 决策点）

新分支 `feat/tauri`，`npm create tauri` 最小壳，只验证五件事：

1. **透明置顶窗**：transparent + decorations(false) + alwaysOnTop，WebView2 下无黑底/白闪（注意 webview 背景也要透明；历史 issue 的 workaround：decorations 先 false）。已知怪癖备查：tauri#4881。
2. **系统级拖拽**：`data-tauri-drag-region` 拖拽顺滑；**拖拽结束后 click 是否仍派发**（Electron 会，需要位移标志区分「拖/点」——Tauri 行为要实测，决定 PetApp.vue 的改动写法）。
3. **3D 渲染专项 → 平台能力验证**（上游已移除 3D 产品方案，本项降级为记录，结论保留）：`WebGLRenderer({alpha:true}) + setClearAlpha(0)` 在 WebView2 透明窗上正常合成；GLB 经 asset/custom protocol 能被 `GLTFLoader.loadAsync` 拉到（XHR arraybuffer 路径）；离屏 canvas 逐像素 alpha 掩膜（鼠标穿透）readback 正常；按需渲染的 rAF 在透明窗不被吞；**查 WebView2 GPU blocklist**——老驱动可能被禁硬件加速落到 SwiftShader 软件渲染（34fps → 幻灯片），备 `--ignore-gpu-blocklist` 经 `additional_browser_args` 注入；WebGL canvas 与 `data-tauri-drag-region` 的层叠共存（3D 模式下拖拽热区）。已有三项前端硬指标（透明背景/自动取景/鼠标穿透）是协议无关的纯 webview 逻辑，预期不动，但要在 WebView2 里逐项复测。
4. **`?route=` 查询串**：`WebviewUrl::App("index.html?route=pet")` 在 asset protocol 下 `location.search` 是否拿到值。备选方案：Rust 每窗注入 initialization script 设 `window.__ROUTE__`。
5. **http 流代理**：reqwest bytes_stream → Channel 回推 JS，逐 chunk 到位（拿 fake-llm.js 当靶子）。

**通过标准**：5 项全绿 → 进入 Phase 1。透明窗或拖拽不过 → 停止迁移，回到 Electron 优化路线（销毁策略仍值得做）。

#### Phase 0 实测结论（2026-09-23，本机 Win11 + WebView2 153 + dpr=200%）：**GO，5/5 通过**

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 透明置顶窗 | ✅ | OS 级截图：桌面内容透过透明区可见，拖拽条文字与 WebGL 三角形正常叠加；`transparent+decorations:false+alwaysOnTop` 配置即生效，无需 workaround |
| 2 | 系统级拖拽 | ✅ | SendInput 真实拖拽位移 **精确 +150/+80px**；拖拽条内按钮按压**未**触发拖拽（target 自身判定语义确认），事件序列 mousedown/mouseup/click 完整到达按钮 |
| 3 | WebGL 透明画布 | ✅ | 硬件加速 `ANGLE (AMD Radeon, D3D11)`——**非 SwiftShader，无 blocklist 问题**；alpha 画布角落 α=0 / 三角形中心 α=255；合成截图正常 |
| 4 | `?route=` 查询串 | ✅ | asset protocol（release 构建直跑 exe）下 `location.search` 完整保留 |
| 5 | HTTP 流代理 | ✅ | `http_once` 200；流式按**生产形态**验证：Rust 按完整行切分 + `Channel<String>` → 169/169 条全达、字节级一致、0 发送失败 |

**spike 反发现（已纳入后续阶段设计）**：

1. **`Channel<Vec<u8>>` 原始字节路径不送达**（JS 侧 onmessage 不触发）——传输层定型为：Rust `split_inclusive(b'\n')` 按行累加（字节安全，不切多字节字符）→ `Channel<String>` → JS `TextEncoder` 转回 Uint8Array → **现有 `parseSSE` 与 chat-test 全部零改动**（Phase 3 落地）。
2. **release 构建时 exe 被旧进程占用 → cargo `os error 5`**——与 README 记录的 Electron 打包坑同款，Phase 5 构建脚本需先检测/杀旧进程。
3. **frontendDist 资产在构建期嵌入**；运行时动态产物（未来的用户导入模型）须走 resource 目录或 userData + asset protocol scope（Phase 5 演进项，已在 §5/Phase 5 记录）。
4. 本机 dpr=200%：测试脚手架必须用 CDP 读物理坐标，PowerShell DPI 非感知进程的坐标被虚拟化（仅影响测试工具，不影响应用）。
5. `withGlobalTauri` 下 Channel 位于 `__TAURI__.core`（非 `.ipc`）。
6. 本机 vite dev server 绑定 IPv6-only localhost，探测地址用 `localhost` 不用 `127.0.0.1`。
7. 本机**无系统代理**（README 中「必须走系统代理」为原作者机器情况）；需要代理的环境绑 `127.0.0.1:10808`——Phase 3 的 `http_proxy.rs` 把代理做成可选显式配置（settings/env），不假设系统代理存在。

### Phase 1 — 外壳（3 天）

- 4 窗规格迁移（§5.1 对照表）：pet / panel / chat / chatpet（含 non-focusable、min/max 尺寸、skipTaskbar、shadow off）。
- 托盘：32×32 图标资源（`scripts/make-icons.js` 产 PNG → `tauri icon`）、动态菜单重建（监听 show/hide/destroyed）、单击兜底、通知插件替代 `displayBalloon`。
- 单实例插件；`second-instance` → 开面板。
- desk-shim v1：窗口控制类 command（`window:openPanel` 等 7 个）走 Rust，其余先桩。
- Vite：dev 模式 `devUrl` 指向现有 5199 端口，HMR 流程不变；`DESK_DEBUG_PORT` 等价物（WebView2 支持 `--remote-debugging-port`，经 `additional_browser_args` 注入）。

**验收**：桌宠出现、可拖、托盘全套行为（含找回矩阵）可用；panel/chat 能开但界面半残（无数据）。

#### Phase 1 实测结论（2026-09-23，本机 Win11 + WebView2 153 + dpr=200%）：**完成，验收线通过**

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 桌宠出现 | ✅ | pet 窗右下落位 (1076,128) 逻辑 / 340×700，CDP 注册 `?route=pet`，透明渲染正常 |
| 2 | 桌宠可拖 | ✅ | SendInput 从把手真实拖拽位移 -187/-154 物理 px（y 顶到工作区上边界，与夹取算法一致）；用户手动复测正常 |
| 3 | 窗口规格 ×4 | ✅ | chat 贴 pet 右上（x=1992 精确对齐 pet 右缘）并夹进工作区；chatpet 贴对话框左侧、focusable off；panel 居中 1080×720 按需创建；hidden 不销毁 |
| 4 | 窗口类 IPC | ✅ | 12 个窗口/系统 command 全通（async fn）；petVisible/toggle/openPanel/openChatWindow/单实例→开面板均断言 |
| 5 | desk-shim v1 | ✅ | Tauri 环境下自动安装（Electron/浏览器各归其位），`window.desk.petVisible()/getState()` 可用，业务桩返回空数据 |
| 6 | 托盘 | ✅* | 猫脸图标 + 动态菜单 + 单击兜底就位；**菜单点击动作待人工复验**（自动化无法点托盘；底层函数与 command 同源已全通，且修复了回调主线程死锁） |
| 7 | 单实例 | ✅ | 第二次启动自动退出，主实例面板弹出 |

Phase 1 踩出的铁律已汇总至「当前进度」节的迁移铁律清单（WebView2 args 全窗一致；事件回调内窗口操作必须 spawn）。

### Phase 2 — 数据与业务桥（3 天，最大的一块）

- Rust：`db.rs` 三 command（exec/select/txn，`spawn_blocking` + `Mutex<Connection>`；DB 路径**显式**用 `%APPDATA%\desk-pet\desk-pet.db`，与 Electron 版共用同一文件，见 §6）。
- JS：`store-bridge.js`（同 store.js surface，async）；`service.js` async 化（机械改造：所有 store 调用点加 await，~40 个方法）；`ipc-handlers.js` 抽表；`serviceBus` 宿主端挂进 pet 窗，客户端进 desk-shim；`bus:ready` 门控。
- 双 store 后端保持：Node 环境（`npm test`）继续用 node:sqlite 版 store.js，Tauri 运行时用 bridge——service.js 只认 surface，不认实现。
- store.js 的 `createRequire('node:sqlite')` 局限在 Node 后端文件内。

**验收**：面板打卡/摸鱼记账/补卡/设置/人设/图鉴/亲密度全功能可用且与 Electron 版行为一致；`npm test` 全绿（service async 化后 smoke.js 相应改 async）；cargo test 覆盖 db 桥事务与并发串行化。

### Phase 3 — 对话与网络（3 天）

- Rust：`http_proxy.rs`（stream/once/abort，streamId → CancellationToken 映射）。
- JS：`transport.js`（fetch 默认实现 + Tauri 流包装：Channel 字节队列 → async iterable Response-like）；`chat.js` 3 处 fetch 调用点与 `holiday.js` 改走注入 transport（**SSE 解析零改动**）。
- chat:abort → `http_abort`，requestId 关联保持。
- 对话窗/立绘窗全部功能：流式回复、错误翻译、多模态参考图注入（`loadSelfPortrait` 改 Rust command 读资源）、会话管理。

**验收**：`npm test`（含 chat-test 的 SSE 分块/粘包/401/429/abort 场景）全绿；对 fake-llm.js 全链路对话 + 中断正常；配置真实 DeepSeek Key 发一轮真实对话。

### Phase 4 — 硬规则与细节回归（2 天）

- petScale 三路径（菜单/滑块/重置）→ `apply_pet_scale`，广播到位，量窗口/元素尺寸比例（340×700 : 118×136）。
- 窗口找回矩阵全跑（§7.3）；`petPosition` 持久化 + 分辨率变更后的工作区校验（Rust monitor API + 工作区计算，必要时 win32 `SPI_GETWORKAREA`）。
- 桌宠右键菜单、气泡、亲密度面板、挂机冒泡、表情指令跨窗同步（`desk:event` 广播语义核对）。
- 3D 模式：GLB 加载、`dev:3d` 验证台不受影响。

**验收**：§7.3 清单全绿 + 内存预检达标。（实测：自动化项全绿；内存未达标，实测数据与归因见 REVIEW_FINDINGS P5，指标口径已在 §1 修正。）

### Phase 5 — 打包发布（2 天）

- `tauri build`：NSIS（WebView2 `downloadBootstrapper` 模式兜底老 Win10）+ 免安装 portable exe 双产物；版本号/图标/产品信息。
- 资源打包：立绘 PNG（~1MB）+ 视频（12MB）随 frontendDist 嵌入主 exe，无需 resource 目录；`?route=pet3d` 验证台随上游 3D 移除已无对象（GLB 生成脚本删除）。
- 旧 `scripts/build.js` 三个 Windows 坑（TEMP 网络盘/Defender/EPERM）**整体作废**——Tauri bundler 自管；NSIS 工具包首次下载需代理（本机事实），缓存后不需要。
- 真机验证：干净虚拟机（无 WebView2）安装 → 运行；Defender 实测。

**验收（2026-09-23 实测：完成）**：portable 25.6MB / NSIS 15.6MB（磁盘指标达标）；NSIS 静默装→启动→卸载全通且 Defender 未拦；待人工 = 干净虚拟机 + SmartScreen 双击路径。

### Phase 6 — 切换与收尾（1 天）

- 默认产物切 Tauri，观察一个版本后删 `src/main/index.js`（Electron 壳）、`electron`/`@electron/packager` 依赖、`scripts/{dev,build}.js`。
- README「技术栈/命令/打包」章节改写 + 本次迁移决策回写；AGENTS.md 命令区更新（`npm run tauri dev` 等）；本文归档。

**总工期：15 个工作日 ±20% 缓冲**（单人）。

### Phase 7 — 第二段：业务层下沉 Rust（上线稳定后按决策闸门启动，1.5-2 周）

每步独立可回滚，golden test 先行：

1. **对账基建**（~1 天）：node 脚本对 shared 纯函数生成 fixtures JSON → cargo test 重放比对；进 CI，故意改行为时重生成 fixtures 两侧同改。
2. **数据单源化**：personas / outfitStories / videoStories 的数据体抽 JSON，JS 与 Rust 共读——消灭最大的潜在重复面。
3. **store 实体逻辑入 Rust**：SQL/迁移/实体映射并入 `db.rs`，`store-bridge.js` 退役（其 command surface 就是现成 API）。
4. **chat 入 Rust**：SSE 解析/错误翻译/abort（`transport.js` 已是干净边界）；提示词组装若 mobile 仍需 JS 版，保留双份 + golden test，或随步骤 2 数据化为模板。
5. **service 编排入 Rust**：收入/打卡/补卡/亲密度/图鉴推进；`ipc-handlers.js` 逐条变 `#[tauri::command]`；**最后**拆除 serviceBus 与 desk-shim 的总线分支。
6. mobile 保持 PWA 不变（继续用 shared JS）；shared 收缩为「mobile 所需纯函数 + 数据」。若未来转 Tauri mobile，单真相随之完全搬入 Rust。

**验收**：bus 零调用；`service.js`/`chat.js` 退役；`npm test` 收缩为 shared 数据校验；cargo test 全覆盖；§1 指标复核（预期全开内存再降 ~10-25MB，业务层移出 webview）。

**收益**：同步引擎获得窗口无关的常驻宿主；状态核获得类型安全；架构回到 Tauri 主 grain。**代价**：内容逻辑双份 + 对账税（每次行为变更两侧同改 + 重生成 fixtures，估计每次 +30-60 分钟）。

## 5. 关键映射清单

### 5.1 窗口规格（Electron → Tauri）

| 窗口 | 尺寸/约束 | 关键属性 |
|---|---|---|
| pet | 340×700 × petScale（0.6-2），不可调 | transparent, noDecorations, skipTaskbar, alwaysOnTop, shadow off, resizable off, 位置持久化 |
| panel | 1080×720，min 860×600，居中 | 不透明，背景 #F5F5F7，`visible(false)` 待 ready |
| chat | 420×560，min 320×360，max 720×900，可调 | transparent, alwaysOnTop, skipTaskbar, shadow off；move/resize 联动立绘窗 |
| chatpet | 132×232，贴对话框左侧，工作区夹取 | transparent, alwaysOnTop, **focusable off**, skipTaskbar |

注意：Tauri 的 `LogicalSize/LogicalPosition` 与 Electron DIP 语义一致，但 `outer_position/set_bounds` 的物理/逻辑换算要在 scale.rs 里显式处理（DPR≠1 时 Electron 部分默认行为不同，逐项实测）。

### 5.2 IPC → 通道映射规则

- Tauri command 名不允许冒号：`state:get` → Rust 侧 `state_get`（仅窗口类）；总线类保持原名（`channel` 就是字符串）。
- **业务类（~48 个）**：`state:*` `meta:*` `checkin:*` `backfill:*` `settings:*` `session:*` `moyu:*` `worklog:*` `sync:*` `holiday:*` `affinity:*` `gallery:*` `persona:*` `chat:{status,test,diagnose,sessions,ensure,create,rename,delete,load,chatterLine,send,abort}` → ipc-handlers.js 原表，走 serviceBus，Rust 零参与。
- **窗口/系统类（7 个）**：`chat:openWindow` `chat:hideWindow` `chat:togglePet` `window:togglePet` `window:petVisible` `window:showEverything` `window:openPanel` `window:hidePanel` `window:minimize` `pet:setScale` `pet:setAlwaysOnTop` `pet:quit` → Rust command（窗口状态只有 Rust 知道）。
- 事件广播：主进程 `webContents.send('desk:event')` → 宿主端 `app.emit('desk:event')` 全窗广播，payload 结构不变，shim `onEvent` → `listen`。

### 5.3 desk-shim（preload 的 1:1 替代）

导出一个 `installDesk(backend)`：Tauri 环境下组合「总线客户端 + 窗口 command」实现 `window.desk` 全部 45 个方法与 `onEvent`；pet 窗内业务方法进程内直调（不经总线）。渲染层代码（stores/app.js 的 `window.desk` 调用点）**零改动**。现有「mock 后端」分支保留，纯浏览器预览能力不丢。

### 5.4 拖拽注解核对表（逐一重审，不许批量替换）

| 文件:行 | 现状 | Tauri 处理 |
|---|---|---|
| PetApp.vue `.pet` 根 | `app-region: drag` | 根元素加 `data-tauri-drag-region`；确认拖/点位移标志逻辑对 spike 结论的适配 |
| PetApp.vue:1004/1006/1110 | 「刻意不写 app-region」的祖先判定注释区 | 按「target 自身判定」新语义重写注释与结构（Tauri 下子元素天然不拖，通常更简单，但必须逐个点测） |
| ChatApp.vue:726/774 | 标题栏 drag + 按钮 no-drag | 标题栏加属性；按钮无需属性但要点测 |
| ChatPetApp.vue:121/126/155/171 | 立绘窗 drag + 交互区 no-drag | 同上 |

## 6. 数据与配置兼容

- **DB 路径显式复用**：Rust 端固定 `dirs::data_dir()/desk-pet/desk-pet.db`（即 `%APPDATA%\desk-pet\`），**不用** Tauri 默认 app_data_dir（随 identifier 变化，会导致老用户数据「消失」）。表结构/同步字段零迁移。
- 迁移期同机双版本共存共享同一 DB——**禁止同时运行两个版本**（SQLite WAL 下并发写有风险；Tauri 单实例锁与 Electron 锁互不感知，发布说明里写明先卸旧再装新，或首启检测旧进程提示）。
- 设置项语义不变；`activeSessionId`/`petPosition` 等 meta 键继续由宿主侧读写。

## 7. 测试与验证策略

### 7.1 自动化

- **保留 Node 直跑**：smoke.js（shared 纯函数 + service + node:sqlite store，async 化适配）、chat-test.js（SSE 解析/错误翻译——transport mock 后**完全不用改断言**）。
- **新增 cargo test**：db 桥（迁移 CRUD/事务批/并发串行化）、http 代理（本地假服务器的流式与 abort）、scale/position 纯计算。
- 提交前验证 = `npm test && cargo test && npm run build && tauri build`。

### 7.2 调试

- `DESK_DEBUG_PORT` 等价：`additional_browser_args: "--remote-debugging-port=9222"`，CDP 工具链（cdp-act.mjs）继续可用。
- WebView2 自带 DevTools（F12），右键菜单禁用策略与 Electron 对齐。

### 7.3 手工 parity 回归清单（Phase 4 验收线）

1. 窗口找回矩阵：仅关桌宠 / 关桌宠+面板 / 全关 → 托盘单击、托盘菜单「找回桌宠」、「全部显示」各路径全通；菜单文案三态正确。
2. 拖拽：桌宠拖动顺滑无断流；拖后不误触菜单；位置重启恢复；改分辨率后不丢。
3. 缩放：三条路径改 petScale，窗口与立绘同步、热区对准、重启保持。
4. 对话：新/切/删会话、流式中断、错误提示翻译、多模态自画像、挂机冒泡、表情联动桌宠。
5. 打卡：现场/补卡/工作日连击/节假日判断（含调休补班）。
6. 收入：状态机三态、休息日为 0、月末工作日数按真实日历。
7. 图鉴/服饰/视频触发三层逻辑与 Electron 版一致（同输入同输出抽 10 例对照）。

## 8. 全维度性能与质量评估（迁移前 vs 迁移后）

基线方法：真实构建产物 + `.tmp-yuki/mem-report.ps1` 分进程实测（私有内存）、CDP 分窗口归因。以下「预期」标注了置信度：★实测推算 / ☆经验估算（迁移后需复测确认）。

| 维度 | Electron 38 现状 | Tauri 2 预期 | 依据与说明 |
|---|---|---|---|
| **内存-驻留**（仅桌宠） | 172 MB 私有 | ~130-140 MB ★ | Rust 宿主替代 Node 主进程（-25MB）+ 网络服务并入；GPU 86MB 与 4 个 Chromium 渲染层不变 |
| **内存-全开**（4 窗） | 395 MB 私有 | ~340 MB ★；后续叠加「隐藏窗延时销毁」可到 ~180 MB | GPU 进程 ~200MB 是透明窗+DPR2 的固定成本，**两框架同付**；渲染进程数不变（**Phase 4 实测证伪**：WebView2 每窗独立渲染进程 + browser 进程 ~50MB 固定，全开实测 ~735MB，见 REVIEW_FINDINGS P5） |
| **CPU-空闲** | ~0-1%（UI 动画主导） | 持平或略优 ☆ | 空闲 CPU 都由渲染层 CSS 动画/rAF 决定；Rust 宿主无轮询任务（service 是响应式的），tokio 空转开销趋零 |
| **CPU-峰值** | 对话流式解析占 1 核一小部分 | 持平 ☆ | SSE 解析留在 JS（webview），量级 MB/s 级，无感知差异；不做「Rust 解析更快」的假设 |
| **磁盘** | 322 MB（exe+运行库+asar） | **~25-30 MB** ★（exe ~10MB + 立绘 1MB + 视频 12MB + NSIS 开销） | WebView2 运行时系统自带，不随包分发；这是确定性最大收益 |
| **冷启动** | ~2s 到桌宠可见 | ~0.8-1.2s ☆ | 省去 Node/Chromium 主进程初始化；WebView2 进程树启动更轻。**风险**：资源嵌入方式影响首帧，Phase 5 实测 |
| **窗口打开速度**（panel/chat 首开） | ~300-600ms | 同级 ☆ | 都是「新建渲染进程 + 加载产物」，瓶颈相同 |
| **运行速度**（业务操作：打卡/查询/设置保存） | ipcRenderer.invoke 往返 + SQLite | invoke 往返 + rusqlite | SQLite 都是 C 引擎；JSON 序列化开销同级（~0.1-0.5ms/次）★。**总线链路**（跨窗 req/res）比现状多一跳（~1ms 级），人对无感知 |
| **UI 渲染效果** | Chromium 140（Electron 38 固定） | WebView2 Evergreen（跟随系统 Edge 更新） | 同引擎同 CSS/SVG/字体渲染；Evergreen 意味着渲染特性随系统升级而**变新也可能变数**，回归面略增 |
| **UI 刷新流畅度** | rAF/vsync，3 透明窗合成 | 同引擎，理论持平 ☆ | 唯一变数是 WebView2 透明合成路径的历史怪癖（Phase 0 spike 拦截）；迁移后用同一动画场景对比掉帧 |
| **3D/WebGL 渲染**（平台能力记录） | 上游已移除 3D 方案（a09a0e7），现役纯 2D 立绘 | spike 已验证 WebView2 下 WebGL alpha 画布 + 硬件加速可用（AMD D3D11，非软件渲染） | 作为平台能力记录保留：未来 2D 可动关节若走 canvas/WebGL 渲染可直接复用该结论；产品层面无 3D 回归面 |
| **用户交互** | 系统级拖拽、托盘、右键菜单 | 同级 | 拖拽同为系统级（硬规则保持）；中文 IME 在 WebView2（Edge 输入体验）成熟；托盘交互一致；**注意**：notification toast 与 balloon 观感不同 |
| **安全** | contextIsolation ✓ / nodeIntegration ✗ / IPC 白名单 ✓ / **sandbox: false ⚠** / Chromium 补丁随 Electron 版本滞后 | **能力 ACL 默认拒绝**（db/http 仅授 pet 窗）/ CSP 可显式配置 / WebView2 自动安全更新 / 无 Node 运行时面 | Tauri 安全模型整体更优：权限按窗口粒度授予、命令显式注册；并顺带补上现状 sandbox:false 的短板。API Key 仍明文存 SQLite（两框架同现状，后续可选 DPAPI 加密，不在本期） |
| **供应链/依赖面** | Node 全量运行时 + 38 版 Chromium 固定捆绑 | Rust 静态链接 + 系统 WebView | 攻击面与补丁义务都显著缩小 |

**结论**：全维度没有一项比现状更差；内存与磁盘显著改善、安全模型显著增强、其余维度持平。内存收益的上限取决于是否叠加「隐藏窗延时销毁」（与框架无关的架构优化，建议在 Phase 4 一并以 Tauri 语义实现：panel/chat/chatpet 隐藏 5 分钟后销毁，重建走既有创建路径，托盘找回矩阵不受影响）。

## 9. 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| WebView2 透明窗渲染怪癖（黑底/闪烁/置顶失效） | 高 | Phase 0 首项验证，不过即止损（Electron 路线继续） |
| 拖拽 click 派发行为差异破坏「拖/点」区分 | 中 | Phase 0 实测；保留位移标志方案可适配两种行为 |
| service async 化引入回归（触碰全部业务路径） | 中 | 双 store 后端让 `npm test` 全程可跑；parity 清单全量回归；handlers 表原样复用 |
| 总线消息丢失/乱序 | 中 | requestId + 15s 超时 + 一次重试；bus:ready 门控；流式走既有广播不经总线 |
| `?route=` 查询串在 asset protocol 失效 | 低 | Phase 0 验证；备选 init script 注入 `window.__ROUTE__` |
| 老 Win10 无 WebView2 | 低 | NSIS downloadBootstrapper；发版说明注明 |
| 双版本同开损坏 DB | 低 | 发布说明 + 首启进程检测提示 |
| 性能指标不达标 | 低 | 每 Phase 用实测脚本复测；Electron 版保留到 parity 确认后才删除 |

**回滚策略**：`feat/tauri` 分支全程不破坏 main 的 Electron 版；发布顺序 = Tauri 版与 Electron 版并行发 1-2 个版本 → 用户无感切换 → 再删 Electron 代码。任一阶段失败，丢弃分支成本仅为已投入工时，用户数据无风险（DB 由 Tauri 版只读迁移为共用，写路径 schema 不变）。

## 10. 验收（Definition of Done）

1. §1 指标表全部达标（实测数据贴回本节）。
2. §7.3 parity 清单 100% 通过。
3. `npm test` + `cargo test` + 双构建全绿；无头验证（CDP）脚本适配完成。
4. README / AGENTS.md 完成改写，硬规则章节更新为 Tauri 语义；本文归档。
