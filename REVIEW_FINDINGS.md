# 迁移代码审查问题清单（2026-09-23）

> 来源：双视角静态逐行比对。
> 基线 = 上游 `3346723`（Electron 最终态）↔ 分支 `feat/tauri`。
> 处置状态：`[ ]` 待修 / `[x]` 已修 / `[~]` 记录为有意偏差（不改代码）。
> 修复完成后本文件随代码一起提交，作为 Phase 2 审查记录归档。

## 一、必修（高严重度）

### H1 ✅已修｜总线 15s 超时打在流式对话上
- 位置：`src/renderer/src/lib/service-bus.js`（客户端 call 的统一超时）
- 问题：`LONG_RUNNING` 只绕开宿主串行队列，客户端 15s 超时对 `chat:send` / `chat:diagnose` / `chat:test` / `chat:chatterLine` 照常生效。LLM 回复超 15s 时出现「报错横幅 + 流式内容继续输出」的矛盾态；diagnose 多步自检几乎必然超时。基线 IPC 无超时。
- 修法：客户端对 LONG_RUNNING 通道豁免超时（对话以 `chat-done` 事件为准），或对其单独放宽。

### H2 ✅已修｜bus:ready 门控失效——后开窗口每次调用白等 20s
- 位置：`service-bus.js`（waitForReady）+ `service-host.js`（仅启动时广播一次）
- 问题：panel/chat 由 Rust 按需创建，永远收不到一次性的 `bus:ready`，`readySeen` 恒 false → 每一次业务调用都先等满 20s 超时才放行（放行后调用本身正常）。基线无任何门控。
- 修法：客户端 ready 未知时向宿主发 `bus:ping`、宿主应答 `bus:ready`；宿主在每个窗页面加载完成后也补发。二选一或并用。

### H3 ✅已修｜全窗销毁 = 应用整体退出，托盘消失（击穿找回入口硬规则）
- 位置：`src-tauri/src/lib.rs`（`.run()` 无 RunEvent 处理）
- 问题：基线 `window-all-closed` 空函数保证托盘常驻；Tauri 默认最后一个窗口销毁即退出。桌宠 Alt+F4 且面板/对话未开时应用直接死掉，只能重启。
- 修法：`RunEvent::ExitRequested { code: None }` 时 `api.prevent_exit()`（`pet:quit`/托盘退出走 `code: Some` 不受影响）。

### H4 ✅已修｜WebView2 调试端口默认常开进 release（安全回归）
- 位置：`windows.rs apply_debug_args`（无 env 时默认 9224）+ `tauri.conf.json` spike 窗静态 `additionalBrowserArgs`
- 问题：基线仅 `DESK_DEBUG_PORT` 显式开启；新版无条件开 9224，任何本地进程可经 CDP 在 webview 执行任意 JS 并调用 `db_exec` 读写用户库。
- 修法：调试参数改为仅 env 存在时附加（全窗一致铁律不变）；spike 窗从静态配置移到 Rust 创建（同样的参数逻辑）；默认（无 env）不开端口，CDP 复验改为 `DESK_DEBUG_PORT=9224` 启动。

## 二、建议修（中严重度）

### M1 ✅已修｜Electron 壳无串行队列，async 读改写可交错
- 位置：`src/main/index.js` registerIpc
- 问题：service 异步化后 ipcMain.handle 并发交错，基线同步 IPC 的原子性丢失（如 affinity 读改写丢更新）。Tauri 侧总线有队列，Electron 侧没有。
- 修法：Electron 壳对业务通道套用与总线宿主相同的串行队列。

### M2 ✅已修｜补卡事务可被并发写入卷入（Tauri）
- 位置：`src/shared/bridge/store-bridge.js` addCheckins（跨 invoke 的 begin/insert…/commit）
- 问题：补卡事务打开期间，绕开队列的 `chat:send` 写消息会加入同一事务；补卡失败 ROLLBACK 连带回滚 chat 消息。基线 addCheckins 整段同步不可插入。
- 修法：addCheckins 改为「一次 select 查重 + 单条 batch invoke（`BEGIN; INSERT…; COMMIT;`，exec 无参走 execute_batch）」，事务收进单个锁段，消除跨 invoke 窗口；失败补发 ROLLBACK。

