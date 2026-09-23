/**
 * 对话内容块工具 —— 纯文本与图文混排的统一处理。
 *
 * OpenAI 兼容格式里 `content` 有两种形态：
 *   - 字符串：           "你好"
 *   - 块数组：           [{ type:'text', text:'...' },
 *                        { type:'image_url', image_url:{ url:'data:...' } }]
 *
 * 放在 shared 而不是 main/chat.js，是因为两侧都要用：
 *   - main/chat.js          组装请求
 *   - shared/interactions.js 生成挂机台词时提取文字
 * 若放在 main 里，shared 反向 import main 会形成循环依赖。
 *
 * 服务端约束（DeepSeek 官方 vision 文档）：
 *   - 图片只能出现在 **user** 消息，放 system/assistant 返回 400
 *   - 支持 JPEG / PNG / GIF / WebP，按**文件内容**判定而非扩展名
 *   - 单图 ≤ 32 MiB，整个请求体 ≤ 48 MiB，每张最多约 1024 token
 */

/** 支持的 MIME 类型 */
export const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

/** 单张图片上限（与官方一致） */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024

/** 从 data URL 里读 MIME 类型 */
export function dataUrlMime(dataUrl) {
  const m = /^data:([^;,]+)[;,]/.exec(String(dataUrl ?? ''))
  return m ? m[1].toLowerCase() : ''
}

/** 估算 base64 payload 的原始字节数 */
export function dataUrlBytes(dataUrl) {
  const s = String(dataUrl ?? '')
  const i = s.indexOf(',')
  if (i < 0) return 0
  return Math.floor((s.length - i - 1) * 0.75)
}

/**
 * 校验一张待发送的图片。
 * @returns {string|null} null 表示可用，否则返回中文原因（可直接展示给用户）
 */
export function validateImageDataUrl(dataUrl) {
  const s = String(dataUrl ?? '')
  if (!s.startsWith('data:')) return '图片格式不是 data URL'
  const mime = dataUrlMime(s)
  if (!SUPPORTED_IMAGE_TYPES.includes(mime)) {
    /* 官方按文件内容判定格式，所以这里也不看扩展名，只认 MIME */
    return `不支持 ${mime || '未知'} 格式，只支持 JPEG / PNG / GIF / WebP`
  }
  if (dataUrlBytes(s) > MAX_IMAGE_BYTES) {
    return `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB 上限`
  }
  return null
}

/** 取内容里的纯文本（兼容字符串与块数组） */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('')
}

/** 取内容里的图片（返回 data URL 数组） */
export function imagesOfContent(content) {
  if (!Array.isArray(content)) return []
  return content
    .filter((b) => b?.type === 'image_url')
    .map((b) => String(b.image_url?.url ?? ''))
    .filter(Boolean)
}

/**
 * 组装 content。
 *
 * 没有图片时**返回纯字符串**而不是单元素数组 ——
 * 让绝大多数纯文本请求保持原样，不给所有调用方（含第三方兼容接口）引入新格式。
 */
export function buildContent(text, images = []) {
  const t = String(text ?? '')
  const imgs = (Array.isArray(images) ? images : []).filter(Boolean)
  if (!imgs.length) return t
  const blocks = []
  /* 文本放最前：实测「先读指令后看图」比反过来稳 */
  if (t) blocks.push({ type: 'text', text: t })
  for (const url of imgs) blocks.push({ type: 'image_url', image_url: { url } })
  return blocks
}

/**
 * 把历史消息规范化成可发送的形态。
 *
 * 关键：**图片只保留在最后一条 user 消息里**。两个原因：
 *   1. 官方硬约束 —— 图片出现在非 user 消息里会 400；
 *   2. 历史图片会让上下文迅速膨胀（每张最多 1024 token），聊几轮就吃光预算。
 * 所以老消息里的图统一降级成文字占位，让模型知道「这里本来有图」。
 */
export function normalizeForRequest(messages) {
  const list = Array.isArray(messages) ? messages : []
  let lastUserIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') {
      lastUserIdx = i
      break
    }
  }

  return list.map((m, i) => {
    const role = m?.role
    const text = textOfContent(m?.content)
    const images = imagesOfContent(m?.content)

    if (role !== 'user') return { role, content: text }
    if (i !== lastUserIdx) {
      if (!images.length) return { role, content: text }
      const note = `[图片×${images.length}]`
      return { role, content: text ? `${text}\n${note}` : note }
    }
    return { role, content: buildContent(text, images) }
  })
}

/**
 * 含图消息在「字符预算」口径下的成本。
 *
 * 图片是几百 KB 的 base64，按原始长度算会瞬间吃满预算；但 token 成本实打实存在，
 * 所以既不能按真实长度算，也不能当零成本 —— 用一个固定占位。
 */
export const IMAGE_CHAR_COST = 2000

/** 一条消息在字符预算口径下的成本 */
export function contentCost(content) {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const b of content) {
    if (b?.type === 'text') n += String(b.text ?? '').length
    else if (b?.type === 'image_url') n += IMAGE_CHAR_COST
  }
  return n
}

