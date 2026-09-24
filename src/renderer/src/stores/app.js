/**
 * 渲染进程状态容器。
 * 优先走 window.desk（Electron preload）；不在 Electron 里时回退到内置的
 * 本地 mock —— 这样纯浏览器打开也能开发/预览界面。
 */
import { reactive, readonly } from 'vue'
import {
  DEFAULT_SETTINGS,
  LEVELS,
  REST_PATTERNS,
  formatMoney,
  levelOf,
  paydayCountdown,
  todaySnapshot,
  toDateKey,
} from '@shared/moyu.js'

const store = reactive({
  ready: false,
  settings: { ...DEFAULT_SETTINGS },
  snapshot: todaySnapshot(DEFAULT_SETTINGS),
  days: 0,
  streak: 0,
  level: levelOf(0),
  payday: paydayCountdown(DEFAULT_SETTINGS),
  checkedInToday: false,
  checkin: null,
  workDaysThisMonth: 0,
  todayEarnedText: formatMoney(0),
  dailySalaryText: formatMoney(0),
  salaryText: formatMoney(DEFAULT_SETTINGS.salary),
  loggedMinutesToday: 0,
  checkins: [],
  /* 节假日：{ name, isMakeup, isStatutory, hasTable } */
  holiday: { name: null, isMakeup: false, isStatutory: false, hasTable: false },
  /* 亲密度等级表与得分规则由主进程 meta 下发，这里只给占位避免首屏 undefined */
  meta: { levels: LEVELS, restPatterns: REST_PATTERNS, defaults: DEFAULT_SETTINGS, affinity: null, version: '0.1.0' },
  backend: 'mock',
  lastError: null,
  personas: [],
  /* 亲密度：{ points, lastDay, streakDays, chatToday, max, isMax, sessionId } */
  affinity: { points: 0, lastDay: null, streakDays: 0, chatToday: 0, max: 0, isMax: false },
  /*
   * 图鉴：{ sessionId, outfit: {..}, video: {..} }
   * 每个会话一份（独立角色），所以拉取时必须带 sessionId。
   */
  gallery: null,
  /* 最近一次解锁：{ kind, slug, title, line }，聊天窗据此弹展示 */
  lastUnlock: null,
  /*
   * 当前活跃会话 id。
   * 桌宠跟着它走（换装/亲密度按会话隔离）；对话窗切换时写入。
   */
  activeSessionId: null,
  /* 补卡预览：{ from, to, count, days, hasHolidayTable } */
  backfill: null,
  /* 跨窗口表情指令：{ key, holdMs, seq }；面板/对话窗触发，桌宠窗消费 */
  emoteRequest: null,
  /* 对话 */
  chat: {
    status: { ready: false, reason: null, model: '', hasApiKey: false, needsApiKey: true },
    sessions: [],
    sessionId: null,
    messages: [],
    streaming: false,
    streamText: '',
    requestId: null,
  },
})

export const state = readonly(store)

function applyState(next) {
  if (!next) return
  Object.assign(store, next, { ready: true })
}

function toApiError(err) {
  return err instanceof Error ? err.message : String(err)
}

/* ---------- mock 后端：浏览器内预览用 ---------- */

