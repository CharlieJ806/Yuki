# FIX_PLAN — 托盘 AI 对话失效 / 菜单双闪 / 桌宠状态切换闪烁

状态：**批次一已实施（2026-09-24）**：§1、3a/3b/3c 完成并验证——托盘 open-chat 恢复；气泡定高落地（注：只稳定台词期内的多段 say，「台词↔收益」两态内容不同、高度本就变化，该切换的 refit 是 WYSIWYG 既定行为）；立绘预加载就位；`pet_refit` 单次 SetWindowPos 经高频采样验证零中间态（右缘/底缘分毫不差）。批次二（3d/3e/3f）待安排。

**§2 菜单双闪——未解决，消闪改动已回退（2026-09-24）**：`setBackgroundThrottling(false)` 实测对用户感知的闪烁无效（rAF 首帧 0-3ms 但肉眼仍见双闪，说明闪的不是「首帧延迟」而是 show 时的 DWM 激活/透明窗重映射层面的东西），且副作用是隐藏窗持续合成渲染——已回退。已排除：懒创建加载闪、首帧门控时序、表面回收经节流可解、show/hide 竞态（事件层实测干净）。保留：预建常驻（首开即时 + Tauri 同构）、ready-to-show 门控、blur 走 hidePetMenuWindow 的卫生修。若日后续查，下一步是 Plan B（透明+穿透替代 hide，需改失焦关闭语义）或验证「focus() 引发的 DWM 激活动画」假设。
日期：2026-09-24 · 分支 feat/tauri · 结论来源：三路并行分析（静态逐行 + CDP 带栈实测 + 资产/渲染管线走查）

---

## 症状一览

| # | 症状 | 范围 | 根因定性 |
|---|------|------|----------|
| 1 | 托盘「AI 对话」点击无反应（面板入口正常） | 仅 Tauri | 本轮托盘重构误删 dispatch 分支（我的失误） |
| 2 | 右键菜单闪一下，像打开了两次 | 仅 Electron | Windows 透明窗 hide→show 表面回收，首帧迟 45-60ms |
| 3 | 桌宠切换状态闪烁明显 | 两壳共享 | 硬切+剪影跳变（主）、贴合两段式台阶（Tauri）、动画重启 |

---

## 1. Tauri 托盘「AI 对话」打不开

### 根因（已实锤）
`src-tauri/src/tray.rs` 托盘重排时，`dispatch_action` 的 `"open-panel"` 与 `"open-chat"` 两个分支被一起删除，补写 `"toggle-panel"` 时未察觉下方已存在 → **两个相同的 `"toggle-panel"` 分支（tray.rs:222、225），`"open-chat"` 落入 `_ => {}` 静默无操作**。Rust 对重复 match 分支不报错不告警，编译/测试全绿漏过。旁证：`build_menu` 里 `pet_label` 计算块重复两遍（tray.rs:116、123）。面板路径走 `chat_open_window` 命令不经 dispatch 表，Electron 用闭包无字符串表，故两者无恙。

### 修复步骤
- [ ] `tray.rs dispatch_action`：删除第二个 `"toggle-panel"` 分支（tray.rs:225-227），原位恢复
  ```rust
  "open-chat" => {
      windows::open_chat_window(app);
  }
  ```
- [ ] `tray.rs build_menu`：删除被 shadow 的第一份 `pet_label` 计算块（tray.rs:116-122），保留 123 起的一份
- [ ] 可选加固（建议同批）：`windows::open_chat_window` 现以 `let _ =` 吞掉 `create_chat` 的 `Result`，改 `log::warn` 落日志——托盘与命令两条路径共享这一吞错点，建窗失败不应两端无感

### 验证
`cargo test` 全绿；运行时托盘点「AI 对话」chat 窗出现（CDP 目标清单可见 `route=chat`）；面板入口回归不受影响。

---

## 2. Electron 右键菜单双闪

### 根因（带栈实测定案）
事件层干净：每次右键恰好一次 show，开路径无任何 hide，无重复注册（menu:show 仅一处注册；PetApp contextmenu 单次触发）。闪烁在呈现层：**Electron Windows 透明窗 hide 时表面被回收，show 后 Chromium 需 45-60ms 才产出第一帧**（6 次实测 45/52/54/59/61/61ms），期间屏幕是原生层被清空的表面——即「开了一下又开一下」。对应陈年已知问题 electron/electron#12130。Tauri 不闪：WebView2 的合成树在 hide/show 间保持存活（windows.rs `set_shown` 注释记录的可见性模型差异）。已做的预建+ready-to-show 只解决加载就绪，管不到表面回收。

### 修复步骤（结果：方案 A 无效已回退，卫生修保留）
- [x] ~~`setBackgroundThrottling(false)`~~：已实施又回退——rAF 首帧虽降到 0-3ms，用户感知的双闪不变（闪不在首帧延迟层），副作用是隐藏窗持续合成渲染。
- [x] 卫生修：`win.on('blur')` 内 `petMenuWindow.hide()` 改调 `hidePetMenuWindow()`——直调绕过 `__menuPending` 清理，启动极早期「右键后、reveal 前失焦」会残留 pending，reveal 时在旧位置幻影开菜单。（保留）
- [ ] 备选方案 B（未做）：不 hide，改「透明+鼠标穿透」——关：`setOpacity(0)` + `setIgnoreMouseEvents(true, { forward: true })` + `blur()`；开：`setPosition` → `setIgnoreMouseEvents(false)` → `setOpacity(1)` → `focus()`。表面零回收，但失焦关闭语义要跟着改。

