/**
 * Tauri 运行时的 HTTP transport —— 把 fetch 语义包到 Rust http 代理上
 * （TAURI_MIGRATION.md §2.2 决策 5，service-host 启动时 installTauriTransport()）。
 *
 * 流式形态经迁移验证定型：Rust 按 '\n' 切完整行（字节安全），经
 * Channel 推帧 → 这里把行转回字节流。parseSSE 与 chat-test 因此零改动。
 *
 * 帧协议（http_proxy.rs StreamFrame，status 必须先于数据行——chat.js 在消费
 * body 之前就要读 res.ok/res.status，与 fetch 的语义对齐）：
 *   {event:'status', status} → 响应头就绪，fetch() 的 Promise 在此 resolve
 *   {event:'line', data}     → 一条完整行（含行尾 '\n'）
 *   {event:'end', ok}        → 流毕
 *
 * 取消语义与 fetch 对齐：signal.abort() 时本地立即以 AbortError 拒绝（不等
 * Rust 回包），同时 invoke http_abort 让读循环退出。id 由这里生成、invoke 前
 * 就挂好 abort 监听——没有「等 streamId 返回」的竞态窗口。
 *
 * 非流式调用（completeOnce/pingChat/holiday）也走同一条流式命令：响应整体
 * 聚合为 text()/json()，行切分对 JSON 无损，一条代码路径两种形态。
 */

/* 相对路径而非 @shared 别名：chat-test 在 Node 直跑本文件，没有 vite 别名 */
import { setHttpTransport } from '../../../shared/bridge/transport.js'

let counter = 0

function abortError() {
  /* 与 fetch 的 AbortError 同名同形，chat.js 按 err.name 归一错误类别 */
  return new DOMException('The operation was aborted.', 'AbortError')
}

function normalizeHeaders(raw) {
  const headers = {}
  if (raw) for (const [k, v] of Object.entries(raw)) headers[k] = String(v)
  return headers
}

export function installTauriTransport() {
  const { invoke, Channel } = window.__TAURI__.core
  const encoder = new TextEncoder()

  async function tauriFetch(url, init = {}) {
    const method = String(init.method ?? 'GET').toUpperCase()
    const headers = normalizeHeaders(init.headers)
    const body = typeof init.body === 'string' ? init.body : ''
    const signal = init.signal ?? null
    const id = `http-${Date.now().toString(36)}-${++counter}`

    if (signal?.aborted) throw abortError()

    /* 行队列喂 body 流；wholeParts 同步聚合喂 text()/json()（两条消费路径互不干扰，
       SSE 事件行很小，双份内存可忽略） */
    const lineQueue = []
    const wholeParts = []
    let lineNotify = null
    let wholeNotify = null
    let statusSettle = null
    let ended = false
    let streamErr = null

    const headersReady = new Promise((resolve, reject) => {
      statusSettle = { resolve, reject }
    })

    const wake = () => {
      if (lineNotify) { const n = lineNotify; lineNotify = null; n() }
      if (wholeNotify) { const n = wholeNotify; wholeNotify = null; n() }
    }
    const finish = (err) => {
      if (ended) return
      ended = true
      streamErr = err ?? null
      wake()
    }

    /* abort 接线：本地先抛，Rust 侧取消是幂等的收尾（http_abort 对已结束 id 返回 false） */
    const onAbort = () => {
      invoke('http_abort', { id }).catch(() => {})
      statusSettle.reject(abortError())
      finish(abortError())
    }
    signal?.addEventListener('abort', onAbort)

    const chan = new Channel()
    chan.onmessage = (frame) => {
      if (frame?.event === 'status') {
        statusSettle.resolve({ status: frame.status, ok: frame.status >= 200 && frame.status < 300 })
      } else if (frame?.event === 'line') {
        lineQueue.push(frame.data)
        wholeParts.push(frame.data)
        wake()
      } else if (frame?.event === 'end') {
        finish(null)
      }
    }

    invoke('http_fetch_stream', { id, url, method, headers, body, onFrame: chan })
      /* 正常结束由 end 帧收尾；这里只处理 Rust 侧错误（连接失败/读流失败） */
      .catch((e) => {
        const err = signal?.aborted ? abortError() : new Error(String(e?.message ?? e))
        statusSettle.reject(err)
        finish(err)
      })
      .finally(() => signal?.removeEventListener('abort', onAbort))

    /* 等一条新行；流毕返回 null（单消费循环，不会并发等待） */
    const takeLine = () =>
      new Promise((resolve) => {
        if (lineQueue.length) return resolve(lineQueue.shift())
        lineNotify = () => resolve(lineQueue.length ? lineQueue.shift() : null)
      })

    const bodyStream = new ReadableStream({
      start(controller) {
        ;(async () => {
          try {
            for (;;) {
              const line = await takeLine()
              if (line === null) {
                if (streamErr) throw streamErr
                break
              }
              controller.enqueue(encoder.encode(line))
            }
            controller.close()
          } catch (e) {
            try { controller.error(e) } catch { /* 已 errored 的 controller 再 error 会抛，忽略 */ }
          }
        })()
      },
    })

    const wholeText = (async () => {
      while (!ended) await new Promise((r) => { wholeNotify = r })
      if (streamErr) throw streamErr
      return wholeParts.join('')
    })()
    /* abort 时 text()/json() 未必被消费（流式路径只走 body），挂兜底防 unhandled rejection；
       一旦有真实消费者，rejection 照常送达 */
    wholeText.catch(() => {})

    const head = await headersReady
    return {
      ok: head.ok,
      status: head.status,
      body: bodyStream,
      text: () => wholeText,
      json: () => wholeText.then((t) => JSON.parse(t)),
    }
  }

  setHttpTransport(tauriFetch)
}
