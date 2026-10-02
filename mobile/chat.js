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
  toDateKey,
  isRestDay,
} from '../src/shared/moyu.js'
import {
  buildContent,
  validateImageDataUrl,
  checkImagesForModel,
  normalizeForRequest,
  modelSupportsImages,
  withSelfPortrait,
  buildRouteOptions,
  splitReplySegments,
  trimByChars,
} from '../src/shared/content.js'
/*
 * 易变块（时间块 + 关系块）与 system 组装**走桌面端同一份实现**。
 *
 * 早先这里是自己拼的（把时间块与关系块 filter 掉空值后用空行 join），
 * 因为手机端 import 不到
 * `src/main/chat.js`（那是主进程代码）。现在实现搬到了 `src/shared/prompt.js`，
 * 两端共用一条路径 —— 改一次两边同时生效，不会再出现「桌面改了、手机漏了」。
 */
import { composeSystemPrompt, volatileContextFor } from '../src/shared/prompt.js'
/* 手机端没有桌面那套联网节假日（纯静态 PWA），用内置常量表补上同一口径 */
import { builtinHolidayTable } from '../src/shared/holidays.js'
import { createGalleryRunner } from '../src/shared/gallery.js'
import {
  AFFINITY_GAIN,
  affinityLevel,
  affinityReadSettle,
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

/* ---------- 人设操作（内置 + 自定义） ---------- */

/*
 * 桌面端这一段住在 `src/main/service.js`（listPersonas / createPersona /
 * duplicatePersona / updatePersona / deletePersona），手机端此前**整段缺失**：
 * 设置页只有一个下拉框，存储层连 updatePersona 都没有 ——
 * 用户能看见「角色设定」却改不了它，只能在内置的三份之间切换。
 *
 * 这里按桌面端的语义补齐（含「删掉正在用的那份要回落默认」）。
 * 内置人设照桌面端的规矩**不可改**：想改就「复制」出一份副本再编辑，
 * 副本是自定义记录，随便改都不影响内置那份。
 */

/** 新建一份空白自定义人设（与桌面端一样，先建默认名，再由用户改） */
export async function createPersona({ label = '新人设', prompt = '' } = {}) {
  return db.createPersona({ label, prompt })
}

/**
 * 复制一份现有（内置或自定义）人设作为新的自定义人设。
 *
 * 这是改内置人设的**唯一途径** —— 直接改内置会让「Yuki 是谁」变成
 * 用户本地的一个变量，两端人设内容就再也对不上了。
 *
 * @returns {Promise<object|null>} 源不存在时返回 null（调用方要给出可见提示）
 */
export async function duplicatePersona(sourceId) {
  const all = await allPersonas()
  const src = all.find((p) => p.id === sourceId)
  if (!src) return null
  return db.createPersona({ label: `${src.label} 副本`.slice(0, 40), prompt: src.prompt })
}

/** 改一份自定义人设（空名称不覆盖原名等语义在 storage.updatePersona 里） */
export async function updatePersona(id, patch) {
  return db.updatePersona(id, patch)
}

/**
 * 删一份自定义人设。
 *
 * 删掉的正好是**正在用**的那份时回落到第一个内置人设 ——
 * 否则 `chatPersona` 会指向一条已软删的记录：下拉框空白、
 * 聊天标题顶着旧名字，而用户完全不知道发生了什么。
 * （桌面端还会清掉各会话的逐会话副本；手机端的人设是全局一份，无需那一步。）
 */
export async function deletePersona(id) {
  await db.deletePersona(id)
  const cur = await loadSettings()
  if (cur.chatPersona === id) await saveSettings({ chatPersona: CHAT_PERSONAS[0].id })
  return { ok: true }
}

/** 解析出当前请求要用的配置（含人设 prompt） */
export async function resolveConfig(settings, now = new Date()) {
  const personas = await allPersonas()
  const persona =
    personas.find((p) => p.id === settings.chatPersona) ?? CHAT_PERSONAS[0]

  /*
   * 关系块 —— 与桌面端**同一份实现**（shared/prompt.js 的 volatileContextFor，
   * 内部用 affinityView + affinityContextFor）。
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

  /*
   * 顺序：人设在前、易变块在后 —— 为了命中前缀缓存（见 composeSystemPrompt）。
   * 时间块每分钟变，放在末尾才不会把前面 1500+ 字的人设缓存击穿。
   * 关系块同理，且必须跟在人设之后（写进人设正文里会每轮击穿缓存）。
   *
   * `isRestDay` 必须带**节假日表**：只按周末算的话，调休补班的周末
   * （表里 isMakeup）和放假的工作日（表里 isHoliday）会和桌面端
   * 得出相反的结论 —— 她在手机上说你今天休息、在电脑上说你今天上班。
   * 手机端用不了桌面那套联网方案，所以读 shared/holidays.js 的内置表。
   */
  const volatile = volatileContextFor(settings, {
    now,
    isRestDay: isRestDay(settings, now, builtinHolidayTable(now.getFullYear())),
    affinityPoints: points,
    godMode: settings.godMode === true,
  })

  const baseUrl = String(settings.chatBaseUrl || '').trim().replace(/\/+$/, '')
  const apiKey = String(settings.chatApiKey || '').trim()

  return {
    baseUrl,
    apiKey,
    model: String(settings.chatModel || '').trim() || 'deepseek-chat',
    /* 路由偏好透传（仅 OpenRouter 认；与桌面端共用同一份实现） */
    routeOptions: buildRouteOptions(baseUrl, settings),
    /*
     * 钳制口径与桌面端 `resolveChatConfig` 保持一致。
     *
     * 特别是温度：这里原来写的是 `Number(...) || 1`，于是**用户把温度调到 0
     * （要最确定的回答）会被当成「没设置」而变成 1** —— 0 是合法值。
     * 默认值也必须是 DEFAULT_SETTINGS 的 1.3，不能各写一个数。
     */
    temperature: clampNumber(settings.chatTemperature, 0, 2, DEFAULT_SETTINGS.chatTemperature),
    maxHistory: clampNumber(settings.chatMaxHistory, 2, 400, 100),
    maxChars: clampNumber(settings.chatMaxChars, 2000, 400000, 48000),
    systemPrompt: composeSystemPrompt(persona.prompt, volatile),
    personaId: persona.id,
    needsApiKey: !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(baseUrl),
  }
}

/** 数值钳制（与桌面端 chat.js 的 clampNumber 同口径） */
function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
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
  /*
   * 先规范化（图片只留最后一条 user、老图降级成文字占位），再按预算裁剪 ——
   * 顺序不能反：裁剪是按成本算的，而规范化会改变每条消息的内容形态。
   *
   * **这里必须裁**：早先手机端只在「注入参考图」那条分支里裁过一次，
   * 而且预算写死成 48000/1200 —— 结果用户在设置里改的 chatMaxChars
   * 在手机端等于没生效（桌面端一直是裁的）。人设越长这个问题越明显。
   */
  const normalized = normalizeForRequest(history)
  const trimmed = trimByChars(normalized, cfg.maxChars, cfg.systemPrompt.length)
  /*
   * 参考图必须在裁剪**之后**注入，否则它会被当成最早的历史丢掉 ——
   * 而被丢掉就等于白花钱还没效果。
   * 只在模型支持视觉时注入：纯文本模型收到图会直接 400。
   */
  const withPortrait =
    selfPortrait && modelSupportsImages(cfg.model) ? withSelfPortrait(trimmed, selfPortrait) : trimmed
  const payload = [{ role: 'system', content: cfg.systemPrompt }, ...withPortrait]

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

  /*
   * 连续互动天数 —— 与桌面端 `addAffinity` 同一口径：
   * 昨天来过就 +1，断档（或首次）则从 1 重新开始。
   *
   * 手机端此前**从不维护这个字段**，而桌面端一直在写 ——
   * 同一个人在两端的记录长得不一样，是备份互通/同步时的隐形地雷。
   * 它不影响扣分规则，纯粹是「数据形状要一致」。
   */
  let streakDays = Number(cur.streakDays) || 0
  if (cur.lastDay !== today) {
    const y = new Date(now)
    y.setDate(y.getDate() - 1)
    streakDays = cur.lastDay === toDateKey(y) ? streakDays + 1 : 1
  }

  return db.setAffinity({
    ...cur,
    ...next,
    streakDays,
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

/*
 * `withPortraitIfAny` / `trim` 已删除：
 * 裁剪改用 shared 的 `trimByChars`（与桌面端同一份），参考图的注入顺序
 * 就地写在 sendMessage 里 —— 原来那份的毛病是「预算写死 48000/1200」
 * 且「不注入参考图就完全不裁」。
 */

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

/**
 * 一次性（非流式）短生成 —— 用于挂机台词、主动找话题、图鉴判定这类
 * 「只要一个短回答」的场景。
 *
 * ## 为什么这里也要注入易变块
 *
 * `system` 是**专用提示词**（CHATTER_SYSTEM_PROMPT / TOPIC_SYSTEM_PROMPT /
 * 判定提示词），不是人设 —— 但它同样需要「现在几点、处在哪一档」：
 *
 *   - 不带时间块：她会在清晨冒一句「吃午饭了吗」；
 *   - 不带关系块：一个刚认识的人也会说出「今天也想和你多待一会儿」，
 *     而「主动程度」正是档位差异最明显的地方（最低档几乎不主动找他）。
 *
 * 桌面端的 `completeOnce` 一直是这么做的（同一个 `volatileContextFor`），
 * 手机端此前只发了裸提示词，于是「同一份人设、两端两个性格」在**主动搭话**
 * 这条路径上尤其明显。现在两端走同一条路。
 *
 * @param {object} opts
 * @param {object} opts.settings
 * @param {string} opts.system   专用提示词（覆盖人设，用于约束输出格式）
 * @param {Array}  opts.messages 对话上下文
 * @param {number} [opts.maxTokens]
 * @param {object} [opts.runtime] now / isRestDay / affinityPoints / godMode；
 *   缺 affinityPoints / isRestDay 时由本函数自己取（见下），调用方不必逐个伺候
 */
export async function completeOnce({ settings, system, messages, maxTokens = 100, runtime = {} }) {
  const st = await configStatus(settings)
  if (!st.ready) throw new Error(st.reason)
  const cfg = st.cfg

  /*
   * 调用方没给运行时上下文就自己补：
   * 少一个字段就少一个提示块，而「静默少一块」是最难发现的那种不一致，
   * 所以这里宁可按「真实档位 + 真实节假日」补齐，也不默认成最低档。
   */
  const rt = { now: new Date(), ...runtime }
  if (rt.affinityPoints === undefined) rt.affinityPoints = (await affinityNow())?.points ?? 0
  if (rt.isRestDay === undefined) rt.isRestDay = isRestDay(settings, rt.now, builtinHolidayTable(rt.now.getFullYear()))
  if (rt.godMode === undefined) rt.godMode = settings.godMode === true

  const systemPrompt = composeSystemPrompt(system, volatileContextFor(settings, rt))

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      /* 预算口径与流式那条路一致：system 也占额度 */
      messages: [
        { role: 'system', content: systemPrompt },
        ...trimByChars(messages, cfg.maxChars, systemPrompt.length),
      ],
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
