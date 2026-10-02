/**
 * 对话后端客户端 —— OpenAI 兼容的 /chat/completions（SSE 流式）。
 *
 * 用 Node 内置 fetch，不引第三方 SDK；AbortController 支持中途停止。
 * 不依赖 electron，可被脚本直接调用做测试。
 */
import { CHAT_PERSONAS } from '../shared/moyu.js'
import { normalizeForRequest, modelSupportsImages, withSelfPortrait, buildRouteOptions, trimByChars } from '../shared/content.js'
import { composeSystemPrompt, volatileContextFor } from '../shared/prompt.js'
import { httpTransport } from '../shared/bridge/transport.js'

/*
 * `composeSystemPrompt` / `volatileContextFor` 的**实现已上移到
 * `src/shared/prompt.js`**：手机端（纯浏览器 PWA）import 不到 src/main，
 * 只能把同样的逻辑抄一遍，两端因此会漂移。
 *
 * 这里保留 re-export，只为不破坏既有调用方（scripts/、其它 main 模块）。
 */
export { composeSystemPrompt, volatileContextFor }

/*
 * `trimByChars` 同理，实现移到 `src/shared/content.js`（只依赖 contentCost，
 * 是纯函数）。手机端现在也用它，不再自己写一份「只在注入参考图时才裁」的版本。
 */
export { trimByChars }


/** 把设置解析成一次请求所需的参数。
 *
 * @param {object} settings
 * @param {Array}  [customPersonas]
 * @param {object} [runtime] 运行时上下文
 * @param {Date}   [runtime.now]        用于生成「当前时间」块；测试可注入固定时间
 * @param {boolean}[runtime.isRestDay]  今天是否休息日
 * @param {boolean}[runtime.withClock]  是否注入时间块（自检/测试可关掉）
 * @param {number} [runtime.affinityPoints] 当前亲密度点数（决定注入哪一档）
 * @param {boolean}[runtime.godMode]     上帝模式：档位读时覆盖成最高档
 * @param {boolean}[runtime.withAffinity] 是否注入关系块（自检/测试可关掉）
 */
export function resolveChatConfig(settings, customPersonas = [], runtime = {}) {
  const baseUrl = String(settings.chatBaseUrl || '').trim().replace(/\/+$/, '')
  const apiKey = String(settings.chatApiKey || '').trim()
  const model = String(settings.chatModel || '').trim() || 'deepseek-chat'
  /* 先在内置里找，再找自定义；都没有才回落到第一个内置人设 */
  const persona =
    CHAT_PERSONAS.find((p) => p.id === settings.chatPersona) ??
    (Array.isArray(customPersonas) ? customPersonas.find((p) => p.id === settings.chatPersona) : null) ??
    CHAT_PERSONAS[0]

  /*
   * 顺序：人设在前、易变块在后 —— 为了前缀缓存（见 composeSystemPrompt）。
   *
   * 代价与补偿：时间块不再占据开头，注意力相对弱一些。
   * 补偿办法是在时间块自己内部重申「这是真实的此刻」，
   * 且明确要求「被问到就照上面直接回答」——实测这样仍然准确。
   *
   * 关系块同理：它和人设里的档位表是一对，必须**在人设之后**注入
   * （每轮都可能变，混进人设会击穿缓存）。
   */
  const volatile = volatileContextFor(settings, runtime)

  return {
    baseUrl,
    apiKey,
    model,
    /*
     * 路由偏好透传给请求体。只有 OpenRouter 认这个字段，
     * 别的服务商会忽略未知字段（OpenAI 兼容接口的惯例）。
     */
    routeOptions: buildRouteOptions(baseUrl, settings),
    temperature: clampNumber(settings.chatTemperature, 0, 2, 1.3),
    maxHistory: clampNumber(settings.chatMaxHistory, 2, 400, 100),
    maxChars: clampNumber(settings.chatMaxChars, 2000, 400000, 48000),
    systemPrompt: composeSystemPrompt(persona.prompt, volatile),
    personaId: persona.id,
  }
}

/**
 * 含图消息（content 为块数组）在「字符预算」口径下的成本。
 *
 * 图片本身是几百 KB 的 base64，按原始长度算会瞬间吃满预算；
 * 但它的 token 成本又实打实存在（官方：每张最多 1024 token），
 * 所以既不能按真实长度算，也不能当零成本 —— 用一个固定占位。
 */
/*
 * 按字符预算裁剪历史的 `trimByChars` 已移到 `src/shared/content.js`
 * （见文件顶部的 re-export 说明）——手机端现在用的是同一份实现。
 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 按 baseUrl 判断是否需要 API Key（本地 Ollama 不需要） */
export function needsApiKey(settings) {
  return !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(String(settings.chatBaseUrl || ''))
}

