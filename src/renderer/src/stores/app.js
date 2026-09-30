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
/* 上限只从 shared 读 —— 预览用的 mock 也不许另写一个数字 */
import { AFFINITY_MAX_POINTS, PET_AFFINITY_DAILY_CAP } from '@shared/interactions.js'

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
  /*
   * 亲密度：{ points, lastDay, streakDays, gainToday, petToday, petCap, max, isMax, sessionId }
   * `gainToday` 是**今天一共涨了多少**（只用于展示，聊天不限量）；
   * `petToday/petCap` 才是唯一还有的那个每日额度（桌宠互动）。
   */
  affinity: { points: 0, lastDay: null, streakDays: 0, gainToday: 0, petToday: 0, petCap: 0, max: 0, isMax: false },
  /*
   * 未读数：她说的、我还没看过的条数（由 getState 下发）。
   * 桌宠据此显示红点；对话窗获得焦点时调 markChatRead() 清零。
   */
  unread: 0,
  /*
   * 图鉴：{ sessionId, outfit: {..}, photo: {..} }
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
  /* 桌宠窗本地行为指令：{ action, seq }；菜单窗触发（气泡开关/退出挥手），桌宠窗消费 */
  petUiRequest: null,
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
    /* 浏览器预览的 settings 本就是全量（无真实 Key），与桌面 getFullSettings 同形 */
    getFullSettings: async () => ({ ...settings }),
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
    affinityGet: async () => ({ points: 0, lastDay: null, streakDays: 0, gainToday: 0, petToday: 0, petCap: PET_AFFINITY_DAILY_CAP, max: AFFINITY_MAX_POINTS, isMax: false }),
    affinityAdd: async (d) => ({ points: d ?? 0, lastDay: null, streakDays: 0, gainToday: d ?? 0, petToday: d ?? 0, petCap: PET_AFFINITY_DAILY_CAP, max: AFFINITY_MAX_POINTS, isMax: false }),
    affinityReset: async () => ({ points: 0, lastDay: null, streakDays: 0, gainToday: 0, petToday: 0, petCap: PET_AFFINITY_DAILY_CAP, max: AFFINITY_MAX_POINTS, isMax: false }),
    /* 预览模式本来就没有真数据，清空即重置内存态 */
    wipeAllData: async () => {
      settings = { ...DEFAULT_SETTINGS }
      checkins = []
      mockSessions = [
        { id: 'mock-default', title: '新的对话', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
      ]
      mockMessages = []
      return recompute()
    },
    galleryGet: async () => null,
    sessionAffinity: async () => null,
    sessionGallery: async () => null,
    /* 浏览器预览没有工作日判定，预览空结果即可 */
    backfillPreview: async (fromKey) => ({ from: fromKey, to: toDateKey(new Date()), count: 0, days: [], hasHolidayTable: false }),
    backfillApply: async (fromKey) => ({ from: fromKey, to: toDateKey(new Date()), count: 0, days: [], created: [], skipped: [], state: recompute() }),
    openDataDir: async () => false,
    onEvent: () => () => {},
  }
}

const backend = typeof window !== 'undefined' && window.desk ? window.desk : createMockBackend()
/* 后端标记用 native 而不是 electron：桌面壳有两个（Electron 与 Tauri），
   渲染层对它们一视同仁，只有浏览器 mock 是另一回事 */
store.backend = backend === window?.desk ? 'native' : 'mock'

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

/**
 * 桌宠窗本地行为指令（气泡开关/退出挥手）。
 * 菜单窗发出，经 service 广播给全窗，桌宠窗的 petUiRequest watch 消费。
 */
