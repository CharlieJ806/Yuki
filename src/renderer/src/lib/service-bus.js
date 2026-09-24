/**
 * serviceBus —— 业务总线的宿主端与客户端（TAURI_MIGRATION.md §2.2 决策 3）。
 *
 * 业务层（service）宿主在 pet 窗。panel / chat 窗的业务调用经本总线
 * 转发到 pet 窗执行：`bus:req`（请求）→ `bus:res`（响应），requestId 关联。
 * 流式对话不走总线应答 —— chunk 一直走 `desk:event` 广播，`chat:send`
 * 的最终结果以 `chat-done` 事件为准，所以这类通道**不设调用超时**。
 *
 * 就绪门控：panel / chat 由 Rust 按需创建，大概率晚于宿主启动，一次性
 * 广播收不到。客户端就绪状态未知时先发 `bus:ping`，宿主立即应答；
 * ping 超时也放行（宿主真不在时，正式调用自身会以更明确的错误超时）。
 *
 * 短操作经宿主端**串行队列**执行：service 的读-改-写序列（如图鉴解锁、
 * 亲密度）依赖 Electron 时代同步 IPC 的原子性，串行化保持同一语义；
 * 长操作（流式对话、自检、台词生成）绕开队列 —— 它们本来就会长时间
 * 占用（await 网络段让出），队列挡不住，绕开才能不阻塞别的窗口。
 */

export const BUS_HOST_LABEL = 'pet'
const REQ = 'bus:req'
const RES = 'bus:res'
const READY = 'bus:ready'
const PING = 'bus:ping'
const CALL_TIMEOUT_MS = 15_000
/** 就绪探测超时：超时后照样放行正式调用 */
const READY_PROBE_TIMEOUT_MS = 20_000

/** 长操作通道：绕开宿主串行队列，且客户端不设调用超时 */
const LONG_RUNNING = new Set(['chat:send', 'chat:diagnose', 'chat:test', 'chat:chatterLine'])

function tauri() {
  return window.__TAURI__
}

/* ---------- 宿主端（pet 窗） ---------- */

/**
 * @param {Record<string, (...args) => Promise<any>>} handlers 业务通道表
 *   （createIpcHandlers 的返回值）
 */
export function installServiceBusHost(handlers) {
  const { listen, emitTo } = tauri().event

  let tail = Promise.resolve()
  const enqueue = (fn) => {
    const p = tail.then(fn)
    /* 队尾吞错：单次失败不能堵死后面的请求 */
    tail = p.catch(() => {})
    return p
  }

  async function handle(req) {
    const { id, channel, args, from } = req ?? {}
    const reply = (payload) => emitTo(from, RES, payload).catch(() => {})
    const fn = handlers[channel]
    if (typeof fn !== 'function') {
      await reply({ id, ok: false, error: `未知业务通道: ${channel}` })
      return
    }
    try {
      const run = () => fn(...(args ?? []))
      const result = await (LONG_RUNNING.has(channel) ? run() : enqueue(run))
      await reply({ id, ok: true, result })
    } catch (err) {
      await reply({ id, ok: false, error: err?.message ?? String(err) })
    }
  }

  /* 就绪探测应答：客户端 ready 未知时 ping 一次，这里立即回 */
  const pong = listen(PING, (e) => {
    const { id, from } = e.payload ?? {}
    if (id && from) emitTo(from, RES, { id, ok: true, result: null }).catch(() => {})
  })

  /* 业务请求分发 */
  const req = listen(REQ, (e) => handle(e.payload))

  return Promise.all([req, pong])
}

/* ---------- 客户端（panel / chat 窗，pet 窗亦可直调不经此） ---------- */

/**
 * @param {string} selfLabel 本窗 label（回包投递地址）
 */
export function createBusClient(selfLabel) {
  const { listen, emitTo } = tauri().event
  const pending = new Map()
  let readySeen = false
  let readyProbe = null
  let readyWaiters = []

  const setReady = () => {
    readySeen = true
    readyWaiters.splice(0).forEach((w) => w())
  }

  listen(READY, setReady).catch(() => {})
  listen(RES, (e) => {
    const { id, ok, result, error } = e.payload ?? {}
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (ok) p.resolve(result)
    else p.reject(new Error(error || '总线调用失败'))
  }).catch(() => {})

  /* 就绪探测：发 ping 等应答。多个调用共享一次探测。 */
  function ensureHost() {
    if (readySeen) return Promise.resolve()
    if (readyProbe) return readyProbe
    readyProbe = (async () => {
      try {
        await new Promise((resolve) => {
          const id = globalThis.crypto.randomUUID()
          let done = false
          const finish = () => {
            if (done) return
            done = true
            pending.delete(id)
            resolve()
          }
          pending.set(id, {
            resolve: () => {
              setReady()
              finish()
            },
            reject: finish,
          })
          setTimeout(finish, READY_PROBE_TIMEOUT_MS)
          emitTo(BUS_HOST_LABEL, PING, { id, from: selfLabel }).catch(finish)
        })
      } finally {
        readyProbe = null
      }
    })()
    return readyProbe
  }

  /**
   * 调用宿主业务通道。
   * @returns {Promise<any>} 宿主处理器返回值
   */
  async function call(channel, ...args) {
    await ensureHost()
    const id = globalThis.crypto.randomUUID()
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      /* 流式对话等长操作不设超时：结果以 chat-done 事件为准（或 chat:abort 主动取消） */
      if (!LONG_RUNNING.has(channel)) {
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`总线调用超时: ${channel}`))
        }, CALL_TIMEOUT_MS)
      }
    })
    await emitTo(BUS_HOST_LABEL, REQ, { id, channel, args, from: selfLabel })
    return promise
  }

  return { call }
}
