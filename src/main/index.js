/**
 * 主进程 —— 桌宠透明窗 + 侧边栏面板窗 + 托盘。
 * 两个窗口共享同一份 service 状态，通过 IPC 广播保持同步。
 */
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { openStore } from './store.js'
import { createService } from './service.js'
import { createIpcHandlers } from './ipc-handlers.js'
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
 * 当前活跃会话 id 的存取已并入 ipc-handlers.js 业务表（双端共用），
 * 这里不再持有副本。
 */
let chatPetWindow = null
let petMenuWindow = null
let tray = null
let service = null
let petState = { x: null, y: null }

/* 桌宠不需要 File/Edit 菜单栏 */
Menu.setApplicationMenu(null)

/*
 * 桌宠窗 = 内容包围盒：宽 160×缩放（气泡 144 + 留白）；高 = 固定部分
 * （气泡+把手+留白 164，不随缩放，CDP 实测定值）+ 立绘 136×缩放。
 * 右键菜单已迁独立小窗，不再为它预留高度。
 * 公式与 Tauri scale.rs 的 pet_size 必须保持一致。
 */
const petSize = (s) => ({ width: Math.round(160 * s), height: Math.round(164 + 136 * s) })
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

/* 建窗互斥：createPetWindow 现在异步读设置，两次快速触发（如连点托盘）
   会各自走到建窗分支，创建出两个桌宠窗——复用同一份进行中的 promise。 */
let petCreating = null

function createPetWindow() {
  if (petCreating) return petCreating
  petCreating = createPetWindowImpl().finally(() => {
    petCreating = null
  })
  return petCreating
}

