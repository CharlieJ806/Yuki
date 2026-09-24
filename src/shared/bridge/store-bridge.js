/**
 * Tauri 运行时的数据层 —— openStore（src/main/store.js）的同 surface 异步实现。
 *
 * 与 node:sqlite 版的差异只有一处：SQL 经 IPC 交给 Rust 的 rusqlite 桥
 * （db_exec / db_select，见 src-tauri/src/db.rs）执行，
 * 连接与事务状态都在 Rust 侧。schema 的单一来源是 src/shared/db-schema.js，
 * 首次使用前由本模块建表；行映射与 store.js 共用 store-maps.js，防行为漂移。
 *
 * service 层只认 surface 不认实现（双 store 后端），本文件只在
 * Tauri 的 pet 窗宿主里被 import，Node 测试与 Electron 走不到这里。
 */
import { DEFAULT_SETTINGS } from '../moyu.js'
import { serializeContent } from '../content.js'
import { SCHEMA } from '../db-schema.js'
import {
  mapCheckin,
  mapMessage,
  mapPersona,
  mapSession,
  safeParse,
  streakFromKeys,
} from './store-maps.js'

/* UUID：webview 里的 Web Crypto（与 node:crypto randomUUID 同为 UUIDv4） */
const uuid = () => globalThis.crypto.randomUUID()

function invoke(cmd, args = {}) {
  return window.__TAURI__.core.invoke(cmd, args)
}

