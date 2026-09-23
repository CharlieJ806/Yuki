/**
 * 生图客户端 —— 用 Pollinations（免 Key、免注册）。
 *
 * 为什么不用 DeepSeek：实测 api.deepseek.com 的 /images/generations 返回 404，
 * 它全线只有文本模型，没有生图能力。
 *
 * 协议：GET https://image.pollinations.ai/prompt/{urlencode(prompt)}?width=&height=&nologo=true
 * 注意必须跟随重定向（服务端会 302 到实际图片地址），否则拿到的是空 body。
 */
import { createHash } from 'node:crypto'

export const DEFAULT_IMAGE_BASE = 'https://image.pollinations.ai/prompt'

export const IMAGE_SIZES = [
  { id: 'square', label: '方形 1:1', width: 768, height: 768 },
  { id: 'landscape', label: '横图 4:3', width: 1024, height: 768 },
  { id: 'portrait', label: '竖图 3:4', width: 768, height: 1024 },
]

export function resolveSize(sizeId) {
  return IMAGE_SIZES.find((s) => s.id === sizeId) ?? IMAGE_SIZES[0]
}

/** 由 prompt + 尺寸推导稳定文件名，便于同图复用与缓存 */
export function imageCacheKey(prompt, size) {
  const h = createHash('sha1')
    .update(`${prompt}|${size.width}x${size.height}`)
    .digest('hex')
    .slice(0, 16)
  return `img-${h}.jpg`
}

export function buildImageUrl({ prompt, width, height, baseUrl, seed }) {
  const base = (baseUrl || DEFAULT_IMAGE_BASE).replace(/\/+$/, '')
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    nologo: 'true',
    /* 固定 seed 让同一 prompt 结果可复现，便于测试与「重画」时换 seed */
    seed: String(seed ?? 0),
  })
  return `${base}/${encodeURIComponent(prompt)}?${params.toString()}`
}

/**
 * 下载图片返回 Buffer，对 5xx / 网络抖动自动重试。
 *
 * Pollinations 是免费服务，实测偶发 500（同样的 URL 重试就好），
 * 所以必须重试，否则用户会看到莫名其妙的失败。
 *
 * @param {object} opts
 * @param {string} opts.prompt  画面描述（建议英文，效果更稳）
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 */
export async function generateImage({
  prompt,
  width = 768,
  height = 768,
  baseUrl,
  seed,
  signal,
  timeoutMs = 90_000,
  retries = 2,
}) {
  const clean = String(prompt ?? '').trim()
  if (!clean) throw new ImageError('画面描述为空', 'empty')
  if (clean.length > 900) throw new ImageError('画面描述太长（最多 900 字）', 'too-long')

  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new ImageError('已取消', 'aborted')
    try {
      /* 重试时换 seed，避免大概率撞上同一张缓存里的坏结果 */
      const useSeed = seed == null ? undefined : Number(seed) + attempt
      return await fetchImageOnce({ prompt: clean, width, height, baseUrl, seed: useSeed, signal, timeoutMs })
    } catch (err) {
      lastErr = err
      /* 只重试服务端错误与网络问题；参数错、取消、超时不重试 */
      const retryable = err instanceof ImageError && (err.kind === 'http' || err.kind === 'network') && (err.status == null || err.status >= 500)
      if (!retryable || attempt === retries) throw err
      /* 退避：免费服务偶发抽风，稍等一下再试 */
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  throw lastErr ?? new ImageError('生图失败', 'unknown')
}

async function fetchImageOnce({ prompt, width, height, baseUrl, seed, signal, timeoutMs }) {
  const url = buildImageUrl({ prompt, width, height, baseUrl, seed })

  /* 自己管超时：fetch 的 signal 被外部 abort 时要能区分开 */
  const timer = new AbortController()
  const onAbort = () => timer.abort()
  const t = setTimeout(() => timer.abort(), timeoutMs)
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    /* redirect: 'follow' 是必须的 —— 不加会拿到空 body */
    const res = await fetch(url, { redirect: 'follow', signal: timer.signal })
    if (!res.ok) {
      throw new ImageError(`生图服务返回 ${res.status}`, 'http', res.status)
    }
    const type = res.headers.get('content-type') ?? ''
    const buf = Buffer.from(await res.arrayBuffer())

    if (buf.length < 1024) {
      /* 太小的响应基本是错误页；正常 JPEG 至少几十 KB */
      throw new ImageError('生图服务返回的内容不是有效图片', 'invalid')
    }
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8
    const isPng = buf[0] === 0x89 && buf[1] === 0x50
    if (!isJpeg && !isPng) {
      throw new ImageError(`生图服务返回了非图片内容（${type || '未知类型'}）`, 'invalid')
    }

    return {
      buffer: buf,
      mime: isPng ? 'image/png' : 'image/jpeg',
      url,
      bytes: buf.length,
    }
  } catch (err) {
    if (err instanceof ImageError) throw err
    if (err?.name === 'AbortError') {
      throw signal?.aborted
        ? new ImageError('已取消', 'aborted')
        : new ImageError('生图超时，稍后再试', 'timeout')
    }
    throw new ImageError(`连不上生图服务：${err?.message ?? err}`, 'network')
  } finally {
    clearTimeout(t)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 从模型回复里提取画图指令。
 * 约定：模型输出 [DRAW]描述[/DRAW]，可能夹杂其他文字，所以用正则抽取。
 * @returns {{ prompt: string, cleaned: string } | null}
 */
export function extractDrawCommand(text) {
  const src = String(text ?? '')
  const m = /\[DRAW\]([\s\S]*?)\[\/DRAW\]/i.exec(src)
  if (!m) return null
  const prompt = m[1].trim()
  if (!prompt) return null
  /* 把标记从可见文本里抹掉，避免气泡里出现 [DRAW] 这种噪声 */
  const cleaned = src.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim()
  return { prompt, cleaned }
}

export class ImageError extends Error {
  constructor(message, kind = 'unknown', status = null) {
    super(message)
    this.name = 'ImageError'
    this.kind = kind
    this.status = status
  }
}