### M3 ✅已修｜setPetScale 丢入参钳位 + clamp 边界漂移
- 位置：`desk-shim.js` setPetScale；`scale.rs clamp_scale`
- 问题：原始值直送 settings 持久化（基线先夹取再存），越界值会让立绘 scale 与窗口 scale 失配、热区错位；`clamp_scale` 对负值回退 1（基线 `Math.max(0.6, 负) = 0.6`）。返回值也从钳位数字变成 state 对象（现无调用方消费，属接口漂移）。
- 修法：shim 内复刻基线钳位后再持久化并 `return s`；`clamp_scale` 非有限值才回退 1，数值走 `clamp(0.6, 2.0)`。

### M4 ✅已修｜service 默认参数改写吞显式 null（行为地雷）
- 位置：`src/main/service.js` 约 10 处 `sessionId ?? (await currentSessionId())`
- 问题：基线默认参数只对 `undefined` 回退，`null` 保留走「全局键」分支；新版对 null 也解析成当前会话，读写错层。现网调用面无触发点。
- 修法：改为 `sessionId === undefined ? await currentSessionId() : sessionId`。

## 三、低严重度（修复或记录）

### L1 ✅已修｜托盘打卡在宿主就绪前静默丢失
- 位置：`tray.rs` dispatch「checkin」→ `emit_to(pet)`
- 修法：pet 窗不存在时先 `create_pet` 再 emit；宿主就绪前的秒级窗口期记录为已知限制。

### L2 ✅已修｜Electron createPetWindow 异步化的双建窗竞态
- 位置：`src/main/index.js` togglePet/restoreAnyWindow
- 修法：建窗互斥（进行中的 create promise 复用）。

### L3 ✅已修｜restoreActive 与 session:setActive 写后覆盖竞态
- 位置：`src/main/ipc-handlers.js`
- 修法：restoreActive 完成时仅在未被显式设置过的情况下赋值。

### L4 ✅已修｜streak 预载 3 年 vs 基线任意年按需查库
- 位置：`src/main/service.js` getState
- 修法：预载年数对齐回看 guard（10 年）。

### L5 ✅已修｜坐标缺 Math.round（三处）
- 位置：`windows.rs` chatpet set_position、pet 建窗 position；`scale.rs` apply_pet_scale 锚定
- 修法：补 `.round()`（dpr 非 2 的屏避免 1px 偏移）。

### L6 ✅已修｜store-bridge ready 门控与注释不符
- 位置：`src/shared/bridge/store-bridge.js`
- 修法：把 `await ready` 收进 select/exec 两个 helper，删除只包了一处的 run()。

### L7 ✅已修｜托盘菜单重建路径不统一
- 位置：`windows.rs`（open_chat_window 里无意义的 rebuild；panel show/hide 部分路径不刷新）
- 修法：rebuild 收口到 create_panel 的 show 与 window_hide_panel，删除 open_chat_window 的 rebuild。

### L8 ✅已修｜面板背景色防白闪未迁移
- 位置：`windows.rs` create_panel
- 修法：builder 补 background_color #F5F5F7。

### L9 📝记录为有意偏差｜petAlwaysOnTop 启动回放与基线分叉
- 位置：`service-host.js`（回放）vs 基线硬编码置顶
- 处置：`[~]` 保留回放（更符合设置语义），记录为有意偏差；Phase 4 回归时按此口径。

### L10 📝记录为有意偏差｜托盘图标颜色解释差异
- 位置：`tray.rs`
- 处置：`[~]` Electron nativeImage 按 BGRA 解释、基线实际显示通道交换色；Tauri 按 RGBA 显示代码本意的青色。绘制算法一致，颜色以 Tauri 为准，注释记录。

## 四、简化机会（无行为损失）

### S1 ✅已修｜ShellState 整层可删（含 Default 错误默认值陷阱）
- pet_scale 建窗前已直读 settings 表、pet_position 已实时写 meta，内存副本唯一用途是 DB 未就绪的头几秒回退。删除 ShellState/with_state，create_pet 只信 DB、回退 1.0/默认位。

### S2 ✅已修｜物理逻辑换算重复 5 处 + chat_anchor 双胞胎
- 提取 `window_logical_rect(win) -> Option<FRect>`，chat_anchor 与 chat_anchor_for_pet 合并。

### S3 ✅已修｜BUSINESS_CHANNELS 死导出
- 注释宣称的消费方不存在。删除。

