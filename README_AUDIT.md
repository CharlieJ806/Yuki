# README_AUDIT — README 与当前代码冲突审计（2026-09-24）

状态：审计完成，按本清单逐项修复 README。
背景：feat/tauri 完成 Tauri 化（双壳）+ 合并 origin/main（生活照/立绘页/亲密度机制/mobile/资产去量化）后，README（1366 行）多处描述与代码脱节。
方法：子 agent 通读 README 全文逐节核对，冲突按严重度排序。行号为审计时的实际行号，修复时会漂移，以章节定位为准。

---

## 一、高危冲突（会误导开发/使用）

| # | README 位置 | README 原文要点 | 当前代码实况 | 修复方向 |
|---|---|---|---|---|
| 1 | 亲密度 L783-785 | 「聊天另设日上限（CHAT_AFFINITY_DAILY_CAP=60），手动互动不受约束」 | AFFINITY_DAILY_CAP=60 是**全来源合计**封顶，点击/摸头也计入；CHAT_AFFINITY_DAILY_CAP 仅是兼容旧名（interactions.js:100-113；service 走 settleAffinity） | 改为「全来源合计」 |
| 2 | 亲密度 L807-809 | `addAffinity(delta, opts)` 两参、`opts.kind==='chat'` 决定配额 | 公开签名 `addAffinity(delta, opts, sessionId, now)` 四参；全来源都过 settleAffinity；新增 `opts.upsetting` | 重写签名与配额语义 |
| 3 | 亲密度全章 L765-809 | 无衰减/惹怒机制 | 新增 AFFINITY_DECAY（3 天未互动每天 −1）、惹怒 −2 且当轮只扣不加、settleAffinity/affinityDecay/isUpsetting、gainDay/gainToday/lastActive/decaySettledDays 字段 | 整节补写 |
| 4 | 亲密度 L762-764；L1354 | 「亲密度存在 meta.affinity」 | 按会话隔离存 `meta.affinity:<sessionId>`，legacy 全局键迁移后清除；另有 activeSessionId、`set:<key>` 逐会话设置键 | 更新键名与隔离说明 |
| 5 | 桌宠窗口尺寸约束 L1315-1323 | 「菜单+气泡+桌宠同窗 flex 布局，340×700，菜单 overflow-y:auto」 | 菜单迁独立 petmenu 小窗（340×560，光标定位+工作区钳制+blur 收起）；桌宠窗=内容包围盒 petSize(s)；渲染层 ResizeObserver → pet:refit 右下角锚定；menu:resize setBounds；KEEP_OPEN 分类 | 整节重写 |
| 6 | 缩放 L702-706 | 「三条路径统一走 applyPetScale()」；「340×700 : 118×136 成比例」排查口诀 | applyPetScale 已删除；pet:setScale 只写设置+广播，窗口尺寸由渲染层 refit | 保留「单一真相来源」不变量，机制段改 refit |
| 7 | 拖拽 L708-711 | 「移动用 -webkit-app-region: drag」 | 仅 Electron 壳成立；Tauri 壳用 startDragging；「禁止 mousemove+setPosition」两壳都成立 | 改为两壳分述 + 共同禁令 |
| 8 | 安全边界 L1362-1364 | 「渲染层只走 preload 白名单 window.desk；IPC 全走 ipcMain.handle」 | 仅 Electron 壳成立；Tauri 壳业务层在 pet 窗 webview（service-host 直建 service，走 invoke/总线） | 补 Tauri 壳安全边界 |
| 9 | 角色设定 L322-327 | 「四个预设：Yuki/女友（黏人型）/学习助手/通用助手」 | 内置 3 个：yuki/study/assistant，女友人设已删 | 改为三个 |
| 10 | 服饰系统 L912/953/968 | 「17 张/共 17 套/全部 17 套」 | OUTFITS 24 套（README L90/L486 自己已写 24） | 统一 24 |
| 11 | 挂机轮换 L595-618 | 候选池「4→5→12→16→27」；动作档位「snack/music/think/yawn」；「剩 4 张事件触发」 | 动作池 4/7/10/13/15（最低档 read，yawn 在最高档）；候选 4/8/14/21/39；事件触发 6 张（angry/jump/wave/thumbsup/clap/cry） | 重写两张表 |
| 12 | 挂机轮换 L623-625 | 「深夜早八只显示 TIRED_POSES，不轮换」 | 已是加权不排除（weightedPool；README L983-998 自己也这么说——内部矛盾） | 删硬过滤旧说法 |
| 13 | 表情系统 L563/582/591/613-614 | 「12 张立绘两类」；jump=打卡备选、thumbsup=打卡成功 | PET_EXPRESSIONS 25 个 key；打卡成功由 service 直接广播 jump（checkIn 与补卡同源）；thumbsup 现由聊天关键词触发 | 更新表情表与触发行 |
| 14 | 图鉴 L1044 | 「装扮 17 套 + 视频 7 段」 | 24 装扮 + 15 视频 + 23 生活照三分类（GALLERY_KEYS 含 photo） | 三分类并更新数量 |
| 15 | 图鉴 L1062 | 「checkGalleryUnlock 按 kind 参数化」 | 该函数已不存在；现为 shared/gallery.js 的 createGalleryRunner 三分类共用管线 | 更新 API 名 |
| 16 | 照片解锁 L396-402 | 「每套装扮配一张照片」「聊天记录里多一条消息」 | 一套可配多张；解锁产出多条消息（配文+每图一条，appendUnlockPhoto） | 与 L546 段对齐 |
| 17 | 时间感 L884-885、L1128 | 「时间块拼在 system 最前面/每轮都在最前」 | 实际是人设在前、时间块在后（chat.js:27/55/81；README L1091-1122 章节也如此——L884/L1128 是改序前残留） | 改为「人设后、system 末尾」 |
| 18 | 自动换装 L972-978 | 「23-07 睡衣 / 07-09、21-23 居家清凉 / 其余便服」三套规则 | outfitForTime 按「已解锁服饰 × 时段适配表 + 稳定散列」从全池挑选；旧三套只是无解锁清单时的回落 | 重写为解锁池+时段适配规则 |
| 19 | 命令 L49-76 | 清单只列 smoke/test/dev/start/pack；fake-llm 一节引用 scripts/fake-llm.js | package.json 还有 test:chat/dev:web/tauri/pack:mobile/mobile/mobile:open；fake-llm.js 文件已丢失 | 补命令清单；fake-llm 脚本补回（本次已补） |