export function openStoreBridge() {
  const now = () => Date.now()

  /* select/exec 是全部数据访问的收口：先等建表完成，再进 IPC。
     宿主（service-host）也会 await ready，这里是 store surface 自身的防线 */
  const ready = invoke('db_exec', { sql: SCHEMA, params: null }).then(() => undefined)
  const select = async (sql, params) => {
    await ready
    return invoke('db_select', { sql, params: params ?? null })
  }
  const exec = async (sql, params) => {
    await ready
    return invoke('db_exec', { sql, params: params ?? null })
  }

  /* ---------- settings ---------- */

  async function getSettings() {
    const merged = { ...DEFAULT_SETTINGS }
    for (const row of await select('SELECT key, value FROM settings')) {
      try {
        merged[row.key] = JSON.parse(row.value)
      } catch {
        /* 损坏的单项回退默认值，不拖垮整体 */
      }
    }
    return merged
  }

  async function saveSettings(patch) {
    const ts = now()
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!(key in DEFAULT_SETTINGS)) continue
      await exec(
        `INSERT INTO settings (key, value, updatedAt, syncState) VALUES (?, ?, ?, 'pending')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt, syncState = 'pending'`,
        [key, JSON.stringify(value), ts],
      )
    }
    return getSettings()
  }

  /* ---------- checkins ---------- */

  async function getCheckin(dateKey) {
    const rows = await select('SELECT * FROM checkins WHERE dateKey = ? AND deletedAt IS NULL', [dateKey])
    return rows[0] ? mapCheckin(rows[0]) : null
  }

  async function addCheckin(dateKey, note = null) {
    const existing = await getCheckin(dateKey)
    if (existing) return { checkin: existing, created: false }
    const id = uuid()
    const ts = now()
    await exec(
      `INSERT INTO checkins (id, dateKey, createdAt, note, updatedAt, syncState)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [id, dateKey, ts, note, ts],
    )
    return { checkin: await getCheckin(dateKey), created: true }
  }

  /**
   * 批量补卡：校验后一次性写入所有缺失工作日，已存在的日期跳过。
   *
   * 基线是「循环逐天查重 + 手写 BEGIN/COMMIT」（同步 IPC 原子）。
   * 新版改为「一次查重 + 单条多行 INSERT」：单条语句天然原子，
   * 不会有绕开总线队列的并发写（如流式对话落库）滑进打开的事务、
   * 被失败的 ROLLBACK 连带回滚（见 REVIEW_FINDINGS M2）。天数上限远低于
   * SQLite 单语句 32766 个参数的上限（每天 5 个参数）。
   *
   * @returns {{ created: string[], skipped: string[], note: string|null }} created 为实际写入的日期（正序）
   */
  async function addCheckins(dateKeys, note = null) {
    const skipped = []
    const created = []
    const ts = now()
    const wanted = []
    for (const key of dateKeys ?? []) {
      const k = String(key ?? '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue
      wanted.push(k)
    }
    if (wanted.length) {
      const placeholders = wanted.map(() => '?').join(', ')
      const rows = await select(
        `SELECT dateKey FROM checkins WHERE deletedAt IS NULL AND dateKey IN (${placeholders})`,
        wanted,
      )
      const existing = new Set(rows.map((r) => r.dateKey))
      for (const k of wanted) (existing.has(k) ? skipped : created).push(k)
      if (created.length) {
        const params = []
        const values = created
          .map((k) => {
            params.push(uuid(), k, ts, note, ts)
            return "(?, ?, ?, ?, ?, 'pending')"
          })
          .join(', ')
        await exec(
          `INSERT INTO checkins (id, dateKey, createdAt, note, updatedAt, syncState) VALUES ${values}`,
          params,
        )
      }
    }
    return { created, skipped, note }
  }

  async function listCheckins({ year, month } = {}) {
    let sql = 'SELECT * FROM checkins WHERE deletedAt IS NULL'
    const params = []
    if (year && month) {
      const prefix = `${year}-${String(month).padStart(2, '0')}-%`
      sql += ' AND dateKey LIKE ?'
      params.push(prefix)
    }
    sql += ' ORDER BY dateKey DESC'
    return (await select(sql, params)).map(mapCheckin)
  }

  /** 累计摸鱼天数 = 有效打卡记录数 */
  async function moyuDays() {
    const rows = await select('SELECT COUNT(*) AS n FROM checkins WHERE deletedAt IS NULL')
    return Number(rows[0]?.n) || 0
  }

  /**
   * 连续打卡天数：逐日推进算法在 store-maps.js（与 node:sqlite 版共用）。
   * 休息日由调用方（service 层）按节假日表算好传进来，这里不碰日历规则。
   */
  async function streak(todayKey, isRest = null) {
    const rows = await select('SELECT dateKey FROM checkins WHERE deletedAt IS NULL ORDER BY dateKey DESC')
    return streakFromKeys(rows.map((r) => r.dateKey), todayKey, isRest)
  }

  /* ---------- worklogs ---------- */

  async function addWorklog(dateKey, minutes, kind = 'moyu') {
    const id = uuid()
    const ts = now()
    await exec(
      `INSERT INTO worklogs (id, dateKey, minutes, kind, createdAt, updatedAt, syncState)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [id, dateKey, Math.round(minutes), kind, ts, ts],
    )
    return id
  }

  async function listWorklogs(dateKey) {
    return select('SELECT * FROM worklogs WHERE dateKey = ? AND deletedAt IS NULL ORDER BY createdAt', [dateKey])
  }

  async function worklogTotal(dateKey, kind = 'moyu') {
    const rows = await select(
      'SELECT COALESCE(SUM(minutes), 0) AS m FROM worklogs WHERE dateKey = ? AND kind = ? AND deletedAt IS NULL',
      [dateKey, kind],
    )
    return Number(rows[0]?.m) || 0
  }

  /* ---------- events ---------- */

  async function addEvent(type, payload = null) {
    await exec('INSERT INTO events (id, type, payload, createdAt) VALUES (?, ?, ?, ?)', [
      uuid(),
      type,
      payload ? JSON.stringify(payload) : null,
      now(),
    ])
    return true
  }

  async function listEvents(type, limit = 50) {
    const rows = await select('SELECT * FROM events WHERE type = ? ORDER BY createdAt DESC LIMIT ?', [type, limit])
    return rows.map((r) => ({ ...r, payload: r.payload ? safeParse(r.payload) : null }))
  }

  /* ---------- sync bookkeeping ---------- */

  async function getMeta(key, fallback = null) {
    const rows = await select('SELECT value FROM meta WHERE key = ?', [key])
    return rows[0] ? safeParse(rows[0].value) : fallback
  }

  async function setMeta(key, value) {
    await exec(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, JSON.stringify(value)],
    )
    return value
  }

  /** 待同步变更集 —— 云端同步实现时直接消费 */
  async function pendingChanges() {
    return {
      settings: await select("SELECT * FROM settings WHERE syncState != 'synced'"),
      checkins: await select("SELECT * FROM checkins WHERE syncState != 'synced'"),
      worklogs: await select("SELECT * FROM worklogs WHERE syncState != 'synced'"),
      chatSessions: await select("SELECT * FROM chat_sessions WHERE syncState != 'synced'"),
      chatMessages: await select("SELECT * FROM chat_messages WHERE syncState != 'synced'"),
    }
  }

  async function markSynced(idsByTable) {
    const ts = now()
    for (const [table, ids] of Object.entries(idsByTable ?? {})) {
      if (!Array.isArray(ids) || ids.length === 0) continue
      const sql = `UPDATE ${table} SET syncState = 'synced', updatedAt = ? WHERE id = ?`
      for (const id of ids) await exec(sql, [ts, id])
    }
    return true
  }

  /* ---------- chat ---------- */

  async function createSession(title = '新的对话') {
    const id = uuid()
    const ts = now()
    await exec(
      `INSERT INTO chat_sessions (id, title, createdAt, updatedAt, syncState)
       VALUES (?, ?, ?, ?, 'pending')`,
      [id, title, ts, ts],
    )
    return mapSession({ id, title, createdAt: ts, updatedAt: ts })
  }

  async function listSessions() {
    const rows = await select(
      `SELECT s.*, (SELECT COUNT(*) FROM chat_messages m
                    WHERE m.sessionId = s.id AND m.deletedAt IS NULL) AS messageCount
       FROM chat_sessions s WHERE s.deletedAt IS NULL
       ORDER BY s.updatedAt DESC`,
    )
    return rows.map((r) => ({ ...mapSession(r), messageCount: Number(r.messageCount) || 0 }))
  }

  async function getSession(id) {
    const rows = await select('SELECT * FROM chat_sessions WHERE id = ? AND deletedAt IS NULL', [id])
    return rows[0] ? mapSession(rows[0]) : null
  }

  async function renameSession(id, title) {
    const ts = now()
    /* 先 trim 再判断，否则纯空格会被当成有效标题 */
    const clean = String(title ?? '').trim().slice(0, 60)
    await exec("UPDATE chat_sessions SET title = ?, updatedAt = ?, syncState = 'pending' WHERE id = ?", [
      clean || '新的对话',
      ts,
      id,
    ])
    return getSession(id)
  }

  async function deleteSession(id) {
    const ts = now()
    await exec("UPDATE chat_sessions SET deletedAt = ?, updatedAt = ?, syncState = 'pending' WHERE id = ?", [ts, ts, id])
    await exec("UPDATE chat_messages SET deletedAt = ?, updatedAt = ?, syncState = 'pending' WHERE sessionId = ?", [
      ts,
      ts,
      id,
    ])
    return true
  }

  async function listMessages(sessionId, limit = 500) {
    const rows = await select(
      `SELECT * FROM chat_messages WHERE sessionId = ? AND deletedAt IS NULL
       ORDER BY createdAt ASC LIMIT ?`,
      [sessionId, limit],
    )
    return rows.map(mapMessage)
  }

  /** 取最近 N 轮给模型做上下文（时间正序返回） */
  async function recentMessages(sessionId, limit) {
    const rows = await select(
      `SELECT * FROM chat_messages WHERE sessionId = ? AND deletedAt IS NULL AND error = 0
       ORDER BY createdAt DESC LIMIT ?`,
      [sessionId, Math.max(1, limit)],
    )
    return rows.reverse().map(mapMessage)
  }

  /**
   * 取「最近若干天内」的消息（时间正序）。
   * 和 `recentMessages` 的区别：那个只看条数，这里用 createdAt 卡时间下界，
   * 防止挂机台词捞到几周前的旧事（详见 node:sqlite 版同名方法）。
   */
  async function messagesSince(sessionId, sinceTs, limit = 200) {
    const rows = await select(
      `SELECT * FROM chat_messages WHERE sessionId = ? AND deletedAt IS NULL AND error = 0
         AND createdAt >= ?
       ORDER BY createdAt DESC LIMIT ?`,
      [sessionId, Math.max(0, Number(sinceTs) || 0), Math.max(1, limit)],
    )
    return rows.reverse().map(mapMessage)
  }

  async function addMessage(sessionId, role, content, { model = null, error = false, createdAt = null } = {}) {
    const id = uuid()
    /*
     * 默认取当前时间；`createdAt` 允许调用方指定（与 node:sqlite 版同语义）：
     * 一次解锁落多条消息时按序传递增时间戳，定死列表顺序。
     */
    const ts = createdAt ?? now()
    /*
     * content 落库形态与 node:sqlite 版一致：纯文本原样存，
     * 含图消息存 `{"blocks":[...]}`（见 serializeContent 的注释）。
     */
    const serialized = serializeContent(content)
    await exec(
      `INSERT INTO chat_messages (id, sessionId, role, content, model, error, createdAt, updatedAt, syncState)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [id, sessionId, role, serialized, model, error ? 1 : 0, ts, ts],
    )
    await exec("UPDATE chat_sessions SET updatedAt = ?, syncState = 'pending' WHERE id = ?", [ts, sessionId])
    return mapMessage({ id, sessionId, role, content: serialized, model, error: error ? 1 : 0, createdAt: ts })
  }

  async function touchSession(id) {
    await exec("UPDATE chat_sessions SET updatedAt = ?, syncState = 'pending' WHERE id = ?", [now(), id])
  }

  async function countMessages(sessionId) {
    const rows = await select('SELECT COUNT(*) AS n FROM chat_messages WHERE sessionId = ? AND deletedAt IS NULL', [
      sessionId,
    ])
    return Number(rows[0]?.n) || 0
  }

  /* ---------- 自定义人设 ---------- */

  async function listPersonas() {
    const rows = await select('SELECT * FROM personas WHERE deletedAt IS NULL ORDER BY sortOrder ASC, createdAt ASC')
    return rows.map(mapPersona)
  }

  async function getPersona(id) {
    const rows = await select('SELECT * FROM personas WHERE id = ? AND deletedAt IS NULL', [id])
    return rows[0] ? mapPersona(rows[0]) : null
  }

  async function createPersona({ id, label, prompt }) {
    const now_ = now()
    const pid = id || `custom-${uuid().slice(0, 8)}`
    const maxRows = await select('SELECT COALESCE(MAX(sortOrder), 0) AS m FROM personas')
    const maxOrder = Number(maxRows[0]?.m) || 0
    await exec(
      `INSERT INTO personas (id, label, prompt, sortOrder, createdAt, updatedAt, syncState)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [pid, String(label).trim().slice(0, 40) || '自定义人设', String(prompt ?? ''), maxOrder + 1, now_, now_],
    )
    return getPersona(pid)
  }

  async function updatePersona(id, patch) {
    const existing = await getPersona(id)
    if (!existing) return null
    const ts = now()
    await exec("UPDATE personas SET label = ?, prompt = ?, updatedAt = ?, syncState = 'pending' WHERE id = ?", [
      patch.label !== undefined ? String(patch.label).trim().slice(0, 40) || existing.label : existing.label,
      patch.prompt !== undefined ? String(patch.prompt) : existing.prompt,
      ts,
      id,
    ])
    return getPersona(id)
  }

  async function deletePersona(id) {
    const ts = now()
    await exec("UPDATE personas SET deletedAt = ?, updatedAt = ?, syncState = 'pending' WHERE id = ?", [ts, ts, id])
    return true
  }

  return {
    /* schema 就绪后 resolve；宿主可以 await 它确认数据层可用 */
    ready,
    getSettings,
    saveSettings,
    getCheckin,
    addCheckin,
    addCheckins,
    listCheckins,
    moyuDays,
    streak,
    addWorklog,
    listWorklogs,
    worklogTotal,
    addEvent,
    listEvents,
    getMeta,
    setMeta,
    pendingChanges,
    markSynced,
    createSession,
    listSessions,
    getSession,
    renameSession,
    deleteSession,
    listMessages,
    recentMessages,
    messagesSince,
    addMessage,
    touchSession,
    countMessages,
    listPersonas,
    getPersona,
    createPersona,
    updatePersona,
    deletePersona,
    /* 连接归 Rust 所有，无需也不应从这里关闭 */
    close: () => {},
  }
}
