/**
 * 手机端对话引擎 —— 浏览器直连 DeepSeek。
 *
 * 能直连的前提（已实测）：DeepSeek 的接口回了 CORS 头
 * （`access-control-allow-origin` 会回显请求的 Origin，
 * 且 allow-headers 含 authorization,content-type），
 * 所以浏览器 fetch 不会被同源策略拦下。
 *
 * 复用的是桌面端同一套 shared 模块：人设、时间感知、多模态、
 * 内容块规范 —— 两端行为一致，改一处两边都生效。
 */
import {
  CHAT_PERSONAS,
  DEFAULT_SETTINGS,
  timeContextFor,
  affinityContextFor,
  toDateKey,
  isRestDay,
} from '../src/shared/moyu.js'
import {
  buildContent,
  validateImageDataUrl,
  checkImagesForModel,
  normalizeForRequest,
  contentCost,
  modelSupportsImages,
  withSelfPortrait,
  buildRouteOptions,
  splitReplySegments,
} from '../src/shared/content.js'
import { createGalleryRunner } from '../src/shared/gallery.js'
import {
  AFFINITY_GAIN,
  AFFINITY_SOURCE,
  affinityLevel,
  affinityReadSettle,
  affinityView,
  averageReplyLength,
  happyBonus,
  settleAffinity,
  sourceOfGain,
  isUpsetting,
  outfitForTime,
} from '../src/shared/interactions.js'
import * as db from './storage.js'

/* ---------- 配置 ---------- */

export async function loadSettings() {
  const saved = await db.allSettings()
  const merged = { ...DEFAULT_SETTINGS, ...saved }
  /*
   * 空字符串不能当成有效值。
   *
   * 设置面板刚打开时人设下拉还没填充完（openSettings 是异步的），
   * 此时若点了「保存」，`$('f-persona').value` 是 ''，会被写进库 ——
   * 之后 loadSettings 读到的 chatPersona 就是 ''，而下拉里没有任何
   * value='' 的选项，于是**显示成无人设且无法选中**。
   * 这里把空串退回默认值，避免脏数据一路传下去。
   */
  if (!merged.chatPersona) merged.chatPersona = DEFAULT_SETTINGS.chatPersona
  return merged
}

export async function saveSettings(patch) {
  const allowed = Object.keys(DEFAULT_SETTINGS)
  /*
   * 空串的语义要按键区分：
   * - 默认值非空的键（chatPersona 等）：'' 只可能来自「还没填完的控件」，
   *   写进去会把默认值顶掉（chatPersona 就踩过这个坑）→ 跳过；
   * - 默认值就是空串的键（chatApiKey / chatRouteSort）：'' 是合法值。
   *   一律跳过会让「用户清空 API Key」永远写不进库 —— 旧 Key 静默保留、
   *   状态仍显示已就绪、导出备份还带着它 → 必须允许写。
   */
  const emptyOk = new Set(allowed.filter((k) => DEFAULT_SETTINGS[k] === ''))
  for (const [k, v] of Object.entries(patch ?? {})) {
    /* 和桌面端一致：只接受已知键，避免脏数据写进库 */
    if (!allowed.includes(k)) continue
    if (v === '' && !emptyOk.has(k)) continue
    await db.setSetting(k, v)
  }
  return loadSettings()
}

export async function allPersonas() {
  return [
    ...CHAT_PERSONAS.map((p) => ({ id: p.id, label: p.label, prompt: p.prompt, custom: false })),
    ...(await db.listPersonas()).map((p) => ({ ...p, custom: true })),
  ]
}

