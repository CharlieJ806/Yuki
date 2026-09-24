/**
 * 「今天是哪天」相关的一切 —— 手机端「她」页顶部信息栏用。
 *
 * ## 为什么不做天气
 *
 * 一开始用 Open-Meteo 做了真实天气（免 Key、有 CORS）。但用户改主意了：
 * 天气要**联网**才能拿到，而这一栏真正的价值是「一眼看到今天的处境」——
 * 日期、时间、离周末还有几天。这些**本地就能算**，秒出、不依赖网络、
 * 也不涉及任何隐私（天气接口要知道你在哪个城市）。
 *
 * 少一个网络依赖 = 少一类「打开页面那一栏是空的」的故障。
 *
 * ## 没有节假日表
 *
 * 项目里有一套法定节假日表（`src/main/holiday.js`），但它靠
 * timor.tech 拉取 + 存 SQLite，手机端用不了。这里**只按星期算**周末 ——
 * 调休会让「离周末还有几天」偶尔不准（比如周日补班），
 * 但那个偏差只影响一句提示文案，不值得为它引入整张表 + 网络请求。
 */

/** 星期名（getDay() 的索引 0 = 周日） */
const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const pad2 = (n) => String(n).padStart(2, '0')

/** `YYYY-MM-DD`（与项目其它地方的 dateKey 格式一致） */
export function toDateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 「9月24日 周四」 */
export function formatDate(d = new Date()) {
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK_NAMES[d.getDay()]}`
}

/** `HH:MM` —— 补零，配合 CSS 的 tabular-nums 才不会每分钟左右抖 */
export function formatClock(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 今天是不是周末（只看星期，不看调休） */
export function isWeekend(d = new Date()) {
  return d.getDay() === 0 || d.getDay() === 6
}

/**
 * 离周末还有几天。
 *
 * 语义取「**还有几天到能休息的那天**」：
 *   - 周六/周日 → 0（已经在休息）
 *   - 周五      → 1（明天就是周六）
 *   - 周一      → 5（要等到周六）
 *
 * 用 `(6 - day + 7) % 7` 算到**周六**的距离：
 * 周一(1) → 5、周二(2) → 4 …… 周六(6) → 0、周日(0) → 6。
 * 但周日已经在休息了，所以要特判成 0。
 */
export function daysToWeekend(d = new Date()) {
  const day = d.getDay()
  if (day === 0 || day === 6) return 0
  return (6 - day + 7) % 7
}

/**
 * 周末倒计时的文案。
 *
 * @param {Date} d
 * @returns {string} 例如「离周末 3 天」「今天是周末」「明天就是周末」
 */
export function weekendText(d = new Date()) {
  const n = daysToWeekend(d)
  if (n === 0) return '今天是周末'
  if (n === 1) return '明天就是周末'
  return `离周末 ${n} 天`
}

/**
 * 打卡状态 → 界面要显示的东西。
 *
 * @param {object} args
 * @param {string[]} args.days     已打卡的日期（`YYYY-MM-DD`），可乱序
 * @param {Date}     [args.now]
 * @returns {{today: boolean, total: number, streak: number, label: string}}
 */
export function checkinStatus({ days = [], now = new Date() } = {}) {
  /*
   * 用 Set 去重 —— 存储层理论上不会写重复，但这里多做一步：
   * 重复值会让「累计天数」虚高，而用户只能看到数字不对、很难查原因。
   */
  const set = new Set(days.filter(Boolean))
  const todayKey = toDateKey(now)
  const today = set.has(todayKey)

  /*
   * 连续天数：从今天（或昨天）往前数。
   *
   * 今天还没打卡时**从昨天开始数** —— 否则「连续 5 天」会因为
   * 今天还没打而显示成 0，看着像断签了（其实今天还没过完）。
   */
  let streak = 0
  const cursor = new Date(now)
  if (!today) cursor.setDate(cursor.getDate() - 1)
  /* 上限 3660 天（约十年）只是防死循环，正常情况下很快就会 break */
  for (let i = 0; i < 3660; i++) {
    if (!set.has(toDateKey(cursor))) break
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }

  return {
    today,
    total: set.size,
    streak,
    label: today ? `今天已打卡 · 累计 ${set.size} 天` : '打卡',
  }
}
