# PACKAGING_PLAN — 双壳四形态打包方案

> 状态：待实施。目标矩阵：Electron / Tauri 各出 **NSIS 安装版** + **纯绿色版**。
> 与 AUTOSTART_PLAN.md 衔接：安装版卸载钩子负责清理开机自启注册表条目。

## 0. 现状盘点（2026-09-25 实测）

**Electron（`npm run pack`，@electron/packager）**：产物 `release/摸鱼桌宠-win32-x64/`，
实测 **12GB**。根因：`build.js` 的 packager `ignore` 只有 5 条，`app.asar` 里被打进了——

| 内容 | 规模 | 性质 |
|---|---|---|
| `src-tauri/`（含 `target/` Rust 构建产物） | 15,529 文件，**≈12G 的大头** | 另一壳的源码+编译产物，纯垃圾 |
| `node_modules/` | 713 条目 | 主进程**零外部 npm 依赖**（已核实：只有 electron + node: 内建 + 相对导入），可整体排除 |
| `.tmp-yuki/` | 299 文件 | 本地调试探针 |
| `TAURI_MIGRATION.md` `REVIEW_FINDINGS.md` 等内部文档 | 各 1 | **随包外流**——asar 用 7-zip 即可读，开源审计白做 |
| `.mimosa/` `mobile/` 仓库 `resources/`（源素材） | 60/17/124 文件 | 运行时不需要（代码不引用仓库根 resources/，渲染层只读 dist/） |

应有的体积 ≈ **350MB**：exe 201M + locales 44M + DLL/pak ~60M + asar ~40-60M（dist 含照片
31M + src 223 文件）。

**Tauri（`npx tauri build`）**：
- NSIS 安装版**已配置**（`bundle.targets: ["nsis"]`，`webviewInstallMode: downloadBootstrapper`），
  产物在 `src-tauri/target/release/bundle/nsis/`。
- 绿色版 = `target/release/app.exe`（Release 档资产已嵌入，69MB，单文件天然满足）。
- 元数据占位：`description: "A Tauri App"`、`authors: ["you"]`（开源审计已提）。

**工具链**：本机无 makensis / 7z；devDeps 只有 @electron/packager，无 electron-builder。

---

## 0.5 危险操作红线（安装/卸载的强制约束，步骤 2/3 的验收标准）

**数据位置清单**（三处，先盘点再动手）：