## 二、中危：描述过期、部分失真

| # | README 位置 | 要点 | 实况 | 修复方向 |
|---|---|---|---|---|
| 20 | 技术栈 L13 | 「桌宠是手绘 SVG，无图片资源」 | PNG 立绘（L80 自己也是 img PNG——内部矛盾） | 改「PNG 立绘 + CSS 动效」 |
| 21 | 技术栈 L11、目录 L34 | 「route=pet\|panel 两个应用」「pet/panel/chat」 | 5 路由：pet/panel/chat/chatpet/petmenu | 更新路由清单 |
| 22 | 目录 L23/25/37 | index.js 三窗；store 表清单；PetApp「SVG 猫+右键菜单」；shared 只列 moyu.js | index.js 管五窗；表清单缺 personas；PetApp 是 PNG 立绘无菜单；shared 15+ 模块 | 更新目录树 |
| 23 | 位置记忆 L723-724 | 「moved 写 meta.petPosition，重启恢复」 | 升级 v4=顶角+当时尺寸，恢复按右下角锚点−建窗尺寸；v<3 迁移；钳制补偿 | 补 v4 语义 |
| 24 | 数据与同步 L1354 | meta 存 affinity/holiday-<year>/petPosition | affinity:<sid>；petPosition v4；activeSessionId；set:* 键 | 更新 meta 键清单 |
| 25 | AI 对话 L295-296 | 配置存 settings 表（含 chatPersona 等） | chatPersona/outfitMode/outfitSlug/petStories 已逐会话存 meta `set:<key>` | 注明逐会话键 |
| 26 | 照片消息形态 L553-555 | 「主进程/手机端各自实现，见 stores/app.js 与 mobile/app.js」 | 桌面主进程也有 appendUnlockPhoto（service.js） | 指路补 service.js |
| 27 | 视频 L1073 | 「7 段约 7.3MB 压到 5.1MB」 | 现在 15 段 | 更新数字 |
| 28 | 手机版 L197 | 共享图只列 moyu/content/interactions | shared 15+ 模块 | 扩充图示 |
| 29 | 服饰解锁表 L960-968 | 按档位「熟络起来了→便服…形影不离 17 套」 | OUTFIT_MIN_POINTS 精确到每套（0/40/120/300） | 表重画 |

## 三、两壳行为不同但 README 断言唯一行为

1. 拖拽机制（#7）：Electron=app-region；Tauri=startDragging。
2. 安全边界/IPC 面（#8）：Electron=preload+ipcMain.handle；Tauri=webview 内业务层+总线+Rust command。
3. Node 22+/node:sqlite 硬要求（L16）：只约束 Electron 壳；Tauri 走 rusqlite（改写技术栈时注明）。

## 四、仍然有效、无需改的章节

L49-64 命令主干与 DESK_DEBUG_PORT；L96-146 2D 动效路线/3D 移除结论；L184-228 手机版机制主体；L230-279 打包产物与三个 Windows 坑；L281-317 AI 对话 SSE/取消/错误翻译；L336-530 立绘/照片素材流水线；L532-560 查看详情与照片消息逐条出现；L633-656 chatDiagnose；L658-686 窗口找回；L688-697 缩放不变量段；L726-762 节假日与互动表；L776-782 亲密度上限 300 与档位行为表；L811-838 补卡/streak；L840-875 挂机台词 role 重建；L877-908 时间感主体（除「最前面」两处）；L910-929 命名空间与换装入口守卫；L1002-1032 对话窗立绘放窗外；L1065-1122 视频三问题/预缓存/提示词顺序章节；L1130-1273 主动认知/多模态/认识自己；L1275-1313 挂机冒泡 6:4/自定义人设；L1325-1360 摸鱼算法与同步字段。

## 五、README 内部自相矛盾（一并清理）

1. L884/L1128（时间块最前）vs L1091-1122（人设在前）。
2. L623-625（深夜硬过滤）vs L983-998（加权）。
3. L13（SVG）vs L80（PNG 立绘）。
4. L396-402（照片一条消息）vs L546-559（多条）。
5. L90/L486（24 套）vs L953/L968（17 套）。
