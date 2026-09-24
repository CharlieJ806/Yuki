/**
 * 中国法定节假日「常量化」表（2025 ~ 2026）。
 *
 * ## 为什么内置而不是联网拉
 *
 * 桌面端有一套联网方案（`src/main/holiday.js` 拉 timor.tech + 存 SQLite），
 * 但手机端是纯静态 PWA，用不了那套。而节假日数据有两个特点：
 *
 *   1. **每年国务院提前公布，一年内不变** —— 拉一次能用一整年
 *   2. **数据量极小** —— 两年共 72 条，压成常量不到 4KB
 *
 * 所以直接内置是最省事的：零网络依赖、零缓存逻辑、秒出结果。
 * 代价是**每年要手动更新一次** —— 到期后 `upcomingHoliday()` 会返回 null，
 * 界面只是不显示节日倒计时，不会出错（比联网失败要体面）。
 *
 * ## 数据来源与格式
 *
 * 来源：timor.tech（与桌面端同源，保证两端判断一致）。
 * 值是紧凑的元组 `[是否放假, 名字]`：
 *   `true`  = 法定放假（含周末调过来的）
 *   `false` = 调休补班（本来是周末，但要上班）
 * 用元组而不是对象是为了压缩体积 —— 72 条 × 少写两个键名，
 * 在 PWA 的首次加载里是实打实的字节。
 *
 * ## 维护
 *
 * 每年 11 月国务院公布次年安排后，跑：
 *   node scripts/fetch-holidays.js 2027    # 追加到本表
 * 没跟上的年份会静默降级（只按周末算），不影响其它功能。
 */

/**
 * 年份 → { 'MM-DD': [是否放假, 节日名] }
 * @type {Record<string, Record<string, [boolean, string]>>}
 */
export const HOLIDAY_TABLE = {
  2025: {
    '01-01': [true, '元旦'],
    '01-26': [false, '春节前补班'],
    '01-28': [true, '除夕'],
    '01-29': [true, '初一'],
    '01-30': [true, '初二'],
    '01-31': [true, '初三'],
    '02-01': [true, '初四'],
    '02-02': [true, '初五'],
    '02-03': [true, '初六'],
    '02-04': [true, '初七'],
    '02-08': [false, '春节后补班'],
    '04-04': [true, '清明节'],
    '04-05': [true, '清明节'],
    '04-06': [true, '清明节'],
    '04-27': [false, '劳动节前补班'],
    '05-01': [true, '劳动节'],
    '05-02': [true, '劳动节'],
    '05-03': [true, '劳动节'],
    '05-04': [true, '劳动节'],
    '05-05': [true, '劳动节'],
    '05-31': [true, '端午节'],
    '06-01': [true, '端午节'],
    '06-02': [true, '端午节'],
    '09-28': [false, '国庆节前补班'],
    '10-01': [true, '国庆节'],
    '10-02': [true, '国庆节'],
    '10-03': [true, '国庆节'],
    '10-04': [true, '国庆节'],
    '10-05': [true, '国庆节'],
    '10-06': [true, '中秋节'],
    '10-07': [true, '国庆节'],
    '10-08': [true, '国庆节'],
    '10-11': [false, '国庆节后补班'],
  },
  2026: {
    '01-01': [true, '元旦'],
    '01-02': [true, '元旦'],
    '01-03': [true, '元旦'],
    '01-04': [false, '元旦后补班'],
    '02-14': [false, '春节前补班'],
    '02-15': [true, '春节'],
    '02-16': [true, '除夕'],
    '02-17': [true, '初一'],
    '02-18': [true, '初二'],
    '02-19': [true, '初三'],
    '02-20': [true, '初四'],
    '02-21': [true, '初五'],
    '02-22': [true, '初六'],
    '02-23': [true, '初七'],
    '02-28': [false, '春节后补班'],
    '04-04': [true, '清明节'],
    '04-05': [true, '清明节'],
    '04-06': [true, '清明节'],
    '05-01': [true, '劳动节'],
    '05-02': [true, '劳动节'],
    '05-03': [true, '劳动节'],
    '05-04': [true, '劳动节'],
    '05-05': [true, '劳动节'],
    '05-09': [false, '劳动节后补班'],
    '06-19': [true, '端午节'],
    '06-20': [true, '端午节'],
    '06-21': [true, '端午节'],
    '09-20': [false, '中秋节前补班'],
    '09-25': [true, '中秋节'],
    '09-26': [true, '中秋节'],
    '09-27': [true, '中秋节'],
    '10-01': [true, '国庆节'],
    '10-02': [true, '国庆节'],
    '10-03': [true, '国庆节'],
    '10-04': [true, '国庆节'],
    '10-05': [true, '国庆节'],
    '10-06': [true, '国庆节'],
    '10-07': [true, '国庆节'],
    '10-10': [false, '国庆节后补班'],
  },
}

/**
 * 查某天的节假日信息。
 *
 * @param {Date|string} date Date 或 'YYYY-MM-DD'
 * @returns {{isHoliday:boolean, name:string}|null} 表里没有该日期时返回 null
 */
export function holidayOf(date) {
  const d = typeof date === 'string' ? date : toKey(date)
  const year = String(d).slice(0, 4)
  const md = String(d).slice(5)
  const row = HOLIDAY_TABLE[year]?.[md]
  if (!row) return null
  return { isHoliday: row[0], name: row[1] }
}

/** 'YYYY-MM-DD' */
function toKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 下一个「放假」的日子（跳过补班日）。
 *
 * 用途：顶部信息栏显示「离国庆节还有 7 天」。
 *
 * ## 为什么要跳过补班日
 *
 * 表里补班日是 `isHoliday: false` 且带名字（如「国庆节前补班」）。
 * 把它的名字当节日显示会很怪 —— 用户要的是「还有几天放假」，
 * 不是「还有几天要补班」。所以只认 `isHoliday: true` 的。
 *
 * @param {Date} [from] 从哪天开始找（含当天）
 * @param {number} [limitDays] 最多往后找多少天（防越界到没数据的年份）
 * @returns {{date:Date, days:number, name:string}|null}
 */
export function upcomingHoliday(from = new Date(), limitDays = 400) {
  const start = new Date(from)
  start.setHours(0, 0, 0, 0)

  for (let i = 0; i < limitDays; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    const info = holidayOf(d)
    if (info?.isHoliday) return { date: d, days: i, name: info.name }
  }
  /*
   * 找不到就返回 null（表没覆盖到的年份）。
   * 调用方据此隐藏倒计时，而不是显示「离 undefined 还有 0 天」。
   */
  return null
}

/**
 * 节日倒计时的文案。
 *
 * @param {Date} [from]
 * @returns {string} 例如「离国庆节 7 天」「今天是中秋节」「明天是元旦」
 */
export function holidayCountdownText(from = new Date()) {
  const next = upcomingHoliday(from)
  if (!next) return ''
  if (next.days === 0) return `今天是${next.name}`
  if (next.days === 1) return `明天是${next.name}`
  return `离${next.name} ${next.days} 天`
}
