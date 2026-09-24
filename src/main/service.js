/**
 * 应用服务层 —— 把 store + 摸鱼算法组装成渲染进程可直接消费的模型。
 * 不依赖 electron 也不依赖具体 store 实现，便于用 node 直接跑冒烟脚本。
 *
 * 双 store 后端（TAURI_MIGRATION.md §2.2 决策 2）：
 *   - Node / Electron：注入 openStore()（node:sqlite，同步）
 *   - Tauri：注入 openStoreBridge()（IPC → rusqlite，异步）
 * store 全是异步接口，本层所有方法随之 async；
 * 调用方（ipc-handlers / 总线宿主 / smoke）一律 await。
 */
import { streamChat, pingChat, validateConfig, ChatError, completeOnce } from './chat.js'
import { buildContent, validateImageDataUrl, checkImagesForModel } from '../shared/content.js'
import { createGalleryRunner, galleryTotal, explainCandidates } from '../shared/gallery.js'
import { OUTFIT_STORIES } from '../shared/outfitStories.js'
import { VIDEO_STORIES } from '../shared/videoStories.js'
import { fetchHolidayYear, isCacheFresh, HOLIDAY_CACHE_TTL_MS } from './holiday.js'
import {
  CHAT_PERSONAS,
  CHAT_PROVIDERS,
  DEFAULT_SETTINGS,
  LEVELS,
  REST_PATTERNS,
  formatMoney,
  toDateKey,
  isRestDay,
  levelOf,
  paydayCountdown,
  todaySnapshot,
  workDaysInMonth,
  workdayRange,
  parseDateKey,
} from '../shared/moyu.js'
import {
  AFFINITY_GAIN,
  AFFINITY_LEVELS,
  AFFINITY_MAX_POINTS,
  CHAT_AFFINITY_DAILY_CAP,
  CHATTER_SYSTEM_PROMPT,
  affinityGain,
  affinityLevel,
  outfitForTime,
  recentDialogueMessages,
  sanitizeChatter,
} from '../shared/interactions.js'

/**
 * @param {object} store 已打开的数据层实例（openStore(...) 或 openStoreBridge()）
 * @param {object} [deps]
 * @param {() => string} [deps.loadSelfPortrait] 返回她自己的参考图（data URL）。
 *   通过参数注入而不是在 service 里直接读文件：service 刻意不依赖 electron、
 *   也不假设自己的资源路径，让打包后的路径解析留给调用方（宿主）决定。
 */