### S4 ✅已修｜杂项清理包
- `create_chat_pet` 返回 `Result<()>`（Ok(None) 分支不可达消费）；`[diag]` eprintln 删除；scale.rs 两处「Phase 2 补」注释已过时（说反了）更正；日志统一 eprintln（`log` 依赖与无实现的 warn 黑洞一并移除）；`installDeskShim` 去 export；bus:ready payload 简化；loadSelfPortrait 改 FileReader.readAsDataURL；`open_at(&PathBuf)` → `&Path`。

### S5 📋Phase 6 计划内｜Phase 6 清理项（计划内，列出防漏）
- spike.rs / spike.html / spike 窗 / spike 相关 capability；H4 修复后 `apply_debug_args` 已收敛为 env 单点控制，无遗留。reqwest/futures-util Phase 3 即将使用，保留。

## 五、已知有意偏差（比对确认等价或改良，不改代码）

1. 六个纯逻辑文件相对基线零改动（git 证明）。
2. settings 建表语句移入 db-schema.js（文本逐字节一致）。
3. streak isRest 回调预载替代同步查库（见 L4 收窄边界）。
4. getState 亲密度跟随显式会话 id（修正原版「指定会话广播状态时亲密度读最近会话」的潜在错位）。
5. 面板关闭立即刷新托盘文案（原版延迟，改良）。
6. displayBalloon → Windows toast；ready-to-show → 页面加载完成事件。
7. settings:reset 单次广播（原版 service 内部 emit + handler 手动 broadcast 双发，前端幂等）。
8. store-bridge 不暴露 db 句柄、close 为 no-op（连接归 Rust 所有，grep 确认无消费方）。
9. petAlwaysOnTop 启动回放（L9）。
10. 托盘图标颜色按 RGBA 解释（L10）。

## 六、Phase 4 回归轮新增发现（2026-09-23，OS 级实测驱动）

### P1 ✅已修（根因更正）｜tao 对「左上角出屏」的 builder 位置静默回退级联位
- 位置：`src-tauri/src/windows.rs` create_pet
- 现象：保存位 (884,-210) 解析正确（调试输出 `resolved=(884,-210)`），但窗口实际落 Windows 级联默认位（两次重启分别落 25/98 逻辑坐标，随机）。
- 根因（~~builder.position 对 transparent+noDecorations 不生效~~ 更正）：tao 建窗时把 builder 位置换算物理坐标后**逐显示器检查左上角是否在屏内，不命中任何显示器即回退 `CW_USEDEFAULT`**（tao-0.35.3 windows/window.rs:1174-1190）——与透明/无装饰无关。pet 的保存位允许挂屏幕上缘（`is_on_screen` 四周 20px 余量语义），左上角出屏恰好触发；panel（几何中心）/chat（夹进工作区）/spike（固定 120,140）位置恒在屏内，故均不受影响、**无需推广修复**。
- 修法：build 后显式 `win.set_position(LogicalPosition::new(x, y))`（`SetWindowPos` 无显示器命中检查，任意坐标精确；与 apply_pet_scale 同路径）。builder 上的 position 已删（真实生效点唯一化）。
- 伴随对齐：建窗摆放触发的首个 Moved（与解析位相同）跳过写 meta——Electron 基线初始摆位不触发 moved，屏幕外的失效保存位得以保留（外接屏重插后可回旧位）。

### P2 ✅已修（方案更正）｜window.hide() 不同步 WebView2 IsVisible——隐藏窗不释放内存
- 位置：`src-tauri/src/windows.rs` `set_shown()` helper（文件头 helpers 区），替换全部 15 处显隐调用点
- 现象：panel 隐藏后渲染层 `document.visibilityState` 仍为 "visible"，CSS 动画继续、Chromium 不修剪渲染树，全树私有内存不降。
- 修法：显隐时同步 `controller.SetIsVisible`。实测 panel 藏后全树 453→305MB（-148MB），且 visibilityState 正确变 hidden（隐藏窗动画暂停，与 Electron 行为对齐）。
- 实现路线（~~unstable feature + Manager::get_webview~~ 更正）：`with_webview` 稳定 API 直接拿 `ICoreWebView2Controller` 调 `SetIsVisible`，**零额外依赖、不开 unstable**——源码比对发现 unstable 会连带把 webview 宿主从 WindowContent 翻成 WindowChild（tauri-runtime-wry），破坏无边框可调窗（chat）的边缘拖拽缩放覆盖层挂载，见 P7。