export function validateConfig(settings, customPersonas = [], runtime = {}) {
  const cfg = resolveChatConfig(settings, customPersonas, runtime)
  if (!cfg.baseUrl) return { ok: false, reason: '还没有配置对话接口地址' }
  if (!/^https?:\/\//i.test(cfg.baseUrl)) return { ok: false, reason: '接口地址必须以 http:// 或 https:// 开头' }
  if (needsApiKey(settings) && !cfg.apiKey) {
    return { ok: false, reason: '还没有填写 API Key，请到「设置 → AI 对话」里填' }
  }
  return { ok: true, cfg }
}

/**
 * 发起一次流式对话。
 *
 * @param {object} opts
 * @param {object} opts.settings  应用设置
 * @param {Array}  opts.messages  上下文（[{role, content}]，时间正序）
 * @param {(delta:string, full:string)=>void} opts.onDelta 增量回调
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.runtime] 运行时上下文（now / isRestDay / withClock）
 * @param {string} [opts.selfPortrait] 她自己的参考图（data URL），用于「认识自己」
 * @returns {Promise<{content:string, model:string}>}
 */
export async function streamChat({
  settings,
  messages,
  onDelta,
  signal,
  customPersonas = [],
  runtime = {},
  selfPortrait = '',
}) {
  const check = validateConfig(settings, customPersonas, runtime)
  if (!check.ok) throw new ChatError(check.reason, 'config')
  const cfg = check.cfg

  /*
   * 先规范化（图片只留最后一条 user、老图降级成文字占位），再按预算裁剪。
   * 顺序不能反：裁剪是按成本算的，而规范化会改变每条消息的内容形态。
   */
  const normalized = normalizeForRequest(messages)

  /* 二次裁剪：调用方可能只按条数截断，这里再按字符预算兜一层。
     把 system 提示词计入预留，保证「人设 + 历史」总量不超过预算。 */
  const trimmed = trimByChars(normalized, cfg.maxChars, cfg.systemPrompt.length)

  /*
   * 参考图必须在裁剪**之后**注入，否则它会被当成最早的历史丢掉 ——
   * 而被丢掉就等于白花钱还没效果。
   * 只在模型支持视觉时注入：纯文本模型收到图会直接 400。
   */
  const withPortrait =
    selfPortrait && modelSupportsImages(cfg.model)
      ? withSelfPortrait(trimmed, selfPortrait)
      : trimmed

  const body = {
    model: cfg.model,
    messages: [{ role: 'system', content: cfg.systemPrompt }, ...withPortrait],
    stream: true,
    temperature: cfg.temperature,
    /* 路由偏好（仅 OpenRouter 用；别的服务商忽略未知字段） */
    ...(cfg.routeOptions ?? {}),
  }

  const headers = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`

  let res
  try {
    res = await httpTransport()(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw new ChatError('已取消', 'aborted')
    throw new ChatError(`连不上对话接口：${err?.message ?? err}`, 'network')
  }

  if (!res.ok) {
    const text = await safeText(res)
    throw new ChatError(describeHttpError(res.status, text), 'http', res.status)
  }
  if (!res.body) throw new ChatError('接口没有返回流式内容', 'empty')

  let full = ''
  let model = cfg.model

  try {
    for await (const event of parseSSE(res.body)) {
      if (event === '[DONE]') break
      let json
      try {
        json = JSON.parse(event)
      } catch {
        continue
      }
      if (json?.model) model = json.model
      const delta = json?.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta.length > 0) {
        full += delta
        onDelta?.(delta, full)
      }
    }
  } catch (err) {
    /* 读取过程中被 abort，fetch 已经返回了，这里要把 AbortError 归一成 ChatError */
    if (err?.name === 'AbortError') throw new ChatError('已取消', 'aborted')
    throw new ChatError(`读取流式响应失败：${err?.message ?? err}`, 'stream')
  }

  if (!full) throw new ChatError('接口返回了空回复', 'empty')
  return { content: full, model }
}

/**
 * 一次性（非流式）短生成。
 *
 * 用于「跟最近对话相关」的挂机台词：只要一句话，走流式没有意义，
 * 而且流式会把 token 一点点吐出来、延迟更高。
 *
 * @param {object} opts
 * @param {object} opts.settings
 * @param {string} opts.system   系统提示词（覆盖人设，用于约束输出格式）
 * @param {Array}  opts.messages 对话上下文
 * @param {number} [opts.maxTokens]
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.runtime] 运行时上下文（now / isRestDay / withClock /
 *                                affinityPoints / godMode / withAffinity）
 * @returns {Promise<string>} 生成的文本（已 trim）
 */
export async function completeOnce({ settings, system, messages, maxTokens = 64, signal, runtime = {} }) {
  const check = validateConfig(settings, undefined, runtime)
  if (!check.ok) throw new ChatError(check.reason, 'config')
  const cfg = check.cfg

  const headers = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`

  /*
   * 挂机台词同样要带当前时间，否则她会在清晨冒一句「吃午饭了吗」。
   * 这里 system 是调用方给的专用提示词（CHATTER_SYSTEM_PROMPT）。
   *
   * 顺序同样是「固定提示词在前、易变块在后」，理由见 composeSystemPrompt ——
   * 挂机台词每次都是新的短请求，命中前缀缓存对它同样有效。
   *
   * 关系块也一起注入：挂机台词是她**主动开口**，而「主动程度」正是
   * 档位差异最明显的地方（最低档几乎不主动找他）。不给她档位，
   * 一个刚认识的人也会冒出「今天也想和你多待一会儿」。
   * 走的是同一个 volatileContextFor，不是另写一份。
   */
  const systemPrompt = composeSystemPrompt(system, volatileContextFor(settings, runtime))

  const payload = [{ role: 'system', content: systemPrompt }, ...trimByChars(messages, cfg.maxChars, systemPrompt.length)]

  const res = await httpTransport()(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      /* 路由偏好（仅 OpenRouter 用；别的服务商忽略未知字段） */
      ...(cfg.routeOptions ?? {}),
      messages: payload,
      max_tokens: maxTokens,
      temperature: cfg.temperature,
      stream: false,
    }),
    signal,
  })

  if (!res.ok) {
    const text = await safeText(res)
    throw new ChatError(describeHttpError(res.status, text), 'http', res.status)
  }
  const json = await res.json().catch(() => null)
  const reply = json?.choices?.[0]?.message?.content
  if (typeof reply !== 'string' || !reply.trim()) throw new ChatError('接口返回了空回复', 'empty')
  return reply.trim()
}