function createMockBackend() {
  let settings = { ...DEFAULT_SETTINGS }
  let checkins = []
  let mockSessions = [
    { id: 'mock-default', title: '新的对话', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
  ]
  let mockMessages = []
  const recompute = () => {
    const snap = todaySnapshot(settings)
    const days = checkins.length
    return {
      settings,
      snapshot: snap,
      days,
      streak: days,
      level: levelOf(days),
      payday: paydayCountdown(settings),
      checkedInToday: checkins.some((c) => c.dateKey === snap.dateKey),
      checkin: checkins.find((c) => c.dateKey === snap.dateKey) ?? null,
      workDaysThisMonth: snap.workDaysInMonth,
      todayEarnedText: formatMoney(snap.todayEarned, settings.salaryCurrency),
      dailySalaryText: formatMoney(snap.dailySalary, settings.salaryCurrency),
      salaryText: formatMoney(settings.salary, settings.salaryCurrency),
      loggedMinutesToday: 0,
      checkins,
    }
  }
  return {
    getState: async () => recompute(),
    getMeta: async () => store.meta,
    checkIn: async () => {
      const dateKey = toDateKey(new Date())
      if (!checkins.some((c) => c.dateKey === dateKey)) {
        checkins = [{ id: `mock-${dateKey}`, dateKey, createdAt: Date.now(), note: null }, ...checkins]
      }
      return { created: true, dateKey, state: recompute() }
    },
    listCheckins: async () => checkins,
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch }
      return recompute()
    },
    resetSettings: async () => {
      settings = { ...DEFAULT_SETTINGS }
      return recompute()
    },
    logMoyu: async () => recompute(),
    listWorklogs: async () => [],
    pendingChanges: async () => ({}),
    markSynced: async () => true,
    /* 对话：浏览器预览下给一个能跑通的假后端 */
    chatStatus: async () => ({
      ready: false,
      reason: '浏览器预览模式没有对话后端，请在桌面版里配置 API Key',
      provider: 'deepseek',
      baseUrl: '',
      model: 'deepseek-chat',
      hasApiKey: false,
      needsApiKey: true,
    }),
    chatTest: async () => ({ ok: false, reason: '浏览器预览模式不支持' }),
    chatDiagnose: async () => ({ ok: false, steps: [{ name: '浏览器预览', ok: false, detail: '预览模式没有对话后端' }] }),
    chatSessions: async () => mockSessions,
    chatEnsureSession: async () => mockSessions[0],
    chatCreateSession: async (title) => {
      const s = { id: `mock-${Date.now()}`, title: title || '新的对话', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }
      mockSessions.unshift(s)
      return s
    },
    chatRenameSession: async (id, title) => {
      const s = mockSessions.find((x) => x.id === id)
      if (s) s.title = title
      return s
    },
    chatDeleteSession: async (id) => {
      mockSessions = mockSessions.filter((x) => x.id !== id)
      return mockSessions
    },
    chatLoad: async (id) => ({
      session: mockSessions.find((x) => x.id === id) ?? null,
      messages: mockMessages.filter((m) => m.sessionId === id),
    }),
    chatSend: async () => ({ ok: false, reason: '浏览器预览模式没有对话后端' }),
    chatAbort: async () => false,
    openChatWindow: async () => false,
    togglePet: async () => false,
    petVisible: async () => false,
    showEverything: async () => false,
    personaList: async () => [],
    personaCreate: async (p) => ({ id: 'mock-p1', label: p?.label ?? '新人设', prompt: p?.prompt ?? '', custom: true }),
    personaDuplicate: async () => ({ id: 'mock-p2', label: '副本', prompt: '', custom: true }),
    personaUpdate: async (id, patch) => ({ id, ...patch, custom: true }),
    personaDelete: async () => ({ ok: true }),
    affinityGet: async () => ({ points: 0, lastDay: null, streakDays: 0, chatToday: 0, max: 300, isMax: false }),
    affinityAdd: async (d) => ({ points: d ?? 0, lastDay: null, streakDays: 0, chatToday: 0, max: 300, isMax: false }),
    affinityReset: async () => ({ points: 0, lastDay: null, streakDays: 0, chatToday: 0, max: 300, isMax: false }),
    galleryGet: async () => null,
    sessionAffinity: async () => null,
    sessionGallery: async () => null,
    /* 浏览器预览没有工作日判定，预览空结果即可 */
    backfillPreview: async (fromKey) => ({ from: fromKey, to: toDateKey(new Date()), count: 0, days: [], hasHolidayTable: false }),
    backfillApply: async (fromKey) => ({ from: fromKey, to: toDateKey(new Date()), count: 0, days: [], created: [], skipped: [], state: recompute() }),
    onEvent: () => () => {},
  }
}

const backend = typeof window !== 'undefined' && window.desk ? window.desk : createMockBackend()
store.backend = backend === window?.desk ? 'electron' : 'mock'

async function call(label, fn, fallback) {
  try {
    const result = await fn()
    store.lastError = null
    return result
  } catch (err) {
    store.lastError = `${label}: ${toApiError(err)}`
    return fallback
  }
}

/* ---------- 对外动作 ---------- */

export async function refresh() {
  const next = await call('读取状态失败', () => backend.getState(), null)
  if (next) applyState(next)
  return store
}

export async function refreshCheckins(args = {}) {
  const list = await call('读取打卡记录失败', () => backend.listCheckins(args), null)
  if (Array.isArray(list)) store.checkins = list
  return store.checkins
}

export async function doCheckIn() {
  const result = await call('打卡失败', () => backend.checkIn(), null)
  if (result?.state) applyState(result.state)
  return result
}

