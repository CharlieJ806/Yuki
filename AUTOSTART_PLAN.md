# AUTOSTART_PLAN — 开机自启（双壳）实施方案

> 状态：待实施。按步骤顺序执行，每步带验证；全部完成后单提交。
> 决策已定：官方插件 `tauri-plugin-autostart = "2"`（与本仓 tauri =2.11.6 匹配）；
> Electron 用 `app.setLoginItemSettings` 对照实现；UI 共享，双壳同构。

## 0. 设计原理（为什么这么做）

**意图与执行分离**：

- `settings.autoStart`（新设置键）= 用户意图，走现有 `updateSettings` 管线落库。
- 注册表（Windows：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`）/ 登录项 = 执行结果，
  存的是 **exe 绝对路径**。本产品是免安装便携 exe，用户挪目录后该路径静默失效。
- **启动对账（自愈）**：每次启动按意图重写一次——意图开 → 无条件重新 enable（用当前路径
  覆写旧条目）；意图关且系统仍是开 → disable 清掉残留。插件底层的 `is_enabled()` 只判
  「条目存在与否」，看不出路径过期，所以对账必须无条件重写，不能只在不一致时写。
- UI 显示读设置键（即时、离线），不读注册表。

**双壳同构**：`window.desk.autostartGet() / autostartSet(on)` 两端同名同义；
共享层（设置键、UI）只写一遍。

**已知边界**：

- 插件用 `current_exe()`，`tauri dev` 下注册的是 `target/debug` 的 exe → UI 加 dev 提示。
- `tauri-plugin-single-instance` 已在场（lib.rs 第一个注册的插件）→ 开机自启实例与
  用户手开实例不会并存，无需额外处理。
- `updateSettings`（service.js:780）对未知键直通全局 `store.saveSettings`，
  且 smoke 只断言具体默认值不枚举键集 → 新键零后端改动、零测试改动。
- 手机端共享 DEFAULT_SETTINGS 带上此键无副作用（mobile 设置页不渲染）。

**便携 vs 安装版**（当前只有免安装打包，便携为主）：

- **挪动目录**：旧路径在下次开机时被 Windows 静默跳过，自启失效——这是便携应用的
  物理极限（没有常驻组件能替它改注册表）。自愈的触发条件是「用户再手动启动一次」：
  启动对账用当前路径重写条目，下一个开机周期恢复。开关描述文案即此语义。
- **删除应用**：Run 条目成为孤儿，开机静默失败、任务管理器启动页残留死条目。
  应用已不存在，任何代码都无法清理——便携应用固有的代价（安装版由卸载器负责），
  接受并在手册说明， severity 低（不弹窗、不耗资源）。
- **未来若出 NSIS 安装版**：路径固定无挪动问题；卸载残留用
  `bundle.windows.nsis.installerHooks` 挂 `DeleteRegValue HKCU
  "Software\Microsoft\Windows\CurrentVersion\Run" "<条目名>"` 清理，届时补一行。
  （双壳 NSIS 安装版已立项，见 PACKAGING_PLAN.md 步骤 2/3。）
- **两壳并存边角**：Electron 登录项与 Tauri Run 条目命名规则不同（前者跟
  Electron 应用名、后者跟 productName），两壳都开自启会留两条条目、开机各起
  一实例——两壳 DB 共享，并发写有风险。真实用户基本固定单壳，v1 接受；
  验证步骤里用 `reg query` 确认两壳实际条目名并记录进蓝图，供未来按需清理。
- **同壳两形态互占名**（review 补）：安装版与绿色版的登录项/Run 条目**同名**——
  Tauri 模板卸载按名删除（不做指向核对），Electron 卸载器读值核对后才删；被误删方的
  下次启动由对账按意图重写，自愈。两形态的启动对账互相覆盖条目指向，属预期
  （最后启动的形态赢得开机自启）。
- **auto-launch 伴生残留**（review 补）：Tauri 侧 enable 会同步写
  `Explorer\StartupApproved\Run` 伴生值，disable 不删、模板也不删——不可见且无害，
  v1 不清理（PACKAGING_PLAN 核对表有记录）；如后续在意，加一行卸载钩子即可。
- **auto-launch 0.5 的 Run 值数据不带引号**（review 补）：自启路径含**空格**会失效——
  默认安装/绿色目录无空格安全；使用说明提示「安装/解压路径勿含空格」。
  Tauri 侧即使踩中，启动对账也会在下次手动启动时重写修正。

---

## 步骤 1：Rust 接插件

**`src-tauri/Cargo.toml`** `[dependencies]` 段，`tauri-plugin-notification = "2"` 之后加一行：

```toml
tauri-plugin-autostart = "2"
```

**`src-tauri/src/lib.rs`** builder 链，`.plugin(tauri_plugin_notification::init())` 之后加：

```rust
/* 开机自启：Windows 写 HKCU Run 项（值 = 当前 exe 路径）。启动参数 None——
   启动即按常规流程建 pet/托盘等全窗，无需隐藏类标记 */
