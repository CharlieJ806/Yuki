/**
 * 主动搭话 —— 她会在挂机一段时间后自己开口。
 *
 * ## 桌面端已有，这份是给手机端的等价实现
 *
 * 桌面端在 `src/renderer/src/pet/PetApp.vue`（调度）+ `src/main/service.js`
 * （生成台词）里做了同一件事，但那是 Electron 主进程 + Vue 的组合，
 * 手机端（浏览器 PWA）两边都用不了。
 *
 * **共用的是这些（already in shared）**：
 *   - `CHATTER_SYSTEM_PROMPT` 提示词
 *   - `sanitizeChatter` 清洗模型输出
 *   - `recentDialogueMessages` 按真实 role 重建上下文
 *   - `IDLE_JITTER_MIN/MAX`、`idleIntervalScale` 抖动与关系倍率
 *
 * **这份新增的是「该不该说、说什么」的决策** —— 两端形态不同：
 * 桌面端只把台词显示在气泡里（说完就没了），手机端还要**落到聊天记录**，
 * 所以「什么时候开新话题」的规则要更明确（见 `buildChatterRequest`）。
 *
 * ## 什么时候「接着说」、什么时候「开新话题」
 *
 * 用户要求：「可以接着说，但如果很长时间没说话就提出新的」。
 * 判据是**最后一条消息距今的时间**：
 *   - < 2 小时：上下文还是热的，让她顺着聊（追问没说完的、接着上次情绪）
 *   - >= 2 小时：重新开个头，不要装作刚才还在聊
 *
 * 阈值放常量而不是写死进提示词，方便测试与调参。
 */
import {
  CHATTER_SYSTEM_PROMPT,
  sanitizeChatter,
  recentDialogueMessages,
  IDLE_JITTER_MIN,
  IDLE_JITTER_MAX,
  idleIntervalScale,
} from './interactions.js'

/**
 * 「还算接着聊」的时间窗。
 *
 * 2 小时：短于这个，对话的余温还在（追问「那你后来呢」很自然）；
 * 超过这个，用户多半已经切走做别的事了，再追问会显得她没眼力见。
 */
export const CHATTER_CONTINUE_WINDOW_MS = 2 * 60 * 60 * 1000

/** 挂机间隔的安全下限（防止设置成 0 时刷屏） */
export const CHATTER_MIN_MS = 30_000

/**
 * 算下一次主动搭话该等多久。
 *
 * 基准分钟数来自设置，乘两层系数：
 *   ① 随机抖动 —— 固定间隔像定时机器人
 *   ② 关系倍率 —— 越熟越黏人（`idleIntervalScale`）
 *
 * @param {object} args
 * @param {number} args.intervalMin 设置里的间隔（分钟）
 * @param {string} args.voice       关系档（stranger/familiar/...）
 * @returns {number} 毫秒
 */
export function nextChatterDelay({ intervalMin = 12, voice = 'familiar' } = {}) {
  const base = Math.max(0.5, Number(intervalMin) || 12) * 60_000 * idleIntervalScale(voice)
  const lo = Math.max(CHATTER_MIN_MS, base * IDLE_JITTER_MIN)
  const hi = Math.max(lo, base * IDLE_JITTER_MAX)
  return lo + Math.random() * (hi - lo)
}

/**
 * 组装「让她主动说一句」的请求。
 *
 * @param {object} args
 * @param {Array}  args.history     全部聊天记录（从 db.recentMessages 取）
 * @param {number} [args.now]       当前时间戳
 * @returns {{messages: Array, mode: 'continue'|'fresh', system: string}}
 *   `mode` 只用于日志/调试 —— 提示词已经按它写好了。
 */
export function buildChatterRequest({ history = [], now = Date.now() } = {}) {
  /*
   * 按真实 role 重建 —— 不能拼成一整条 user 文本。
   * 后者会让模型分不清哪句是自己说的（桌面端踩过：她对着自己说过的话发问）。
   */
  const context = recentDialogueMessages(history, 12, 1500)

  /*
   * 最后一条消息的时间 —— 判断「热不热」。
   * 注意要用**记录里的时间戳**而不是「她上次开口的时间」：
   * 用户可能一直在说话而她没回（不该发生，但防御一下更稳）。
   */
  const lastAt = history.length ? Number(history[history.length - 1].createdAt) || 0 : 0
  const stale = !lastAt || now - lastAt >= CHATTER_CONTINUE_WINDOW_MS

  /* 没有任何可用的对话上下文 —— 让她凭空开口，走「新话题」的通用引导 */
  if (!context.length) {
    return {
      mode: 'fresh',
      system: CHATTER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            '（我们有一阵子没聊了。随便对她说一句自然的话 —— ' +
            '可以是关心、可以是随口提一件你自己的事。只输出那句话本身。）',
        },
      ],
    }
  }

  /*
   * 两种引导语。
   *
   * 关键差别在**有没有前提「我们刚才在聊」**：
   * 说「现在突然想起一件事」会让她默认前面在聊，
   * 于是 2 小时后的开场白也写成「对了刚说到…」—— 对不上。
   */
  const nudge = stale
    ? '（你们上次聊天已经过去一阵子了。不要提刚才聊过什么，像突然想起对方一样开个头，' +
      '说一句只是想跟对方说的话。只输出那句话本身。）'
    : '（以上是你和我的真实聊天。现在突然想起一件事，对我说一句相关的话，只输出那句话本身。）'

  return {
    mode: stale ? 'fresh' : 'continue',
    system: CHATTER_SYSTEM_PROMPT,
    messages: [...context, { role: 'user', content: nudge }],
  }
}

/**
 * 清洗模型输出 —— 直接复用 shared 的实现，这里只做一层兜底。
 *
 * 单独包一下是为了**在手机端也能统一处理「模型返回空/只有标点」**：
 * 那种情况不该发出一个空气泡。
 */
export function cleanChatter(raw) {
  const line = sanitizeChatter(raw)
  if (!line) return ''
  /* 只剩标点/省略号的当成空 */
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(line)) return ''
  return line
}

/**
 * 模型不可用时的兜底台词。
 *
 * 为什么需要：用户可能没配 Key、或接口临时挂了。这时**不该静默什么都不做** ——
 * 表现成「开了主动搭话但从来不说话」，用户会以为功能坏了。
 * 用写死的短句兜住，至少能看到她在动。
 */
export const FALLBACK_CHATTER = [
  '…在忙吗',
  '有点无聊，你说点话嘛',
  '今天过得怎么样',
  '刚刚在想你',
  '诶，你在干嘛呢',
]
