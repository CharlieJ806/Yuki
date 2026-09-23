/**
 * 主进程 —— 桌宠透明窗 + 侧边栏面板窗 + 托盘。
 * 两个窗口共享同一份 service 状态，通过 IPC 广播保持同步。
 */
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { createService } from './service.js'
import { SELF_PORTRAIT_SLUG } from '../shared/content.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEV_URL = process.env.DESK_DEV_URL || null
const IS_DEV = Boolean(DEV_URL)

/*
 * 允许通过环境变量开远程调试端口。
 * 用途：无头验证真实 Electron 窗（量取景、查渲染状态）。
 * 默认关闭，只有显式设了 DESK_DEBUG_PORT 才生效。
 */
if (process.env.DESK_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.DESK_DEBUG_PORT)
}

let petWindow = null
let panelWindow = null
let chatWindow = null

/*
 * 当前活跃会话 id —— 桌宠跟着它走（换装/亲密度都按会话隔离）。
 *
 * 桌宠是常驻窗，自己不知道用户正在聊哪个会话，所以由对话窗切换时
 * 通过 IPC 告知。**持久化**到 meta：重启后桌宠应该还是同一个她，
 * 不能每次开机都回落到「第一个会话」。
 */
let activeSessionId = null
let chatPetWindow = null
let tray = null
let service = null
let petState = { x: null, y: null }

/* 桌宠不需要 File/Edit 菜单栏 */
Menu.setApplicationMenu(null)

/*
 * 窗口要同时容纳：右键菜单 + 气泡 + 桌宠。
 * 菜单含亲密度面板后内容约 420px，加气泡 110 + 桌宠 140 + 间距 ≈ 690。
 * 之前 560 高会让菜单出现不易察觉的滚动条。
 */
const PET_SIZE = { width: 340, height: 700 }
const PANEL_SIZE = { width: 1080, height: 720 }

/* ---------- 窗口 ---------- */

function loadRenderer(win, route) {
  if (IS_DEV) {
    const url = new URL(DEV_URL)
    url.searchParams.set('route', route)
    return win.loadURL(url.toString())
  }
  return win.loadFile(join(ROOT, 'dist', 'index.html'), { query: { route } })
}

function createPetWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const settings = service.getSettings()
  const scale = Math.max(0.6, Math.min(2, Number(settings.petScale) || 1))
  const W = Math.round(PET_SIZE.width * scale)
  const H = Math.round(PET_SIZE.height * scale)

  const saved = service.getMeta('petPosition', null)
  /* 保存的位置若完全落在可视区外（换分辨率 / 拔掉外接屏），回退到右下角默认位 */
  const onScreen =
    saved &&
    Number.isFinite(saved.x) &&
    Number.isFinite(saved.y) &&
    saved.x + W > workArea.x + 20 &&
    saved.x < workArea.x + workArea.width - 20 &&
    saved.y + H > workArea.y + 20 &&
    saved.y < workArea.y + workArea.height - 20

  const x = onScreen ? saved.x : workArea.x + workArea.width - W - 24
  const y = onScreen ? saved.y : workArea.y + workArea.height - H - 24

  petWindow = new BrowserWindow({
    width: W,
    height: H,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(ROOT, 'src', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  petWindow.setAlwaysOnTop(true, 'floating')
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  loadRenderer(petWindow, 'pet')

  const rememberPosition = () => {
    if (!petWindow || petWindow.isDestroyed()) return
    const [px, py] = petWindow.getPosition()
    petState = { x: px, y: py }
    service.setMeta('petPosition', petState)
  }
  petWindow.on('moved', rememberPosition)
  petWindow.on('closed', () => {
    petWindow = null
    rebuildTrayMenu()
  })
  /* 系统快捷键 / 任务栏操作隐藏窗口时，托盘文案也要跟着更新 */
  petWindow.on('show', rebuildTrayMenu)
  petWindow.on('hide', rebuildTrayMenu)
  return petWindow
}

function createPanelWindow() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.show()
    panelWindow.focus()
    return panelWindow
  }
  const { workArea } = screen.getPrimaryDisplay()
  panelWindow = new BrowserWindow({
    width: PANEL_SIZE.width,
    height: PANEL_SIZE.height,
    x: Math.round(workArea.x + (workArea.width - PANEL_SIZE.width) / 2),
    y: Math.round(workArea.y + (workArea.height - PANEL_SIZE.height) / 2),
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: '摸鱼面板',
    backgroundColor: '#F5F5F7',
    webPreferences: {
      preload: join(ROOT, 'src', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  loadRenderer(panelWindow, 'panel')
  panelWindow.once('ready-to-show', () => panelWindow.show())
  panelWindow.on('closed', () => {
    panelWindow = null
  })
  return panelWindow
}

/**
 * 把事件推给所有活着的窗口。
 *
 * 注意别漏窗口：`chatPetWindow`（对话旁立绘小窗）必须在这里 ——
 * 漏掉它的后果是「对话框换装后，旁边立绘不变」，因为它收不到 state 广播，
 * 只能等自己的时间 tick（而那只更新时间、不刷设置）。
 */
function broadcast(event, payload) {
  /* 收尾阶段窗口正在销毁，再发消息没有意义，还可能踩到已关闭的 service */
  if (quitting) return
  for (const win of [petWindow, panelWindow, chatWindow, chatPetWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('desk:event', { event, payload })
  }
}

/**
 * 按缩放值调整桌宠窗口尺寸，保持右下角锚定。
 * 缩放相关的入口（菜单按钮、设置滑块、重置设置）都走这里，避免漏掉某个路径。
 */
function applyPetScale(rawScale) {
  const s = Math.max(0.6, Math.min(2, Number(rawScale) || 1))
  if (!petWindow || petWindow.isDestroyed()) return s
  const b = petWindow.getBounds()
  const w = Math.round(PET_SIZE.width * s)
  const h = Math.round(PET_SIZE.height * s)
  petWindow.setBounds({
    x: Math.round(b.x + b.width - w),
    y: Math.round(b.y + b.height - h),
    width: w,
    height: h,
  })
  return s
}

function togglePanel() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    if (panelWindow.isVisible()) panelWindow.hide()
    else {
      panelWindow.show()
      panelWindow.focus()
    }
    return
  }
  createPanelWindow()
}

/**
 * 兜底恢复：如果桌宠、面板、对话窗全都不显示，就说明用户「找不到了」。
 * 托盘单击默认走这里，保证任何情况下都有办法把界面叫回来。
 */
function restoreAnyWindow() {
  const petAlive = petWindow && !petWindow.isDestroyed()
  const petVisible = petAlive && petWindow.isVisible()
  const panelVisible = panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()
  const chatVisible = chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()

  if (petVisible || panelVisible || chatVisible) return false

  /* 桌宠优先恢复，它是最小、最不打扰的入口 */
  if (petAlive) petWindow.show()
  else createPetWindow()
  if (tray) tray.displayBalloon?.({
    title: '摸鱼桌宠',
    content: '桌宠已重新显示',
  })
  rebuildTrayMenu()
  return true
}

function togglePet() {
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow()
    rebuildTrayMenu()
    return
  }
  if (petWindow.isVisible()) petWindow.hide()
  else petWindow.show()
  /* 托盘里的「显示/隐藏桌宠」文案要跟着变，否则会与实际状态不一致 */
  rebuildTrayMenu()
}

/* ---------- 对话窗 ---------- */

const CHAT_PANEL_SIZE = { width: 420, height: 560 }
/* 侧边立绘窗：独立无边框小窗，贴在对话框左侧 */
const CHAT_PET_SIZE = { width: 132, height: 232 }

/**
 * 侧边立绘窗 —— 和对话框分开的独立窗口。
 *
 * 为什么不做在对话框内部：窗口宽只有 420，立绘浮在消息流右侧必然压到文字
 * （实测确认）。做成同级窗口后它贴着对话框外侧，互不遮挡，
 * 而且可以独立于对话框隐藏。
 */
function createChatPetWindow(anchorBounds) {
  if (chatPetWindow && !chatPetWindow.isDestroyed()) {
    positionChatPetWindow(anchorBounds)
    return chatPetWindow
  }
  const { workArea } = screen.getPrimaryDisplay()
  chatPetWindow = new BrowserWindow({
    width: CHAT_PET_SIZE.width,
    height: CHAT_PET_SIZE.height,
    x: workArea.x,
    y: workArea.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: join(ROOT, 'src', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  chatPetWindow.setAlwaysOnTop(true, 'floating')
  chatPetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  /* 它只是装饰，不该抢焦点（否则打字会断） */
  chatPetWindow.setFocusable(false)
  loadRenderer(chatPetWindow, 'chatpet')
  chatPetWindow.once('ready-to-show', () => {
    positionChatPetWindow(anchorBounds)
    chatPetWindow.show()
  })
  chatPetWindow.on('closed', () => {
    chatPetWindow = null
  })
  return chatPetWindow
}

/**
 * 把立绘窗贴到对话框左侧，夹在当前显示器工作区内。
 * 左边放不下时改放右侧，保证永远可见。
 */
function positionChatPetWindow(anchorBounds = null) {
  if (!chatPetWindow || chatPetWindow.isDestroyed()) return
  const { workArea } = screen.getPrimaryDisplay()
  const anchor = anchorBounds ?? (chatWindow && !chatWindow.isDestroyed() ? chatWindow.getBounds() : null)
  const W = CHAT_PET_SIZE.width
  const H = CHAT_PET_SIZE.height

  let x
  let y
  if (anchor) {
    /* 默认贴左侧，间距 8px；左边不够就贴右边 */
    x = anchor.x - W - 8
    if (x < workArea.x + 4) x = anchor.x + anchor.width + 8
    /* 底部对齐（立绘「站」在对话框旁边），上面夹住 */
    y = anchor.y + anchor.height - H
  } else {
    x = workArea.x + workArea.width - W - 24
    y = workArea.y + workArea.height - H - 24
  }

  x = Math.round(Math.min(Math.max(x, workArea.x + 4), workArea.x + workArea.width - W - 4))
  y = Math.round(Math.min(Math.max(y, workArea.y + 4), workArea.y + workArea.height - H - 4))
  chatPetWindow.setBounds({ x, y, width: W, height: H })
}

function destroyChatPetWindow() {
  if (chatPetWindow && !chatPetWindow.isDestroyed()) chatPetWindow.destroy()
  chatPetWindow = null
}

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show()
    chatWindow.focus()
    createChatPetWindow(chatWindow.getBounds())
    return chatWindow
  }

  /* 贴着桌宠弹出来，并夹在当前显示器工作区内 */
  const { workArea } = screen.getPrimaryDisplay()
  let x = workArea.x + workArea.width - CHAT_PANEL_SIZE.width - 40
  let y = workArea.y + workArea.height - CHAT_PANEL_SIZE.height - 60
  if (petWindow && !petWindow.isDestroyed()) {
    const b = petWindow.getBounds()
    x = b.x + b.width - CHAT_PANEL_SIZE.width
    y = b.y - CHAT_PANEL_SIZE.height + 40
  }
  x = Math.round(Math.min(Math.max(x, workArea.x + 8), workArea.x + workArea.width - CHAT_PANEL_SIZE.width - 8))
  y = Math.round(Math.min(Math.max(y, workArea.y + 8), workArea.y + workArea.height - CHAT_PANEL_SIZE.height - 8))

  chatWindow = new BrowserWindow({
    width: CHAT_PANEL_SIZE.width,
    height: CHAT_PANEL_SIZE.height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 320,
    minHeight: 360,
    maxWidth: 720,
    maxHeight: 900,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: join(ROOT, 'src', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  chatWindow.setAlwaysOnTop(true, 'floating')
  chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  loadRenderer(chatWindow, 'chat')
  /* 首次打开时要等窗口就绪再定位，否则 getBounds 拿到的还是初始位置 */
  chatWindow.once('ready-to-show', () => {
    chatWindow.show()
    createChatPetWindow(chatWindow.getBounds())
  })
  /* 立绘窗贴着对话框，所以对话框一动它就得跟着动 */
  chatWindow.on('move', () => positionChatPetWindow())
  chatWindow.on('resize', () => positionChatPetWindow())
  chatWindow.on('show', () => {
    createChatPetWindow(chatWindow.getBounds())
    positionChatPetWindow()
  })
  chatWindow.on('hide', () => chatPetWindow?.hide())
  chatWindow.on('closed', () => {
    chatWindow = null
    /* 对话框没了，立绘窗也不该留着变成孤儿窗口 */
    destroyChatPetWindow()
  })
  return chatWindow
}

/* ---------- 托盘 ---------- */

/**
 * 托盘图标 —— 画一只简化的小猫脸，而不是纯色方块。
 *
 * 之前是 16x16 里一个 10x10 纯色方块，Windows 11 默认把新托盘图标收进
 * 溢出面板，这种没辨识度的方块用户根本找不到，导致「关了桌宠就找不回来」。
 * 现在按 32x32 绘制（系统会缩放到托盘尺寸），有耳朵和眼睛，缩略下也能认出来。
 */
function trayImage() {
  const S = 32
  const buf = Buffer.alloc(S * S * 4)

  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return
    const i = (y * S + x) * 4
    buf[i] = r
    buf[i + 1] = g
    buf[i + 2] = b
    buf[i + 3] = a
  }

  const ACCENT = [0x14, 0xb8, 0xa6]
  const DARK = [0x0f, 0x2e, 0x2a]

  /* 头（实心圆） */
  const cx = 16
  const cy = 18
  const r = 10
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r * r) set(x, y, ...ACCENT)
    }
  }

  /* 两只耳朵（三角形，用简单扫描填充） */
  const ear = (baseX, dir) => {
    for (let h = 0; h < 8; h++) {
      const w = Math.max(1, Math.round((h / 7) * 6))
      for (let k = 0; k < w; k++) {
        set(baseX + dir * k, cy - 8 - h, ...ACCENT)
      }
    }
  }
  ear(9, -1)
  ear(23, 1)

  /* 两只眼睛（深色），缩略后仍能看出是猫 */
  const eye = (ex) => {
    for (let y = cy - 4; y <= cy - 1; y++) {
      for (let x = ex - 1; x <= ex + 1; x++) set(x, y, ...DARK)
    }
  }
  eye(12)
  eye(20)

  return nativeImage.createFromBuffer(buf, { width: S, height: S })
}

function createTray() {
  tray = new Tray(trayImage())
  tray.setToolTip('摸鱼桌宠 —— 单击显示/隐藏面板，右键打开菜单')
  rebuildTrayMenu()
  /* 单击：有窗口可见就切面板，全隐藏了就兜底恢复桌宠 */
  tray.on('click', () => {
    if (restoreAnyWindow()) return
    togglePanel()
  })
  tray.on('double-click', () => createPanelWindow())
  return tray
}

/*
 * 退出中标志。
 *
 * 退出顺序是：before-quit 关数据库 → 窗口收到 closed → 窗口的 closed 处理器
 * 调 rebuildTrayMenu() → service.getState() → 在已关闭的库上 getSettings()，
 * 于是弹出一个「database is not open」的原生错误框（用户点「退出」时必现）。
 * 所以一旦开始收尾，所有会碰 service 的回调都要直接短路。
 */
let quitting = false

/** 托盘菜单需要跟随状态刷新；与广播解耦，避免托盘创建失败时状态不同步 */
function rebuildTrayMenu() {
  /* 退出中不再刷新：托盘马上就没了，刷新反而会碰到已关闭的数据库 */
  if (quitting) return
  if (!tray || tray.isDestroyed?.()) return
  const state = service.getState()
  const petAlive = petWindow && !petWindow.isDestroyed()
  const petVisible = petAlive && petWindow.isVisible()
  const panelOpen = panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()

  const menu = Menu.buildFromTemplate([
    { label: `今日已摸鱼赚到 ${state.todayEarnedText}`, enabled: false },
    { label: `累计摸鱼 ${state.days} 天 · ${state.level.level.name}`, enabled: false },
    { type: 'separator' },
    {
      label: state.checkedInToday ? '今日已打卡' : '打卡',
      enabled: !state.checkedInToday,
      click: () => service.checkIn(),
    },
    { type: 'separator' },
    /* 明确写「找回」而不是「显示」，用户找不到时才会想到点它 */
    petVisible
      ? { label: '隐藏桌宠', click: () => togglePet() }
      : { label: petAlive ? '显示桌宠' : '找回桌宠', click: () => togglePet() },
    { label: '打开摸鱼面板', click: () => createPanelWindow() },
    { label: 'AI 对话', click: () => createChatWindow() },
    { type: 'separator' },
    { label: panelOpen ? '隐藏面板' : '显示面板', click: () => togglePanel() },
    { type: 'separator' },
    { label: '全部显示（找不到界面时点这里）', click: () => showEverything() },
    { label: '退出', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
}

/** 把桌宠和面板都叫出来 —— 兜底入口 */
function showEverything() {
  if (petWindow && !petWindow.isDestroyed()) petWindow.show()
  else createPetWindow()
  createPanelWindow()
  rebuildTrayMenu()
}

/** 服务层任何变更都同步到两个窗口 + 托盘 */
function bindStateBridge() {
  service.onChange((event, payload) => {
    if (quitting) return
    if (event === 'state') rebuildTrayMenu()
    broadcast(event, payload)
  })
}

/* ---------- IPC ---------- */

function registerIpc() {
  /* 恢复上次的活跃会话，桌上那只才是「同一个她」 */
  try {
    activeSessionId = service.getMeta?.('activeSessionId', null) ?? null
  } catch {
    activeSessionId = null
  }

  const handlers = {
    'state:get': () => service.getState(),
    'meta:get': () => service.meta(),
    'checkin:create': () => service.checkIn(),
    'checkin:list': (_e, args) => service.listCheckins(args ?? {}),
    'settings:update': (_e, patch, sessionId) => service.updateSettings(patch, sessionId),
    'settings:reset': () => {
      const next = service.resetSettings()
      /* 重置会把 petScale 恢复成 1，窗口尺寸必须跟着回去，
         否则立绘是 1× 但窗口还是放大后的尺寸，热区对不上 */
      applyPetScale(next.settings.petScale)
      broadcast('state', next)
      return next
    },
    'moyu:log': (_e, minutes) => service.logMoyu(minutes),
    'worklog:list': (_e, dateKey) => service.listWorklogs(dateKey),
    'sync:pending': () => service.pendingChanges(),
    'sync:mark': (_e, ids) => service.markSynced(ids),

    /* 节假日 */
    'holiday:info': (_e, dateKey) => service.holidayInfo(dateKey),
    'holiday:month': (_e, year, month) => service.monthSummary(year, month),
    'holiday:refresh': (_e, year) => service.refreshHolidays(year ?? new Date().getFullYear(), { force: true }),

    /* 亲密度 */
    'affinity:get': () => service.affinity(),
    'affinity:level': () => service.affinityLevel(),
    'affinity:add': (_e, delta, opts, sessionId) => service.addAffinity(delta, opts, sessionId),
    'affinity:reset': (_e, sessionId) => service.resetAffinity(sessionId),
    /*
     * 当前活跃会话 —— 桌宠跟它走。
     *
     * 桌宠是常驻窗，本身不知道用户在聊哪个会话；由对话窗在切换时
     * 显式告知。存下来后桌宠/面板都能读到同一个值。
     */
    'session:getActive': () => activeSessionId,
    'session:setActive': (_e, sessionId) => {
      activeSessionId = sessionId ?? null
      /* 持久化：重启后桌宠还是同一个她，不回落成「第一个会话」 */
      try {
        service.setMeta('activeSessionId', activeSessionId)
      } catch {
        /* 记不上不影响本次运行 */
      }
      /* 广播给所有窗口：桌宠要跟着换衣服、面板要刷新图鉴 */
      broadcast('session-active', { sessionId: activeSessionId })
      return activeSessionId
    },

    /* 逐会话状态：渲染端切换会话时必须传 sessionId */
    'session:affinity': (_e, sessionId) => service.sessionAffinity(sessionId),
    'session:settings': (_e, sessionId) => service.sessionSettings(sessionId),
    'session:setSetting': (_e, sessionId, key, value) => service.setSessionSetting(sessionId, key, value),
    'gallery:get': (_e, sessionId) => service.sessionGallery(sessionId),
    'gallery:clear': (_e, sessionId) => service.clearSessionGallery(sessionId),
    'gallery:explain': (_e, text, sessionId) => service.explainTriggers(text, sessionId),

    /* 补卡 */
    'backfill:preview': (_e, fromKey) => service.previewBackfill(fromKey),
    'backfill:apply': (_e, fromKey) => service.applyBackfill(fromKey),

    /* 人设 */
    'persona:list': () => service.listPersonas(),
    'persona:create': (_e, payload) => service.createPersona(payload),
    'persona:duplicate': (_e, id) => service.duplicatePersona(id),
    'persona:update': (_e, id, patch) => service.updatePersona(id, patch),
    'persona:delete': (_e, id) => service.deletePersona(id),

    /* 对话 */
    'chat:status': () => service.chatStatus(),
    'chat:test': () => service.chatTest(),
    'chat:diagnose': () => service.chatDiagnose(),
    'chat:sessions': () => service.listChatSessions(),
    'chat:ensure': () => service.ensureChatSession(),
    'chat:create': (_e, title) => service.createChatSession(title),
    'chat:rename': (_e, id, title) => service.renameChatSession(id, title),
    'chat:delete': (_e, id) => service.deleteChatSession(id),
    'chat:load': (_e, id) => service.loadChatSession(id),
    'chat:chatterLine': () => service.generateChatterLine(),
    'chat:send': (_e, payload) => service.sendChat(payload ?? {}),
    'chat:abort': (_e, requestId) => service.abortChat(requestId),
    'chat:openWindow': () => {
      createChatWindow()
      return true
    },
    'chat:hideWindow': () => {
      chatWindow?.hide()
      return true
    },
    /* 侧边立绘窗开关：返回切换后的可见状态 */
    'chat:togglePet': () => {
      if (!chatPetWindow || chatPetWindow.isDestroyed()) {
        createChatPetWindow(chatWindow && !chatWindow.isDestroyed() ? chatWindow.getBounds() : null)
        return true
      }
      if (chatPetWindow.isVisible()) {
        chatPetWindow.hide()
        return false
      }
      positionChatPetWindow()
      chatPetWindow.show()
      return true
    },
    'window:togglePet': () => {
      togglePet()
      return petWindow?.isVisible() ?? false
    },
    'window:petVisible': () => Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible()),
    'window:showEverything': () => {
      showEverything()
      return true
    },
    'window:openPanel': () => {
      createPanelWindow()
      return true
    },
    'window:hidePanel': () => {
      panelWindow?.hide()
      return true
    },
    'window:minimize': (e) => {
      BrowserWindow.fromWebContents(e.sender)?.minimize()
      return true
    },
    'pet:setScale': (_e, scale) => {
      const s = Math.max(0.6, Math.min(2, Number(scale) || 1))
      service.updateSettings({ petScale: s })
      applyPetScale(s)
      /*
       * 必须广播新状态：桌宠的立绘尺寸由 settings.petScale 推导，
       * 不广播的话它要等下一次轮询（15s）才会重排，
       * 期间窗口已经是新尺寸、图还是旧的，点击热区就对不上了。
       */
      broadcast('state', service.getState())
      return s
    },
    'pet:setAlwaysOnTop': (_e, flag) => {
      const on = Boolean(flag)
      service.updateSettings({ petAlwaysOnTop: on })
      petWindow?.setAlwaysOnTop(on, 'floating')
      return on
    },
    /* 拖拽由 -webkit-app-region: drag 交给窗口管理器完成，无需 IPC 参与 */
    'pet:quit': () => {
      app.quit()
      return true
    },
  }

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, fn)
  }
}

/**
 * 读取她自己的参考图并转成 data URL，供对话时注入。
 *
 * 为什么在这里读而不是 service 里：资源路径的解析依赖打包方式
 * （开发时在 src/renderer/public，打包后被复制到 dist/ 一起进 asar），
 * service 刻意不感知这些。所以由主进程提供，通过参数注入。
 *
 * 用同步读：只在第一次对话时调用一次，之后 service 内部有缓存；
 * 出错返回空串（没有参考图也能正常聊，不该因此让对话整个失败）。
 */
function loadSelfPortrait() {
  const file = join(ROOT, 'dist', `yuki-${SELF_PORTRAIT_SLUG}.png`)
  try {
    const buf = readFileSync(file)
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch (err) {
    console.warn(`[desk-pet] 参考图读取失败（将不注入）：${err?.message ?? err}`)
    return ''
  }
}

/* ---------- 生命周期 ---------- */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => createPanelWindow())

  app.whenReady().then(() => {
    const userData = app.getPath('userData')
    mkdirSync(userData, { recursive: true })
    service = createService(join(userData, 'desk-pet.db'), { loadSelfPortrait })
    /* 节假日表异步拉取，失败不影响启动（没有表就退回只看周末） */
    service
      .ensureHolidays()
      .then((r) => {
        if (r.ok) console.log(`[desk-pet] 节假日表就绪（${r.count} 天${r.cached ? '，来自缓存' : ''}）`)
        else console.warn(`[desk-pet] 节假日表获取失败，暂用周末规则：${r.reason}`)
        broadcast('state', service.getState())
      })
      .catch(() => {})
    registerIpc()
    bindStateBridge()
    createTray()
    createPetWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createPetWindow()
    })
  })

  /* 桌宠是常驻窗口：全部关闭也不退出，靠托盘退出 */
  app.on('window-all-closed', () => {})

  app.on('before-quit', () => {
    /*
     * 必须先置 quit 标志再关库：关库之后窗口的 closed 事件还会跑一遍
     * rebuildTrayMenu，那时它若去读已关闭的数据库就会抛原生错误框。
     */
    quitting = true
    try {
      service?.close()
    } catch {
      /* ignore */
    }
    service = null
  })
}
