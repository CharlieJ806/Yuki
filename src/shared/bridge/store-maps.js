/**
 * SQLite 行映射与纯计算 —— node:sqlite 版（src/main/store.js）与
 * Tauri 桥接版（store-bridge.js）共用的行 → 业务对象转换。
 * 两边 SQL 相同、行结构相同，映射必须同源，否则两条运行时行为漂移。
 */
import { parseStoredContent } from '../content.js'

export function mapPersona(row) {
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

export function mapSession(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function mapMessage(row) {
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

export function mapCheckin(row) {
  return {
    id: row.id,
    dateKey: row.dateKey,
    createdAt: row.createdAt,
    note: row.note,
    updatedAt: row.updatedAt,
  }
}

/**
 * 连续打卡天数（从今天或昨天往前推）。
 *
 * 必须按**日历天**连推，但 `isRest` 里的日子（休息日）不算断档也不计入 ——
 * 否则周五打了卡、周一一来「连续」就变成 1 天，用户会以为记录丢了。
 * 休息日由调用方（service 层）按节假日表算好传进来，这里不碰日历规则。
 *
 * @param {string[]} dateKeys 已打卡的日期键
 * @param {string} todayKey 'YYYY-MM-DD'
 * @param {(date: Date) => boolean} [isRest] 判断某天是否为休息日
 */
export function streakFromKeys(dateKeys, todayKey, isRest = null) {
  const set = new Set(dateKeys)
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

export function toKey(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

export function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
