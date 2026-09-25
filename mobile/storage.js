/**
 * 手机端存储层 —— IndexedDB。
 *
 * 为什么不用桌面端的 node:sqlite：浏览器里没有 Node 运行时，
 * 而且手机浏览器需要的是「可持久化 + 大容量 + 支持二进制」的存储 ——
 * localStorage 只有 5MB 且只能存字符串，装不下聊天里的图片。
 *
 * 表结构刻意和桌面端保持一致（sessions / messages / settings / personas / meta），
 * 这样两端共用同一套上层逻辑，将来想同步也只需序列化这几张表。
 */
import { GALLERY_KEYS as KIND_KEYS } from '../src/shared/gallery.js'

const DB_NAME = 'desk-pet-mobile'
const DB_VERSION = 1
const STORES = ['settings', 'sessions', 'messages', 'personas', 'meta']

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('personas')) db.createObjectStore('personas', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('messages')) {
        /* 按 sessionId 建索引：取某会话的历史是最频繁的操作 */
        const s = db.createObjectStore('messages', { keyPath: 'id' })
        s.createIndex('bySession', 'sessionId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

/** 在一个事务里跑完 fn（Promise 化，避免回调地狱） */
async function tx(storeNames, mode, fn) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode)
    let result
    t.oncomplete = () => resolve(result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
    try {
      result = fn(t)
    } catch (err) {
      reject(err)
    }
  })
}

