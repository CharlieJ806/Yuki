/**
 * 中国法定节假日 / 调休检测。
 *
 * 数据源：timor.tech（免费，无需 Key）。注意它挡无 UA 的请求，
 * 必须带 User-Agent，否则返回 Cloudflare 验证页而不是 JSON。
 *
 * 三方行为约定：
 *   - 拿到数据后写进本地缓存（meta 表按年存），当天有效期内不再联网
 *   - 联网失败时用缓存；没缓存则退回「只看周末」的老逻辑，不阻塞使用
 *
 * 为什么需要它：2026-09-20 是周日，但那是「中秋节前补班」——
 * 只按星期判断会误报成休息日，摸鱼收入算成 0。
 */

const API_BASE = 'https://timor.tech/api/holiday'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) desk-pet'

/** 缓存有效期：节假日表一年才变一次，缓存 7 天足够，避免每次启动都联网 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * @typedef {object} HolidayInfo
 * @property {boolean} isHoliday   法定放假日
 * @property {boolean} isMakeup    调休补班日（周末但要上班）
 * @property {string}  name        节日名，如「春节」
 * @property {string}  note        备注，如「中秋节前补班」
 */

/**
 * 拉取某年的节假日表。
 * @returns {Promise<Record<string, HolidayInfo>>}  以 'MM-DD' 为键
 */
export async function fetchHolidayYear(year, { timeoutMs = 12_000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${API_BASE}/year/${year}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`节假日接口返回 ${res.status}`)
    const json = await res.json()
    if (json?.code !== 0 || !json.holiday) throw new Error('节假日接口返回结构异常')

    const out = {}
    for (const [md, raw] of Object.entries(json.holiday)) {
      if (!raw || typeof raw !== 'object') continue
      out[md] = {
        isHoliday: raw.holiday === true,
        isMakeup: raw.holiday === false,
        name: String(raw.name ?? '').trim(),
        note: raw.after ? `${raw.target ?? ''}${raw.name ?? ''}`.trim() : String(raw.name ?? '').trim(),
      }
    }
    return out
  } finally {
    clearTimeout(timer)
  }
}

/** 'YYYY-MM-DD' -> 'MM-DD' */
export function toMonthDay(dateKey) {
  return String(dateKey).slice(5)
}

/**
 * 查询某天是不是节假日/调休。
 * @param {Record<string, HolidayInfo>} table
 * @param {string} dateKey 'YYYY-MM-DD'
 * @returns {HolidayInfo | null}  表里没有该日期时返回 null（普通日子）
 */
export function lookupHoliday(table, dateKey) {
  if (!table) return null
  return table[toMonthDay(dateKey)] ?? null
}

/** 判断缓存是否还有效 */
export function isCacheFresh(cached) {
  if (!cached || typeof cached !== 'object') return false
  const at = Number(cached.fetchedAt)
  if (!Number.isFinite(at)) return false
  return Date.now() - at < CACHE_TTL_MS
}

export const HOLIDAY_CACHE_TTL_MS = CACHE_TTL_MS
