/**
 * 本地数据层 —— node:sqlite（Node 22+ 内置，零外部依赖）。
 *
 * 同步友好设计：每张业务表都带 id / updatedAt / deletedAt / syncState，
 * 云端同步只需按 updatedAt 做增量推拉，不需要改表结构。
 *
 * 注意：Electron 的 ESM 加载器不暴露 node:sqlite（只有 CJS 有），
 * 所以这里走 createRequire 加载，而不是 `import`。
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_SETTINGS } from '../shared/moyu.js'
import { parseStoredContent, serializeContent } from '../shared/content.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  syncState TEXT NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS checkins (
  id        TEXT PRIMARY KEY,
  dateKey   TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL,
  note      TEXT,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  syncState TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(dateKey);

CREATE TABLE IF NOT EXISTS worklogs (
  id        TEXT PRIMARY KEY,
  dateKey   TEXT NOT NULL,
  minutes   INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  syncState TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_worklogs_date ON worklogs(dateKey);

CREATE TABLE IF NOT EXISTS events (
  id        TEXT PRIMARY KEY,
  type      TEXT NOT NULL,
  payload   TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, createdAt);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

/*
 * 自定义人设：内置人设写死在 CHAT_PERSONAS，这里只存用户自建的。
 * sortOrder 决定展示顺序，内置的排在前面。
 */