/** 补卡预览：只读，不写库。用户确认前必须能看到「会补哪几天」。 */
export async function previewBackfill(fromKey) {
  const result = await call('读取待补打卡失败', () => backend.backfillPreview?.(fromKey), null)
  store.backfill = result
  return result
}

/** 执行补卡：一次写入从 fromKey 到今天的所有缺失工作日 */
export async function applyBackfill(fromKey) {
  const result = await call('补卡失败', () => backend.backfillApply?.(fromKey), null)
  if (result?.state) applyState(result.state)
  if (result) store.backfill = result
  await refreshCheckins()
  return result
}

/**
 * 保存设置。
 *
 * **必须显式带上活跃会话** —— 人设/穿着是逐会话的，不传的话主进程
 * 会回落到「最近更新的会话」，于是：
 *   - 在对话窗给会话 A 换装，可能写到会话 B 上
 *   - 桌宠/立绘窗读的是活跃会话，拿不到刚写的值，表现成「换了没反应」
 * 这正是「对话窗换装点了没用」的根因。
 */
export async function saveSettings(patch, sessionId) {
  const sid = sessionId ?? store.activeSessionId ?? store.chat.sessionId ?? undefined
  const next = await call('保存失败', () => backend.updateSettings(patch, sid), null)
  if (next) applyState(next)
  /* 广播回来后 store.settings 会被覆盖，这里再拉一次当前会话的，
     避免「写进了 A，但界面显示的是 B 的值」 */
  if (sid) await refreshSessionSettings(sid)
  return !store.lastError
}

export async function resetSettings() {
  const next = await call('重置失败', () => backend.resetSettings(), null)
  if (next) applyState(next)
  return !store.lastError
}

export async function logMoyu(minutes) {
  const next = await call('记录失败', () => backend.logMoyu(minutes), null)
  if (next) applyState(next)
  return !store.lastError
}

export async function loadMeta() {
  const meta = await call('读取元数据失败', () => backend.getMeta(), null)
  if (meta) store.meta = meta
  return store.meta
}

export function initBridge() {
  if (typeof backend.onEvent !== 'function') return () => {}
  return backend.onEvent((msg) => {
    if (!msg) return
    if (msg.event === 'state') applyState(msg.payload)
    /* 亲密度单独广播（对话记分不经过 state），不接的话界面要等下一次轮询 */
    if (msg.event === 'affinity' && msg.payload) store.affinity = msg.payload
    /*
     * 解锁广播。
     *
     * 同时更新 lastUnlock（给聊天窗弹展示）和重拉图鉴（给图鉴面板刷新）——
     * 不重拉的话用户下次打开图鉴才会看到新解锁的那一项。
     */
    /*
     * 活跃会话变了（对话窗切了会话）。
     *
     * 桌宠/面板据此重拉该会话的图鉴与穿着 —— 否则桌宠上还是
     * 上一个人的衣服，而「每个会话是独立的她」就名存实亡。
     */
    if (msg.event === 'session-active') {
      store.activeSessionId = msg.payload?.sessionId ?? null
      refreshGallery(store.activeSessionId).catch(() => {})
      refreshSessionAffinity(store.activeSessionId).catch(() => {})
      refreshSessionSettings(store.activeSessionId).catch(() => {})
    }
    if (msg.event === 'gallery-unlock' && msg.payload) {
      store.lastUnlock = { ...msg.payload, seq: (store.lastUnlock?.seq ?? 0) + 1 }
      refreshGallery().catch(() => {})
    }
    /*
     * 跨窗口的表情指令（例如面板里点了补卡，要让桌宠窗蹦一下）。
     * 用递增 seq 而不是 key 本身去重：连续两次同一个表情也要能重放，
     * 只比对 key 的话第二次会被当成重复丢掉。
     */
    if (msg.event === 'emote' && msg.payload?.key) {
      store.emoteSeq = (store.emoteSeq ?? 0) + 1
      store.emoteRequest = { key: msg.payload.key, holdMs: msg.payload.holdMs ?? 2600, seq: store.emoteSeq }
    }
    if (msg.event === 'chat-delta') {
      if (msg.payload.requestId === store.chat.requestId) {
        store.chat.streamText = msg.payload.full ?? ''
        store.chat.streaming = true
      }
    }
    if (msg.event === 'chat-done') {
      if (msg.payload.requestId === store.chat.requestId) {
        store.chat.streaming = false
        store.chat.streamText = ''
        store.chat.requestId = null
      }
    }
    if (msg.event === 'chat' && msg.payload.type === 'message') {
      const { sessionId, message } = msg.payload
      if (sessionId === store.chat.sessionId) {
        /* 流式占位在真正落库消息到达时清掉，避免重复显示 */
        store.chat.streaming = false
        store.chat.streamText = ''
        if (!store.chat.messages.some((m) => m.id === message.id)) enqueueMessage(message)
      }
    }
  })
}