### P3 ✅已验证｜窗口找回矩阵（hide 维度全通，destroy 引 Phase 2 实测）
- toggle_pet 隐/显、open/hide_panel、show_everything、跨窗广播到达（panel 收到宿主 state）全部通过。
- 渲染层 invoke `window.close` 被 ACL 正确拒绝（`plugin:window|close not allowed`）——渲染层无法销毁窗口，安全面正确。
- destroy（Alt+F4）路径引 Phase 2 实测：应用存活、toggle 重建、pet_quit 可退出。

### P4 📝记录｜JS window.close() 产生「壳活内容死」僵尸态
- WebView2 下脚本 window.close() 只杀 webview 不销毁 HWND：窗壳 alive=true、webview/CDP target 消失，之后 toggle/show 恢复的是空壳窗，业务宿主不可自愈。
- 影响面：生产代码零调用（grep 确认），ACL 已挡渲染层 Tauri close；仅自动化工具或未来误用可触发。托盘「找回桌宠」对此僵尸态无法感知（alive 仍 true）。
- 缓解：不使用 JS close；如需真实关闭走 Alt+F4/WM_CLOSE（CloseRequested→destroy 正常路径）。

### P5 📝记录｜内存指标未达 §1 预期，主因 WebView2 多进程树固定开销
- 实测（全树私有内存，dpr=200% 透明窗）：
  - 净驻留（仅 pet 单 webview）：~241MB（目标 140）
  - pet+panel 可见：~453MB；panel 隐藏（P2 优化后）：~305MB
  - 全开（pet+panel+chat+chatpet）：~735MB（目标 340；Electron 基线 395）
- 归因：GPU 进程 ~145MB（透明窗+dpr2 固定成本，两框架同付）；WebView2 browser 进程 ~50MB 固定 + 每窗独立渲染进程的 Chromium 完整渲染器成本超 §8 预估。§8「渲染进程数不变」的假设不成立。
- 对决策的影响：§1 内存预期按实测修正；磁盘（30MB vs 322MB）、启动时间、安全面收益不变，迁移结论不变。后续可做「隐藏窗延时销毁」（§8 已预留）进一步压全开态。

### P6 📝记录｜dev 形态（直接 cargo build）IPC origin 校验偶发全拒
- 直接 `cargo build --release`（不经 tauri CLI）的产物会嵌入 build.devUrl：加载 vite 页面、IPC 走 fetch origin 校验，持续运行后出现全窗 invoke 被拒（"Origin header is not a valid URL"），业务宿主起不来。
- 处置：验证一律用 `npx tauri build --no-bundle` 产物（asset protocol，origin=tauri.localhost，无此问题）；dev 形态仅用于 vite HMR 联调，不跑 IPC 重活。

### P7 📝决策记录｜禁止为 get_webview 开 tauri unstable feature
- 源码比对发现：`unstable` feature 不只是 API 稳定性门——它经 `tauri-runtime-wry` 连带把建窗时的 webview 宿主从 `WindowContent` 翻成 `WindowChild`（tauri-runtime-wry lib.rs:4684-4687）。后果：无边框可调窗（chat 是全应用唯一 `resizable(true)+decorations(false)`）的边缘拖拽缩放覆盖层（`undecorated_resizing::attach_resize_handler`）只在 WindowContent 模式挂载，WindowChild 下 WebView2 子 HWND 吃掉 NCHITTEST，边缘缩放大概率失效；webview 尺寸联动路径也随之改变。
- 决策：set_shown 改走 `with_webview` 稳定 API（P2 更正），Cargo.toml 撤销 unstable 并精确锁 `tauri = "=2.11.6"`、`tauri-build = "=2.6.3"`（build 脚本生成代码与 tauri 版本耦合，任何升级都是显式动作）。
- 教训：feature flag 的语义要查到 runtime 层实现为止，「只是 API 门」的判断在 Tauri 不成立。

### P8 ✅已验证｜已证实无问题的项（防重复排查）
- set_shown 15 处替换完整无遗漏（tray/lib/scale/spike/db/http_proxy 均无直接窗口显隐；tray.rs:264 的 show 是通知 builder）；窗口/webview 双向同步的中间态不足一个事件循环，无白屏/残留帧。
- get_webview（若在用）返回 Option 无 panic 面；with_webview 对已销毁窗返回 Err 被 `let _` 吞掉；显隐频率下开销可忽略。
- 渲染层无法绕过 set_shown 造成失步：core:window 默认权限不含 show/hide/close，capabilities 仅 `core:default + start-dragging`。
- 文档数字自洽：15 处调用点、148MB、442×910、cargo 19、smoke 339 + chat-test 138、ACL 拒绝记录均与代码一致。