export async function sendPetUi(action) {
  await call('指令发送失败', () => backend.petUiCommand?.(action), null)
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
 * 把值转成能安全穿过 IPC 的纯对象。
 *
 * Vue 的 `reactive` 是**深**的：`reactive({...DEFAULT_SETTINGS}).chatBgPool`
 * 拿到的是数组 Proxy，而 `{...form}` 只是浅展开 —— 顶层成了普通对象，
 * 嵌套值仍然是 Proxy。Electron 的 `ipcRenderer.invoke` 走 structured clone，
 * 遇到 Proxy 直接抛 `DataCloneError: An object could not be cloned.`
 *
 * 症状极有迷惑性：设置页点「保存」必失败，但**改哪个字段都一样失败**
 * （真正决定成败的是有没有哪个值是对象/数组，而不是刚改的那一项）。
 * 设置页的 `form` 里恰好有 `chatBgPool: []`，所以整页保存全废；
 * 而对话窗的 `saveSettings({ outfitMode: 'auto' })` 全是原始值，一直正常 ——
 * 于是看起来像「只有设置页坏了」，实际是调用方传的东西不同。
 *
 * 为什么用 JSON 往返而不是 `toRaw`：
 *   - `toRaw` 只脱最外层，嵌套 Proxy 原样留着，治不了本；
 *   - 设置本来就是逐项 `JSON.stringify` 存进 SQLite 的
 *     （见 store.saveSettings），JSON 往返与落库表示完全一致，
 *     不会引入「内存里是一种形状、存下去是另一种」。
 */
function plainForIpc(value) {
  /* null 与原始值本来就可克隆，不必也不该走 JSON（JSON.parse(undefined) 会抛） */
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value))
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
  /* 归一化放在这里而不是各个调用点：漏斗只有一处，Proxy 进不来 */
  const safe = plainForIpc(patch)
  const next = await call('保存失败', () => backend.updateSettings(safe, sid), null)
  if (next) applyState(next)
  /* 广播回来后 store.settings 会被覆盖，这里再拉一次当前会话的，
     避免「写进了 A，但界面显示的是 B 的值」 */
  if (sid) await refreshSessionSettings(sid)
  /*
   * 保存完就重算一次对话可用性。
   *
   * 为什么放在**保存这个动作**上，而不是靠 ChatApp 里 watch 某个字段变没变：
   * `chatStatus` 的结果只存在 store.chat.status 里，而它是从
   * `validateConfig(settings)` 算出来的 —— 决定结果的字段有 baseUrl / apiKey
   * 两个，将来还可能加。按「值变了没有」去驱动刷新，等于把这份依赖清单
   * 抄一遍，抄漏一个就是「配好了却说没配」。
   * 挂在保存动作上则天然覆盖全部字段，也不依赖密钥是否下发到渲染层。
   */
  refreshChatStatus().catch(() => {})
  return !store.lastError
}

export async function resetSettings() {
  const next = await call('重置失败', () => backend.resetSettings(), null)
  if (next) applyState(next)
  return !store.lastError
}

/**
 * 清空全部本地数据 —— **不可恢复**。
 *
 * 清完之后要把前端这边一起拉回干净状态：服务端已经删光，
 * 但 store 里还留着旧的打卡、图鉴、会话列表和亲密度，
 * 表现会是「数据没了但面板上的数字还在」，
 * 直到用户手动重启。所以这里主动刷一轮。
 */
export async function wipeAllData() {
  const id = await call('清空失败', () => backend.wipeAllData(), null)
  if (!id) return false
  /*
   * 成功与否**只看 wipe 这一步**，不看后面的刷新。
   *
   * 之前把 `return !store.lastError` 放在所有刷新之后，于是：
   * 任何一次刷新失败/变慢 → 返回 false → 设置页不刷新表单、
   * 提示文案也不显示，用户看到的是「按钮没反应、界面还是清空前的样子」，
   * 而数据其实已经清掉了。这是最难排查的一类不一致。
   *
   * 刷新改成**不阻塞**：清空已经落库，界面晚几百毫秒追上没关系，
   * 让它决定成败才是本末倒置。
   */
  store.checkins = []
  store.gallery = null
  store.lastUnlock = null
  store.personas = []
  Object.assign(store.chat, { sessions: [], sessionId: id, messages: [], streamText: '', streaming: false })
  store.activeSessionId = id
  /* 不 await：失败也不该把「已清空」这个事实变成失败 */
  Promise.all([refresh(), refreshCheckins(), refreshChatSessions(), refreshSessionSettings(id)]).catch(() => {})
  return true
}

/**
 * 全量设置（含 chatApiKey 原文）。
 *
 * state 快照广播到全部窗口，已剥掉 Key 原文（与 chatStatus 脱敏口径一致）；
 * 只有设置页的表单需要真实值，走这里按需拉取。
 */