| 数据 | 位置 | 归属与说明 |
|---|---|---|
| 业务 DB（打卡/设置/聊天/亲密度全部数据） | `%APPDATA%\desk-pet\desk-pet.db` | **代码写死的固定路径**，双壳/双形态共享同一份；安装/卸载逻辑默认**绝不触碰** |
| Electron userData | `%APPDATA%\desk-pet\`（由 package name 决定，与 DB 同目录） | 缓存类数据 |
| Tauri/WebView2 用户数据 | 默认 = **exe 同目录 `<exe名>.exe.WebView2\`**（wry 不传 UDF 时 WebView2 自身默认）。**方案显式配 `dataDirectory`**（窗口配置键，指向 identifier 数据目录下）：UDF 移出安装目录 → 卸载后安装目录天然干净、绿色 exe 放只读目录也不再失败。键名与相对路径解析基准实施前查证 schema + 实测；查证不顺则回退默认 + 文档注明残留（不写钩子） | webview 缓存。放进 identifier 数据目录后归入「默认保留的个人数据」，与红线 3 哲学一致 |

**安装红线**：

1. **安装器绝不写开机自启**——自启唯一入口是应用内设置开关（AUTOSTART_PLAN），安装器
   连读都不读该状态。将来若要「安装时询问是否自启」，也必须跳转到应用内开关，不由安装器代写。
2. 只写 HKCU；**禁碰 HKLM**（per-user 安装免 UAC）。
3. 不改 PATH、不注册文件关联、不装服务、不装驱动、不写共享 DLL。
4. 安装目录只含程序文件；**个人数据（%APPDATA%）不迁移、不覆盖、不删除**——升级安装与
   首次安装对用户数据完全无感。
5. 安装前检测旧版进程在运行 → 提示用户退出后重试（可提供「尝试关闭」按钮但默认不强杀）。

**卸载红线**：

1. 删除范围 = 安装目录 + 本产品快捷方式 + 本产品卸载注册项 + **（仅当存在时）本产品的
   自启条目**。四项之外什么都不碰。
2. 自启条目按**精确条目名**删（`DeleteRegValue` 单值），**禁止删整个 Run key**、禁止
   通配/遍历清理。且**删前先 `ReadRegStr` 读值**，值数据指向本安装目录才删——同壳
   「安装版/绿色版」共用同一条目名，卸载安装版时不能误删指向绿色目录的自启。
3. **默认保留 `%APPDATA%` 个人数据**：v1 卸载器**不提供**「删除个人数据」选项
   （红线 8）；Tauri 侧由模板自带复选承担（红线 7），Electron 侧文档给出手动路径。
4. 卸载前同样做进程占用检测。
5. 卸载器自身删除（NSIS 自删机制）不留残目录。
6. **安装目录只含程序文件，零卸载钩子代码**：WebView2 UDF 显式配置到 identifier 数据
   目录（见数据位置清单），`$INSTDIR` 卸载后天然干净；模板自带的 Run 条目清理照用。
   自定义钩子 = 自定义风险面，v1 一行不写。
7. Tauri 卸载页自带「delete app data」复选（默认不勾）：勾选删 identifier 数据目录
   （含移入的 WebView2 UDF），**不含业务 DB**——写进使用说明防误判。
8. Electron 卸载器 v1 **不提供「删除个人数据」选项**（每多一条数据删除路径就多一类
   不可逆风险）；文档给出 DB 路径与手动清理方法。

**条目名核对表**（review 已查三方源码，实测仍要做）：

| 条目 | 名字规则（已查证） | 待实测 |
|---|---|---|
| Tauri 自启 Run 值名 | auto-launch 用 `package_info().name` = **productName** → 改名后即「摸鱼桌宠」；**2.11.5 NSIS 模板卸载段已内置删此条目** | 实施后 `reg query` 复核 |
| Electron 登录项 Run 值名 | 值名 = 显式 `name` 参数，否则 AUMID（`electron.app.<exe ProductName>`）。**方案已改为显式传 `name: '摸鱼桌宠'` 钉死**，杜绝随 exe 元数据漂移 | 实施后 `reg query` 复核 |
| `Explorer\StartupApproved\Run` 伴生值 | auto-launch enable 时同步写入、**disable 不删、NSIS 模板也不删** | v1 不清理（不可见、无害，≈注册表灰尘）；如后续在意，加一行钩子即可 |

**实现前查证——review 已给出结论（附出处，见审查报告）**：

- ✅ Tauri NSIS 钩子宏名 `NSIS_HOOK_PREINSTALL/POSTINSTALL/PREUNINSTALL/POSTUNINSTALL`、
  配置键 `installerHooks` 均正确；POSTUNINSTALL 在卸载段最末执行。
- ✅ NSIS 默认 `installMode: currentUser`，安装路径 = `$LOCALAPPDATA\${PRODUCTNAME}`；
  本仓 conf 已显式配 currentUser 与 `languages: ["SimpChinese","English"]`（方案原文
  「增补 languages」有误，实际已存在）。
- ✅ `downloadBootstrapper`：机器已有 WebView2 Runtime 则整段跳过；无 Runtime 时在线拉
  bootstrapper，**下载失败 → 安装中止（Abort）**——离线且无 Runtime 的机器装不了，
  使用说明注明；`offlineInstaller`（+127MB）留作备选不进 v1。
- ✅ Electron `setLoginItemSettings` 值名规则与 `name` 参数（见核对表）。
- ✅ WebView2 UDF 默认 = exe 同目录（见数据位置清单）。

**仍需实施时查证/实测**：

- [ ] 窗口配置键 `dataDirectory` 的 schema 拼写与相对路径解析基准（目标 = identifier
      数据目录下；解析不对就写死 `%LOCALAPPDATA%\com.yuki.deskpet\WebView2` 字面量）
- [ ] Electron exe 实际写入的 VersionInfo ProductName（显式 `name` 已兜底，仅记录）
- [ ] 实施后 `reg query` 复核两壳条目名与预期一致

## 0.6 免杀与系统友好（第一性原则的落地对照）

原则：**最小自定义面 + 行业最标准行为 + 无系统级变更**。逐项对照：

| 措施 | 依据 |
|---|---|
| 无 SFX、无加壳、无自解压（绿色单 exe 用 Tauri 原生 exe，方案 C） | SFX/壳是杀软误报第一大源 |
| Tauri 安装器 = 官方模板默认行为（CurrentUser、HKCU、标准 NSIS 结构） | 最标准的安装形态，启发式最低 |
| Electron .nsi 只做四件事：复制文件/快捷方式/HKCU 卸载注册/受保护的自启清理 | 行业最简安装器模式，无花活 |
| 全部 exe 元数据完整（FileDescription/CompanyName/ProductName/版本/图标） | 无元数据的 exe 是启发式重点对象；build.js 的 rcedit 步骤实施时核实存在且字段齐全 |
| 自启仅应用内 opt-in，安装器永不写 Run | 自启条目受 AV 关注，但「用户明确开关 + 标准写入」是正常行为 |
| 不碰 HKLM/服务/驱动/PATH/文件关联/共享 DLL | 系统级变更 = 误报 + 系统影响双重来源 |
| WebView2 UDF 显式配置 | 微软官方推荐做法（默认 exe 同目录被官方标注为安装型应用不可靠） |
| 数字签名 | 治本之策，OV 证书列 backlog（未签名的残余误报风险无法归零，只能最小化） |

---

## 步骤 1：Electron 绿色版止血（修 ignore）——独立先行提交

`scripts/build.js` packager `ignore` 增补（沿用现有前导斜杠正则风格）：

```js
/^\/src-tauri($|\/)/,      // 另一壳源码 + Rust target 构建产物（12G 大头）
/^\/node_modules($|\/)/,   // 主进程零外部依赖，运行时不需要；将来引入第一个生产依赖时记得收窄此条
/^\/\.tmp-yuki($|\/)/,     // 本地调试探针
/^\/\.mimosa($|\/)/,
/^\/\.zcode($|\/)/,        // agent 工作区目录（若存在）
/^\/mobile($|\/)/,         // 手机端独立分发
/^\/dist-mobile($|\/)/,    // mobile 构建产物（若存在）
/^\/resources($|\/)/,      // 仓库源素材（raw-cut/photos-new），运行时只读 dist/
/^\/(AGENTS|TAURI_MIGRATION|FIX_PLAN|README_AUDIT|REVIEW_FINDINGS|AUTOSTART_PLAN|PACKAGING_PLAN)\.md$/,
/^\/package-lock\.json$/,
```

必须保留：`src/`（主进程/preload/shared 按源码运行）、`dist/`（渲染层产物）、
`package.json`（Electron 入口清单）。

**验证**：打包后目录 ≤400MB；`npx asar list` 无 src-tauri / node_modules / 内部文档；
功能冒烟（启动、打卡、桌宠互动、AI 对话、设置保存）。预期 12GB → ~350MB。

## 步骤 2：Tauri NSIS 安装版（正式化）

1. `src-tauri/tauri.conf.json`（全部为**配置级**改动，零自定义安装代码）：
   - `productName` 改 `"摸鱼桌宠"`（安装目录 = `$LOCALAPPDATA\摸鱼桌宠`、开始菜单/主 exe
     显示中文名；**不动** `identifier`——单实例与数据目录锚点按 identifier 走，业务 DB
     路径本就固定）。**独立验证步**：先装一轮确认无误，异常则一行退回英文名。
   - `description`/`authors` 补真实值（去除占位，开源审计项）。
   - 窗口配置加 `dataDirectory`（见数据位置清单）：UDF 移出 `$INSTDIR`，卸载后安装目录
     天然干净——用配置解决残留，**替代自定义卸载钩子**；附带修复「绿色 exe 放只读
     目录启动失败」的失败模式。
   - 不配 `installerHooks`：模板自带的 Run 条目清理（按 productName）已覆盖主要残留；
     `StartupApproved` 伴生值残留不可见且无害，v1 接受（核对表有记录）。
2. **实施顺序依赖**：自启条目名复核与「开自启 → 卸载 → 无 Run 条目」验证依赖
   AUTOSTART_PLAN 先落地——本步骤与 AUTOSTART_PLAN 同批实施，或排其后。
3. 产物：`bundle/nsis/摸鱼桌宠_0.1.0_x64-setup.exe`。
4. **验证**：装 → 桌宠/托盘起 → 开自启 → 卸载 → `reg query` 确认 Run 条目已被模板清掉、
   `$INSTDIR` 整目录消失（含 UDF 已外移的前提）、`%LOCALAPPDATA%\com.yuki.deskpet\`
   保留（默认保留数据，符合红线 3）；安装版与绿色版数据互通、identifier 单实例防双开；
   「应用运行中直接卸载」一轮（模板 CheckIfAppIsRunning，确认行为）。

## 步骤 3：Electron NSIS 安装版（新做）

**选型：自写精简 `.nsi`，不引 electron-builder**——它自带 NSIS 但依赖链重、产物结构与
@electron/packager 双轨，build.js 的三个 Windows 坑硬化（Defender 锁/rename/EPERM）要重做；
我们只需要 NSIS 一个 target，脚本 ~80 行可控。

1. 工具：本机装 NSIS（`winget install NSIS.NSIS`，或 npm 包 `makensis` 封装下载）。
2. `scripts/installer.nsi` 要点：
   - **脚本头 `Unicode true`**（makensis 默认产出 ANSI 安装器，中文 productName/文案会乱码；
     文件以 UTF-8 写）
   - `RequestExecutionLevel user`（per-user 免 UAC），`InstallDir "$LOCALAPPDATA\Programs\摸鱼桌宠"`
   - `File /r` 打进 build.js 产物目录；开始菜单 + 桌面快捷方式；`WriteUninstaller`
   - HKCU 卸载注册（`Software\Microsoft\Windows\CurrentVersion\Uninstall`，含
     DisplayVersion）→ 出现在「应用和功能」
   - 卸载段：删目录 + **读值核对后**删登录项（值指向本安装目录才删，防误删绿色版；
     StartupApproved 伴生值 v1 不清理，见核对表）。**无数据删除选项、无升级逻辑**
   - **升级覆盖：v1 不做自动升级逻辑**，使用说明写「升级 = 先卸载再装」
   - 安装前检测旧版进程在跑则提示退出（复用 build.js `listAppProcesses` 思路）
   - VersionInfo + 图标（icons 既有 .ico）
3. `package.json` scripts 增：`"pack:installer": "node scripts/build.js && makensis scripts/installer.nsi"`
4. 产物：`release/摸鱼桌宠-Setup-<版本>.exe`。
5. **验证**：装/卸一轮；装完开自启 → 卸载 → 登录项无残留；与绿色版数据互通；
   未签名 → SmartScreen 警告（与现状一致），手册注明「更多信息 → 仍要运行」。

## 步骤 4：Electron 纯绿色单 exe（已决策：方案 C）

> 用户已拍板 **C**。评估记录（为什么不选 A/B）：A = 7z SFX，每次启动解压 ~350MB（启动慢
> 数秒）+ SFX 是杀软误报重灾区；B = 自研启动器壳（首启解压固定目录，体验好），但 +0.5~1 天
> 新组件，而双壳同构下 Tauri 天然就是真单 exe——C 零折损零新组件，单文件诉求由 Tauri 版承担。

落地内容：

- 绿色单 exe = Tauri `app.exe`（改名不影响运行，资产按自身路径解析）。
- Electron 绿色维持**目录形态** + 产出 zip（单文件分发用 zip；要真单 exe 就发 Tauri 版）。
- `release/` 里两形态并存、说明文字写清「单文件版（Tauri）/ 免安装目录版（Electron）」。
- 两壳功能一致（同一业务层），打包体积/启动特性差异如实写进使用说明。

## 步骤 5：Tauri 绿色版正式化 + 产物布局

- `target/release/app.exe` 即绿色单文件（改名不影响运行——资产按自身路径解析）。
- `release/` 统一布局（命名实施时定，原则三类分明）：

  ```
  release/
    摸鱼桌宠-<版本>-win32-x64/        # Electron 绿色目录
    摸鱼桌宠-<版本>-绿色单文件.zip     # Electron 目录 zip
    摸鱼桌宠-绿色版-单文件.exe         # Tauri app.exe（真单 exe，方案 C 的「单文件」担当）
    摸鱼桌宠-Setup-<版本>.exe          # Electron NSIS
    摸鱼桌宠-<版本>-x64-setup.exe      # Tauri NSIS
    使用说明.txt
  ```

- WebView2 Runtime：绿色版无 bootstrapper，依赖系统预装（Win10 21H2+/Win11 默认有）；
  缺失时启动报错。可选优化（不进 v1）：Rust 启动前探注册表 BLBeacon 版本，缺失提示安装。
- UDF 失败模式已由 `dataDirectory` 配置消除（UDF 不再依赖 exe 目录可写）；配置查证
  失败的回退情形下，恢复「使用说明提示放可写目录」。
- 多用户/权限注记（review 补）：per-user 数据各 Windows 账户独立，换账户或「以管理员
  身份运行」会看到另一份空数据，属预期；升级发版记得 bump 版本号（Arp 的
  DisplayVersion 取自 conf/package.json）。
- 数字签名：未签名的 SmartScreen/杀软误报短期靠手册话术，长期 OV 证书积累名誉——
  列 backlog 不进 v1。
- 体积注记：Tauri 绿色 69MB 由嵌入照片主导；「照片外置按需下载」蓝图 §8 已记为可选优化。

## 步骤 6：文档

- `scripts/release-readme.txt`（同步 `release/使用说明.txt`）：分「安装版 / 绿色版」两段——
  启动方式、升级（安装版重装覆盖 / 绿色版覆盖目录）、卸载（卸载程序 / 删目录 +
  自启条目说明）。使用说明还要写明（review 补充）：
  - 安装/解压路径**勿含空格**（auto-launch 写 Run 值不加引号，路径含空格自启失效；
    绿色版放可写目录）
  - 安装中断/杀软拦截 → 重新运行安装器覆盖即可（NSIS 无事务回滚）
  - Tauri 卸载页「delete app data」删的是 identifier 缓存目录，**不含业务 DB**
  - 离线且无 WebView2 Runtime 的机器装不了安装版（bootstrapper 在线拉取失败即中止）
  - 多账户各看各的数据属预期
- `TAURI_MIGRATION.md` 补实现记录（照惯例）。

## 验证清单（汇总）

- 每形态：装/卸或启动冒烟 + 包内容抽查（asar/zip 里无内部文档、无构建产物）。
- 自启联动：每形态开关一次；Tauri 卸载后 `reg query` 确认 Run 条目已被模板清掉
  （`StartupApproved` 残留为已知接受项）；Electron 卸载后登录项无残留（受保护删除）；
  「应用运行中直接卸载」一轮；「升级 = 卸载重装」走一遍。
- UDF：`dataDirectory` 生效位置实测；卸载后 `$INSTDIR` 整目录消失；
  绿色 exe 放只读目录可正常启动（UDF 已外移）。
- 体积对照：Electron 绿色 12GB → ~350MB（步骤 1 前后）。
- 回归：`npm test` + `npm run build` + `cargo check`。

## 提交拆分（每步一个 commit）

1. `fix(build): 打包 ignore 收紧，asar 12G→~40M`（止血，先行）
2. `build(tauri): NSIS 安装版正式化（元数据/WebView2 数据目录，零自定义钩子）`——**与
   AUTOSTART_PLAN 同批或后置**（自启条目名复核与卸载验证依赖自启功能已接入）
3. `build(electron): NSIS 安装脚本`（含 AUTOSTART_PLAN 步骤 5 的 name 钉死）
4. `chore(build): release 产物布局（Tauri 单 exe + Electron 目录/zip，方案 C）`
5. `docs: 使用说明分安装版/绿色版`

## 风险与回滚

- ignore 收紧若漏排运行时文件 → 冒烟即暴露；运行时依赖全清单 = electron + node:* + 相对导入（已核实）。
- NSIS 未装/脚本错误 → 步骤 3 独立，不阻塞绿色版产线。
- productName 改动 → 只影响 bundle 命名/安装目录显示；identifier 与数据路径不动，回滚 = 还原 conf。