/** 解析出当前请求要用的配置（含人设 prompt） */
export async function resolveConfig(settings, now = new Date()) {
  const personas = await allPersonas()
  const persona =
    personas.find((p) => p.id === settings.chatPersona) ?? CHAT_PERSONAS[0]

  const clock = timeContextFor(now, {
    workStart: settings.workStart,
    workEnd: settings.workEnd,
    isRestDay: isRestDay(settings, now, null),
  })

  /*
   * 关系块 —— 与桌面端**同一份实现**（`affinityContextFor` + `affinityView`）。
   *
   * 手机端的亲密度是全局键 `affinity`（没有会话概念，见 desktop 端
   * service.js 的命名空间注释），所以直接读库里的 points 就行。
   *
   * 这里必须真的读一遍库、不能省：漏了的话手机上的她会永远演最低档，
   * 而桌面上已经是「默契搭档」—— 同一份人设、两端两个性格，最难查的那种不一致。
   *
   * **走 `affinityNow`（读时结算）而不是裸读**：手机端的亲密度是在
   * 回复落地之后才结算的，裸读会让「30 天没开、回来第一句」这轮
   * prompt 里还挂着旧的高档位（她会用「恋人」的语气回答一个刚被冷落
   * 30 天的人）。它无待结算时是纯读，不额外写库。
   */
  const affinity = await affinityNow()
  const points = Math.max(0, Number(affinity?.points) || 0)
  const view = affinityView(points, settings.godMode === true)
  const relation = affinityContextFor(points, {
    name: view.level?.name,
    next: view.next,
    isMax: view.isMax,
    godMode: view.godMode === true,
  })

  /*
   * 顺序：人设在前、易变块在后 —— 为了命中前缀缓存（见桌面端 composeSystemPrompt）。
   * 时间块每分钟变，放在末尾才不会把前面 1500+ 字的人设缓存击穿。
   * 关系块同理，且必须跟在人设之后（写进人设正文里会每轮击穿缓存）。
   */
  const baseUrl = String(settings.chatBaseUrl || '').trim().replace(/\/+$/, '')
  const apiKey = String(settings.chatApiKey || '').trim()
  const volatile = [clock, relation].filter(Boolean).join('\n\n')

  return {
    baseUrl,
    apiKey,
    model: String(settings.chatModel || '').trim() || 'deepseek-chat',
    /* 路由偏好透传（仅 OpenRouter 认；与桌面端共用同一份实现） */
    routeOptions: buildRouteOptions(baseUrl, settings),
    temperature: Number(settings.chatTemperature) || 1,
    maxHistory: Number(settings.chatMaxHistory) || 100,
    maxChars: Number(settings.chatMaxChars) || 48000,
    systemPrompt: volatile ? `${persona.prompt}\n\n${volatile}` : persona.prompt,
    personaId: persona.id,
    needsApiKey: !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(baseUrl),
  }
}

/** 配置是否可用 */
export async function configStatus(settings) {
  const cfg = await resolveConfig(settings)
  if (!cfg.baseUrl) return { ready: false, reason: '还没有配置接口地址', cfg }
  if (!/^https?:\/\//i.test(cfg.baseUrl)) return { ready: false, reason: '接口地址要以 http(s):// 开头', cfg }
  if (cfg.needsApiKey && !cfg.apiKey) return { ready: false, reason: '还没有填 API Key', cfg }
  return { ready: true, cfg }
}

/* ---------- SSE 流式解析（与桌面端同款逻辑） ---------- */

async function* parseSSE(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    /* 按空行切事件，能同时处理「JSON 被切断」和「多事件粘连」 */
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      const t = line.trim()
      if (!t || t.startsWith(':') || !t.startsWith('data:')) continue
      yield t.slice(5).trim()
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) yield tail.slice(5).trim()
}

/* ---------- 发送消息 ---------- */

/**
 * 发一条消息并流式接收回复。
 *
 * @param {object} opts
 * @param {object} opts.settings
 * @param {string} opts.sessionId
 * @param {string} opts.text
 * @param {string[]} [opts.images] data URL 数组
 * @param {(full:string)=>void} [opts.onDelta]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.selfPortrait] 参考图（data URL）
 * @param {Date}   [opts.now]
 * @returns {Promise<{ok:boolean, message?:object, reason?:string, aborted?:boolean}>}
 */