export async function getFullSettings() {
  return call('读取完整设置失败', () => backend.getFullSettings?.(), null)
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
     * 未读数单独广播 —— 她回复/主动搭话之后立刻更新红点，
     * 不必等桌宠自己 15 秒轮询（实测那段滞后很明显）。
     */
    if (msg.event === 'unread' && msg.payload) store.unread = msg.payload.count ?? 0
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
    /* 菜单窗 → 桌宠窗的本地行为指令（气泡开关/退出挥手），同 emote 的 seq 重放语义 */
    if (msg.event === 'pet-ui' && msg.payload?.action) {
      store.petUiSeq = (store.petUiSeq ?? 0) + 1
      store.petUiRequest = { action: msg.payload.action, seq: store.petUiSeq }
    }
    if (msg.event === 'chat-delta') {
      if (msg.payload.requestId === store.chat.requestId) {
        store.chat.streamText = msg.payload.full ?? ''
        store.chat.streaming = true
      }
    }
    if (msg.event === 'chat-done') {
      /*
       * 兜底**不能**套在 requestId 匹配里。
       *
       * 原来整段都在 `payload.requestId === store.chat.requestId` 之内：
       * 一旦对不上（requestId 已被别的路径清成 null、旧请求迟到、
       * 或错峰队列卡死导致「消息落地」这条正常路径根本没跑过），
       * `settleStream()` 和看门狗**一个都不会跑**。而 `chat-done` 是一轮里
       * 最后一条事件，不会再有下一个机会 —— `streaming` 就永久卡在 true，
       * 发送键永远是暂停键，只能关掉对话窗重开。
       * 卡死不可恢复，比偶尔早撤一次占位严重得多，所以兜底与 requestId 无关。
       *
       * 撤占位的**时机**仍然受队列长度约束：
       * 只在**没有待落地消息**时才就地撤。service 里 `chat`/`message` 是先于
       * `chat-done` emit 的，正常路径下撤占位由「消息落地」负责（见下面的
       * enqueueMessage 回调）；这里若无条件撤，就会抢在错峰队列前面把
       * liveText 清掉 —— 那正是「回复的瞬间看不见」的空窗。
       * 队列非空时改上超时看门狗（队列最长也就一跳）。
       */
      if (!pendingQueue.length) settleStream()
      else armSettleWatchdog()
    }
    if (msg.event === 'chat' && msg.payload.type === 'message') {
      const { sessionId, message } = msg.payload
      if (sessionId === store.chat.sessionId) {
        /*
         * 撤占位**必须等消息真的进了 messages**。
         *
         * 之前是「立刻清 streaming/streamText + 把消息丢进错峰队列」，
         * 两者之间隔着 `wait` 毫秒：liveText 已经空了、消息还没 push，
         * 于是整条回复消失一段再冒出来。
         *
         * 错峰队列本意是让**照片连发**一张张出现（间隔按 createdAt 差值），
         * 但它用 `gap <= 3s` 当作「这是连发」的判据 ——
         * 而模型流式回复常常就在 3 秒内完成，于是普通回复被误判成连发，
         * 延迟最多 3 秒才显示。deepseek-flash 上很容易命中。
         */
        if (store.chat.messages.some((m) => m.id === message.id)) settleStream()
        else enqueueMessage(message, settleStream)
      }
    }
  })
}

/**
 * 撤掉流式占位（正在打字的那个气泡）。
 *
 * 只在「最终消息已经进了列表」或「确认没有消息会再来」时调用 ——
 * 早撤一步就会露出一段既没有 liveText、也没有落库消息的空窗。
 */
function settleStream() {
  store.chat.streaming = false
  store.chat.streamText = ''
  store.chat.requestId = null
  if (settleWatchdog) {
    window.clearTimeout(settleWatchdog)
    settleWatchdog = null
  }
}

/*
 * 撤占位的**看门狗**。
 *
 * 为什么必须有：`streaming` 卡在 true 会让发送键**永久变成暂停键**，
 * 用户再也发不出消息 —— 只能关掉对话窗重开。而撤占位依赖
 * 「错峰队列把消息播完」，任何一环出问题（消息没落地、队列被吞、
 * 事件顺序异常）都会把它永久挂住。
 *
 * 实测踩到过：`streaming` 一直为 true，那个没有时间戳的流式气泡
 * 永远挂在那儿，发送键变成暂停键。
 *
 * 所以 `chat-done` 之后若队列还没播完，就上一道超时：
 * 队列最长也就 STAGGER_MAX_MS 一跳，给足余量后**强制收尾**。
 * 宁可偶尔早撤一次占位，也不能让界面卡死 —— 卡死是不可恢复的，
 * 早撤只是少看半秒。
 */
let settleWatchdog = null

