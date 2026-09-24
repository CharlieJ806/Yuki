/**
 * preload —— contextIsolation 下的唯一桥。
 * 暴露 window.desk，渲染进程不接触 Node / ipcRenderer 原始对象。
 */
const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('desk', {
  /* 只读状态 */
  getState: () => invoke('state:get'),
  getMeta: () => invoke('meta:get'),

  /* 打卡 */
  checkIn: () => invoke('checkin:create'),
  listCheckins: (args) => invoke('checkin:list', args ?? {}),

  /* 补卡：先预览再确认写入 */
  backfillPreview: (fromKey) => invoke('backfill:preview', fromKey),
  backfillApply: (fromKey) => invoke('backfill:apply', fromKey),

  /* 设置 */
  updateSettings: (patch, sessionId) => invoke('settings:update', patch, sessionId),
  /* 当前活跃会话：对话窗设置，桌宠跟随 */
  getActiveSession: () => invoke('session:getActive'),
  setActiveSession: (sessionId) => invoke('session:setActive', sessionId),
  /* 逐会话状态（人设/穿着/亲密度/图鉴都按会话隔离） */
  sessionAffinity: (sessionId) => invoke('session:affinity', sessionId),
  sessionSettings: (sessionId) => invoke('session:settings', sessionId),
  setSessionSetting: (sessionId, key, value) => invoke('session:setSetting', sessionId, key, value),
  galleryGet: (sessionId) => invoke('gallery:get', sessionId),
  clearSessionGallery: (sessionId) => invoke('gallery:clear', sessionId),
  explainTriggers: (text, sessionId) => invoke('gallery:explain', text, sessionId),
  resetSettings: () => invoke('settings:reset'),

  /* 摸鱼时长记账 */
  logMoyu: (minutes) => invoke('moyu:log', minutes),
  listWorklogs: (dateKey) => invoke('worklog:list', dateKey),

  /* 云同步预留 */
  pendingChanges: () => invoke('sync:pending'),
  markSynced: (ids) => invoke('sync:mark', ids),

  /* 节假日 */
  holidayInfo: (dateKey) => invoke('holiday:info', dateKey),
  holidayMonth: (year, month) => invoke('holiday:month', year, month),
  holidayRefresh: (year) => invoke('holiday:refresh', year),

  /* 亲密度 */
  affinityGet: () => invoke('affinity:get'),
  affinityLevel: () => invoke('affinity:level'),
  affinityAdd: (delta, opts) => invoke('affinity:add', delta, opts),
  affinityReset: () => invoke('affinity:reset'),

  /* 人设 */
  personaList: () => invoke('persona:list'),
  personaCreate: (payload) => invoke('persona:create', payload),
  personaDuplicate: (id) => invoke('persona:duplicate', id),
  personaUpdate: (id, patch) => invoke('persona:update', id, patch),
  personaDelete: (id) => invoke('persona:delete', id),

  /* 对话 */
  chatStatus: () => invoke('chat:status'),
  chatTest: () => invoke('chat:test'),
  chatDiagnose: () => invoke('chat:diagnose'),
  chatSessions: () => invoke('chat:sessions'),
  chatChatterLine: () => invoke('chat:chatterLine'),
  chatEnsureSession: () => invoke('chat:ensure'),
  chatCreateSession: (title) => invoke('chat:create', title),
  chatRenameSession: (id, title) => invoke('chat:rename', id, title),
  chatDeleteSession: (id) => invoke('chat:delete', id),
  chatLoad: (id) => invoke('chat:load', id),
  chatSend: (payload) => invoke('chat:send', payload),
  chatAbort: (requestId) => invoke('chat:abort', requestId),
  openChatWindow: () => invoke('chat:openWindow'),
  hideChatWindow: () => invoke('chat:hideWindow'),
  /* 对话窗旁边的立绘小窗显隐 */
  chatPetToggle: () => invoke('chat:togglePet'),

  /* 窗口控制 */
  togglePet: () => invoke('window:togglePet'),
  petVisible: () => invoke('window:petVisible'),
  showEverything: () => invoke('window:showEverything'),
  openPanel: () => invoke('window:openPanel'),
  hidePanel: () => invoke('window:hidePanel'),
  minimize: () => invoke('window:minimize'),
  setPetScale: (scale) => invoke('pet:setScale', scale),
  setPetAlwaysOnTop: (flag) => invoke('pet:setAlwaysOnTop', flag),
  quit: () => invoke('pet:quit'),

  /* 桌宠右键菜单窗：独立小窗，主进程定位到光标并钳制防溢出 */
  showPetMenu: () => invoke('menu:show'),
  hidePetMenu: () => invoke('menu:hide'),
  /* 桌宠窗本地行为指令（气泡开关/退出挥手）：经 service 广播回桌宠窗 */
  petUiCommand: (action) => invoke('ui:pet', action),

  /* 主进程 → 渲染进程 事件 */
  onEvent: (fn) => {
    const listener = (_e, msg) => fn(msg)
    ipcRenderer.on('desk:event', listener)
    return () => ipcRenderer.removeListener('desk:event', listener)
  },
})