/** 包一层：把 IDBRequest 变成 Promise */
function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`)

/* ---------- settings / meta（都是简单 KV） ---------- */

export async function getSetting(key, fallback = null) {
  const db = await openDb()
  const row = await req(db.transaction('settings').objectStore('settings').get(key))
  return row ? row.value : fallback
}

export async function setSetting(key, value) {
  const db = await openDb()
  await req(db.transaction('settings', 'readwrite').objectStore('settings').put({ key, value }))
  return value
}

export async function allSettings() {
  const db = await openDb()
  const rows = await req(db.transaction('settings').objectStore('settings').getAll())
  const out = {}
  for (const r of rows) out[r.key] = r.value
  return out
}

export async function getMeta(key, fallback = null) {
  const db = await openDb()
  const row = await req(db.transaction('meta').objectStore('meta').get(key))
  return row ? row.value : fallback
}

export async function setMeta(key, value) {
  const db = await openDb()
  await req(db.transaction('meta', 'readwrite').objectStore('meta').put({ key, value }))
  return value
}

/* ---------- 会话 ---------- */

export async function listSessions() {
  const db = await openDb()
  const rows = await req(db.transaction('sessions').objectStore('sessions').getAll())
  /* 最近更新的排前面，和桌面端一致 */
  return rows.filter((s) => !s.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getSession(id) {
  const db = await openDb()
  const s = await req(db.transaction('sessions').objectStore('sessions').get(id))
  return s && !s.deletedAt ? s : null
}

export async function createSession(title = '新的对话') {
  const id = uid()
  const ts = Date.now()
  const s = { id, title, createdAt: ts, updatedAt: ts }
  const db = await openDb()
  await req(db.transaction('sessions', 'readwrite').objectStore('sessions').put(s))
  return s
}

export async function renameSession(id, title) {
  const s = await getSession(id)
  if (!s) return null
  const clean = String(title ?? '').trim().slice(0, 60) || '新的对话'
  const next = { ...s, title: clean, updatedAt: Date.now() }
  const db = await openDb()
  await req(db.transaction('sessions', 'readwrite').objectStore('sessions').put(next))
  return next
}

export async function deleteSession(id) {
  /*
   * 同样的 IndexedDB 陷阱：先 await 拿数据，再开写事务。
   * （事务里一 await 就会自动提交，之后碰 objectStore 就报错）
   */
  const session = await getSession(id)
  if (!session) return false

  const db = await openDb()
  /* 先查要删哪些消息（只读事务），再开写事务删 —— 全程不在事务里 await */
  const keys = await req(
    db.transaction('messages').objectStore('messages').index('bySession').getAllKeys(id),
  )

  await tx(['sessions', 'messages'], 'readwrite', (t) => {
    t.objectStore('sessions').put({ ...session, deletedAt: Date.now() })
    for (const k of keys) t.objectStore('messages').delete(k)
  })
  return true
}

/* ---------- 消息 ---------- */

export async function listMessages(sessionId) {
  const db = await openDb()
  const idx = db.transaction('messages').objectStore('messages').index('bySession')
  const rows = await req(idx.getAll(sessionId))
  return rows.filter((m) => !m.deletedAt).sort((a, b) => a.createdAt - b.createdAt)
}

export async function addMessage(sessionId, role, content, { model = null, error = false, createdAt: at = null } = {}) {
  const id = uid()
  /*
   * 默认取当前时间；`createdAt` 允许调用方指定。
   *
   * 为什么需要：一次解锁要落**多条**消息（配文一条、每张照片一条），
   * 而 `Date.now()` 是毫秒级 —— 连续调用很可能拿到同一个值。
   * 列表按 `createdAt` 排序，并列时顺序就不可靠了。
   * 调用方按序传入递增的时间戳即可定死顺序。
   */
  const createdAt = at ?? Date.now()
  const msg = { id, sessionId, role, content, model, error: Boolean(error), createdAt }

  /*
   * 关键：**所有 objectStore 操作必须在 await 之前同步发出**。
   *
   * IndexedDB 的事务在「没有待处理请求」时会自动提交，
   * 而 `await` 会让出微任务队列 —— 一旦 await 了别的东西（比如 getSession），
   * 事务就提交了，之后再 t.objectStore(...) 会抛
   * InvalidStateError: The transaction has finished。
   *
   * 所以这里先把会话读出来（独立事务），再开写事务一次性发出两个 put。
   */
  const db = await openDb()
  const session = await getSession(sessionId)

  await tx(['messages', 'sessions'], 'readwrite', (t) => {
    t.objectStore('messages').put(msg)
    if (session) t.objectStore('sessions').put({ ...session, updatedAt: createdAt })
  })
  return msg
}

/** 取最近 N 条（时间正序），用于拼上下文 */
export async function recentMessages(sessionId, limit = 100) {
  const all = await listMessages(sessionId)
  return all.filter((m) => !m.error).slice(-Math.max(1, limit))
}

export async function countMessages(sessionId) {
  const db = await openDb()
  const idx = db.transaction('messages').objectStore('messages').index('bySession')
  const rows = await req(idx.getAll(sessionId))
  return rows.filter((m) => !m.deletedAt).length
}

/* ---------- 亲密度 ---------- */

/**
 * 亲密度状态。
 *
 * 桌面端有完整实现（`AFFINITY_GAIN` / 日上限 / 5 档等级），
 * 手机端此前**只有一句注释说「用已聊条数当代理」，从没展示给用户** ——
 * 于是手机上完全看不到关系进展，图鉴的「条件解锁」也失去参照。
 *
 * 这里存的是和桌面端**同一份结构**（points / lastDay / gainDay / gainToday；
 * chatDay/chatToday 是「只封聊天」时代的旧字段，老数据靠 settleAffinity 兼容读取），
 * 判定直接复用 `@shared/interactions.js` 的 affinityLevel / affinityGain，
 * 两端规则不会漂移。
 */
export async function getAffinity() {
  return (
    (await getMeta('affinity', null)) ?? {
      points: 0,
      lastDay: null,
      gainDay: null,
      gainToday: 0,
    }
  )
}

export async function setAffinity(next) {
  await setMeta('affinity', next)
  return next
}

/** 累计对话条数 —— 亲密度之外，也用来给用户一个直观的「聊了多少」 */
export async function totalMessages() {
  const db = await openDb()
  const rows = await req(db.transaction('messages').objectStore('messages').getAll())
  return rows.filter((m) => !m.deletedAt).length
}

/* ---------- 自定义人设 ---------- */

export async function listPersonas() {
  const db = await openDb()
  const rows = await req(db.transaction('personas').objectStore('personas').getAll())
  return rows.filter((p) => !p.deletedAt).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

export async function createPersona({ label, prompt }) {
  const p = {
    id: `custom-${uid().slice(0, 8)}`,
    label: String(label ?? '').trim().slice(0, 40) || '自定义人设',
    prompt: String(prompt ?? ''),
    createdAt: Date.now(),
  }
  const db = await openDb()
  await req(db.transaction('personas', 'readwrite').objectStore('personas').put(p))
  return p
}

export async function deletePersona(id) {
  const db = await openDb()
  const p = await req(db.transaction('personas').objectStore('personas').get(id))
  if (!p) return false
  await req(db.transaction('personas', 'readwrite').objectStore('personas').put({ ...p, deletedAt: Date.now() }))
  return true
}

/* ---------- 图鉴解锁（= 她的长期记忆） ---------- */

/*
 * 装扮 / 视频 / 背景图共用同一套解锁机制，只是键名不同。
 * 参数化而不是复制三份：解锁/记忆/清理的逻辑完全一样，
 * 复制出去改一处忘一处，就会出现「装扮清了但视频还在」这类问题。
 *
 * 键名表来自 shared/gallery.js —— 主进程用的是同一份，
 * 两端键名必须一致（备份同步要用），不能各写一张。
 */

function keysOf(kind) {
  const k = KIND_KEYS[kind]
  if (!k) throw new Error(`未知的图鉴类型: ${kind}`)
  return k
}

/**
 * 已解锁的项。
 * 存进 IndexedDB 而不是内存：这是**跨会话的进度**，
 * 而且用户要求「触发一次后留在记忆里」—— 重开 App 必须还在。
 */
export async function listUnlocked(kind = 'outfit') {
  const { list } = keysOf(kind)
  return (await getMeta(list, [])) ?? []
}

export async function isUnlocked(kind, slug) {
  return (await listUnlocked(kind)).includes(slug)
}

/**
 * 解锁一项，并记下触发时的细节（成为她的记忆）。
 * @returns {Promise<{slug:string, at:number, line:string, title:string}|null>} 已解锁过则返回 null
 */
export async function unlockItem(kind, slug, line = '', title = '') {
  const { list, mem: memKey } = keysOf(kind)
  const cur = await listUnlocked(kind)
  if (cur.includes(slug)) return null
  await setMeta(list, [...cur, slug])
  const mem = (await getMeta(memKey, {})) ?? {}
  mem[slug] = { at: Date.now(), line, title }
  await setMeta(memKey, mem)
  return { slug, at: mem[slug].at, line, title }
}

/** 解锁时说的话，用来拼「她还记得」的上下文 */
export async function listMemories(kind = 'outfit') {
  const { mem } = keysOf(kind)
  return (await getMeta(mem, {})) ?? {}
}

/** 清空图鉴进度（「清空本机数据」时一起清） */
export async function clearUnlocks() {
  await setMeta('unlockedOutfits', [])
  await setMeta('outfitMemories', {})
  await setMeta('unlockedVideos', [])
  await setMeta('videoMemories', {})
}

/* 装扮的便捷封装（调用点更短，语义更清楚） */
export const listUnlockedOutfits = () => listUnlocked('outfit')
export const unlockOutfit = (slug, line, title) => unlockItem('outfit', slug, line, title)

/* ---------- 维护 ---------- */

/** 清空所有数据（设置里的「重置」用） */
export async function wipeAll() {
  const db = await openDb()
  return tx(STORES, 'readwrite', (t) => {
    for (const s of STORES) t.objectStore(s).clear()
  })
}

/* ---------- 备份 / 恢复 ---------- */

/**
 * 导出全部数据为一个可序列化的对象。
 *
 * ## 为什么必须有这个
 *
 * 所有数据（对话、她的记忆、图鉴进度、设置）都躺在 IndexedDB 里，
 * 而 IndexedDB 和 Service Worker 缓存**同属一个 origin** ——
 * 浏览器「清除站点数据」会一起端掉。
 *
 * 也就是说：在只有「清空本机数据」没有备份的情况下，
 * 任何一次排障式的清缓存都等于**永久删除全部聊天记录**。
 * 这个功能是让「清缓存」这件事变得可接受的前提。
 *
 * 导出的是纯 JSON，不加密 —— 里面有 API Key，
 * 所以 UI 上要明确提示「别随便发给别人」。
 */
export async function exportAll() {
  const db = await openDb()
  const out = { format: 'yuki-backup', version: 1, exportedAt: Date.now(), data: {} }
  for (const s of STORES) {
    const rows = await req(db.transaction(s).objectStore(s).getAll())
    out.data[s] = rows
  }
  return out
}

/**
 * 从备份恢复。
 *
 * @param {object} payload  exportAll() 的产物
 * @param {'merge'|'replace'} mode
 *   - replace：清空现有数据再写入（换机、重置后用）
 *   - merge：按主键覆盖同名记录，保留现有（怕丢东西时用）
 * @returns {{ok:boolean, counts:object, error?:string}}
 */
export async function importAll(payload, mode = 'replace') {
  if (!payload || payload.format !== 'yuki-backup' || !payload.data) {
    return { ok: false, error: '不是有效的备份文件' }
  }
  const db = await openDb()
  const counts = {}
  return tx(STORES, 'readwrite', (t) => {
    for (const s of STORES) {
      const rows = payload.data[s]
      if (!Array.isArray(rows)) continue
      const store = t.objectStore(s)
      if (mode === 'replace') store.clear()
      for (const row of rows) store.put(row)
      counts[s] = rows.length
    }
  }).then(() => ({ ok: true, counts }))
}

/* ---------- 一键把数据挪出来（给「清缓存」兜底） ---------- */

/**
 * 备份文件下载。
 *
 * 用 Blob + <a download> 而不是 File System Access API：
 * iOS Safari 不支持后者，而手机端恰恰是最需要备份的地方
 * （用户没法像桌面那样直接翻用户目录）。
 */
export function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  /* 立刻 revoke 会让部分浏览器来不及下载，延后释放 */
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** 让用户选一个备份文件并读出来 */
export function pickJsonFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      try {
        resolve(JSON.parse(await file.text()))
      } catch (err) {
        reject(new Error('文件不是合法 JSON'))
      }
    })
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

/** 估算占用空间（图片会让它增长，给用户一个可视的反馈） */
export async function usageBytes() {
  try {
    if (!navigator.storage?.estimate) return null
    const { usage } = await navigator.storage.estimate()
    return usage ?? null
  } catch {
    return null
  }
}