.plugin(tauri_plugin_autostart::init(
    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
    None,
))
```

（`MacosLauncher` 参数仅 macOS 消费，Windows 忽略；用全限定路径，与文件内
`tauri_plugin_single_instance::init` 的风格一致，不加 use。）

**验证**：`cargo check`（src-tauri 下）。

## 步骤 2：capabilities 放行

**`src-tauri/capabilities/default.json`**：

```json
"description": "桌面端默认能力：事件监听 + 拖拽把手 + 开机自启",
"permissions": [
  "core:default",
  "core:window:allow-start-dragging",
  "autostart:allow-enable",
  "autostart:allow-disable",
  "autostart:allow-is-enabled"
]
```

该文件 `windows` 数组已覆盖全部 5 窗；权限只暴露「注册/注销自己」三个动作，无数据面。

## 步骤 3：共享设置键

**`src/shared/moyu.js`** `DEFAULT_SETTINGS`，`petAlwaysOnTop: true,` 之后加：

```js
/* 开机自启：用户意图存这里；注册表/登录项是执行结果，启动时对账（见 service-host/index.js） */
autoStart: false,
```

注意语义：这是「全局键」——不要加进 `PER_SESSION_SETTINGS`（service.js），开机自启天然
账号级而非会话级，现有分流逻辑自动把它当全局键处理，无需改动。

## 步骤 4：Tauri 桥（desk-shim.js）

**`src/renderer/src/lib/desk-shim.js`** 系统类区（`togglePet: () => invoke('window_toggle_pet'),`
附近的 invoke 直连方法群里）加：

```js
/* 开机自启：系统边界，直接走插件通道。不引 @tauri-apps/plugin-autostart——
   该包就是这三个 invoke 的薄封装，命令名是插件稳定 API */
autostartGet: () => invoke('plugin:autostart|is_enabled'),
autostartSet: (on) => invoke(on ? 'plugin:autostart|enable' : 'plugin:autostart|disable'),
```

## 步骤 5：Electron 对照（IPC + preload）

**`src/main/index.js`** `registerIpc()` 内的 `windowHandlers` 表（`'pet:refit'` 条目之后）加：

```js
/* 开机自启：Windows 登录项。必须显式传 name 钉死条目名——不传的话 Electron 用
   AppUserModelID（electron.app.<exe ProductName>），随 exe 元数据漂移，卸载钩子会删不到。
   get 按当前 exe 路径查——便携目录挪动后会读到 false，正好由启动对账重注册 */
const LOGIN_ITEM_NAME = '摸鱼桌宠'
'autostart:get': () => app.getLoginItemSettings({ name: LOGIN_ITEM_NAME }).openAtLogin,
'autostart:set': (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(on), name: LOGIN_ITEM_NAME })
  return true
},
```

（windowHandlers 的 fn 直接作为 `ipcMain.handle(channel, fn)`，首参是 event——
带参条目签名照 `'pet:refit': (_e, size)` 的样子写。`name` 参数经 review 查 Electron
源码/文档确认两端 API 均支持；`LOGIN_ITEM_NAME` 与 PACKAGING_PLAN 卸载钩子共用同一名字。）

**`src/preload/index.cjs`** `window.desk` 白名单（`togglePet` 附近）加：

```js
/* 开机自启 */
autostartGet: () => invoke('autostart:get'),
autostartSet: (on) => invoke('autostart:set', on),
```

（preload 的 `invoke` 是 `(channel, ...args)` 直通封装，无通道校验表，无需其他改动。）

## 步骤 6：启动对账（自愈，两壳各一处）

**Tauri — `src/renderer/src/lib/service-host.js`**
「启动补齐」区，`pet_set_always_on_top` 那行之后（settings 已取得，同一段落）加：

```js
/* 开机自启对账：注册表记的是 exe 绝对路径，便携目录挪动后失效；
   意图在 settings.autoStart，这里按意图重写一次（幂等，兼自愈）。
   意图关且系统本就关时不碰注册表；系统调用失败不阻塞启动 */
try {
  const wantAutoStart = Boolean(settings.autoStart)
  if (wantAutoStart || (await window.desk.autostartGet())) {
    await window.desk.autostartSet(wantAutoStart)
  }
} catch (err) {
  console.warn('[service-host] 开机自启对账失败:', err)
}
```

（此文件只在 Tauri 的 pet 窗执行：main.js 仅 `route === 'pet'` 时动态 import，
且 desk-shim 是 main.js 首位 import，`window.desk` 此处必然已就绪。）

**Electron — `src/main/index.js`**
`whenReady` 内 `registerIpc()` 调用之后（service 已可用）加：

```js
/* 开机自启对账：与服务层设置对齐（挪目录后登录项路径失效，重设即自愈） */
service
  .getSettings()
  .then((s) => {
    const wantAutoStart = Boolean(s.autoStart)
    const opts = { name: '摸鱼桌宠' } /* 与 windowHandlers 的 LOGIN_ITEM_NAME 同名 */
    if (wantAutoStart || app.getLoginItemSettings(opts).openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: wantAutoStart, name: '摸鱼桌宠' })
    }
  })
  .catch(() => {})