### 验证
rAF 探针（`.tmp-yuki/probe7/8.mjs`）测得 show→首帧 0-3ms，但与用户感知不符——**该指标不是闪烁的度量**，后续排查勿再以它为准。闪烁本身挂起。

---

## 3. 桌宠状态切换闪烁（两壳共享渲染层）

### 根因（按贡献排序）
立绘是单 `<img>` 换 src（PetApp.vue:754，容器固定盒 118×136×scale，:887），浏览器解码期持有旧图——**不是空窗**，闪烁来源：

1. **硬切 + 剪影跳变（主因）**：46 张立绘（public/yuki-*.png，高 300、宽 143-300）固有宽差近 2 倍，contain 后可见宽度 65→118px 瞬跳（ChatPetApp 更糟：无固定盒，label 一起跳）。
2. **互动场景贴合台阶**：表情必带 `say()`（气泡高度变）→ RO → `pet_refit`。Electron 单次 `setBounds` 原子；**Tauri 是 `set_size` + `set_position` 两次独立 SetWindowPos**——先按左上角锚定改尺寸（内容下坠）、再挪回右下角锚点，两个可见台阶 + 一帧 `overflow:hidden` 裁切。一次互动跑两轮 refit（台词 3200ms 与表情 2600ms 分两拍）。
3. **动画同帧重启**：mood 常驻动画（bob/sway/breath）与 `.reacting` bounce 挂同一元素，快照刷新致 mood 变化时整套 keyframes 重启，transform 不连续。
4. **无任何预加载**：首显各图走协议请求+解码（帧级延迟，表现为图慢半拍）。

### 第一批修复（低风险、快速见效）
- [ ] **3a 气泡台词定高**：`PetApp.vue .bubble-speech` 加 3 行 `min-height`（line-clamp 3 已存在）→ 台词出现/消失不改 stage 高度 → 互动场景 refit 2→0。纯 CSS。视觉代价：气泡常驻略高，需用户过目。
- [ ] **3b 立绘预加载**：PetApp onMounted（或 requestIdleCallback）遍历解锁服饰 + 全部表情 key `new Image()` 预热（可顺带 `.decode()`）。资源合计 ~0.9MB，解码峰值 16-20MB，可接受。
- [ ] **3c Tauri `pet_refit` 原子化**：`windows.rs pet_refit` 改经 HWND 一次 `SetWindowPos` 同时带尺寸+位置（不加 NOMOVE/NOSIZE），替代 `set_size`+`set_position` 两连击。需先实验验证 tao/WebView2 下单次调用行为；若仍是两步合成，退而求其次调整调用顺序/渲染层时序。Electron 已是原子调用，无需改。
- [ ] 验收：互动时无 refit 触发（3a）、boot-watch 式高频采样窗口一次到位无中间态（3c）、首次互动不慢半拍（3b）。

### 第二批修复（治本，逐项单独验证）
> 实施前注意：上游 6f0d06b 已对立绘/照片**去量化**并入库 `scripts/prepare-yuki.js`——
> 3d 的素材前提已变（重导出不再是「去量化」而是「统一画布」），动手前先重估剩余量。
- [ ] **3d 资产归一化**：用 `scripts/prepare-yuki.js` 重导出全部立绘到统一画布（300×300、统一地平线、水平居中）→ contain 后尺寸恒定，硬切变「换动作」而非「闪」。需逐套视觉回归（换装/时段/表情），体积略增。
- [ ] **3e 双 img 交叉淡入**：两层绝对定位 img，新图 decode 完成后 opacity 过渡 ~160ms，完成后回收旧层；互动 emote 用 ~100ms 或免淡入保反馈。PetApp 固定盒已满足；**ChatPetApp 需先定高**（现状盒随图浮动）。
- [ ] **3f 动画解耦**：mood 常驻动画与 bounce 挂不同元素层，避免 keyframes 互相顶掉。锦上添花。

---

## 实施顺序与验证矩阵

| 批次 | 内容 | 验证 |
|------|------|------|
| 一 | §1 托盘修复 + §2 方案 A+卫生修 + 3a/3b/3c | cargo test / npm test / npm run build 全绿；托盘点 AI 对话实测；菜单连续开合手感；refit 高频采样 |
| 二 | 3d → 3e → 3f（每项单独提交单独验视觉） | 逐套立绘视觉回归；换装/挂机轮换/时段换装三场景手感 |

提交拆分建议（批次一）：`fix(tauri)` 托盘 open-chat 分支恢复 · `fix(electron)` 菜单窗关后台节流消闪 · `feat(ui)` 气泡定高+立绘预加载 · `perf(tauri)` pet_refit 单次 SetWindowPos。

## 风险与边界

- 三处都**不动共享业务层**（stores/shared 逻辑），mobile 无需同步。
- `setBackgroundThrottling(false)` 只给 petmenu；面板窗禁用（隐藏内存收敛是既定决策）。
- 3c 的单次 SetWindowPos 在 tao/WebView2 下行为需实验先行，失败则回退双调用并只保留渲染层时序合并。
- 3d 重导出改变全部立绘画布，是最重的一项，放批次二单独走。