CREATE TABLE IF NOT EXISTS personas (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  prompt    TEXT NOT NULL,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  syncState TEXT NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  syncState TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updatedAt DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id        TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  role      TEXT NOT NULL,
  content   TEXT NOT NULL,
  model     TEXT,
  error     INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  syncState TEXT NOT NULL DEFAULT 'local',
  FOREIGN KEY (sessionId) REFERENCES chat_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(sessionId, createdAt);
`

export function openStore(filePath) {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true })
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)

  const now = () => Date.now()

  /* ---------- settings ---------- */

  const selectSetting = db.prepare('SELECT value FROM settings WHERE key = ?')
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value, updatedAt, syncState) VALUES (?, ?, ?, 'pending')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt, syncState = 'pending'
  `)

  function getSettings() {
    const merged = { ...DEFAULT_SETTINGS }
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
      try {
        merged[row.key] = JSON.parse(row.value)
      } catch {
        /* 损坏的单项回退默认值，不拖垮整体 */
      }
    }
    return merged
  }

  function saveSettings(patch) {
    const ts = now()
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!(key in DEFAULT_SETTINGS)) continue
      upsertSetting.run(key, JSON.stringify(value), ts)
    }
    return getSettings()
  }

  /* ---------- checkins ---------- */

  const findCheckin = db.prepare('SELECT * FROM checkins WHERE dateKey = ? AND deletedAt IS NULL')
  const countCheckins = db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE deletedAt IS NULL')
  const insertCheckin = db.prepare(`
    INSERT INTO checkins (id, dateKey, createdAt, note, updatedAt, syncState)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `)

  function getCheckin(dateKey) {
    const row = findCheckin.get(dateKey)
    return row ? mapCheckin(row) : null
  }

  function addCheckin(dateKey, note = null) {
    const existing = getCheckin(dateKey)
    if (existing) return { checkin: existing, created: false }
    const id = randomUUID()
    const ts = now()
    insertCheckin.run(id, dateKey, ts, note, ts)
    return { checkin: getCheckin(dateKey), created: true }
  }

  /**
   * 批量补卡：一次事务写入多天，已存在的日期跳过。
   *
   * 补卡最坏情况要写几百天（入职日到今天），逐条 INSERT 各自开一个隐式事务，
   * 在机械盘上能卡出可感知的停顿。`node:sqlite` 没有 better-sqlite3 的
   * `db.transaction()` 包装（实测 `db.transaction` 是 undefined），
   * 所以这里手写 BEGIN/COMMIT，失败时 ROLLBACK。
   * 每条的 note 用于标记「补卡」，和现场打卡区分开。
   *
   * @returns {{ created: string[], skipped: string[], note: string|null }} created 为实际写入的日期（正序）
   */
  function addCheckins(dateKeys, note = null) {
    const created = []
    const skipped = []
    const ts = now()
    db.exec('BEGIN')
    try {
      for (const key of dateKeys ?? []) {
        const k = String(key ?? '').trim()
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue
        if (getCheckin(k)) {
          skipped.push(k)
          continue
        }
        insertCheckin.run(randomUUID(), k, ts, note, ts)
        created.push(k)
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return { created, skipped, note }
  }

  function listCheckins({ year, month } = {}) {
    let sql = 'SELECT * FROM checkins WHERE deletedAt IS NULL'
    const params = []
    if (year && month) {
      const prefix = `${year}-${String(month).padStart(2, '0')}-%`
      sql += ' AND dateKey LIKE ?'
      params.push(prefix)
    }
    sql += ' ORDER BY dateKey DESC'
    return db.prepare(sql).all(...params).map(mapCheckin)
  }

  /** 累计摸鱼天数 = 有效打卡记录数 */
  function moyuDays() {
    return Number(countCheckins.get().n) || 0
  }

  /**
   * 连续打卡天数（从今天或昨天往前推）。
   *
   * 必须按**日历天**连推，但 `skip` 里的日子（休息日）不算断档也不计入 ——
   * 否则周五打了卡、周一一来「连续」就变成 1 天，用户会以为记录丢了。
   * 休息日由调用方（service 层）按节假日表算好传进来，store 不碰日历规则。
   *
   * @param {string} todayKey 'YYYY-MM-DD'
   * @param {(date: Date) => boolean} [isRest] 判断某天是否为休息日
   */
  function streak(todayKey, isRest = null) {
    const all = db.prepare('SELECT dateKey FROM checkins WHERE deletedAt IS NULL ORDER BY dateKey DESC').all()
    const set = new Set(all.map((r) => r.dateKey))
    if (set.size === 0) return 0
    const cursor = new Date(`${todayKey}T00:00:00`)
    /* 今天还没打卡不算断档，从昨天算起 */
    if (!set.has(todayKey)) cursor.setDate(cursor.getDate() - 1)
    let n = 0
    /* 只回看有限天数：休息日可以连续很多天，但不能无限循环下去 */
    for (let guard = 0; guard < 3660; guard++) {
      const key = toKey(cursor)
      if (set.has(key)) {
        n++
      } else if (isRest && isRest(cursor)) {
        /* 休息日：跳过，既不计入也不断档 */
      } else {
        break
      }
      cursor.setDate(cursor.getDate() - 1)
    }
    return n
  }

  /* ---------- worklogs ---------- */

  const insertWorklog = db.prepare(`
    INSERT INTO worklogs (id, dateKey, minutes, kind, createdAt, updatedAt, syncState)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `)

  function addWorklog(dateKey, minutes, kind = 'moyu') {
    const id = randomUUID()
    const ts = now()
    insertWorklog.run(id, dateKey, Math.round(minutes), kind, ts, ts)
    return id
  }

  function listWorklogs(dateKey) {
    return db.prepare('SELECT * FROM worklogs WHERE dateKey = ? AND deletedAt IS NULL ORDER BY createdAt').all(dateKey)
  }

  function worklogTotal(dateKey, kind = 'moyu') {
    const row = db
      .prepare('SELECT COALESCE(SUM(minutes), 0) AS m FROM worklogs WHERE dateKey = ? AND kind = ? AND deletedAt IS NULL')
      .get(dateKey, kind)
    return Number(row.m) || 0
  }

  /* ---------- events ---------- */

  const insertEvent = db.prepare('INSERT INTO events (id, type, payload, createdAt) VALUES (?, ?, ?, ?)')

  function addEvent(type, payload = null) {
    insertEvent.run(randomUUID(), type, payload ? JSON.stringify(payload) : null, now())
    return true
  }

  function listEvents(type, limit = 50) {
    return db
      .prepare('SELECT * FROM events WHERE type = ? ORDER BY createdAt DESC LIMIT ?')
      .all(type, limit)
      .map((r) => ({ ...r, payload: r.payload ? safeParse(r.payload) : null }))
  }

  /* ---------- sync bookkeeping ---------- */

  function getMeta(key, fallback = null) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? safeParse(row.value) : fallback
  }

  function setMeta(key, value) {
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, JSON.stringify(value))
    return value
  }

  /** 待同步变更集 —— 云端同步实现时直接消费 */
  function pendingChanges() {
    return {
      settings: db.prepare("SELECT * FROM settings WHERE syncState != 'synced'").all(),
      checkins: db.prepare("SELECT * FROM checkins WHERE syncState != 'synced'").all(),
      worklogs: db.prepare("SELECT * FROM worklogs WHERE syncState != 'synced'").all(),
      chatSessions: db.prepare("SELECT * FROM chat_sessions WHERE syncState != 'synced'").all(),
      chatMessages: db.prepare("SELECT * FROM chat_messages WHERE syncState != 'synced'").all(),
    }
  }

  function markSynced(idsByTable) {
    const ts = now()
    for (const [table, ids] of Object.entries(idsByTable ?? {})) {
      if (!Array.isArray(ids) || ids.length === 0) continue
      const stmt = db.prepare(`UPDATE ${table} SET syncState = 'synced', updatedAt = ? WHERE id = ?`)
      for (const id of ids) stmt.run(ts, id)
    }
    return true
  }

  /* ---------- chat ---------- */

  const insertSession = db.prepare(`
    INSERT INTO chat_sessions (id, title, createdAt, updatedAt, syncState)
    VALUES (?, ?, ?, ?, 'pending')
  `)
  const insertMessage = db.prepare(`
    INSERT INTO chat_messages (id, sessionId, role, content, model, error, createdAt, updatedAt, syncState)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `)

  function createSession(title = '新的对话') {
    const id = randomUUID()
    const ts = now()
    insertSession.run(id, title, ts, ts)
    return mapSession({ id, title, createdAt: ts, updatedAt: ts })
  }

  function listSessions() {
    return db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM chat_messages m
                      WHERE m.sessionId = s.id AND m.deletedAt IS NULL) AS messageCount
         FROM chat_sessions s WHERE s.deletedAt IS NULL
         ORDER BY s.updatedAt DESC`,
      )
      .all()
      .map((r) => ({ ...mapSession(r), messageCount: Number(r.messageCount) || 0 }))
  }

  function getSession(id) {
    const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND deletedAt IS NULL').get(id)
    return row ? mapSession(row) : null
  }

  function renameSession(id, title) {
    const ts = now()
    /* 先 trim 再判断，否则纯空格会被当成有效标题 */
    const clean = String(title ?? '').trim().slice(0, 60)
    db.prepare("UPDATE chat_sessions SET title = ?, updatedAt = ?, syncState = 'pending' WHERE id = ?").run(
      clean || '新的对话',
      ts,
      id,
    )
    return getSession(id)
  }

  function deleteSession(id) {
    const ts = now()
    db.prepare("UPDATE chat_sessions SET deletedAt = ?, updatedAt = ?, syncState = 'pending' WHERE id = ?").run(ts, ts, id)
    db.prepare("UPDATE chat_messages SET deletedAt = ?, updatedAt = ?, syncState = 'pending' WHERE sessionId = ?").run(ts, ts, id)
    return true
  }

  function listMessages(sessionId, limit = 500) {
    return db
      .prepare(
        `SELECT * FROM chat_messages WHERE sessionId = ? AND deletedAt IS NULL
         ORDER BY createdAt ASC LIMIT ?`,
      )
      .all(sessionId, limit)
      .map(mapMessage)
  }

  /** 取最近 N 轮给模型做上下文（时间正序返回） */
  function recentMessages(sessionId, limit) {
    const rows = db
      .prepare(
        `SELECT * FROM chat_messages WHERE sessionId = ? AND deletedAt IS NULL AND error = 0
         ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(sessionId, Math.max(1, limit))
    return rows.reverse().map(mapMessage)
  }

  /**
   * 取「最近若干天内」的消息（时间正序）。
   *
   * 和 `recentMessages` 的区别：那个只看条数，聊得少时会捞出几周前的内容，
   * 挂机台词照着老话题搭话会很出戏（用户反馈：希望只用最近两天的）。
   * 这里用 createdAt 卡时间下界，再叠加条数上限兜底。
   */
  function messagesSince(sessionId, sinceTs, limit = 200) {
    const rows = db
      .prepare(
        `SELECT * FROM chat_messages WHERE sessionId = ? AND deletedAt IS NULL AND error = 0
           AND createdAt >= ?
         ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(sessionId, Math.max(0, Number(sinceTs) || 0), Math.max(1, limit))
    return rows.reverse().map(mapMessage)
  }

  function addMessage(sessionId, role, content, { model = null, error = false } = {}) {
    const id = randomUUID()
    const ts = now()
    /*
     * content 列是 NOT NULL TEXT，而图文消息是块数组，所以要序列化。
     *
     * 用「JSON 对象」而不是「JSON 数组」当落库形态，是为了和纯文本区分开：
     * 纯文本原样存字符串（和以前完全一致，老数据零迁移），
     * 只有含图消息才存 `{"blocks":[...]}`。
     * 读回来时按前缀判断，不需要给表加列，也不影响 syncState 那套增量同步。
     */
    const serialized = serializeContent(content)
    insertMessage.run(id, sessionId, role, serialized, model, error ? 1 : 0, ts, ts)
    db.prepare("UPDATE chat_sessions SET updatedAt = ?, syncState = 'pending' WHERE id = ?").run(ts, sessionId)
    return mapMessage({ id, sessionId, role, content: serialized, model, error: error ? 1 : 0, createdAt: ts })
  }

  function touchSession(id) {
    db.prepare("UPDATE chat_sessions SET updatedAt = ?, syncState = 'pending' WHERE id = ?").run(now(), id)
  }

  function countMessages(sessionId) {
    return Number(
      db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE sessionId = ? AND deletedAt IS NULL').get(sessionId).n,
    )
  }

  /* ---------- 自定义人设 ---------- */

  function listPersonas() {
    return db
      .prepare('SELECT * FROM personas WHERE deletedAt IS NULL ORDER BY sortOrder ASC, createdAt ASC')
      .all()
      .map(mapPersona)
  }

  function getPersona(id) {
    const row = db.prepare('SELECT * FROM personas WHERE id = ? AND deletedAt IS NULL').get(id)
    return row ? mapPersona(row) : null
  }

  function createPersona({ id, label, prompt }) {
    const now_ = now()
    const pid = id || `custom-${randomUUID().slice(0, 8)}`
    const maxOrder = Number(db.prepare('SELECT COALESCE(MAX(sortOrder), 0) AS m FROM personas').get().m) || 0
    db.prepare(
      `INSERT INTO personas (id, label, prompt, sortOrder, createdAt, updatedAt, syncState)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(pid, String(label).trim().slice(0, 40) || '自定义人设', String(prompt ?? ''), maxOrder + 1, now_, now_)
    return getPersona(pid)
  }

  function updatePersona(id, patch) {
    const existing = getPersona(id)
    if (!existing) return null
    const ts = now()
    db.prepare(
      "UPDATE personas SET label = ?, prompt = ?, updatedAt = ?, syncState = 'pending' WHERE id = ?",
    ).run(
      patch.label !== undefined ? String(patch.label).trim().slice(0, 40) || existing.label : existing.label,
      patch.prompt !== undefined ? String(patch.prompt) : existing.prompt,
      ts,
      id,
    )
    return getPersona(id)
  }

  function deletePersona(id) {
    const ts = now()
    db.prepare("UPDATE personas SET deletedAt = ?, updatedAt = ?, syncState = 'pending' WHERE id = ?").run(ts, ts, id)
    return true
  }

  return {
    db,
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
    close: () => db.close(),
  }
}

function mapPersona(row) {
  return {
    id: row.id,
    label: row.label,
    prompt: row.prompt,
    sortOrder: Number(row.sortOrder) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    custom: true,
  }
}

function mapSession(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function mapMessage(row) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: parseStoredContent(row.content),
    model: row.model ?? null,
    error: Boolean(row.error),
    createdAt: row.createdAt,
  }
}

function mapCheckin(row) {
  return {
    id: row.id,
    dateKey: row.dateKey,
    createdAt: row.createdAt,
    note: row.note,
    updatedAt: row.updatedAt,
  }
}

function toKey(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