```

## 步骤 7：设置页 UI

**`src/renderer/src/views/SettingsView.vue`**

模板：「桌宠外观」段「窗口置顶」field 之后加（沿用同款 switch 结构）：

```html
<div class="field">
  <label>开机自启</label>
  <label class="switch">
    <input
      :checked="form.autoStart"
      type="checkbox"
      @change="onAutoStartChange($event.target.checked)"
    />
    <span>登录 Windows 后自动运行；便携目录挪动后下次启动自动修正</span>
  </label>
  <p v-if="isDev" class="hint">开发模式下注册的是调试版 exe，正式使用请在打包版里开启</p>
</div>
```

script（与 `savedAt` 等 ref 同区）：

```js
const isDev = import.meta.env.DEV

/* 开机自启：立即写系统 + 立即落库，不走「保存」按钮——
   只改系统不落库的话，下次启动对账会按旧意图把它关掉 */
async function onAutoStartChange(on) {
  form.autoStart = on
  try {
    await window.desk.autostartSet(on)
    await saveSettings({ autoStart: on })
    savedAt.value = new Date()
    window.setTimeout(() => (savedAt.value = null), 2200)
  } catch {
    form.autoStart = await window.desk.autostartGet().catch(() => false)
  }
}
```

（`saveSettings`/`savedAt` 均为本文件现成成员；成功反馈复用「设置已保存」闪现。
立即落库 + 只提交 `{autoStart}` 单键，不掺入表单里其他未保存的半成品修改——
这与 `save()` 全量提交 `{...form}` 的语义刻意不同。）

## 步骤 8：文档

- `scripts/release-readme.txt`：「桌宠怎么用」或设置相关段落加一条用户可感的说明
  （设置 → 桌宠外观 → 开机自启；挪目录自动修正），并同步 `release/使用说明.txt`。
- `TAURI_MIGRATION.md`「当前进度」：完成后照惯例补一行实现记录
  （插件接线点、意图+对账模型、双壳覆盖）。

---

## 验证清单（全部步骤后）

自动化：`cargo check`（src-tauri）、`npm test`（smoke 448 + chat-test 138 全绿）、
`npm run build`。

手动（Tauri）：

1. 开关开 → `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"` 出现条目，
   值指向**当前** exe；关 → 条目消失。**同时记下条目名**（与 Electron 侧的条目名对照，
   供「两壳并存边角」留档）。
2. 自愈：把 release 目录改名模拟挪动 → 重启应用 → Run 条目值更新为新路径。
3. 挪动后不开应用直接重启系统 → 开机静默跳过旧路径（预期行为，非 bug）；
   手动启动一次后恢复。
2. 自愈：把 release 目录改名模拟挪动 → 重启应用 → Run 条目值更新为新路径。
3. 意图持久：开 → 退出 → 重启，开关仍为开（设置表落库正确）。
4. 面板多窗可达性：在 panel 窗的设置页切换正常（capabilities 全窗授权）。

手动（Electron）：开关后任务管理器「启动应用」页出现/消失对应条目；
同样做一遍挪目录自愈；两壳不同时跑（托盘/单实例/调试端口互扰，硬规则）。

## 提交

单提交（UI/桥/双壳是一个功能整体，拆开会出现「某壳开关损坏」的中间态）：

```
feat(desktop): 开机自启（双壳，意图存设置 + 启动对账自愈）

- Tauri 接官方 autostart 插件（capabilities 放行三命令），Electron 对照 setLoginItemSettings
- desk 新增 autostartGet/autostartSet 系统类方法，Tauri 直接 invoke 插件通道不加 npm 包
- settings.autoStart 存意图；两壳启动时按意图重写注册表/登录项，便携目录挪动后自愈
- 设置页桌宠外观段加开关：立即写系统+落库（不走「保存」，防对账按旧意图回关）；dev 模式提示注册的是调试 exe
```

## 风险与回滚

- revert 单提交即整体回滚（无 schema/数据迁移）。
- 已写入用户机器的 Run 项不会被 revert 清理——开关本身就是清理路径（关掉即删），
  无需迁移脚本。
- 最坏情况：插件在某 Windows 版本行为异常 → 对账逻辑包了 try/catch，不会阻塞启动；
  UI 回退显示真实注册表状态。