function armSettleWatchdog() {
  if (settleWatchdog) window.clearTimeout(settleWatchdog)
  settleWatchdog = window.setTimeout(() => {
    settleWatchdog = null
    /* 只有还卡着才动手 —— 正常路径早就撤干净了 */
    if (store.chat.streaming) settleStream()
  }, STAGGER_MAX_MS + 1500)
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
/*
 * 导出是为了和主进程的 `REPLY_SEGMENT_GAP_MS` 对账（smoke 断言间隔 < 窗口）。
 * 这两个常量跨模块，改了其中一个而另一个没跟上时不会报任何错，
 * 症状是多段回复整段立即弹出、逐条冒出来的节奏消失。
 */
export const STAGGER_MAX_MS = 3000 /* 相邻两条 createdAt 差超过这个数，视为普通对话，不递延 */

let pendingQueue = []
let pendingTimer = null
/*
 * 上一条消息**落地**（push 进数组）的时刻，错峰递延从它起算。
 *
 * 为什么必须有这个变量：递延时长不能靠「每次重新算 createdAt 差值」得到。
 * `step` 在 head 出队之前会被反复调用，而只要 head 没落地，`last` 就一直是
 * **同一条**已落地的消息 —— 重算出的 gap 每次都一样，于是定时器一次次
 * 重新武装，head **永远出不了队**。
 *
 * 实测（真实 API + 采样）：她的回复被 `<<<MSG>>>` 拆成 3 条时，第 1 条落地、
 * 第 2 条起就落进这个死循环，队列**永久卡死**在 `a:第2条` 上。后果连锁：
 *   - 那条回复剩下的分段永远不出现（用户只看到她第一句）；
 *   - 之后**所有**消息都排在死掉的 head 后面永不落地 ——
 *     包括用户自己发的那句（症状「我发的句子看不见」）；
 *   - `onLanded` 是撤流式占位的唯一正常路径，队列不动 → 它永远不跑，
 *     `chat-done` 又因为队列非空只上 4.5 秒看门狗 → 看门狗一响
 *     `settleStream()` 把 liveText 清掉，屏幕上「她的回复闪一下就没了」
 *     （症状「消息回滚」），期间发送键一直是■暂停键。
 * 多段回复是**默认写法**（REPLY_SEGMENT_GAP_MS=1200 < STAGGER_MAX_MS=3000），
 * 所以这条路径几乎每轮都会命中，从第二句起必然坏掉。
 *
 * 语义：`gap` 是相邻两条 `createdAt` 的差，即「她这两条之间隔了多久」，
 * 递延应该是「距上一条出现还差多久」= gap − 已经等过的时间。
 * 初值 0 表示「队列里还没有落地过任何东西」，此时 `Date.now() - 0`
 * 足够大 → wait 归零 → 立即出队（切会话/重读历史后正是这个语义）。
 */
let lastLandAt = 0

/**
 * 入队一条待展示的消息。
 *
 * @param {object} message
 * @param {() => void} [onLanded] 这条消息**真正 push 进数组之后**才调用。
 *   用来把「撤流式占位」和「消息落地」绑成同一个时刻 ——
 *   分开做就会露出一段两边都没有的空窗（见 settleStream 的注释）。
 */
function enqueueMessage(message, onLanded = null) {
  pendingQueue.push({ message, onLanded })
  /*
   * 队列按 createdAt 排序 —— 消息从 IPC 来，顺序有保证，
   * 但延迟插队后仍以时间戳为准更稳。
   */
  pendingQueue.sort((a, b) => (a.message.createdAt ?? 0) - (b.message.createdAt ?? 0))
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

    const entry = pendingQueue[0]
    const next = entry.message
    const last = store.chat.messages[store.chat.messages.length - 1]
    /*
     * gap **只在「她连发」时才算** —— 上一条必须也是 assistant。
     *
     * 踩过的坑：原来无条件拿「数组最后一条」算差值，而待落地的第一条
     * 前面排的正是**用户刚发的那条**。于是
     *     gap = 回复的 createdAt − 用户消息的 createdAt = 整轮 API 往返耗时
     * 模型 3 秒内答完时它就落进 `gap <= STAGGER_MAX_MS` 分支，
     * 普通回复被误判成连发、被延迟最多 3 秒才显示 ——
     * **而这期间流式气泡已经被撤掉，屏幕上就是「一闪就没了」。**
     *
     * 多段回复让这个窗口更明显：`createdAt` 是模型答完后才写的时间戳，
     * gap 因此等于完整往返耗时，很容易卡在 3 秒以内。
     *
     * 连发递延只在**她自己的两条之间**才有意义，用户那条不该参与。
     */
    const gap =
      last && last.role === 'assistant' && next.role === 'assistant'
        ? (next.createdAt ?? 0) - (last.createdAt ?? 0)
        : 0
    /*
     * gap <= 0：乱序或同毫秒（不该发生，落库已保证递增）→ 立即出。
     * gap >  STAGGER_MAX_MS：普通对话 → 立即出。
     * 其余：按 gap 递延 —— 但递延的是「距上一条**落地**还差多久」，
     *       不是「再等 gap 毫秒」（见下）。
     */
    const wait = gap > 0 && gap <= STAGGER_MAX_MS ? Math.max(0, gap - (Date.now() - lastLandAt)) : 0

    if (wait > 0) {
      pendingTimer = window.setTimeout(step, wait)
      return
    }
    pendingQueue.shift()
    if (!store.chat.messages.some((m) => m.id === next.id)) store.chat.messages.push(next)
    /* 记下这条**落地**的时刻，下一条的递延从它起算（见上面的 wait） */
    lastLandAt = Date.now()
    /* 落地回调必须在 push 之后 —— 顺序反了就等于没修 */
    entry.onLanded?.()
    /* 出队一条后立刻看下一条（它可能与这条很近，需要继续递延） */
    if (pendingQueue.length) pumpQueue(1)
  }

  if (extraDelay > 0) pendingTimer = window.setTimeout(step, extraDelay)
  else step()
}

