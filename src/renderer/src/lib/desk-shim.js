/**
 * Tauri 环境下的 window.desk —— Electron preload（src/preload/index.cjs）的 1:1 替代。
 *
 * 分工（TAURI_MIGRATION.md §5.2/§5.3）：
 *   - 窗口/系统类（12 个）→ Rust command（窗口状态只有 Rust 知道）
 *   - 业务类 → serviceBus：转发到 pet 窗的业务宿主执行；pet 窗自身走
 *     `__DESK_BUS_HOST__` 进程内直调（不经事件绕行）
 *   - onEvent → Tauri 全窗事件 `desk:event`，payload 结构与 Electron 广播一致
 *
 * 安装方式：main.js 首位 import 副作用安装（不需具名导出）。
 * Electron 下 window.desk 已由 preload 注入 → 跳过；纯浏览器 → 跳过（mock 兜底）。
 */
import { createBusClient } from './service-bus.js'

function invoke(cmd, args = {}) {
  return window.__TAURI__.core.invoke(cmd, args)
}

/* ---------- 安装 ---------- */

function installDeskShim() {
  if (typeof window === 'undefined') return
  /* Electron preload 已注入真实实现，让位 */
  if (window.desk) return
  /* 纯浏览器打开（无 Tauri）交给 stores/app.js 的 mock，浏览器预览能力不丢 */
  if (!window.__TAURI__) return

  const route = new URLSearchParams(window.location.search).get('route') || 'pet'
  const bus = createBusClient(route)
  /* 业务调用：pet 窗（宿主自身）直调，其他窗走总线 */
  const viaBus = (channel) => (...args) => {
    if (window.__DESK_BUS_HOST__) return window.__DESK_BUS_HOST__.call(channel, ...args)
    return bus.call(channel, ...args)
  }

  window.desk = {
    /* 只读状态 */
    getState: viaBus('state:get'),
    getMeta: viaBus('meta:get'),

    /* 打卡 */
    checkIn: viaBus('checkin:create'),
    listCheckins: (args) => viaBus('checkin:list')(args ?? {}),

    /* 补卡：先预览再确认写入 */
    backfillPreview: viaBus('backfill:preview'),
    backfillApply: viaBus('backfill:apply'),

    /* 设置 */
    updateSettings: (patch, sessionId) => viaBus('settings:update')(patch, sessionId),
    resetSettings: () => viaBus('settings:reset')(),

    /* 当前活跃会话：对话窗设置，桌宠跟随 */
    getActiveSession: viaBus('session:getActive'),
    setActiveSession: viaBus('session:setActive'),

    /* 逐会话状态（人设/穿着/亲密度/图鉴都按会话隔离） */
    sessionAffinity: viaBus('session:affinity'),
    sessionSettings: viaBus('session:settings'),
    setSessionSetting: (sessionId, key, value) => viaBus('session:setSetting')(sessionId, key, value),
    galleryGet: (sessionId) => viaBus('gallery:get')(sessionId),
    clearSessionGallery: (sessionId) => viaBus('gallery:clear')(sessionId),
    explainTriggers: (text, sessionId) => viaBus('gallery:explain')(text, sessionId),

    /* 摸鱼时长记账 */
    logMoyu: viaBus('moyu:log'),
    listWorklogs: viaBus('worklog:list'),

    /* 云同步预留 */
    pendingChanges: viaBus('sync:pending'),
    markSynced: viaBus('sync:mark'),

    /* 节假日 */
    holidayInfo: viaBus('holiday:info'),
    holidayMonth: (year, month) => viaBus('holiday:month')(year, month),
    holidayRefresh: (year) => viaBus('holiday:refresh')(year),

    /* 亲密度 */
    affinityGet: viaBus('affinity:get'),
    affinityLevel: viaBus('affinity:level'),
    affinityAdd: (delta, opts, sessionId) => viaBus('affinity:add')(delta, opts, sessionId),
    affinityReset: (sessionId) => viaBus('affinity:reset')(sessionId),

    /* 人设 */
    personaList: viaBus('persona:list'),
    personaCreate: viaBus('persona:create'),
    personaDuplicate: viaBus('persona:duplicate'),
    personaUpdate: (id, patch) => viaBus('persona:update')(id, patch),
    personaDelete: viaBus('persona:delete'),

    /* 对话 */
    chatStatus: viaBus('chat:status'),
    chatTest: viaBus('chat:test'),
    chatDiagnose: viaBus('chat:diagnose'),
    chatSessions: viaBus('chat:sessions'),
    chatChatterLine: viaBus('chat:chatterLine'),
    chatEnsureSession: viaBus('chat:ensure'),
    chatCreateSession: (title) => viaBus('chat:create')(title),
    chatRenameSession: (id, title) => viaBus('chat:rename')(id, title),
    chatDeleteSession: (id) => viaBus('chat:delete')(id),
    chatLoad: (id) => viaBus('chat:load')(id),
    chatSend: (payload) => viaBus('chat:send')(payload),
    chatAbort: (requestId) => viaBus('chat:abort')(requestId),

    /* ↓ 窗口/系统类：走 Rust command（窗口状态只有 Rust 知道） */
    openChatWindow: () => invoke('chat_open_window'),
    hideChatWindow: () => invoke('chat_hide_window'),
    chatPetToggle: () => invoke('chat_toggle_pet'),
    togglePet: () => invoke('window_toggle_pet'),
    petVisible: () => invoke('window_pet_visible'),
    showEverything: () => invoke('window_show_everything'),
    openPanel: () => invoke('window_open_panel'),
    hidePanel: () => invoke('window_hide_panel'),
    minimize: () => invoke('window_minimize'),

    /*
     * petScale 是「settings 单一真相 + 窗口尺寸」的组合操作：
     * 先夹取（基线同款算术，settings 里永远只存 0.6-2 的合法值），
     * 再经业务表持久化并广播 state（立绘尺寸随广播更新），
     * 最后让 Rust 调整窗口尺寸——与 Electron 的 pet:setScale 等价。
     */
    setPetScale: async (scale) => {
      const s = Math.max(0.6, Math.min(2, Number(scale) || 1))
      /* 只持久化 + 广播：窗口尺寸由渲染层 ResizeObserver 量内容后 refit */
      await viaBus('settings:update')({ petScale: s })
      return s
    },
    setPetAlwaysOnTop: async (flag) => {
      await viaBus('settings:update')({ petAlwaysOnTop: Boolean(flag) })
      return invoke('pet_set_always_on_top', { flag })
    },
    /* 桌宠右键菜单窗：独立小窗，Rust 定位到光标并钳制防溢出 */
    showPetMenu: () => invoke('pet_menu_show'),
    hidePetMenu: () => invoke('pet_menu_hide'),
    /* 窗口贴合：渲染层量内容尺寸，壳层右下角锚定重设窗口 */
    refitPet: (size) => invoke('pet_refit', { width: size.width, height: size.height }),
    resizePetMenu: (height) => invoke('pet_menu_resize', { height }),
    /* 桌宠窗本地行为指令（气泡开关/退出挥手）：经 service 广播回桌宠窗 */
    petUiCommand: (action) => viaBus('ui:pet')(action),

    quit: () => invoke('pet_quit'),

    /* 主进程 → 渲染进程 事件：Tauri 全窗广播，payload 结构与 Electron 一致 */
    onEvent: (fn) => {
      let unlisten = null
      let disposed = false
      window.__TAURI__.event.listen('desk:event', (e) => fn(e.payload)).then((u) => {
        if (disposed) u()
        else unlisten = u
      })
      return () => {
        disposed = true
        unlisten?.()
      }
    },
  }
}

installDeskShim()