export async function sendMessage({
  settings,
  sessionId,
  text,
  images = [],
  onDelta,
  onUserMessage,
  signal,
  selfPortrait = '',
  now = new Date(),
}) {
  const clean = String(text ?? '').trim()
  const pics = (Array.isArray(images) ? images : []).filter(Boolean)
  if (!clean && !pics.length) return { ok: false, reason: '消息不能为空' }

  for (const img of pics) {
    const bad = validateImageDataUrl(img)
    if (bad) return { ok: false, reason: bad }
  }
  const visionIssue = checkImagesForModel(settings.chatModel, pics)
  if (visionIssue) return { ok: false, reason: visionIssue }

  const status = await configStatus(settings)
  if (!status.ready) return { ok: false, reason: status.reason }
  const cfg = status.cfg

  /* 先落库用户消息（含图时存内容块数组） */
  const stored = pics.length ? buildContent(clean, pics) : clean
  let sid = sessionId
  if (!sid || !(await db.getSession(sid))) sid = (await db.createSession()).id

  const userMsg = await db.addMessage(sid, 'user', stored)
  /*
   * 立刻把它交给调用方渲染。
   *
   * 不回调的话，用户要等**整个流式回复走完**才看到自己发的话
   * （早先的 `onSend` 是等 `sendMessage` 返回后才 `openSession` 重渲染）——
   * 表现是「发了消息没反应，过几秒两条一起冒出来」，
   * 用户会怀疑是不是没发出去。
   *
   * 放在落库**之后**：这样界面上画的这条一定已经在库里，
   * 后面 `openSession` 重读时不会出现「刚显示又消失」。
   *
   * 调用方要做成幂等的（按 id 去重）—— 因为结束时还会整体重读一次。
   */
  onUserMessage?.(userMsg, sid)

  const n = await db.countMessages(sid)
  if (n === 1) await db.renameSession(sid, (clean || '图片').slice(0, 24))

  /* 拼上下文：system + 规范化后的历史（参考图在裁剪后注入） */
  const history = (await db.recentMessages(sid, cfg.maxHistory)).map((m) => ({ role: m.role, content: m.content }))
  /*
   * 她**平时**回多长 —— 「这轮回复变长」是「开心」的信号之一
   * （与桌面端 service.js 同一处口径）。必须在这一轮回复落库之前算，
   * 否则新回复会把自己算进平均里，把判据稀释掉。
   */
  const avgReplyLen = averageReplyLength(history)
  const payload = [{ role: 'system', content: cfg.systemPrompt }, ...withPortraitIfAny(history, selfPortrait, cfg.model)]

  const headers = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`

  let res
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: payload,
        stream: true,
        temperature: cfg.temperature,
        /* 路由偏好（仅 OpenRouter 用；别的服务商忽略未知字段） */
        ...(cfg.routeOptions ?? {}),
      }),
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, aborted: true, reason: '已取消', sessionId: sid, userMessage: userMsg }
    /* 浏览器直连失败最常见的是网络/CORS；给出可操作的提示 */
    return {
      ok: false,
      reason: `连不上对话接口：${err?.message ?? err}。检查网络，或确认接口地址允许跨域。`,
      sessionId: sid,
      userMessage: userMsg,
    }
  }

  if (!res.ok) {
    const text2 = await res.text().catch(() => '')
    return { ok: false, reason: describeHttp(res.status, text2), sessionId: sid, userMessage: userMsg }
  }
  if (!res.body) return { ok: false, reason: '接口没有返回流式内容', sessionId: sid, userMessage: userMsg }

  let full = ''
  let model = cfg.model
  try {
    for await (const ev of parseSSE(res.body)) {
      if (ev === '[DONE]') break
      let json
      try {
        json = JSON.parse(ev)
      } catch {
        continue
      }
      if (json?.model) model = json.model
      const delta = json?.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta) {
        full += delta
        onDelta?.(full)
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, aborted: true, reason: '已取消', sessionId: sid, userMessage: userMsg }
    return { ok: false, reason: `读取流式响应失败：${err?.message ?? err}`, sessionId: sid, userMessage: userMsg }
  }

  if (!full) return { ok: false, reason: '接口返回了空回复', sessionId: sid, userMessage: userMsg }

  /*
   * 她可以一次生成、按多条发出（用 `<<<MSG>>>` 分隔，见 shared/content.js）。
   *
   * 每条落成独立消息、时间戳按固定间隔递增 —— 手机端的消息列表
   * 直接按 createdAt 顺序渲染，错开时间戳就会自然呈现出
   * 「一条条冒出来」的节奏（与桌面端同一套约定）。
   *
   * 没有标记时返回单条，行为与以前完全一致。
   */
  /*
   * `splitReplySegments` 的文档写明「全空则返回空数组，**调用方据此回落到原文**」。
   *
   * 这里原先没回落：模型只输出 `<<<MSG>>>`（或全空白）时 `segments` 为空，
   * 于是一条消息都不落库、也不报错 —— 界面表现为「她的回复凭空消失」。
   * 宁可把原文原样落成一条，也不能静默丢。
   */
  const segments = splitReplySegments(full)
  const parts = segments.length ? segments : [full]
  const baseTs = Date.now()
  let assistantMsg = null
  for (const [i, seg] of parts.entries()) {
    assistantMsg = await db.addMessage(sid, 'assistant', seg, {
      model,
      createdAt: baseTs + i * REPLY_SEGMENT_GAP_MS,
    })
  }

  /*
   * 一轮问答完成：记亲密度（用户消息 + 一轮结束 + 开心加成，
   * 与桌面端口径一致）。
   *
   * 同时判断这轮用户**是否惹她生气了** —— 说重话要扣分，
   * 否则「说错话」除了这一轮的回复语气之外没有任何代价，
   * 关系好坏的差别就没了。
   */
  try {
    const upsetting = isUpsetting(text)
    await bumpAffinity('chatMessage', undefined, { upsetting })
    /*
     * 「开心」加成（0~3 点，见 shared 的 happyBonus）：词表命中、
     * 或她这轮回复变长 / 带撒娇语气 / 分条发，都算「这轮聊得开心」。
     * 算在 if 外面，让下面那段受 `upsetting` 约束的结构保持平直
     * （smoke 有源码级守卫，见 service.js 同一处的注释）。
     */
    const happyGain = upsetting ? 0 : happyBonus({ text: clean, reply: parts.join('\n'), avgReplyLen, segments: parts.length })
    /*
     * **惹她生气那轮不给「聊完一次」的分**。
     *
     * 上面那次已按 `upsetting` 扣分并把当次加分清零；这里若再记
     * `chatRound`，就把扣的分加回来了 —— **骂她反而涨点**。
     * 两次调用之间抵消掉了 `settleAffinity` 里「生气当次加分清零」的设计。
     */
    if (!upsetting) await bumpAffinity('chatRound', undefined, { upsetting: false, delta: AFFINITY_GAIN.chatRound + happyGain })
  } catch {
    /* 亲密度记不上不该影响对话 */
  }

  /*
   * 回复落地后再判断故事解锁 —— 用刚发生的这轮对话做依据，
   * 顺序放在最后，是因为它失败（或超时）绝不能影响正常的对话结果。
   */
  let unlocked = null
  try {
    /*
     * 门槛用**真实亲密度**，不再用「已聊条数 × 2」那个代理值。
     *
     * 代理值是手机端还没有亲密度系统时留下的，量纲和两端的门槛表
     * 对不上（聊 150 条就等效 300 点，直接跳过中间五档）。
     * 手机端现在有完整的 `getAffinity`，就该和桌面端用同一个数。
     */
    unlocked = await checkAnyUnlock({
      settings,
      recentText: `${clean}\n${full}`,
      /* 同样走读时结算：门槛判定要用真实档位（无待结算时是纯读） */
      points: (await affinityNow())?.points ?? 0,
    })
  } catch {
    /* 忽略：解锁失败不该让消息发送失败 */
  }

  /*
   * 解锁本身给一笔奖励（用户要求「解锁事件会有奖励好感度」）。
   * 走独立来源 `unlock`：不占聊天额度也不占桌宠额度，且不封顶。
   * 失败不影响已经解锁这个事实。
   */
  if (unlocked) {
    try {
      await bumpAffinity('photoUnlock')
    } catch {
      /* 奖励记不上不该影响解锁 */
    }
  }

  return { ok: true, sessionId: sid, userMessage: userMsg, message: assistantMsg, unlocked }
}

/**
 * 结算一次亲密度变化。
 *
 * 加、扣、该来源的每日额度、每日自然流失、无互动惩罚
 * **全部走 shared 的 `settleAffinity`** —— 两端各写一遍的话，
 * 改规则时漏一处就会出现「手机上掉了 3 点、电脑上只掉 1 点」，
 * 用户没法理解。
 *
 * @param {string} kind AFFINITY_GAIN 的键（chatMessage / chatRound / click / …）
 *   来源由 `sourceOfGain(kind)` 推（只有 click/double/pet 受每日上限约束）
 * @param {Date}   now
 * @param {object} [opts]
 * @param {boolean} [opts.upsetting] 这轮用户是否惹她生气了
 * @param {number}  [opts.delta] 覆盖本次想加的点数（「开心」加成是变动的，
 *   `AFFINITY_GAIN[kind]` 给不出）
 */
export async function bumpAffinity(kind = 'chatMessage', now = new Date(), { upsetting = false, delta } = {}) {
  const today = toDateKey(now)
  const cur = await db.getAffinity()

  const next = settleAffinity(cur, {
    today,
    delta: Number.isFinite(delta) ? delta : (AFFINITY_GAIN[kind] ?? 0),
    upsetting,
    source: sourceOfGain(kind),
  })

  return db.setAffinity({
    ...cur,
    ...next,
    /* `lastDay` 是旧字段（摸鱼统计在用），保留推进 */
    lastDay: today,
  })
}

/**
 * 读亲密度记录，**顺带做「读时结算」**—— 手机端与桌面端同一条规则。
 *
 * 打开「她」那页 / 打开对话窗时把这段没见面的账结掉，用户回来看到的
 * 就是真实档位，而不是离开时的旧值（发第一句话才「啪」地掉下去）。
 *
 * 四条与桌面端一致的约定（见 shared 的 `affinityReadSettle`）：
 *   - **只结到昨天**（`settleToday: false`）：今天还没过完，它是活跃日
 *     还是空白天此刻不知道，硬结就是猜；留着它，等「今天真的互动了」
 *     （那次结算按活跃日 -5）或「明天再来读」（那时它已是过去的整天，
 *     按空白天 -10 补上）。这样「先开面板再聊」和「直接聊」净扣相等 ——
 *     否则每天先开一下面板的人会比不开的人多扣 5 点（看一眼要收费）；
 *   - `active: false`：**打开面板不是互动**，也不推进 `lastActive`；
 *   - 无待结算时**不写库**（返回 null 直接返回旧记录）—— 这个函数在
 *     `refreshAffinity` / 每次组 prompt 时都会被调到，是热路径；
 *   - 有待结算才写一次，`decaySettledDays` 推进到昨天，一天只扣一次。
 *
 * @param {Date} [now]
 */
export async function affinityNow(now = new Date()) {
  const cur = await db.getAffinity()
  const settled = affinityReadSettle(cur, toDateKey(now))
  if (!settled) return cur
  return db.setAffinity({ ...cur, ...settled })
}

/** 读当前亲密度（含等级、下一级还差多少）—— 会先做读时结算 */
export async function currentAffinity() {
  const a = await affinityNow()
  return { ...a, ...affinityLevel(a.points ?? 0) }
}

/** 参考图只在模型支持视觉时注入（否则纯文本模型会 400） */
function withPortraitIfAny(messages, selfPortrait, model) {
  const normalized = normalizeForRequest(messages)
  if (!selfPortrait || !modelSupportsImages(model)) return normalized
  /* 裁剪后再注入，保证参考图不会被当成最早历史丢掉 */
  const trimmed = trim(normalized, 48000, 1200)
  return withSelfPortrait(trimmed, selfPortrait)
}

function trim(messages, maxChars, reserve) {
  const budget = Math.max(0, maxChars - reserve)
  let total = 0
  const kept = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const len = contentCost(messages[i]?.content)
    if (kept.length > 0 && total + len > budget) break
    total += len
    kept.push(messages[i])
  }
  return kept.reverse()
}

/** 多段回复的相邻间隔（毫秒）—— 与桌面端 service.js 保持一致 */
const REPLY_SEGMENT_GAP_MS = 1200

/**
 * 图鉴解锁：用 shared/gallery.js 的执行器，**不再在本文件里重复实现管线**。
 *
 * 三层逻辑（条件 → 关键词预筛 → 模型判断）与「跑在浏览器还是主进程」
 * 无关，两端（PC / 手机）共用一份才不会漂移 ——
 * 早先这里是手机端独有的实现，PC 端完全缺失，就是因为没抽出来。
 */
const galleryRunner = createGalleryRunner({
  listUnlocked: (kind) => db.listUnlocked(kind),
  unlock: (kind, slug, line, title) => db.unlockItem(kind, slug, line, title),
  recentMessages: async () => {
    const rows = await db.recentMessages(await currentSessionId(), 10)
    return rows.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : (m.content ?? [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join(''),
    }))
  },
  completeOnce: ({ system, messages, maxTokens }) =>
    completeOnce({ settings: currentSettings, system, messages, maxTokens }),
  isReady: async () => (await configStatus(currentSettings)).ready,
  /*
   * 手机端没有桌面端那套亲密度历史，用「已聊条数」当进度代理。
   * 条件类故事（如 jk 初始就有）靠它判定。
   */
  points: () => affinityPoints,
  /*
   * 她此刻穿什么 —— 判定条件②「状态吻合」用。
   * 手机端的穿着同样是从 settings 推导：固定模式取 outfitSlug，
   * 自动模式按时间 + 已解锁池挑，与立绘显示的逻辑保持一致。
   */
  currentOutfit: () => {
    if (currentSettings?.outfitMode === 'fixed' && currentSettings.outfitSlug) {
      return currentSettings.outfitSlug
    }
    return outfitForTime(new Date(), currentUnlockedOutfits)
  },
})

/**
 * 本次检查用的设置与亲密度快照。
 *
 * runner 里几个回调是同步取值的（points / settings），
 * 所以每次检查前把当前值放进这两个变量，避免为了「传参」
 * 把 runner 的接口搞得处处是可选参数。
 */
let currentSettings = null
let affinityPoints = 0
/** 当前会话已解锁的服饰（judge 判条件②时要拿它算「自动模式此刻穿什么」） */
let currentUnlockedOutfits = []

/**
 * 检查解锁。
 * @returns {Promise<{kind:string, slug:string, line:string, title:string}|null>}
 */
export async function checkAnyUnlock({ settings, recentText, points = 0, now = new Date() }) {
  if (!settings.petStories) return null
  currentSettings = settings
  affinityPoints = points
  currentUnlockedOutfits = await db.listUnlockedOutfits()
  return galleryRunner.checkAny({ recentText, now })
}


/** 取当前会话 id（判断故事时用最近对话） */
async function currentSessionId() {
  const list = await db.listSessions()
  return list.length ? list[0].id : (await db.createSession()).id
}

/** 一次性（非流式）短生成 —— 用于故事判断这类「只要一个短回答」的场景 */
export async function completeOnce({ settings, system, messages, maxTokens = 100 }) {
  const st = await configStatus(settings)
  if (!st.ready) throw new Error(st.reason)
  const cfg = st.cfg
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: maxTokens,
      temperature: 0.8,
      stream: false,
      ...(cfg.routeOptions ?? {}),
    }),
  })
  if (!res.ok) throw new Error(describeHttp(res.status, await res.text().catch(() => '')))
  const j = await res.json()
  return j?.choices?.[0]?.message?.content ?? ''
}

/** HTTP 状态码 → 人话 */
function describeHttp(status, body) {
  let upstream = ''
  try {
    upstream = JSON.parse(body)?.error?.message ?? ''
  } catch {
    /* 非 JSON 就不用 */
  }
  const map = {
    401: 'API Key 无效或已过期',
    402: '账户余额不足',
    403: '没有权限访问该模型',
    404: '接口地址不对（检查 BaseURL）',
    422: '请求格式不被接受',
    429: '请求太频繁，稍后再试',
    500: '服务端出错，稍后再试',
    503: '服务暂时不可用，稍后再试',
  }
  const base = map[status] ?? `接口返回 ${status}`
  return upstream ? `${base}：${upstream}` : base
}

export { toDateKey, buildContent, validateImageDataUrl, checkImagesForModel, modelSupportsImages }