/** 一次性（非流式）调用，用于「测试连接」 */
export async function pingChat({ settings, signal }) {
  const check = validateConfig(settings)
  if (!check.ok) return { ok: false, reason: check.reason }
  const cfg = check.cfg
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  try {
    const res = await httpTransport()(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
      /* 路由偏好（仅 OpenRouter 用；别的服务商忽略未知字段） */
      ...(cfg.routeOptions ?? {}),
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
        stream: false,
      }),
      signal,
    })
    if (!res.ok) {
      const text = await safeText(res)
      return { ok: false, reason: describeHttpError(res.status, text), status: res.status }
    }
    const json = await res.json().catch(() => null)
    const reply = json?.choices?.[0]?.message?.content
    return { ok: true, model: json?.model ?? cfg.model, reply: typeof reply === 'string' ? reply.slice(0, 40) : '' }
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, reason: '已取消' }
    return { ok: false, reason: `连不上：${err?.message ?? err}` }
  }
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return ''
  }
}

/** 把 HTTP 错误翻译成用户能看懂的中文 */
function describeHttpError(status, text) {
  const detail = extractApiMessage(text)
  switch (status) {
    case 401:
      return `API Key 无效或已过期${detail ? `（${detail}）` : ''}`
    case 402:
      return `账户余额不足，请到 DeepSeek 充值${detail ? `（${detail}）` : ''}`
    case 403:
      return `没有访问权限${detail ? `（${detail}）` : ''}`
    case 404:
      return `接口地址不对，检查 BaseURL 是否漏了 /v1 或路径写错${detail ? `（${detail}）` : ''}`
    case 429:
      return `请求太频繁，稍后再试${detail ? `（${detail}）` : ''}`
    default:
      if (status >= 500) return `服务端错误（${status}），稍后再试`
      return `请求失败（${status}）${detail ? `：${detail}` : ''}`
  }
}

function extractApiMessage(text) {
  if (!text) return ''
  try {
    const json = JSON.parse(text)
    const m = json?.error?.message ?? json?.message
    return typeof m === 'string' ? m.slice(0, 120) : ''
  } catch {
    return ''
  }
}

/** 解析 SSE 流，逐条 yield data 内容（跳过注释与空行） */
async function* parseSSE(stream) {
  const decoder = new TextDecoder()
  let buffer = ''

  const reader = stream.getReader?.() ?? null
  if (!reader) {
    /* 兼容没有 getReader 的实现：退化为整体读取 */
    const text = await new Response(stream).text()
    for (const line of text.split('\n')) {
      const data = sseData(line)
      if (data !== null) yield data
    }
    return
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      const data = sseData(line)
      if (data !== null) yield data
    }
  }
  if (buffer.trim()) {
    const data = sseData(buffer)
    if (data !== null) yield data
  }
}

function sseData(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':')) return null
  if (!trimmed.startsWith('data:')) return null
  return trimmed.slice(5).trim()
}

export class ChatError extends Error {
  constructor(message, kind = 'unknown', status = null) {
    super(message)
    this.name = 'ChatError'
    this.kind = kind
    this.status = status
  }
}

/*
 * 内容块工具的实现已移到 `src/shared/content.js`（避免 shared ↔ main 循环依赖），
 * 这里原样转出，保持既有引用路径可用。
 */
export {
  SUPPORTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  dataUrlMime,
  dataUrlBytes,
  validateImageDataUrl,
  textOfContent,
  imagesOfContent,
  buildContent,
  IMAGE_CHAR_COST,
} from '../shared/content.js'