/**
 * 让她「认识自己」的参考图注入。
 *
 * 为什么需要：人设里写了外貌文字，但模型对自己长相的理解仍可能很飘，
 * 尤其是用户直接发她的立绘过来时——它会当成陌生人去描述。
 * 给一张参考图让她用视觉能力「亲眼看一次自己」，认得最准。
 *
 * 约束（官方 vision 文档）：图片只能出现在 **user** 消息里，
 * 且为了省 token 只在对话开头注入一次、不随历史累积。
 */

/** 参考图用哪张（正面站姿最清晰） */
export const SELF_PORTRAIT_SLUG = 'pose4'

/** 注入时给模型的一句说明，明确「这张图里的人就是你」 */
export const SELF_PORTRAIT_NOTE =
  '（上面这张图里画的**就是你**——你的立绘。记住自己的样子：棕色长卷发、齐刘海、红棕色眼睛。' +
  '之后我发你的图里如果是这个样子，那就是你自己，要认出来。）'

/**
 * 在消息序列开头注入一张「自己的参考图」。
 *
 * 位置放在**最早一条 user 消息之前**，用一对 user/assistant 把它包起来：
 *   user:      [image: 你的立绘] + 说明
 *   assistant: 嗯，这是我
 * 之所以配一句 assistant 回执，是让这段看起来像自然的对话历史，
 * 而不是一条孤零零的指令——后者容易被模型当成待处理任务。
 *
 * @param {Array} messages 已规范化的消息（时间正序）
 * @param {string} dataUrl 立绘的 data URL
 * @returns {Array} 注入后的新数组（不改原数组）
 */
export function withSelfPortrait(messages, dataUrl) {
  const list = Array.isArray(messages) ? messages : []
  if (!dataUrl) return list

  return [
    { role: 'user', content: buildContent(SELF_PORTRAIT_NOTE, [dataUrl]) },
    { role: 'assistant', content: '嗯，记住了，这是我。' },
    ...list,
  ]
}

/**
 * 已知不具备视觉能力的模型（发图会 400）。
 *
 * 判断「能用视觉」很难（各家命名不一），但判断「肯定不能用」很简单：
 * DeepSeek 只有 flash 系列带视觉，chat/reasoner 都是纯文本。
 * 所以做成「已知不支持的黑名单」，其余一律放行 —— 自定义服务商
 * 很可能提供视觉模型，白名单会把它们误伤。
 */
const NON_VISION_MODELS = [/^deepseek-chat$/i, /^deepseek-reasoner$/i, /^deepseek-coder/i]

/** 这个模型能不能收图 */
export function modelSupportsImages(model) {
  const m = String(model ?? '').trim()
  if (!m) return true
  return !NON_VISION_MODELS.some((re) => re.test(m))
}

/**
 * 发图前的模型检查。
 * @returns {string|null} null 表示可以发，否则返回给用户看的说明
 */
export function checkImagesForModel(model, images) {
  if (!Array.isArray(images) || !images.length) return null
  if (modelSupportsImages(model)) return null
  return `${model} 不支持图片，请在「设置 → AI 对话」把模型换成 deepseek-flash`
}

/** 落库形态：含图消息序列化成 `{"blocks":[...]}`，纯文本原样保留 */
export function serializeContent(content) {
  return Array.isArray(content) ? JSON.stringify({ blocks: content }) : String(content ?? '')
}

/**
 * 还原落库内容。
 *
 * 用前缀快速排除，避免每条纯文本消息都走一次 JSON.parse。
 * 解析失败当纯文本处理 —— 不让一条坏数据把整个会话读挂。
 */
export function parseStoredContent(raw) {
  const s = String(raw ?? '')
  if (!s.startsWith('{"blocks"')) return s
  try {
    const parsed = JSON.parse(s)
    return Array.isArray(parsed?.blocks) ? parsed.blocks : s
  } catch {
    return s
  }
}


/**
 * 构造路由参数 —— 目前只为 OpenRouter 生成，否则返回 null。
 *
 * ## 为什么按 baseUrl 判断而不是按 chatProvider
 *
 * 用户可能选了「自定义」却填的是 OpenRouter 地址（反过来也可能）。
 * 以**实际请求地址**为准才可靠 —— provider 是个 UI 概念，地址才是事实。
 *
 * ## 这不是用来绕审核的
 *
 * 两个参数都是正常的路由控制：
 *   - `zdr`  只用「零数据保留」的端点（隐私，不是免审查）
 *   - `sort` 挑 provider 的策略（价格/吞吐/延迟）
 * 「有没有内容审核」由上游模型和 provider 决定，路由器管不了这个。
 *
 * 两端（PC 主进程 / 手机浏览器）共用这一份，避免规则漂移。
 *
 * @param {string} baseUrl 实际接口地址
 * @param {{chatZdr?:boolean, chatRouteSort?:string}} settings
 * @returns {object|null} 要展开进请求体的字段
 */
export function buildRouteOptions(baseUrl = '', settings = {}) {
  const isOpenRouter = /openrouter\.ai/i.test(String(baseUrl))
  if (!isOpenRouter) return null

  const provider = {}
  if (settings.chatZdr) provider.zdr = true
  const sort = String(settings.chatRouteSort || '').trim()
  if (sort === 'price' || sort === 'throughput' || sort === 'latency') provider.sort = sort

  /* 一个都没设就不塞空对象，保持请求体干净 */
  return Object.keys(provider).length ? { provider } : null
}