export function createService(store, deps = {}) {
  const listeners = new Set()
  /** 进行中的对话请求：requestId -> AbortController，用于「停止生成」 */
  const activeRequests = new Map()

  /**
   * 挂机台词参考多久以内的聊天记录。
   * 两天是刻意选的：够覆盖「昨天聊到一半的话题」，又不会把她拉回一周前的旧事。
   */
  const CHATTER_WINDOW_MS = 2 * 24 * 60 * 60 * 1000

  function emit(event, payload) {
    for (const fn of listeners) {
      try {
        fn(event, payload)
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  }

  /* ---------- 节假日缓存 ---------- */

  /**
   * 按年缓存节假日表。优先内存，其次本地库，最后联网。
   * 联网失败不抛错：没有表时上层自动退回「只看周末」，功能不受影响。
   */
  const holidayMemory = new Map()

  async function holidayTableFor(year) {
    if (holidayMemory.has(year)) return holidayMemory.get(year)
    const cached = await store.getMeta(`holiday-${year}`, null)
    const table = isCacheFresh(cached) ? cached.table : null
    holidayMemory.set(year, table)
    return table
  }

  async function refreshHolidays(year, { force = false } = {}) {
    const cached = await store.getMeta(`holiday-${year}`, null)
    if (!force && isCacheFresh(cached)) {
      holidayMemory.set(year, cached.table)
      return { ok: true, cached: true, count: Object.keys(cached.table ?? {}).length }
    }
    try {
      const table = await fetchHolidayYear(year)
      await store.setMeta(`holiday-${year}`, { fetchedAt: Date.now(), table })
      holidayMemory.set(year, table)
      return { ok: true, cached: false, count: Object.keys(table).length }
    } catch (err) {
      /* 有旧缓存就继续用，没有也不阻塞 */
      if (cached?.table) {
        holidayMemory.set(year, cached.table)
        return { ok: false, cached: true, stale: true, reason: err?.message ?? String(err) }
      }
      holidayMemory.set(year, null)
      return { ok: false, cached: false, reason: err?.message ?? String(err) }
    }
  }

  /** 供对话层解析人设用的自定义人设列表 */
  const customPersonas = () => store.listPersonas()

  /**
   * 对话用的运行时上下文。
   *
   * 把「现在几点、今天休不休息、他的作息」一起交给对话层，
   * 让它拼进 system 提示词 —— 不喂这些，模型就会在早上九点说去吃午饭。
   */
  async function chatRuntime(now = new Date()) {
    const settings = await store.getSettings()
    const table = await holidayTableFor(now.getFullYear())
    return {
      now,
      workStart: settings.workStart,
      workEnd: settings.workEnd,
      isRestDay: isRestDay(settings, now, table),
    }
  }

  /**
   * 她自己的参考图（data URL）。
   *
   * 懒加载 + 缓存：读盘 + base64 只在第一次对话时做一次，
   * 之后每轮直接用缓存。返回空串表示没有参考图（不阻塞对话）。
   */
  let portraitCache
  function selfPortrait() {
    if (portraitCache !== undefined) return portraitCache
    try {
      portraitCache = String(deps.loadSelfPortrait?.() ?? '')
    } catch {
      /* 参考图只是锦上添花，读不到就不加，不能让对话整个失败 */
      portraitCache = ''
    }
    return portraitCache
  }

  /* ---------- 亲密度 ---------- */
  /*
   * 存在 meta 里而不是 settings：它是一个累计计数器，
   * 混进设置会让「重置设置」把互动记录也清掉。
   *
   * chatDay/chatToday 是「聊天得分」的当日计数器 —— 单独存而不是从点数反推，
   * 因为点数还会被摸头等手动互动加走，混在一起就分不清聊天用了多少配额。
   *
   * ## 按会话隔离
   *
   * 每个会话是**独立的她**：亲密度、图鉴解锁、人设选择、当前穿着都各存一份。
   * 键名形如 `affinity:<sessionId>`；老的全局键（`affinity`）在首次读取时
   * 迁移给最早的那个会话，之后的会话从零开始。
   *
   * 之所以不做成「一张表 + sessionId 列」：这些值都是小 JSON，
   * meta 表本来就是键值对，加前缀比新建一张表省事，也不会和同步字段打架。
   */
  const scopedKey = (base, sessionId) => (sessionId ? `${base}:${sessionId}` : base)

  /**
   * 取当前会话 id。
   *
   * 服务层很多入口（摸鱼、挂机台词）拿不到 sessionId，
   * 统一回落到「最近更新的会话」—— 和用户视角一致：
   * 他正在看的那个就是当前的。
   */
  async function currentSessionId() {
    return (await store.listSessions())[0]?.id ?? null
  }

  /**
   * 读取某会话的 meta，带**一次性迁移**。
   *
   * 迁移只在「新键不存在且旧全局键有值」时发生，且写完就删旧键 ——
   * 否则第二个会话也会拿到同一份历史进度。
   */
  async function readScoped(base, fallback, sessionId) {
    const sid = sessionId === undefined ? await currentSessionId() : sessionId
    const key = scopedKey(base, sid)
    const scoped = await store.getMeta(key, null)
    if (scoped != null) return scoped

    const legacy = await store.getMeta(base, null)
    if (legacy != null && sid) {
      /* 把老进度交给现在这个会话，然后删掉全局键，避免被别的会话重复领走 */
      await store.setMeta(key, legacy)
      await store.setMeta(base, null)
      return legacy
    }
    return fallback
  }

  async function writeScoped(base, value, sessionId) {
    await store.setMeta(scopedKey(base, sessionId), value)
  }

  async function readAffinity(sessionId) {
    const data = await readScoped('affinity', null, sessionId)
    return {
      points: Math.max(0, Number(data?.points) || 0),
      lastDay: data?.lastDay ?? null,
      streakDays: Number(data?.streakDays) || 0,
      chatDay: data?.chatDay ?? null,
      chatToday: Math.max(0, Number(data?.chatToday) || 0),
    }
  }

  async function getAffinity(now = new Date(), sessionId) {
    const data = await readAffinity(sessionId)
    const today = toDateKey(now)
    return {
      points: data.points,
      lastDay: data.lastDay,
      streakDays: data.streakDays,
      chatToday: data.chatDay === today ? data.chatToday : 0,
      max: AFFINITY_MAX_POINTS,
      isMax: data.points >= AFFINITY_MAX_POINTS,
      /** 前端要按会话显示，带上 id 才知道这份是谁的 */
      sessionId: sessionId === undefined ? await currentSessionId() : sessionId,
    }
  }

  /**
   * 记亲密度。
   *
   * @param {number} delta 想加的点数
   * @param {Date} now
   * @param {{ kind?: 'chat'|'interaction', silent?: boolean, sessionId?: string }} [opts]
   *   kind='chat' 的得分受 `CHAT_AFFINITY_DAILY_CAP` 约束，
   *   避免一口气聊几十条就把关系刷满。
   */
  async function addAffinity(delta, now = new Date(), opts = {}) {
    /* 会话 id 也接受从 opts 传（内部调用点较多），但显式参数优先 */
    const sid = opts.sessionId ?? (await currentSessionId())
    const cur = await readAffinity(sid)
    const today = toDateKey(now)
    const gain = affinityGain(cur, delta, today, { chat: opts.kind === 'chat' })

    let streakDays = cur.streakDays
    if (cur.lastDay !== today) {
      /* 连续互动天数：昨天来过就 +1，断档则重新计数 */
      const y = new Date(now)
      y.setDate(y.getDate() - 1)
      streakDays = cur.lastDay === toDateKey(y) ? cur.streakDays + 1 : 1
    }

    const chatToday = opts.kind === 'chat'
      ? (cur.chatDay === today ? cur.chatToday : 0) + gain
      : cur.chatDay === today ? cur.chatToday : 0

    const next = {
      points: Math.min(AFFINITY_MAX_POINTS, cur.points + gain),
      lastDay: today,
      streakDays,
      chatDay: today,
      chatToday,
    }
    await writeScoped('affinity', next, sid)

    /* 无进展（已满级 / 聊天配额用完）就不用广播了，省得前端白刷一次 */
    const seen = await getAffinity(now, sid)
    if (gain > 0 || !opts.silent) emit('affinity', seen)
    return seen
  }

  /* ---------- 逐会话的设置项 ---------- */

  /*
   * 哪些设置是「每个会话一份」。
   *
   * 只有**跟「她是谁」相关的**才逐会话：
   *   chatPersona  这个人设是她的人格
   *   outfitMode / outfitSlug  她穿什么
   *   petStories   这个会话要不要对话解锁
   *
   * 而 chatBaseUrl / chatApiKey / chatModel 是**账号级配置**，
   * 逐会话存意味着每开一个会话都要重填一遍 Key —— 那是折磨用户。
   * 摸鱼/工资/窗口尺寸等同理，全局一份才对。
   */
  const PER_SESSION_SETTINGS = ['chatPersona', 'outfitMode', 'outfitSlug', 'petStories']

  /** 读设置时，把逐会话的键替换成当前会话的值 */
  async function settingsForSession(sessionId) {
    const base = await store.getSettings()
    const sid = sessionId === undefined ? await currentSessionId() : sessionId
    if (!sid) return base
    const out = { ...base }
    for (const key of PER_SESSION_SETTINGS) {
      const v = await readScoped(`set:${key}`, undefined, sid)
      if (v !== undefined) out[key] = v
    }
    return out
  }

  /** 写设置时，逐会话的键写进会话命名空间，其余写全局 */
  async function setSetting(key, value, sessionId) {
    const sid = sessionId === undefined ? await currentSessionId() : sessionId
    if (PER_SESSION_SETTINGS.includes(key) && sid) {
      await writeScoped(`set:${key}`, value, sid)
      return
    }
    /* store 层是 saveSettings(patch)，不是 setSetting(key, value) */
    await store.saveSettings({ [key]: value })
  }

  /* ---------- 图鉴解锁（对话触发） ---------- */

  /*
   * 解锁状态存在 meta 里，键名与手机端**刻意保持一致**
   * （unlockedOutfits / outfitMemories / …）—— 两端共用同一套 backup
   * 结构与同一份 shared 逻辑，键名不同会让将来做同步时平白多一层映射。
   *
   * 每个键都会再按会话加前缀（见 scopedKey）：**每个会话是独立的她**，
   * 图鉴进度不跨会话共享。
   */
  const GALLERY_KEYS = {
    outfit: { list: 'unlockedOutfits', mem: 'outfitMemories' },
    video: { list: 'unlockedVideos', mem: 'videoMemories' },
  }

  async function listUnlocked(kind, sessionId) {
    const k = GALLERY_KEYS[kind]
    if (!k) return []
    const v = await readScoped(k.list, [], sessionId)
    return Array.isArray(v) ? v : []
  }

  /**
   * 解锁一项并记下触发细节（成为她的长期记忆）。
   * 已解锁过则返回 null —— 这是「一次性」语义的落点。
   */
  async function unlockItem(kind, slug, line = '', title = '', sessionId) {
    const k = GALLERY_KEYS[kind]
    if (!k) return null
    const sid = sessionId === undefined ? await currentSessionId() : sessionId
    const cur = await listUnlocked(kind, sid)
    if (cur.includes(slug)) return null
    await writeScoped(k.list, [...cur, slug], sid)
    const mem = (await readScoped(k.mem, {}, sid)) ?? {}
    mem[slug] = { at: Date.now(), line, title }
    await writeScoped(k.mem, mem, sid)
    return { kind, slug, at: mem[slug].at, line, title, sessionId: sid }
  }

  const listMemories = async (kind, sessionId) =>
    (await readScoped(GALLERY_KEYS[kind]?.mem ?? '', {}, sessionId)) ?? {}

  /**
   * 图鉴快照：给渲染端渲染用。
   *
   * 返回**渲染所需的一切**（内容表、已解锁、记忆、进度），
   * 而不是让前端自己去拼 —— 拼的话两端会各写一套，
   * 而且前端拿不到 OUTFIT_STORIES 这类只有宿主侧能 import 的数据。
   */
  async function gallerySnapshot(sessionId) {
    const sid = sessionId === undefined ? await currentSessionId() : sessionId
    /* 读之前先补齐初始内容，老会话也能拿到 */
    await seedSessionIfNeeded(sid)
    const build = async (kind, table) => {
      const unlocked = await listUnlocked(kind, sid)
      const mem = await listMemories(kind, sid)
      return {
        kind,
        total: Object.keys(table).length,
        unlockedCount: unlocked.length,
        unlocked,
        items: Object.entries(table).map(([slug, d]) => ({
          slug,
          title: d.title,
          hint: d.hint,
          story: d.story ?? '',
          unlock: d.unlock,
          keywords: d.keywords ?? [],
          condition: d.condition ?? null,
          got: unlocked.includes(slug),
          /* 解锁时她说的那句（记忆）；未解锁时为空 */
          line: mem[slug]?.line ?? '',
          at: mem[slug]?.at ?? null,
        })),
      }
    }
    return {
      sessionId: sid,
      outfit: await build('outfit', OUTFIT_STORIES),
      video: await build('video', VIDEO_STORIES),
    }
  }

  /**
   * 建会话并补上「初始就该有」的内容。
   *
   * `casual` 的解锁条件是 minPoints=0（「初始就有」），但条件解锁只在
   * 聊天时跑 —— 不主动补的话新会话图鉴全黑，用户会以为坏了。
   *
   * 注意 `ensureChatSession` 在**已有会话**时直接返回，不走这里：
   * 那类会话（升级前就存在的）由 seedSessionIfNeeded 单独补。
   */
  async function createSessionSeeded(title) {
    const s = await store.createSession(title)
    await seedSessionIfNeeded(s.id)
    return s
  }

  /**
   * 给会话补「初始就该有」的内容。
   *
   * 每个会话都会调用一次（幂等）：读图鉴时顺手补齐。
   * 这样**升级前就存在的会话**也能拿到初始装扮 ——
   * 只在建会话时补的话，老会话永远是空的。
   */
  async function seedSessionIfNeeded(sessionId) {
    if (!sessionId) return
    try {
      const unlocked = await listUnlocked('outfit', sessionId)
      if (unlocked.includes('casual')) return
      await unlockItem(
        'outfit',
        'casual',
        OUTFIT_STORIES.casual?.story ?? '',
        OUTFIT_STORIES.casual?.title ?? '便服',
        sessionId,
      )
    } catch {
      /* 补初始内容失败不该影响主流程 */
    }
  }

  /** 清空图鉴进度（「重置」时一起清） */
  async function clearGallery(sessionId) {
    const sid = sessionId === undefined ? await currentSessionId() : sessionId
    for (const k of Object.values(GALLERY_KEYS)) {
      await writeScoped(k.list, [], sid)
      await writeScoped(k.mem, {}, sid)
    }
    /* 顺手把老全局键也清掉，否则下一个会话会把它当「可迁移的历史」领走 */
    await store.setMeta('unlockedOutfits', null)
    await store.setMeta('outfitMemories', null)
    await store.setMeta('unlockedVideos', null)
    await store.setMeta('videoMemories', null)
  }

  /**
   * 解锁执行器 —— 三层管线的实现来自 shared/gallery.js，两端共用。
   *
   * 这里只提供「宿主侧」的依赖：读写 meta、取最近对话、
   * 调一次短生成、判断配置是否就绪。依赖全部异步（store 为异步接口），
   * shared/gallery.js 对每个依赖都 await，同步实现也兼容。
   */
  /*
   * runner 的回调是取值时求值的，所以每次检查前把当前会话 id 放这里，
   * 让 listUnlocked / unlock / recentMessages 都作用在同一个会话上。
   */
  let lastGallerySession = null

  const galleryRunner = createGalleryRunner({
    listUnlocked: async (kind) => listUnlocked(kind, lastGallerySession ?? (await currentSessionId())),
    unlock: (kind, slug, line, title) =>
      unlockItem(kind, slug, line, title, lastGallerySession ?? undefined),
    recentMessages: async () => {
      const sid = lastGallerySession ?? (await currentSessionId())
      if (!sid) return []
      return (await store.recentMessages(sid, 10))
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => {
          const content =
            typeof m.content === 'string'
              ? m.content
              : (m.content ?? [])
                  .filter((b) => b.type === 'text')
                  .map((b) => b.text)
                  .join('')
          return { role: m.role, content }
        })
    },
    completeOnce: async ({ system, messages, maxTokens }) =>
      completeOnce({
        settings: await store.getSettings(),
        system,
        messages,
        maxTokens,
        runtime: await chatRuntime(),
      }),
    isReady: async () =>
      (await validateConfig(await store.getSettings(), await customPersonas(), await chatRuntime())).ok,
    points: async () => (await readAffinity(lastGallerySession ?? undefined)).points,
    /*
     * 她此刻穿什么 —— 判定条件②「状态吻合」用。
     *
     * 取当前会话的设置：固定模式用 outfitSlug；自动模式按时间算。
     * 两者都要走 settingsForSession，否则读到的是别的会话的穿着。
     */
    currentOutfit: async () => {
      const sid = lastGallerySession ?? (await currentSessionId())
      const st = await settingsForSession(sid)
      if (st.outfitMode === 'fixed' && st.outfitSlug) return st.outfitSlug
      return outfitForTime(new Date(), await listUnlocked('outfit', sid))
    },
  })

  /**
   * 一轮对话结束后检查解锁。
   *
   * 用最近的往返内容当依据 —— 判定「刚才聊的是不是某个话题」，
   * 只看用户那一条往往不够（她的回复里常带上文）。
   */
  async function checkUnlockAfterReply(text, sessionId) {
    const settings = await store.getSettings()
    if (settings.petStories === false) return null
    /*
     * 显式传入会话 id 而不是让 runner 自己回落 ——
     * 解锁必须记在**刚聊完的那个会话**上，而 currentSessionId() 取的是
     * 「最近更新的会话」，在多窗口同时对话时会指错人。
     */
    if (sessionId) lastGallerySession = sessionId
    return galleryRunner.checkAny({ recentText: text })
  }

  /**
   * 重置亲密度。
   *
   * 必须写**当前会话的键** —— 早先这里还在写全局 `affinity`，
   * 而读取走的是 `affinity:<sid>`，于是「重置」看起来毫无效果
   * （读到的仍是会话里那份旧值）。改按会话隔离时漏改了这一处。
   *
   * 顺带把老的全局键也清掉，否则下一个新建的会话会把它当
   * 「可迁移的历史进度」领走，一开局就有分。
   */
  async function resetAffinity(sessionId) {
    const sid = sessionId === undefined ? await currentSessionId() : sessionId
    const blank = { points: 0, lastDay: null, streakDays: 0, chatDay: null, chatToday: 0 }
    await writeScoped('affinity', blank, sid)
    await store.setMeta('affinity', null)
    const next = await getAffinity(new Date(), sid)
    emit('affinity', next)
    return next
  }

  /** 确保某年的表已就绪（启动时调用一次即可） */
  async function ensureHolidays(now = new Date()) {
    return refreshHolidays(now.getFullYear())
  }

  function onChange(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  /** 汇总状态：所有窗口共用同一份快照 */
  /**
   * 全局状态快照（摸鱼收入、打卡天数等本来就是全设备的，不分会话）。
   *
   * **但 `settings` 字段必须是「当前活跃会话的」**：
   * 人设/穿着是逐会话的，广播全局值会把刚写进会话 A 的覆盖掉 ——
   * 别的窗口收到 state 后又把 casual-red 冲回 casual，
   * 表现成「对话窗换装点了，立绘窗没反应」。
   * 这是那个 bug 的最后一环。
   */
  async function getState(now = new Date(), sessionId) {
    const sid = sessionId === undefined ? await currentSessionId() : sessionId
    const settings = await settingsForSession(sid)
    const table = await holidayTableFor(now.getFullYear())
    const snapshot = todaySnapshot(settings, now, table)
    const days = await store.moyuDays()
    const level = levelOf(days)
    const payday = paydayCountdown(settings, now)
    const checkin = await store.getCheckin(snapshot.dateKey)
    /*
     * streak 的 isRest 回调是同步的（逐日推进在 store 层），拿不到 await ——
     * 预把回看窗口（guard 3660 天 ≈ 10 年）内可能跨到的年份表载入内存缓存。
     * 原实现（同步 store）在回调里能直接查库，这里预载是等价替身；
     * 已缓存的年份零成本，meta miss 也只是几次点查。
     */
    for (let y = 1; y <= 10; y++) await holidayTableFor(now.getFullYear() - y)
    return {
      settings,
      snapshot,
      days,
      /*
       * 连续打卡按「工作日」连推：休息日既不计入也不算断档。
       * 否则周五打卡 + 周一打卡会显示成「连续 1 天」，而用户明明没漏。
       */
      streak: await store.streak(snapshot.dateKey, (date) => {
        const t = holidayMemory.get(date.getFullYear()) ?? table
        return isRestDay(settings, date, t)
      }),
      level,
      payday,
      checkedInToday: Boolean(checkin),
      checkin,
      workDaysThisMonth: workDaysInMonth(settings, now.getFullYear(), now.getMonth() + 1, table),
      todayEarnedText: formatMoney(snapshot.todayEarned, settings.salaryCurrency),
      dailySalaryText: formatMoney(snapshot.dailySalary, settings.salaryCurrency),
      salaryText: formatMoney(settings.salary, settings.salaryCurrency),
      pendingSync: await store.pendingChanges(),
      loggedMinutesToday: await store.worklogTotal(snapshot.dateKey),
      /* 节假日状态：界面用来显示「春节」「补班」标签 */
      holiday: {
        name: snapshot.holidayName,
        isMakeup: snapshot.isMakeupDay,
        isStatutory: snapshot.isStatutoryHoliday,
        hasTable: Boolean(table),
      },
      /* 亲密度：互动累计，用于解锁不同反应 */
      affinity: await getAffinity(now, sid),
    }
  }

  async function checkIn(now = new Date()) {
    const dateKey = toDateKey(now)
    const { checkin, created } = await store.addCheckin(dateKey)
    if (created) await store.addEvent('checkin.created', { dateKey })
    /* 打卡成功桌宠蹦一下：与补卡庆祝同款反馈（广播到桌宠窗播放），
       托盘/面板/菜单所有打卡路径统一受益；重复打卡（created=false）不蹦 */
    if (created) emit('emote', { key: 'jump', holdMs: 2600 })
    const state = await getState(now)
    emit('state', state)
    return { created, dateKey, checkin, state }
  }

  /**
   * 更新设置。
   *
   * 逐会话的键（人设/穿着/解锁开关）写进**指定会话**，其余走全局。
   * 不这样做的话：在会话 A 面板里改人设，会话 B 也跟着变 ——
   * 而人设就是「她是谁」，跟着变等于两个会话是同一个人。
   */
  async function updateSettings(patch, sessionId) {
    const sid = sessionId === undefined ? await currentSessionId() : sessionId
    const perSession = {}
    const global = {}
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (PER_SESSION_SETTINGS.includes(k)) perSession[k] = v
      else global[k] = v
    }
    if (Object.keys(global).length) await store.saveSettings(global)
    for (const [k, v] of Object.entries(perSession)) await setSetting(k, v, sid)

    /*
     * 广播时带上刚写的会话 —— 不带的话 getState 会去读「最近更新的会话」，
     * 而它未必是刚写的那个，于是广播出去的值还是旧的。
     */
    const state = await getState(new Date(), sid)
    emit('state', state)
    return state
  }

  async function resetSettings() {
    return updateSettings({ ...DEFAULT_SETTINGS })
  }

  async function logMoyu(minutes, now = new Date()) {
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('minutes must be a positive number')
    const dateKey = toDateKey(now)
    await store.addWorklog(dateKey, minutes, 'moyu')
    const state = await getState(now)
    emit('state', state)
    return state
  }

  /* ---------- 补卡 ---------- */

  const BACKFILL_NOTE = '补卡'
  /** 从某天到今天之间，还没打卡的工作日（预览与执行共用同一份口径） */
  async function missingWorkdays(fromKey, now = new Date()) {
    const from = parseDateKey(fromKey)
    if (!from) throw new Error('开始日期格式应为 YYYY-MM-DD')
    const toKey = toDateKey(now)
    if (from > now) throw new Error('开始日期不能晚于今天')
    const table = (await holidayTableFor(from.getFullYear())) ?? (await holidayTableFor(now.getFullYear()))
    /* 跨年时用起始年的表盖前一段、今年的表盖后一段 —— 这里按天各取自己的表 */
    const existed = new Set((await store.listCheckins()).map((c) => c.dateKey))
    const settings = await store.getSettings()
    const days = []
    const cursor = new Date(from)
    while (cursor <= now) {
      const key = toDateKey(cursor)
      const yearTable = (await holidayTableFor(cursor.getFullYear())) ?? table
      if (!existed.has(key) && !isRestDay(settings, cursor, yearTable)) {
        const info = yearTable?.[key.slice(5)] ?? null
        days.push({
          dateKey: key,
          weekday: cursor.getDay(),
          holidayName: info?.name ?? null,
          isMakeup: Boolean(info?.isMakeup),
        })
      }
      cursor.setDate(cursor.getDate() + 1)
    }
    return days
  }

  /**
   * 预览：不做任何写入，先把「会补几天、哪几天」摊开给用户确认。
   * 补卡是不可逆的历史写入，没有预览直接写风险太大。
   */
  async function previewBackfill(fromKey, now = new Date()) {
    const days = await missingWorkdays(fromKey, now)
    return {
      from: parseDateKey(fromKey) ? fromKey : null,
      to: toDateKey(now),
      count: days.length,
      days,
      /* 有节假日表时工作日判定更准，没有表只能按周末算 */
      hasHolidayTable: Boolean(await holidayTableFor(now.getFullYear())),
    }
  }

  /** 执行补卡：写入所有缺失的工作日 */
  async function applyBackfill(fromKey, now = new Date()) {
    const preview = await previewBackfill(fromKey, now)
    const result = await store.addCheckins(preview.days.map((d) => d.dateKey), BACKFILL_NOTE)
    if (result.created.length > 0) {
      await store.addEvent('checkin.backfill', { from: preview.from, to: preview.to, count: result.created.length })
      /*
       * 桌宠蹦一下庆祝。跨窗口的观感反馈只能靠广播 ——
       * 补卡是在面板窗点的，但表情要在桌宠窗放。
       */
      emit('emote', { key: 'jump', holdMs: 2600 })
    }
    const state = await getState(now)
    emit('state', state)
    return { ...preview, created: result.created, skipped: result.skipped, state }
  }

  return {
    /* 只读 */
    getState,
    /*
     * 会话感知：逐会话的键（人设/穿着）取当前会话的值，
     * 其余取全局。改这一处就够 —— 内部所有 store.getSettings() 调用
     * 仍走全局，而那些位置（摸鱼、节假日）本来就只关心全局字段。
     */
    getSettings: (sessionId) => settingsForSession(sessionId),
    listCheckins: async (args) => store.listCheckins(args),
    listWorklogs: async (dateKey) => store.listWorklogs(dateKey),

    /* 通用 meta 读写（宿主记「当前活跃会话」等用） */
    getMeta: async (key, fallback = null) => store.getMeta(key, fallback),
    setMeta: async (key, value) => store.setMeta(key, value),

    /*
     * 逐会话状态的读写。
     *
     * 渲染端**切换会话时必须显式传 sessionId** —— 不传会回落到
     * 「最近更新的会话」，切换的瞬间容易读到上一个人的数据。
     */
    sessionSettings: (sessionId) => settingsForSession(sessionId),
    setSessionSetting: async (sessionId, key, value) => {
      await setSetting(key, value, sessionId)
      emit('state', await getState())
    },
    /** 某会话的亲密度（含等级所需字段，前端直接渲染） */
    sessionAffinity: (sessionId) => getAffinity(new Date(), sessionId),
    /** 某会话的图鉴快照 */
    sessionGallery: (sessionId) => gallerySnapshot(sessionId),
    /** 清空某会话的图鉴进度 */
    clearSessionGallery: (sessionId) => clearGallery(sessionId),

    /* 写 */
    checkIn,
    updateSettings,
    resetSettings,
    logMoyu,
    addEvent: async (type, payload) => {
      await store.addEvent(type, payload)
      return true
    },

    /* ---------- 补卡 ---------- */
    previewBackfill,
    applyBackfill,

    /* 同步接口（云端未接入时是本地 no-op 记账） */
    pendingChanges: async () => store.pendingChanges(),
    markSynced: async (ids) => store.markSynced(ids),

    /* 节假日 */
    ensureHolidays,
    refreshHolidays,
    holidayTableFor,
    holidayInfo: async (dateKey) => {
      const table = await holidayTableFor(Number(String(dateKey).slice(0, 4)))
      const info = table?.[String(dateKey).slice(5)] ?? null
      return { dateKey, hasTable: Boolean(table), info }
    },
    /** 某月的休息/工作日统计，供打卡日历使用 */
    monthSummary: async (year, month) => {
      const table = await holidayTableFor(year)
      const settings = await store.getSettings()
      const total = new Date(year, month, 0).getDate()
      const restDays = []
      const workDays = []
      for (let d = 1; d <= total; d++) {
        const date = new Date(year, month - 1, d)
        const key = toDateKey(date)
        const info = table?.[key.slice(5)] ?? null
        const rest = isRestDay(settings, date, table)
        ;(rest ? restDays : workDays).push({ dateKey: key, name: info?.name ?? null, isMakeup: Boolean(info?.isMakeup), isHoliday: Boolean(info?.isHoliday) })
      }
      return { year, month, hasTable: Boolean(table), restDays, workDays }
    },

    /* ---------- 亲密度 ---------- */
    affinity: () => getAffinity(),
    affinityLevel: async () => affinityLevel((await getAffinity()).points),
    /* addAffinity 内部已 emit，不要再手动广播，否则前端收到两次 */
    /*
     * 第 3 个参数是 sessionId。
     *
     * 早先它只能通过 opts.sessionId 传，结果调用方极容易漏 ——
     * 漏了就会静默写到「最近更新的会话」而不是目标会话。
     * 提成显式位置参数后，忘传至少能在签名上被看出来。
     */
    addAffinity: (delta, opts, sessionId) =>
      addAffinity(delta, new Date(), sessionId ? { ...opts, sessionId } : opts),
    resetAffinity,

    /* ---------- 人设（内置 + 自定义） ---------- */
    /** 全部人设：内置在前，自定义在后 */
    listPersonas: async () => [
      ...CHAT_PERSONAS.map((p) => ({ id: p.id, label: p.label, custom: false, prompt: p.prompt })),
      ...(await store.listPersonas()),
    ],

    createPersona: async (payload) => {
      const created = await store.createPersona({
        label: payload?.label ?? '自定义人设',
        prompt: payload?.prompt ?? '',
      })
      emit('personas', { type: 'changed' })
      return created
    },

    /** 复制一份现有（内置或自定义）人设作为新的自定义人设 */
    duplicatePersona: async (sourceId) => {
      const all = [
        ...CHAT_PERSONAS.map((p) => ({ id: p.id, label: p.label, prompt: p.prompt })),
        ...(await store.listPersonas()),
      ]
      const src = all.find((p) => p.id === sourceId)
      if (!src) return null
      const created = await store.createPersona({
        label: `${src.label} 副本`.slice(0, 40),
        prompt: src.prompt,
      })
      emit('personas', { type: 'changed' })
      return created
    },

    updatePersona: async (id, patch) => {
      const updated = await store.updatePersona(id, patch ?? {})
      emit('personas', { type: 'changed' })
      return updated
    },

    deletePersona: async (id) => {
      await store.deletePersona(id)
      /* 删掉的正好是当前使用的人设时，回落到默认 */
      const settings = await store.getSettings()
      if (settings.chatPersona === id) await store.saveSettings({ chatPersona: CHAT_PERSONAS[0].id })
      emit('personas', { type: 'changed' })
      return { ok: true, personas: await store.listPersonas() }
    },

    /* ---------- 对话 ---------- */

    /** 当前可用的对话配置状态（不下发 apiKey 原文，只给是否已填） */
    chatStatus: async () => {
      const settings = await store.getSettings()
      const check = await validateConfig(settings, await customPersonas(), await chatRuntime())
      return {
        ready: check.ok,
        reason: check.ok ? null : check.reason,
        provider: settings.chatProvider,
        baseUrl: settings.chatBaseUrl,
        model: settings.chatModel,
        hasApiKey: Boolean(String(settings.chatApiKey || '').trim()),
        needsApiKey: !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(String(settings.chatBaseUrl || '')),
      }
    },

    chatTest: async () => pingChat({ settings: await store.getSettings(), customPersonas: await customPersonas() }),

    /**
     * 一次跑完全链路自检，把每一步结果摊开，便于定位「测试连接成功但对话失败」。
     * 不落库、不改设置。
     */
    chatDiagnose: async () => {
      const settings = await store.getSettings()
      const steps = []
      const push = (name, ok, detail) => steps.push({ name, ok, detail: String(detail ?? '') })

      push('读取设置', true, `provider=${settings.chatProvider} model=${settings.chatModel}`)

      const check = await validateConfig(settings, await customPersonas(), await chatRuntime())
      push('配置校验', check.ok, check.ok ? `BaseURL=${check.cfg.baseUrl}` : check.reason)
      if (!check.ok) return { ok: false, steps }

      const key = String(settings.chatApiKey || '').trim()
      push('API Key', key.length > 0 || !check.cfg.apiKey, key ? `已填，长度 ${key.length}，前缀 ${key.slice(0, 5)}…` : '为空（本地地址可接受）')

      /* 1) 非流式：等价于「测试连接」 */
      const ping = await pingChat({ settings, customPersonas: await customPersonas() })
      push('非流式请求', ping.ok, ping.ok ? `model=${ping.model}` : ping.reason)
      if (!ping.ok) return { ok: false, steps }

      /* 2) 流式：真正的对话路径，最容易出问题的一步 */
      let streamed = 0
      let streamErr = null
      let reply = ''
      try {
        const r = await streamChat({
          settings,
          customPersonas: await customPersonas(),
          runtime: await chatRuntime(),
          messages: [{ role: 'user', content: '请只回复两个字：正常' }],
          onDelta: (_d, full) => {
            streamed = full.length
          },
        })
        reply = r.content
        push('流式请求', true, `收到 ${r.content.length} 字，model=${r.model}`)
      } catch (err) {
        streamErr = err
        push('流式请求', false, `${err.message}${err.kind ? `（${err.kind}）` : ''}`)
      }
      push('流式增量回调', streamed > 0 || Boolean(streamErr), streamed > 0 ? `onDelta 触发，累计 ${streamed} 字` : '未收到任何增量')

      /* 3) 落库：确认数据库写得进去 */
      try {
        const s = await store.createSession('__diagnose__')
        await store.addMessage(s.id, 'user', 'diag')
        await store.addMessage(s.id, 'assistant', 'ok')
        const n = (await store.listMessages(s.id)).length
        await store.deleteSession(s.id)
        push('数据库读写', n === 2, `写入并读回 ${n} 条消息`)
      } catch (err) {
        push('数据库读写', false, err.message)
      }

      return { ok: steps.every((s) => s.ok), steps, reply: reply.slice(0, 60) }
    },

    listChatSessions: async () => store.listSessions(),

    /** 没有会话就建一个，保证「对话」随时可用 */
    ensureChatSession: async () => {
      const sessions = await store.listSessions()
      if (sessions.length > 0) return sessions[0]
      return createSessionSeeded()
    },

    createChatSession: (title) => createSessionSeeded(title),

    renameChatSession: async (id, title) => store.renameSession(id, title),

    deleteChatSession: async (id) => {
      await store.deleteSession(id)
      emit('chat', { type: 'sessions' })
      return store.listSessions()
    },

    loadChatSession: async (id) => {
      const session = await store.getSession(id)
      if (!session) return null
      return { session, messages: await store.listMessages(id) }
    },

    /** 下面几个是给测试与后续功能用的底层入口 */
    addChatMessage: async (sessionId, role, content, opts) => store.addMessage(sessionId, role, content, opts),
    recentChatMessages: async (sessionId, limit) => store.recentMessages(sessionId, limit),
    listChatMessages: async (sessionId, limit) => store.listMessages(sessionId, limit),

    /**
     * 生成一句「跟最近对话有关」的挂机台词。
     *
     * 失败一律返回 ok:false，由调用方回落到固定台词池 ——
     * 挂机冒泡不该因为接口抖动就整个卡住。
     */
    generateChatterLine: async () => {
      const settings = await store.getSettings()
      /*
       * 挂机台词不会因为接口没配就整个不冒泡 —— 调用方会回落到台词库。
       * 这里也返回一个 reason，便于「设置 → 全链路自检」定位。
       */
      const check = await validateConfig(settings, await customPersonas(), await chatRuntime())
      if (!check.ok) return { ok: false, reason: check.reason }

      /* 找最近有消息的会话，没聊过就直接放弃 */
      const sessions = await store.listSessions()
      if (!sessions.length) return { ok: false, reason: '还没有对话记录' }
      const latest = sessions[0]

      /*
       * 只取「最近两天」的消息。
       *
       * 之前只按条数取（24 条），聊得少时会捞出几周前的内容，
       * 她照着老话题搭话会很出戏 —— 用户明确要求限定到最近两天。
       * 时间下界 + 条数上限叠加，两个都不能省：
       * 时间界定「多久之前算旧事」，条数防止两天内聊了几百条撑爆上下文。
       */
      const since = Date.now() - CHATTER_WINDOW_MS
      const history = await store.messagesSince(latest.id, since, 200)
      /*
       * 关键：按真实 role 重建多轮消息，不要把记录拼成一条 user 文本。
       * 后者会让模型分不清哪句是自己说的，表现为她对着自己说过的话发问。
       */
      const context = recentDialogueMessages(history, 12, 1500)
      /*
       * 两天内没聊过 → 不编了，交给调用方用台词库。
       * 让她对着一周前的旧事搭话，比说一句通用台词更奇怪。
       */
      if (!context.length) return { ok: false, reason: '最近两天没有聊天内容' }

      try {
        const raw = await completeOnce({
          settings,
          system: CHATTER_SYSTEM_PROMPT,
          messages: [
            ...context,
            { role: 'user', content: '（以上是你和我的真实聊天。现在突然想起一件事，对我说一句相关的话，只输出那句话本身。）' },
          ],
          maxTokens: 80,
          runtime: await chatRuntime(),
        })
        const line = sanitizeChatter(raw)
        if (!line) return { ok: false, reason: '生成的台词为空' }
        return { ok: true, line, fromHistory: true }
      } catch (err) {
        return { ok: false, reason: err?.message ?? String(err) }
      }
    },

    /**
     * 发一条消息并流式接收回复。
     * 通过 emit('chat-delta' / 'chat-done' / 'chat-error') 实时推给渲染进程。
     *
     * @param {string[]} [images] data URL 数组；为空时消息仍是纯文本字符串
     */
    sendChat: async ({ sessionId, text, requestId, images = [] }) => {
      /*
       * 先定会话，再取设置。
       *
       * 人设是**逐会话**的（每个会话是独立的她），所以必须先用
       * sessionId 解析出该会话的设置，否则会拿「最近更新的会话」
       * 的人设去回别人的消息 —— 两个窗口同时聊天时尤其明显。
       */
      let sid = sessionId
      if (!sid || !(await store.getSession(sid))) sid = (await store.createSession()).id

      const settings = await settingsForSession(sid)
      const clean = String(text ?? '').trim()
      const pics = (Array.isArray(images) ? images : []).filter(Boolean)
      /* 允许「只发图不写字」，但不能两者都空 */
      if (!clean && !pics.length) throw new ChatError('消息不能为空', 'empty')

      /* 逐张校验：不支持的格式/超大图要在发出去之前就拦掉 */
      for (const img of pics) {
        const bad = validateImageDataUrl(img)
        if (bad) throw new ChatError(bad, 'image')
      }
      /*
       * 模型不支持视觉时直接给出可执行的提示，而不是等上游回一个
       * 含义模糊的 400（DeepSeek 对纯文本模型发图就是这样）。
       */
      const visionIssue = checkImagesForModel(settings.chatModel, pics)
      if (visionIssue) throw new ChatError(visionIssue, 'image')

      /*
       * 有图时存成内容块数组（含 base64），无图仍存纯字符串 ——
       * 这样绝大多数纯文本消息的表结构和以前完全一致。
       */
      const stored = pics.length ? buildContent(clean, pics) : clean
      const userMsg = await store.addMessage(sid, 'user', stored)
      /* 首条用户消息拿来当会话标题；只有图时就叫「图片」 */
      const session = await store.getSession(sid)
      if (session && (await store.countMessages(sid)) === 1) {
        const title = clean || '图片'
        await store.renameSession(sid, title.slice(0, 24))
      }
      emit('chat', { type: 'message', sessionId: sid, message: userMsg })

      /*
       * 聊天记亲密度 —— 对话是处关系的主要途径，比摸头值钱。
       * 受当日聊天配额约束（见 affinityGain），所以这里只报「想加多少」。
       */
      const affinityAfterMessage = await addAffinity(
        AFFINITY_GAIN.chatMessage,
        new Date(),
        { kind: 'chat', silent: true, sessionId: sid },
      )
      emit('affinity', affinityAfterMessage)

      const cfg = await validateConfig(settings, await customPersonas(), await chatRuntime())
      if (!cfg.ok) {
        const errMsg = await store.addMessage(sid, 'assistant', cfg.reason, { error: true })
        emit('chat', { type: 'message', sessionId: sid, message: errMsg })
        emit('chat-done', { sessionId: sid, requestId, ok: false, reason: cfg.reason })
        return { ok: false, reason: cfg.reason, sessionId: sid }
      }

      const history = (await store.recentMessages(sid, cfg.cfg.maxHistory))
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }))

      const controller = new AbortController()
      activeRequests.set(requestId, controller)

      try {
        const result = await streamChat({
          settings,
          customPersonas: await customPersonas(),
          runtime: await chatRuntime(),
          selfPortrait: selfPortrait(),
          messages: history,
          signal: controller.signal,
          onDelta: (_delta, full) => emit('chat-delta', { sessionId: sid, requestId, full }),
        })
        const msg = await store.addMessage(sid, 'assistant', result.content, { model: result.model })
        await store.touchSession(sid)
        emit('chat', { type: 'message', sessionId: sid, message: msg })
        /* 一轮问答真正聊完，额外记一笔 —— 光发消息不算，得聊完 */
        emit('affinity', await addAffinity(AFFINITY_GAIN.chatRound, new Date(), { kind: 'chat', silent: true, sessionId: sid }))

        /*
         * 检查对话是否触发了图鉴解锁。
         *
         * 放在最后且整体 try 掉：解锁失败（网络抖动、模型乱答）
         * 绝不能影响「消息已经发出去了」这个事实。
         */
        let unlocked = null
        try {
          unlocked = await checkUnlockAfterReply(`${clean}\n${result.content}`, sid)
        } catch {
          unlocked = null
        }
        if (unlocked) emit('gallery-unlock', unlocked)

        emit('chat-done', { sessionId: sid, requestId, ok: true, message: msg, unlocked })
        return { ok: true, sessionId: sid, message: msg, unlocked }
      } catch (err) {
        const aborted = err instanceof ChatError && err.kind === 'aborted'
        const reason = aborted ? '已取消' : (err?.message ?? String(err))
        if (!aborted) {
          const msg = await store.addMessage(sid, 'assistant', reason, { error: true })
          emit('chat', { type: 'message', sessionId: sid, message: msg })
        }
        emit('chat-done', { sessionId: sid, requestId, ok: false, aborted, reason })
        return { ok: false, reason, aborted, sessionId: sid }
      } finally {
        activeRequests.delete(requestId)
      }
    },

    abortChat: (requestId) => {
      const controller = activeRequests.get(requestId)
      if (!controller) return false
      controller.abort()
      activeRequests.delete(requestId)
      return true
    },

    /* 元数据：前端渲染选项用 */
    meta: async () => ({
      levels: LEVELS,
      restPatterns: REST_PATTERNS,
      defaults: DEFAULT_SETTINGS,
      chatProviders: CHAT_PROVIDERS,
      chatPersonas: [
        ...CHAT_PERSONAS.map((p) => ({ id: p.id, label: p.label, custom: false })),
        ...(await store.listPersonas()).map((p) => ({ id: p.id, label: p.label, custom: true })),
      ],
      /* 亲密度：等级表、上限、单次得分，前端要拿去渲染等级与收益说明 */
      affinity: {
        levels: AFFINITY_LEVELS,
        max: AFFINITY_MAX_POINTS,
        gain: AFFINITY_GAIN,
        chatDailyCap: CHAT_AFFINITY_DAILY_CAP,
      },
      version: '0.1.0',
    }),

    /* ---------- 图鉴（对话解锁） ---------- */

    /**
     * 图鉴快照：给渲染端渲染用。
     *
     * 返回**渲染所需的一切**（内容表、已解锁、记忆、进度），
     * 而不是让前端自己去拼 —— 拼的话两端会各写一套，
     * 而且前端拿不到 OUTFIT_STORIES 这类只有宿主侧能 import 的数据。
     */
    gallery: (sessionId) => gallerySnapshot(sessionId),

    /** 触发规则的调试视图：这段文本会命中哪些候选（排查「为什么没解锁」） */
    explainTriggers: async (text, sessionId) =>
      explainCandidates(text, {
        outfit: await listUnlocked('outfit', sessionId),
        video: await listUnlocked('video', sessionId),
      }),

    /** 手动清空图鉴进度（不传则清当前会话） */
    clearGallery: (sessionId) => clearGallery(sessionId),

    onChange,
    emit,
    /* 关闭要幂等：退出流程里窗口事件、before-quit 都可能触发，重复关会抛错 */
    close: () => {
      try {
        store.close()
      } catch {
        /* 已经关了就算了，收尾阶段不该因为重复关闭再抛一次 */
      }
    },
  }
}