/* ---------- 照片消息的「逐条出现」队列 ---------- */

/*
 * 一次解锁会落**多条**消息（配文一条、每张照片一条），主进程是
 * 一口气全部发过来的。直接 push 会瞬间全冒出来，不像她一张张发。
 *
 * 所以在这里排队：消息仍按 `createdAt` 顺序进数组，但**进数组的时刻**
 * 按相邻两条 `createdAt` 的差值递延 —— 差值正是落库时按连拍节奏
 * 算好的 `offsetMs`（见 `buildPhotoMessages`）。
 * 这样不需要给消息加额外字段，也不改变数据本身，只是控制了「出现时机」。
 *
 * 只对**间隔很小**的相邻消息递延：正常对话两条消息可能隔几分钟，
 * 那种情况必须立刻显示（否则她会「迟到」几分钟才回话）。
 */
const STAGGER_MAX_MS = 3000 /* 相邻两条 createdAt 差超过这个数，视为普通对话，不递延 */

let pendingQueue = []
let pendingTimer = null

function enqueueMessage(message) {
  pendingQueue.push(message)
  /*
   * 队列按 createdAt 排序 —— 消息从 IPC 来，顺序有保证，
   * 但延迟插队后仍以时间戳为准更稳。
   */
  pendingQueue.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  pumpQueue(0)
}

function pumpQueue(extraDelay) {
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  const step = () => {
    pendingTimer = null
    if (!pendingQueue.length) return

    const next = pendingQueue[0]
    const last = store.chat.messages[store.chat.messages.length - 1]
    const gap = last ? (next.createdAt ?? 0) - (last.createdAt ?? 0) : 0
    /*
     * gap <= 0：乱序或同毫秒（不该发生，落库已保证递增）→ 立即出。
     * gap >  STAGGER_MAX_MS：普通对话 → 立即出。
     * 其余：按 gap 递延。
     */
    const wait = gap > 0 && gap <= STAGGER_MAX_MS ? gap : 0

    if (wait > 0) {
      pendingTimer = window.setTimeout(step, wait)
      return
    }
    pendingQueue.shift()
    if (!store.chat.messages.some((m) => m.id === next.id)) store.chat.messages.push(next)
    /* 出队一条后立刻看下一条（它可能与这条很近，需要继续递延） */
    if (pendingQueue.length) pumpQueue(1)
  }

  if (extraDelay > 0) pendingTimer = window.setTimeout(step, extraDelay)
  else step()
}

/** 切换会话时清空队列 —— 旧会话的照片不该出现在新会话里 */
export function resetPhotoQueue() {
  pendingQueue = []
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
}

/* ---------- 对话 ---------- */

export async function refreshChatStatus() {
  const s = await call('读取对话配置失败', () => backend.chatStatus?.(), null)
  if (s) store.chat.status = s
  return store.chat.status
}

export async function testChat() {
  return call('测试连接失败', () => backend.chatTest?.(), { ok: false, reason: '当前环境不支持' })
}

export async function diagnoseChat() {
  return call('自检失败', () => backend.chatDiagnose?.(), { ok: false, steps: [] })
}

export async function refreshChatSessions() {
  const list = await call('读取会话失败', () => backend.chatSessions?.(), null)
  if (Array.isArray(list)) store.chat.sessions = list
  return store.chat.sessions
}

export async function ensureChatSession() {
  const s = await call('创建会话失败', () => backend.chatEnsureSession?.(), null)
  if (s) {
    store.chat.sessionId = s.id
    await refreshChatSessions()
    await loadChatMessages(s.id)
  }
  return s
}

export async function openChatSession(id) {
  const data = await call('读取对话失败', () => backend.chatLoad?.(id), null)
  if (!data) return null
  /* 切会话时丢掉还没播完的照片队列 —— 全量重读已经把消息取回来了 */
  resetPhotoQueue()
  store.chat.sessionId = id
  store.chat.messages = data.messages ?? []
  store.chat.streaming = false
  store.chat.streamText = ''
  return data
}