/** 切换会话时清空队列 —— 旧会话的照片不该出现在新会话里 */
export function resetPhotoQueue() {
  pendingQueue = []
  /* 队列清空 = 数组里剩下的消息是「重读来的」而不是「落地的」，递延基准归零 */
  lastLandAt = 0
  if (pendingTimer) {
    window.clearTimeout(pendingTimer)
    pendingTimer = null
  }
  if (settleWatchdog) {
    window.clearTimeout(settleWatchdog)
    settleWatchdog = null
  }
  /*
   * 队列被丢弃 = 那些消息永远不会落地，挂在它们上面的 onLanded（撤占位）
   * 也就永远不会跑。不补这一下，切会话后 streaming 会卡在 true，
   * 输入框一直是禁用的（`canSend` 里有 !streaming）。
   */
  settleStream()
}

/* ---------- 未读 ---------- */

/**
 * 标记当前会话已读。
 *
 * 对话窗「获得焦点 / 重新可见」时调用 —— 那是「用户真的在看」的
 * 最可靠信号。不用 onMounted：窗口只 hide 不销毁，不会再挂载。
 *
 * 打点后把 store 里的未读清零，并让主进程推一次 state
 * （红点要立刻消失，不能等下一次轮询）。
 */
export async function markChatRead(sessionId) {
  const sid = sessionId ?? store.chat.sessionId ?? store.activeSessionId ?? undefined
  await call('标记已读失败', () => backend.chatMarkRead?.(sid), null)
  store.unread = 0
  return true
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
  /* 换会话 = 那个会话的流跟这里无关了，直接撤干净（含 requestId） */
  settleStream()
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
    settleStream()
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
  /*
   * 兜底：主进程事件丢失时也要解除 loading。
   *
   * 但**队列里还有消息待落地时不能撤** —— 那会抢在错峰队列前面把
   * liveText 清掉，重新制造「消息还没进列表、占位已经没了」的空窗，
   * 也就是「回复的瞬间看不见」。此时交给 onLanded 回调去撤。
   */
  if (!pendingQueue.length) settleStream()
  await refreshChatSessions()
  return result
}

export async function abortChat() {
  const id = store.chat.requestId
  if (!id) return false
  /*
   * 用户主动取消：立刻撤占位，不等消息落地（不会有消息了）。
   * 走 settleStream 而不是手写，是为了「清 streaming 只有一处」这条约束
   * 能被 smoke 的源码断言盯住 —— 散着写必然有人漏掉 streamText/requestId。
   */
  settleStream()
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
  /* 与 saveSettings/wipeAllData 同一口径：调用方要能知道这一步成没成，
     否则「删除失败」在界面上和「删除成功」长得一模一样 */
  return !store.lastError
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
  autostartGet: () => call('读取自启状态失败', () => backend.autostartGet?.(), false),
  autostartSet: (on) => call('自启设置失败', () => backend.autostartSet?.(on), null),
  /* 备份数据：打开数据所在目录（浏览器无此概念，mock 返回 false） */
  openDataDir: () => call('打开数据目录失败', () => backend.openDataDir?.(), null),
  quit: () => call('退出失败', () => backend.quit?.(), null),
  hideChat: () => call('关闭失败', () => backend.hideChatWindow?.(), null),
  /* 对话窗旁的立绘小窗显隐；返回切换后的可见状态 */
  chatPetToggle: () => call('操作失败', () => backend.chatPetToggle?.(), null),
}

export { store, LEVELS, REST_PATTERNS, DEFAULT_SETTINGS }
