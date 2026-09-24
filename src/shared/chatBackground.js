/**
 * 聊天背景的选图逻辑 —— 两端（PC / 手机）共用。
 *
 * ## 为什么放 shared
 *
 * 「此刻该显示哪张背景」是个纯函数：给定设置、当前时间、可用的图，
 * 算出结果。两端各写一份的话，轮换的**相位**会不一致
 * （手机按 A 的算法、PC 按 B 的算法，同一时刻显示不同的图），
 * 而它们共用同一份 settings —— 用户会觉得「背景在两端乱跳」。
 *
 * ## 轮换怎么算
 *
 * 不存「轮到第几张」这种状态 —— 那样每次换设备、每次重置设置
 * 都要同步计数，很容易错位。改成**按时间片取模**：
 *
 *     序号 = floor(now / 间隔) % 池大小
 *
 * 好处：
 *   - 无状态，任何一端任何时刻算出的结果都一致
 *   - 刷新页面不会「重置到第一张」
 *   - 改了间隔或池子，下一拍自然生效
 *
 * 代价：从间隔中途开始看，会看到「已经轮到中间某张」而不是从头开始 ——
 * 但背景轮换本来就不需要「从头」，这个取舍是可接受的。
 */
import { ChatBackgroundMode } from './moyu.js'

/**
 * 把间隔钳到合理范围。
 *
 * 不钳的话，用户填 0 会让时间片宽度为 0（除零 / 每秒狂换），
 * 填 100000 会让轮换形同虚设且难以察觉。
 *
 * @param {unknown} minutes
 * @returns {number} 毫秒
 */
export function rotateIntervalMs(minutes) {
  const n = Number(minutes)
  const safe = Number.isFinite(n) && n > 0 ? n : 30
  const clamped = Math.min(24 * 60, Math.max(5, safe))
  return clamped * 60 * 1000
}

/**
 * 算出此刻该用哪张背景。
 *
 * @param {object}   args
 * @param {string}   args.mode     `off` / `fixed` / `rotate`
 * @param {string}   args.fixed    固定模式那张的路径
 * @param {string[]} args.pool     轮换候选池（路径数组）
 * @param {boolean[]} [args.available] 可选的「这张还在不在」判定
 *   —— 手机端的图要探测过才敢用。不传则视为全部可用。
 * @param {number}   [args.rotateMin] 轮换间隔（分钟）
 * @param {number}   [args.now]    当前时间戳（测试用）
 * @returns {string} 背景图路径；空字符串表示「不设背景」
 */
export function pickChatBackground({
  mode,
  fixed = '',
  pool = [],
  available,
  rotateMin = 30,
  now = Date.now(),
}) {
  if (mode === ChatBackgroundMode.ROTATE) {
    /*
     * 池子要**先滤掉不可用的**再取模。
     *
     * 反过来（先取模再滤）会导致空档：池里 3 张、其中第 2 张的文件
     * 没了，轮到第 2 张时算出个空路径，背景就闪一下消失 ——
     * 而用户没改任何设置，看起来像 bug。
     */
    const usable = (Array.isArray(pool) ? pool : []).filter((p) => p && (!available || available(p)))
    if (!usable.length) return ''
    const slot = Math.floor(now / rotateIntervalMs(rotateMin))
    /* 负数（时钟被回拨）取模会得到负索引，加一次长度兜住 */
    const idx = ((slot % usable.length) + usable.length) % usable.length
    return usable[idx]
  }

  if (mode === ChatBackgroundMode.FIXED) {
    if (!fixed) return ''
    /* 固定模式也要求这张还在 —— 否则设成裂图背景 */
    if (available && !available(fixed)) return ''
    return fixed
  }

  return ''
}