export async function loadChatMessages(id) {
  return openChatSession(id)
}

export async function newChatSession() {
  const s = await call('创建会话失败', () => backend.chatCreateSession?.('新的对话'), null)
  if (s) {
    resetPhotoQueue()
    store.chat.sessionId = s.id
    store.chat.messages = []
    store.chat.streaming = false
    store.chat.streamText = ''
    await refreshChatSessions()
  }
  return s
}

export async function renameChatSession(id, title) {
  await call('重命名失败', () => backend.chatRenameSession?.(id, title), null)
  await refreshChatSessions()
}

export async function deleteChatSession(id) {
  const list = await call('删除失败', () => backend.chatDeleteSession?.(id), null)
  if (Array.isArray(list)) store.chat.sessions = list
  if (store.chat.sessionId === id) {
    store.chat.sessionId = null
    store.chat.messages = []
  }
  return store.chat.sessions
}

export async function sendChat(text, images = []) {
  const clean = String(text ?? '').trim()
  const pics = (Array.isArray(images) ? images : []).filter(Boolean)
  if ((!clean && !pics.length) || store.chat.streaming) return null
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  store.chat.requestId = requestId
  store.chat.streaming = true
  store.chat.streamText = ''
  const result = await call('发送失败', () =>
    backend.chatSend?.({ sessionId: store.chat.sessionId, text: clean, requestId, images: pics }),
  )
  if (result?.sessionId && result.sessionId !== store.chat.sessionId) store.chat.sessionId = result.sessionId
  /* 兜底：主进程事件丢失时也要解除 loading */
  store.chat.streaming = false
  store.chat.streamText = ''
  await refreshChatSessions()
  return result
}

export async function abortChat() {
  const id = store.chat.requestId
  if (!id) return false
  store.chat.streaming = false
  return call('取消失败', () => backend.chatAbort?.(id), false)
}

export async function openChatWindow() {
  return call('打开对话失败', () => backend.openChatWindow?.(), false)
}

/* ---------- 亲密度 ---------- */

export async function addAffinity(delta, opts) {
  const next = await call('记录亲密度失败', () => backend.affinityAdd?.(delta, opts), null)
  if (next) store.affinity = next
  return next
}

export async function resetAffinity() {
  const next = await call('重置失败', () => backend.affinityReset?.(), null)
  if (next) store.affinity = next
  return next
}

/* ---------- 活跃会话 ---------- */

/**
 * 设置当前活跃会话（对话窗切换时调用）。
 * 桌宠会跟着换衣服，面板会刷新图鉴。
 */
export async function setActiveSession(sessionId) {
  const r = await call('切换活跃会话失败', () => backend.setActiveSession?.(sessionId), null)
  store.activeSessionId = r ?? sessionId ?? null
  /*
   * 三样都要重拉：
   *   gallery   图鉴进度（换装菜单按它过滤）
   *   affinity  亲密度
   *   settings  穿着/人设 —— **漏了这条就出现「切了会话但衣服没变」**：
   *             后端已经按新会话返回 casual-red，前端 state.settings 里
   *             还是上一个会话的 swimsuit，守卫照着旧值判定并回落。
   */
  await Promise.all([
    refreshGallery(store.activeSessionId),
    refreshSessionAffinity(store.activeSessionId),
    refreshSessionSettings(store.activeSessionId),
  ])
  return r
}

/** 拉某会话的设置（穿着/人设是逐会话的） */
export async function refreshSessionSettings(sessionId) {
  const sid = await resolveSessionId(sessionId)
  if (!sid) return null
  const fn = backend.sessionSettings ?? backend.getSettings
  const data = await call('读取会话设置失败', () => fn?.(sid), null)
  if (data) store.settings = { ...store.settings, ...data }
  return data
}

/* ---------- 图鉴（逐会话） ---------- */

/**
 * 解析「该看哪个会话的数据」。
 *
 * 对话窗里有 `chat.sessionId`（用户正在聊的那个），面板窗里这个值是空的
 * —— 面板没有「当前会话」的概念。所以回落到会话列表的第一个，
 * 与主进程 `currentSessionId()` 的口径一致（都是「最近更新的会话」）。
 */