async function createPetWindowImpl() {
  const { workArea } = screen.getPrimaryDisplay()
  const settings = await service.getSettings()
  const scale = Math.max(0.6, Math.min(2, Number(settings.petScale) || 1))

  /* 一次性几何迁移（petPosition.v < 3，与 Tauri 建窗同规则、标记存共享 meta
     不会重复迁）：x 右移 180×scale（宽 340→160）；y 按旧高公式下移——
     v<2 从 700×scale、v=2 从 148+136×scale 起算（右下角锚定）。 */
  const savedRaw = await service.getMeta('petPosition', null)
  let saved = null
  if (savedRaw && Number.isFinite(savedRaw.x) && Number.isFinite(savedRaw.y)) {
    const v = savedRaw.v ?? 1
    if (v >= 3) {
      saved = savedRaw
    } else {
      saved = {
        x: savedRaw.x + 180 * scale,
        y: savedRaw.y + (v < 2 ? 536 * scale - 164 : -16),
        v: 3,
      }
      await service.setMeta('petPosition', saved).catch(() => {})
    }
  }
  /* 建窗尺寸：有 v4 存档直接用存档尺寸——恢复「上次的窗口」本身，比 petSize
     猜测准，且真实内容尺寸（气泡列定宽 144+16）不低于 Windows 最小窗宽，
     避免建窗被系统钳宽后右缘推出锚点、每次重启右漂。下限 80 与壳层贴合同。
     两壳同式（Tauri create_pet 同规则）。 */
  const savedSizeOk =
    saved &&
    (saved.v ?? 1) >= 4 &&
    Number.isFinite(saved.w) &&
    Number.isFinite(saved.h) &&
    saved.w >= 80 &&
    saved.h >= 80
  const { width: W, height: H } = savedSizeOk
    ? { width: saved.w, height: saved.h }
    : petSize(scale)
  /* v4 起位置记忆以「右下角锚点」为真值：存档记保存时刻的顶角 + 当时尺寸，
     恢复按锚点 − 建窗尺寸落位（建窗尺寸取自存档时即原样回放上次矩形）。
     内容驱动贴合（refitPetWindow）右下角锚定，锚点是它的不变量——直接回放
     顶角会把「气泡收起的贴合位移」当用户拖拽存下来，桌宠每次重启下移一段。
     v3 及更早的存档没有尺寸，按顶角原样落位一次，首次保存即升级 v4。 */
  if (saved && (saved.v ?? 1) >= 4 && Number.isFinite(saved.w) && Number.isFinite(saved.h)) {
    saved = { ...saved, x: saved.x + saved.w - W, y: saved.y + saved.h - H }
  }
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
  /* 系统最小尺寸钳制补偿（两壳同式）：请求尺寸低于 Windows 最小窗宽/高时，
     系统保左上角只钳尺寸，右/下缘被推出锚点。读实际尺寸按锚点 − 实际尺寸
     补一次定位，对任意平台最小值免疫。 */
  {
    const b = petWindow.getBounds()
    if (Math.abs(b.width - W) > 0.5 || Math.abs(b.height - H) > 0.5) {
      petWindow.setBounds({
        x: Math.round(x + W - b.width),
        y: Math.round(y + H - b.height),
        width: b.width,
        height: b.height,
      })
    }
  }

  petWindow.setAlwaysOnTop(true, 'floating')
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  loadRenderer(petWindow, 'pet')

  const rememberPosition = () => {
    if (!petWindow || petWindow.isDestroyed()) return
    const [px, py] = petWindow.getPosition()
    /* v4：顶角 + 当时尺寸，恢复端据此换算右下角锚点（见 createPetWindowImpl）。
       'moved' 只在用户拖拽结束时触发，贴合的程序性移动不会进这里 */
    const [pw, ph] = petWindow.getSize()
    petState = { x: px, y: py, w: pw, h: ph, v: 4 }
    service.setMeta('petPosition', petState).catch(() => {})
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

/* ---------- 桌宠右键菜单窗 ----------
 *
 * 独立无边框小窗（与桌宠窗解耦）：平时隐藏，右键时定位到光标显示。
 * 桌宠窗只包住气泡+本体，不再为菜单预留整块不可穿透的桌面区域。
 * 防溢出：以光标为菜单左上角，按光标所在显示器工作区钳制（右/下缘内收）。
 * 失焦即藏回——点菜单外任何地方（含桌宠本体）都算关闭，与原生菜单手感一致。
 */

const PETMENU_SIZE = { width: 340, height: 560 }

function createPetMenuWindow() {
  const win = new BrowserWindow({
    width: PETMENU_SIZE.width,
    height: PETMENU_SIZE.height,
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
  win.setAlwaysOnTop(true, 'floating')
  loadRenderer(win, 'petmenu')
  win.on('blur', () => {
    if (petMenuWindow && !petMenuWindow.isDestroyed()) petMenuWindow.hide()
  })
  win.on('closed', () => {
    petMenuWindow = null
  })
  return win
}

function showPetMenuWindow() {
  if (!petMenuWindow || petMenuWindow.isDestroyed()) {
    petMenuWindow = createPetMenuWindow()
  }
  const cur = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(cur)
  const { width: w, height: h } = PETMENU_SIZE
  const x = Math.max(workArea.x, Math.min(cur.x, workArea.x + workArea.width - w))
  const y = Math.max(workArea.y, Math.min(cur.y, workArea.y + workArea.height - h))
  petMenuWindow.setPosition(x, y)
  /* 首次显示等页面就绪，避免闪一帧透明空窗；用户在加载完成前已失焦/关闭的
     话以 __menuPending 作废该次显示。之后常驻隐藏、即点即现。 */
  if (petMenuWindow.__menuReady) {
    petMenuWindow.show()
    petMenuWindow.focus()
    return
  }
  petMenuWindow.__menuPending = true
  petMenuWindow.webContents.once('did-finish-load', () => {
    if (!petMenuWindow || petMenuWindow.isDestroyed() || !petMenuWindow.__menuPending) return
    petMenuWindow.__menuReady = true
    petMenuWindow.__menuPending = false
    petMenuWindow.show()
    petMenuWindow.focus()
  })
}

function hidePetMenuWindow() {
  if (petMenuWindow && !petMenuWindow.isDestroyed()) {
    petMenuWindow.__menuPending = false
    petMenuWindow.hide()
  }
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
  /* 托盘「显示/隐藏面板」文案跟随实际状态（桌宠窗 show/hide 同款接线）：
     togglePanel、window:hidePanel IPC、任务栏操作都汇到 show/hide，一处兜住 */
  panelWindow.on('show', rebuildTrayMenu)
  panelWindow.on('hide', rebuildTrayMenu)
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
  /* petMenuWindow 常驻隐藏也要收：菜单面板的亲密度/缩放/换装清单靠广播保持新鲜 */
  for (const win of [petWindow, panelWindow, chatWindow, chatPetWindow, petMenuWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('desk:event', { event, payload })
  }
}

/**
 * 按缩放值调整桌宠窗口尺寸，保持右下角锚定。
 * 缩放相关的入口（菜单按钮、设置滑块、重置设置）都走这里，避免漏掉某个路径。
 */
/* 窗口贴合：渲染层 ResizeObserver 量内容尺寸，这里按右下角锚定重设窗口。
   （取代旧 applyPetScale 手工公式——尺寸真值源是渲染层布局） */
function refitPetWindow({ width, height }) {
  if (!petWindow || petWindow.isDestroyed()) return
  const b = petWindow.getBounds()
  const w = Math.max(80, Math.round(width))
  const h = Math.max(80, Math.round(height))
  petWindow.setBounds({
    x: Math.round(b.x + b.width - w),
    y: Math.round(b.y + b.height - h),
    width: w,
    height: h,
  })
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
    /* Windows 的 nativeImage 按 BGRA 解释裸位图：写 B,G,R 让屏幕显示出代码
       本意的 RGB，与 Tauri 版托盘同色（TAURI_MIGRATION 图标注：以青色为准） */
    buf[i] = b
    buf[i + 1] = g
    buf[i + 2] = r
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
async function rebuildTrayMenu() {
  /* 退出中不再刷新：托盘马上就没了，刷新反而会碰到已关闭的数据库 */
  if (quitting) return
  if (!tray || tray.isDestroyed?.()) return
  const state = await service.getState()
  /* 等待期间可能已开始退出：state 拿到后不再碰已关闭的数据库 */
  if (quitting) return
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
    /* 面板/桌宠两个动态开关相邻；「打开摸鱼面板」与「显示面板」在面板未
       前台时完全同义，已并入这一个动态项 */
    { label: panelOpen ? '隐藏面板' : '显示面板', click: () => togglePanel() },
    { type: 'separator' },
    /* 明确写「找回」而不是「显示」，用户找不到时才会想到点它 */
    petVisible
      ? { label: '隐藏桌宠', click: () => togglePet() }
      : { label: petAlive ? '显示桌宠' : '找回桌宠', click: () => togglePet() },
    { label: 'AI 对话', click: () => createChatWindow() },
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
  /*
   * 业务类通道：与 Tauri 总线宿主共用同一张表（ipc-handlers.js）。
   * 表里的处理器不带 event 首参，这里包一层剥掉再进表。
   *
   * 串行队列：service 异步化后，基线同步 IPC「单 handler 一个事件循环
   * turn 内完成」的原子性要靠队列保持（读改写序列不能与并发 handler 交错）。
   * 长操作与 Tauri 总线同口径绕开——它们本就长时间 await 网络，队列挡不住。
   */
  const business = createIpcHandlers(service)
  const LONG_RUNNING = new Set(['chat:send', 'chat:diagnose', 'chat:test', 'chat:chatterLine'])
  let tail = Promise.resolve()
  const enqueue = (fn) => {
    const p = tail.then(fn)
    tail = p.catch(() => {})
    return p
  }
  for (const [channel, fn] of Object.entries(business)) {
    ipcMain.handle(channel, (_e, ...args) =>
      LONG_RUNNING.has(channel) ? fn(...args) : enqueue(() => fn(...args)),
    )
  }

  /* 窗口/系统类：窗口状态只有主进程知道，留在壳层（Tauri 侧是 Rust command） */
  const windowHandlers = {
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
    'pet:setScale': async (_e, scale) => {
      const s = Math.max(0.6, Math.min(2, Number(scale) || 1))
      await service.updateSettings({ petScale: s })
      /*
       * 必须广播新状态：桌宠的立绘尺寸由 settings.petScale 推导；
       * 窗口尺寸由渲染层量内容后 refit，壳层不再按公式改窗。
       */
      broadcast('state', await service.getState())
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
    /* 桌宠右键菜单窗：光标处弹出 + 防溢出；失焦由窗自身 blur 隐藏。
       （ui:pet 在业务表里，这里不再重复注册） */
    'menu:show': () => {
      showPetMenuWindow()
      return true
    },
    'menu:hide': () => {
      hidePetMenuWindow()
      return true
    },
    /* 菜单窗高度贴合：渲染层量面板高度，这里只改高度（顶边不动）。
       必须用 setBounds——Windows 下 resizable:false 的窗口 setSize 不生效
       （实测传 533 后 innerHeight 仍 560），桌宠窗贴合的 setBounds 一直有效 */
    'menu:resize': (_e, height) => {
      if (petMenuWindow && !petMenuWindow.isDestroyed()) {
        const b = petMenuWindow.getBounds()
        petMenuWindow.setBounds({
          x: b.x,
          y: b.y,
          width: b.width,
          height: Math.max(120, Math.round(height)),
        })
      }
      return true
    },
    /* 窗口贴合：渲染层量内容尺寸，右下角锚定重设窗口 */
    'pet:refit': (_e, size) => {
      refitPetWindow(size)
      return true
    },
  }

  for (const [channel, fn] of Object.entries(windowHandlers)) {
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
    service = createService(openStore(join(userData, 'desk-pet.db')), { loadSelfPortrait })
    /* 节假日表异步拉取，失败不影响启动（没有表就退回只看周末） */
    service
      .ensureHolidays()
      .then(async (r) => {
        if (r.ok) console.log(`[desk-pet] 节假日表就绪（${r.count} 天${r.cached ? '，来自缓存' : ''}）`)
        else console.warn(`[desk-pet] 节假日表获取失败，暂用周末规则：${r.reason}`)
        broadcast('state', await service.getState())
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