async function resolveSessionId(explicit) {
  if (explicit) return explicit
  /*
   * 顺序有讲究：**活跃会话优先**。
   * 桌宠窗没有 chat.sessionId（它不开对话），若不先看 activeSessionId，
   * 就会回落到「会话列表第一个」，而在别的会话聊过之后那个值会变 ——
   * 表现成「桌宠穿的不是当前会话的衣服」。
   */
  if (store.activeSessionId) return store.activeSessionId
  if (store.chat.sessionId) return store.chat.sessionId
  if (store.chat.sessions.length) return store.chat.sessions[0].id
  await refreshChatSessions()
  return store.chat.sessions[0]?.id ?? null
}

/**
 * 拉取某会话的图鉴快照。
 *
 * 必须显式传 sessionId（或确保会话列表已加载）：不传会回落到
 * 「最近更新的会话」，而切换的瞬间那个值可能还指向上一个。
 */
export async function refreshGallery(sessionId) {
  const sid = await resolveSessionId(sessionId)
  if (!sid) {
    store.gallery = null
    return null
  }
  const data = await call('读取图鉴失败', () => backend.galleryGet?.(sid), null)
  if (data) store.gallery = data
  return data
}

/** 拉某会话的亲密度（切换会话后要调，否则显示的还是上一个人的） */
export async function refreshSessionAffinity(sessionId) {
  const sid = await resolveSessionId(sessionId)
  if (!sid) return null
  const fn = backend.sessionAffinity ?? backend.affinityGet
  const data = await call('读取亲密度失败', () => fn?.(sid), null)
  if (data) store.affinity = data
  return data
}

/** 清空某会话的图鉴进度 */
export async function clearGallery(sessionId) {
  const sid = await resolveSessionId(sessionId)
  if (!sid) return null
  const r = await call('清空图鉴失败', () => backend.clearSessionGallery?.(sid), null)
  await refreshGallery(sid)
  return r
}

/** 展示过解锁弹窗后清掉，避免切走再切回来又弹一次 */
export function consumeUnlock() {
  store.lastUnlock = null
}

/* ---------- 人设 ---------- */

export async function listPersonas() {
  const list = await call('读取人设失败', () => backend.personaList?.(), [])
  if (Array.isArray(list)) store.personas = list
  return store.personas
}

export async function createPersona(payload) {
  const created = await call('新建人设失败', () => backend.personaCreate?.(payload), null)
  await refreshMeta()
  return created
}

export async function duplicatePersona(id) {
  const created = await call('复制人设失败', () => backend.personaDuplicate?.(id), null)
  await refreshMeta()
  return created
}

export async function updatePersona(id, patch) {
  const updated = await call('保存人设失败', () => backend.personaUpdate?.(id, patch), null)
  await refreshMeta()
  return updated
}

export async function deletePersona(id) {
  await call('删除人设失败', () => backend.personaDelete?.(id), null)
  await refreshMeta()
  return true
}

/** meta 里含人设列表，刷新后下拉框才会更新 */
export async function refreshMeta() {
  const meta = await call('读取元数据失败', () => backend.getMeta(), null)
  if (meta) store.meta = meta
  return store.meta
}

/* ---------- 窗口控制（浏览器里退化为 no-op） ---------- */

export const win = {
  togglePet: () => call('窗口操作失败', () => backend.togglePet?.(), null),
  petVisible: () => call('窗口操作失败', () => backend.petVisible?.(), null),
  showEverything: () => call('窗口操作失败', () => backend.showEverything?.(), null),
  openPanel: () => call('窗口操作失败', () => backend.openPanel?.(), null),
  hidePanel: () => call('窗口操作失败', () => backend.hidePanel?.(), null),
  minimize: () => call('窗口操作失败', () => backend.minimize?.(), null),
  setPetScale: (s) => call('设置失败', () => backend.setPetScale?.(s), null),
  setPetAlwaysOnTop: (f) => call('设置失败', () => backend.setPetAlwaysOnTop?.(f), null),
  quit: () => call('退出失败', () => backend.quit?.(), null),
  hideChat: () => call('关闭失败', () => backend.hideChatWindow?.(), null),
  /* 对话窗旁的立绘小窗显隐；返回切换后的可见状态 */
  chatPetToggle: () => call('操作失败', () => backend.chatPetToggle?.(), null),
}

export { store, LEVELS, REST_PATTERNS, DEFAULT_SETTINGS }
