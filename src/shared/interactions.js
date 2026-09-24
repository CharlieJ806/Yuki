/**
 * 桌宠互动台词库 + 选择逻辑。
 *
 * 纯函数/常量，无 DOM 依赖，便于单测。
 * 台词刻意写得短——桌宠气泡空间有限，长了会被截断。
 */
import { textOfContent } from './content.js'

/**
 * 主动冒泡的间隔抖动幅度（毫秒）。
 *
 * 用户设置的 petChatterInterval 是「基准分钟数」，实际间隔在
 * [基准 × 0.7, 基准 × 1.8] 之间随机，避免像定时机器人。
 * 只做抖动、不做下限兜底 —— 之前用 Math.max(IDLE_MIN_MS, base*0.6)，
 * 结果任何小于 13 分钟的设置都被 8 分钟下限吃掉，用户改了没反应。
 */
export const IDLE_JITTER_MIN = 0.7
export const IDLE_JITTER_MAX = 1.8

/** 久坐提醒间隔（毫秒），到点冒一句 */
export const SEDENTARY_INTERVAL_MS = 50 * 60 * 1000

/** 各交互场景的台词池 */
export const LINES = {
  /** 摸头（连续点击/长按） */
  pet: [
    '诶嘿…',
    '干嘛啦，突然摸头',
    '欸，好痒的',
    '……嗯，还行吧',
    '摸一次够啦！',
    '再摸要收费了哦',
  ],
  /** 单击 */
  poke: ['干嘛？', '嗯？', '怎么啦', '在的在的', '戳我干嘛'],
  /** 双击 */
  doubleTap: ['诶诶诶，两下！', '这么快？', '有事说事嘛～', '你想干嘛啦'],
  /** 拖拽放下后 */
  dragged: ['放我下来啦', '诶，搬家了？', '这里视野不错', '挪窝成功～'],
  /** 久坐提醒 */
  sedentary: [
    '坐好久了，起来走两步？',
    '腰不酸吗…去接杯水吧',
    '该动一动啦，别一直坐着',
    '伸个懒腰吧，我等你回来',
  ],
  /** 早上打招呼 */
  morning: ['早呀！今天也加油～', '早上好，吃早饭了吗', '早～今天状态怎么样'],
  /** 快到下班 */
  nearOffWork: ['快下班了吧？撑住！', '还有一会儿就解放啦', '今天辛苦咯，快结束了'],
  /** 已经下班 */
  offWork: ['下班啦！去玩吧 🎉', '辛苦一天了，好好休息', '终于结束了，快溜'],
  /** 刚上班 */
  workStart: ['开工咯，先摸会儿鱼再说', '上班时间到，假装很忙 😺'],
  /** 休息日 */
  restDay: ['今天休息，别想工作的事', '休息日就别看工作群啦', '躺平模式启动 🛌'],
  /** 随机闲聊（挂机主动说话） */
  idle: [
    '在忙吗？',
    '刚看到一个超好笑的东西，回头给你看',
    '今天第几杯咖啡了？',
    '偷偷告诉你，我一直在这儿陪着你',
    '要不要休息一下下',
    '我数了下，你今天摸鱼效率还可以',
    '记得喝水呀',
  ],
}

/** 亲密度等级：按累计互动次数划分 */
export const AFFINITY_LEVELS = [
  { min: 0, name: '有点眼熟', note: '刚开始相处' },
  { min: 10, name: '熟络起来了', note: '会主动搭话了' },
  { min: 40, name: '好朋友', note: '开始有点黏人' },
  { min: 120, name: '默契搭档', note: '懂你在想什么' },
  { min: 300, name: '形影不离', note: '已经离不开彼此' },
]

/** 等级索引 → 关系语气档位（见 AFFINITY_VOICE） */
const VOICE_BY_LEVEL = ['stranger', 'familiar', 'friend', 'close', 'intimate']

/**
 * 亲密度上限。桌宠是「处出来的」，无限涨会让等级卡在最后一档、
 * 进度条也一直是满的，于是数值本身失去意义。到顶后再互动只加天数不加点。
 */
export const AFFINITY_MAX_POINTS = AFFINITY_LEVELS[AFFINITY_LEVELS.length - 1].min

/** 每种互动给多少点：贴贴/poke 给得少，来回聊天给得多 */
export const AFFINITY_GAIN = {
  click: 1,
  double: 2,
  pet: 2,
  /** 每条用户消息 —— 对话才是真正处关系的地方 */
  chatMessage: 2,
  /** 一轮问答结束（回复成功落库），把「聊完一次」再记一笔 */
  chatRound: 3,
  /** 每日见面 */
  daily: 1,
}

/**
 * 每天**所有来源合计**最多涨多少点。
 *
 * 早先只封聊天（`chatMessage`/`chatRound`），点击/摸头不计 ——
 * 于是「一直点立绘」能无限涨，一天点 300 下就能从「有点眼熟」
 * 冲到「默契搭档」，等级推进完全失去节奏。
 *
 * 现在全来源合计封顶。60 点约等于「聊 12 轮」或「点 60 下」，
 * 是「认真互动一会儿」的量级，不至于随手就满。
 */
export const AFFINITY_DAILY_CAP = 60

/** 兼容旧名（桌面端还在用） */
export const CHAT_AFFINITY_DAILY_CAP = AFFINITY_DAILY_CAP

/**
 * 亲密度**下降**规则。
 *
 * ## 为什么要有下降
 *
 * 只会涨的关系没有张力 —— 用户没有任何理由「记得回来看看」，
 * 而且「惹她生气」也不会有任何代价（说错话只影响这一轮的回复）。
 * 加上下降之后，亲密度才真正表示「最近处得怎么样」。
 *
 * ## 两条规则
 *
 *   ① 久未互动：超过 `IDLE_DAYS` 天后，每天扣 `IDLE_DECAY_PER_DAY` 点
 *   ② 惹她生气：当次聊天扣 `UPSET_PENALTY` 点（见 `affinityPenalty`）
 *
 * 都取**小额度**：扣得比涨得慢，正常用不会掉档；
 * 只有长期不管或反复惹她才会真的降级。
 */
export const AFFINITY_DECAY = {
  /** 多少天没互动开始衰减 */
  IDLE_DAYS: 3,
  /** 之后每天扣多少点 */
  IDLE_PER_DAY: 1,
  /** 单次惹她生气的扣分 */
  UPSET: 2,
}

export function affinityLevel(points) {
  const p = Math.max(0, Number(points) || 0)
  let idx = 0
  for (let i = 0; i < AFFINITY_LEVELS.length; i++) if (p >= AFFINITY_LEVELS[i].min) idx = i
  const cur = AFFINITY_LEVELS[idx]
  const next = AFFINITY_LEVELS[idx + 1] ?? null
  return {
    level: cur,
    index: idx,
    voice: VOICE_BY_LEVEL[idx],
    isMax: !next,
    next,
    toNext: next ? next.min - p : 0,
    progress: next ? Math.max(0, Math.min(100, ((p - cur.min) / (next.min - cur.min)) * 100)) : 100,
  }
}

/**
 * 单次互动该记多少点：受上限与「聊天日上限」双重约束。
 *
 * 聊天另设日上限的原因：一次对话几十条消息，不设的话一天就能从
 * 「有点眼熟」冲到「默契搭档」，等级推进完全失去节奏。
 * 摸头/双击这类手动互动不受日上限影响。
 *
 * @param {{ points?:number, lastDay?:string|null, chatDay?:string|null, chatToday?:number }} affinity
 * @param {number} delta 本次想加的点
 * @param {string} today 'YYYY-MM-DD'
 * @param {{ chat?: boolean, chatCap?: number, max?: number }} [opts]
 */
export function affinityGain(affinity, delta, today, opts = {}) {
  const max = Number(opts.max) || AFFINITY_MAX_POINTS
  const want = Math.max(0, Math.floor(Number(delta) || 0))
  if (want === 0) return 0

  const cur = Math.max(0, Number(affinity?.points) || 0)
  const room = Math.max(0, max - cur)
  if (room === 0) return 0

  /*
   * 当日已用掉的额度。
   *
   * `gainDay` 是**所有来源**共用的计数日；`chatDay`/`chatToday` 是
   * 早期的「只算聊天」字段，保留读取是为了让升级前已有的数据
   * 不会在当天突然多出一条额度（那天前半段的聊天没被计入新的日额度）。
   */
  const usedToday =
    affinity?.gainDay === today
      ? Number(affinity.gainToday) || 0
      : affinity?.chatDay === today
        ? Number(affinity.chatToday) || 0
        : 0

  const cap = Number(opts.cap) || AFFINITY_DAILY_CAP
  return Math.min(Math.min(want, room), Math.max(0, cap - usedToday))
}

/**
 * 算「久未互动」该扣多少点。
 *
 * ## 语义
 *
 * 从 `lastActive`（最后一次互动那天）到今天，**超过 IDLE_DAYS 之后**
 * 的每一天扣一点。不是「一次性扣一大笔」——
 * 那样用户隔一周回来会发现直接掉了一档，很像惩罚；
 * 而「每天慢慢掉」的感觉是「关系在淡」，更符合直觉，也更容易挽回。
 *
 * ## 只结算「上次结算到哪」
 *
 * 用 `decayDay` 记录「衰减已经算到哪一天」，
 * 否则同一天内每次互动都会重算一遍、反复扣。
 *
 * @param {object} affinity 亲密度记录
 * @param {string} today 'YYYY-MM-DD'
 * @returns {number} 本次该扣的点（0 表示不扣）
 */
export function affinityDecay(affinity, today) {
  const last = affinity?.lastActive
  if (!last || !today) return 0

  const days = daysBetween(last, today)
  if (days <= AFFINITY_DECAY.IDLE_DAYS) return 0

  /*
   * 已经结算过的部分不再扣。
   * `decayDay` 为空说明从没结算过 —— 那时从「开始衰减的第一天」算起。
   */
  const settled = Number(affinity?.decaySettledDays) || 0
  const totalIdleDays = days - AFFINITY_DECAY.IDLE_DAYS
  const pending = Math.max(0, totalIdleDays - settled)
  return pending * AFFINITY_DECAY.IDLE_PER_DAY
}

/**
 * 今天到「上次结算」之间隔了几天。
 *
 * 用 UTC 零点算差再取整，避免夏令时/时区导致的 23h/25h 误差
 * （那种情况下 `Math.round` 也够用，但用 UTC 更干净）。
 */
function daysBetween(fromKey, toKey) {
  const [y1, m1, d1] = String(fromKey).split('-').map(Number)
  const [y2, m2, d2] = String(toKey).split('-').map(Number)
  if (!y1 || !y2) return 0
  const a = Date.UTC(y1, m1 - 1, d1)
  const b = Date.UTC(y2, m2 - 1, d2)
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

/**
 * 「惹她生气」的判定词 —— **专门的一套，不能复用现有的情绪关键词**。
 *
 * ## 为什么不能复用 `CHAT_ACTION_RULES` 的 angry/cry
 *
 * 那两组是「**用户表达自己的情绪**」：
 *   angry → 好气 / 烦死 / 气死
 *   cry   → 想哭 / 委屈 / 好惨
 *
 * 这些是用户在诉苦，她的正确反应是**安慰**。
 * 拿它判定「惹她生气」会完全反过来 ——
 * 用户说「今天好委屈」，结果亲密度被扣，这是明确的误伤。
 *
 * ## 这套词只收「针对她」的冒犯
 *
 * 骂她、贬低她、冷暴力、赶她走。语气上的不耐烦（「烦死了」）
 * 不算 —— 那多半是在说别的事，不是冲她。
 *
 * 词表刻意保守：**宁可漏判也不误判** —— 误扣亲密度是让人恼火的 bug，
 * 漏判只是少一次惩罚。
 */
const UPSET_WORDS = [
  /* 直接的否定与谩骂 */
  '讨厌你', '烦你', '滚开', '走开', '别烦我', '闭嘴', '你很烦', '你好烦',
  '不喜欢你', '不想理你', '别理我', '不理你了',
  /* 贬低 */
  '你真笨', '你好蠢', '真没用', '废物', '垃圾', '傻逼', '神经病',
  /* 冷暴力 / 赶走 */
  '别来找我', '不要你了', '换个', '卸载你', '删了你', '不要你了',
  /* 分手式的 */
  '不想跟你说话', '再也不想见',
]

/**
 * 这轮用户消息是否「惹她生气」。
 *
 * 只看**用户说的话** —— 她的回复里出现「生气」不算
 * （她在描述自己的情绪，不是用户在惹她）。
 *
 * @param {string} text 用户这轮发的内容
 * @returns {boolean}
 */
export function isUpsetting(text) {
  const s = String(text ?? '')
  if (!s) return false
  return UPSET_WORDS.some((w) => s.includes(w))
}

/** 单次惹她生气该扣多少 */
export function affinityPenalty(upsetting) {
  return upsetting ? AFFINITY_DECAY.UPSET : 0
}

/**
 * 结算一次亲密度变化 —— **两端共用**，保证 PC 和手机的规则完全一致。
 *
 * ## 为什么合成一个函数
 *
 * 一次互动要处理四件事：加、减、每日额度、久未互动的衰减。
 * 两端各写一遍的话，任何一处改规则（比如调整衰减天数）
 * 都要记得改两处 —— 而漏改的表现是「手机上掉了 3 点、电脑上只掉 1 点」，
 * 用户根本没法理解为什么。
 *
 * ## 结算顺序（有讲究）
 *
 *   ① 先算**久未互动的衰减**（基于上次互动日期）
 *   ② 再算**本次互动**（加 or 扣）
 *
 * 不能反过来：如果先加、再按「上次互动日期」算衰减，
 * 而这次互动刚好把日期推到了今天，衰减就永远算不出来了。
 *
 * ## 不变量
 *
 *   - 结果夹在 `[0, AFFINITY_MAX_POINTS]`
 *   - `lastActive` 与 `gainDay` 只在**有正向互动**时推进
 *     （纯扣分不该刷新「最近活跃」，否则冷暴力期间永远不会衰减）
 *
 * @param {object} affinity 当前记录
 * @param {object} args
 * @param {string} args.today 'YYYY-MM-DD'
 * @param {number} [args.delta] 想加的点
 * @param {boolean} [args.upsetting] 这轮是否惹她生气了
 * @returns {{points:number, gainDay:string, gainToday:number, lastActive:string, decaySettledDays:number, gained:number, lost:number}}
 */
export function settleAffinity(affinity = {}, { today, delta = 0, upsetting = false } = {}) {
  const max = AFFINITY_MAX_POINTS
  const cur = Math.max(0, Math.min(max, Number(affinity.points) || 0))

  /* ---------- ① 久未互动的衰减 ---------- */
  const days = affinityDecay(affinity, today)
  /*
   * 衰减按「累计待扣天数」结算，并记下已结算到哪一天 ——
   * 否则同一天里每次互动都会重算一遍、反复扣。
   */
  const idleDays = affinity?.lastActive
    ? Math.max(0, daysBetween(affinity.lastActive, today) - AFFINITY_DECAY.IDLE_DAYS)
    : 0
  const lost = Math.min(cur, days)
  let points = cur - lost

  /* ---------- ② 本次互动 ---------- */
  /*
   * 惹她生气那轮**只扣不加**。
   *
   * 早先是「先扣 2 再按互动加分」，两者互相抵消 ——
   * 说一句「讨厌你」净变化 0，等于没有惩罚。
   * 现在生气当次的加分直接清零：这一轮就是负收益。
   */
  const upsetLoss = Math.min(points, affinityPenalty(upsetting))
  points -= upsetLoss

  /*
   * 当日已用额度。
   *
   * **必须先判断「计数器是不是今天的」**，否则跨天不会重置：
   * 第 2 天读到的还是第 1 天的 `gainToday: 60`，额度判定为「已用完」，
   * 于是 `gained` 永远是 0、`gainDay` 永远不推进 —— 卡死在第一天。
   * （这个 bug 的表现是「每天只能涨第一天的量」，很隐蔽。）
   *
   * 旧字段 `chatDay/chatToday` 也要认：升级当天的额度
   * 不能因为换了字段名而凭空重置一截。
   */
  const sameDay = affinity.gainDay === today
  const legacySameDay = !sameDay && affinity.chatDay === today
  const usedToday = sameDay
    ? Number(affinity.gainToday) || 0
    : legacySameDay
      ? Number(affinity.chatToday) || 0
      : 0

  const gained = upsetting
    ? 0
    : affinityGain({ ...affinity, points }, delta, today, { usedToday })
  points = Math.min(max, points + gained)

  /*
   * 有正向互动才推进「最近活跃」——
   * 惹她生气那天不算「互动」，否则冷暴力不会触发衰减。
   */
  const activeToday = gained > 0
  const lastActive = activeToday ? today : (affinity.lastActive ?? today)

  return {
    points,
    /*
     * 当日额度计数：有加才累计。
     * 用 `gainDay/gainToday` 而不是沿用旧的 `chatDay/chatToday` ——
     * 后者的名字带「chat」，现在点击/摸头也计入，叫那个名会误导。
     */
    gainDay: gained > 0 ? today : (sameDay || legacySameDay ? today : affinity.gainDay),
    gainToday: gained > 0 ? usedToday + gained : sameDay ? Number(affinity.gainToday) || 0 : 0,
    lastActive,
    decaySettledDays: idleDays,
    gained,
    /* 扣的总数（衰减 + 惹怒），调用方要用它决定要不要提示用户 */
    lost: lost + upsetLoss,
  }
}

/**
 * 从台词池里随机取一句，尽量不重复上一句（避免连续两次一样显得呆）。
 */
export function pickLine(pool, lastLine = null, rand = Math.random) {
  if (!Array.isArray(pool) || pool.length === 0) return ''
  if (pool.length === 1) return pool[0]
  const candidates = pool.filter((l) => l !== lastLine)
  return candidates[Math.floor(rand() * candidates.length)]
}

/* ---------- 服饰系统 ---------- */

/**
 * 服饰注册表。
 *
 * 和动作立绘（`PET_EXPRESSIONS`）是**两个正交维度**：
 *   - 动作决定「她在做什么」（摸鱼 / 睡觉 / 生气…）
 *   - 服饰决定「她穿什么」（常服 / 睡衣 / 旗袍…）
 *
 * 源素材里每套衣服只有一张图（不是每个动作都有一套），
 * 所以服饰不能当动作立绘用 —— 那样换装后表情就全失效了。
 * 这里的用法是：
 *   1. 挂机轮换池的候选（`outfit-*` 前缀的图直接参与轮换）
 *   2. 对话窗旁边的小立绘，按时间自动换 + 可手动指定
 *
 * slug 必须与 `resources/pet/manifest.json` 里的 outfit 条目一致
 * （由 `scripts/install-pet-assets.js` 从 resources/raw-cut 生成）。
 */
export const OUTFITS = [
  /* 便服系列：都是「出门穿」的，风格不同 */
  { slug: 'jk', label: 'JK 制服', emoji: '🎒', hint: '白衬衫黑背心裙，她最常穿的那套' },
  { slug: 'casual-red', label: '红外套', emoji: '🧥', hint: '红色外套配短裙' },
  { slug: 'casual-lace', label: '荷边裙', emoji: '👗', hint: '白色荷叶边连衣裙' },
  { slug: 'casual-mono', label: '黑白裙', emoji: '🖤', hint: '白衬衫配黑裙，很利落' },
  { slug: 'casual-dark', label: '深色制服', emoji: '🎩', hint: '深色制服西装' },

  /* 睡衣系列：都是「在家躺平穿」的 */
  { slug: 'pajamas', label: '睡裙', emoji: '🛌', hint: '灰色连帽家居裙' },
  { slug: 'pajamas-black', label: '黑吊带', emoji: '🌙', hint: '黑色吊带配长袜，抱着猫' },
  { slug: 'pajamas-pink', label: '粉吊带', emoji: '🎀', hint: '粉色蕾丝吊带睡裙' },
  { slug: 'pajamas-bodysuit', label: '连体衣', emoji: '💤', hint: '灰色连体睡衣，盘腿坐着' },
  { slug: 'pajamas-shorts', label: '短睡裙', emoji: '🌸', hint: '粉色短睡裙，抱着猫' },

  /* 特色款 */
  { slug: 'camisole', label: '吊带', emoji: '✨', hint: '白色吊带配牛仔短裤' },
  { slug: 'longskirt', label: '长裙', emoji: '💃', hint: '紫色长裙，出门约会' },
  { slug: 'qipao', label: '旗袍', emoji: '🧧', hint: '开叉旗袍，正式场合' },
  { slug: 'nun', label: '修女', emoji: '⛪', hint: '修女服，偶尔的神奇搭配' },
  { slug: 'swimsuit', label: '泳装', emoji: '🏖️', hint: '白色沙滩泳装配草帽' },
  { slug: 'campus', label: '清纯校园', emoji: '🌸', hint: '米色开衫配百褶裙' },
  { slug: 'campus-idol', label: '校园偶像', emoji: '🎤', hint: '社团晚会上台的样子' },
  { slug: 'idol', label: '偶像风格', emoji: '🌟', hint: '想当一次舞台主角' },
  { slug: 'maid', label: '女仆', emoji: '🫖', hint: '女仆咖啡店体验' },

  /* 节日 / 场合款 */
  { slug: 'xmas', label: '圣诞装', emoji: '🎄', hint: '圣诞红裙配驯鹿发饰' },
  { slug: 'newyear', label: '新年旗袍', emoji: '🏮', hint: '红金旗袍，过年穿的' },
  { slug: 'gown', label: '礼服', emoji: '👑', hint: '露肩晚宴礼服' },
  { slug: 'formal', label: '西装', emoji: '💼', hint: '深色西装套裙' },
  { slug: 'raincoat', label: '风衣', emoji: '☔', hint: '米色风衣配雨伞' },
]

/** 默认（时间自动模式下无从判断时）穿哪套 —— 用设定图的常服 */
export const DEFAULT_OUTFIT = 'jk'

export const OUTFIT_SLUGS = OUTFITS.map((o) => o.slug)

/** 服饰 key -> 图片文件名 */
export function outfitFile(slug) {
  const s = OUTFIT_SLUGS.includes(slug) ? slug : DEFAULT_OUTFIT
  return `yuki-outfit-${s}.png`
}

/**
 * 时段 → 该穿哪一类。
 *
 * 只做「一眼就知道该换」的时段，不做精细日程 —— 换装是氛围，
 * 猜得太细反而容易不合时宜。
 */
const DAY_PARTS = [
  { from: 23, to: 7, kind: 'sleep' }, // 深夜/凌晨
  { from: 7, to: 9, kind: 'home' },   // 早晨刚起
  { from: 9, to: 18, kind: 'day' },   // 白天
  { from: 18, to: 21, kind: 'eve' },  // 傍晚
  { from: 21, to: 23, kind: 'home' }, // 晚上在家
]

export function dayPartOf(now = new Date()) {
  const h = now.getHours()
  for (const p of DAY_PARTS) {
    /* 23→7 是跨零点的区间，不能用 from <= h < to */
    if (p.from > p.to ? h >= p.from || h < p.to : h >= p.from && h < p.to) return p.kind
  }
  return 'day'
}

/**
 * 每套装扮适合哪个时段。
 *
 * 用途：从**已解锁的**衣服里挑一套「此刻合适」的 ——
 * 让自动模式也能穿到各种衣服（包括 JK、旗袍这些），
 * 而不再是全天只有睡衣/居家服/便服三套。
 *
 * 这不只是好看：解锁条件里有「刚好穿着某套」这类判定，
 * 自动模式永远只穿那 3 套的话，这类条件几乎不可能成立。
 */
const OUTFIT_DAY_PARTS = {
  pajamas: ['sleep', 'home'],
  'pajamas-black': ['sleep', 'home'],
  'pajamas-pink': ['sleep', 'home'],
  'pajamas-bodysuit': ['home', 'sleep'],
  'pajamas-shorts': ['sleep', 'home'],
  jk: ['day'],
  'casual-red': ['day', 'eve'],
  'casual-lace': ['day', 'eve'],
  'casual-mono': ['day', 'eve'],
  'casual-dark': ['day', 'eve'],
  camisole: ['home', 'day'],
  longskirt: ['eve', 'day'],
  qipao: ['eve', 'day'],
  nun: ['day', 'eve'],
  swimsuit: ['day'],
  campus: ['day'],
  'campus-idol': ['day', 'eve'],
  idol: ['eve', 'day'],
  maid: ['day'],
  xmas: ['eve', 'home'],
  newyear: ['eve', 'day'],
  gown: ['eve'],
  formal: ['day'],
  raincoat: ['day', 'eve'],
}

/**
 * 挑一套此刻合适的衣服。
 *
 * @param {Date} now
 * @param {string[]} [unlocked] 已解锁的 slug；不给则回落旧的三套规则
 * @returns {string} outfit slug
 */
export function outfitForTime(now = new Date(), unlocked = null) {
  const part = dayPartOf(now)

  /* 没给解锁清单（老调用点）时按类别回落，避免影响既有测试 */
  if (!Array.isArray(unlocked) || !unlocked.length) {
    if (part === 'sleep' || part === 'home') return 'pajamas'
    return DEFAULT_OUTFIT
  }

  const fit = unlocked.filter((s) => (OUTFIT_DAY_PARTS[s] ?? ['day']).includes(part))
  const pool = fit.length ? fit : unlocked
  /*
   * 挑哪套：同一天同一时段内**稳定不闪**，换天或换时段才变。
   *
   * 早先用 `Number(`${h}${date}`) % pool.length` 当种子 —— 那是假的：
   * 日期固定时 h*100 恒为偶数，加偶数日期仍偶数，模 2 永远是 0。
   * 结果「解锁了 JK 却永远穿 casual」（实测发现）。
   *
   * 改用真正的混合：把「年-月-日-小时」压成一个数再散列，
   * 相邻小时/日期的结果不再有固定奇偶性。
   */
  const key = now.getFullYear() * 1e6 + (now.getMonth() + 1) * 1e4 + now.getDate() * 100 + now.getHours()
  let h32 = (key ^ 0x9e3779b9) >>> 0
  h32 = Math.imul(h32 ^ (h32 >>> 15), 0x85ebca6b) >>> 0
  h32 = Math.imul(h32 ^ (h32 >>> 13), 0xc2b2ae35) >>> 0
  /*
   * 最后一步必须再 `>>> 0`：JS 的位运算返回**有符号 int32**，
   * 直接取模会得到负索引 -> `pool[-23]` = undefined -> 换装静默失效
   * （实测 h=10 时 idx 为 -17，立绘不显示）。
   */
  const idx = ((h32 ^ (h32 >>> 16)) >>> 0) % pool.length
  return pool[idx]
}

/** 服饰 key -> 展示信息（未知 key 回落默认） */
export function outfitInfo(slug) {
  return OUTFITS.find((o) => o.slug === slug) ?? OUTFITS.find((o) => o.slug === DEFAULT_OUTFIT)
}

/* ---------- 挂机台词：结合最近对话生成 ---------- */

/**
 * 生成挂机台词时给模型的系统提示词。
 *
 * 这里必须写清「哪些话是你自己说的」—— 历史按 role 如实重建（assistant = 你），
 * 但模型仍可能把自己的话当成用户的来追问，所以显式约束一次。
 */
export const CHATTER_SYSTEM_PROMPT = [
  '你要以第一人称，对「用户」说一句**突然想起某件旧事**的话，语气自然、口语。',
  '',
  '【回顾聊天记录时注意】',
  '- 记录里 role=assistant 的话是**你自己说过的**，role=user 才是用户说的。',
  '- 绝对不要追问你自己说过的话。比如「我今天好累」是你说的，',
  '  就不能冒出「你今天是不是很累呀？」这种话 —— 那是在对着自己发问。',
  '- 要提就该提**用户**说过的事，或者顺着你自己说过的话继续讲（比如「刚说不困，现在有点困了」）。',
  '',
  '【硬性要求】',
  '1. 只输出那一句话本身，不要引号、不要解释、不要任何前后缀。',
  '2. 最多 30 个字，一句话，不要写小作文。',
  '3. 内容必须和上面的聊天记录有实际关联：可以是追问一个用户没说完的话题、',
  '   提到用户讲过的具体事情、或者顺着上次的情绪接着讲。',
  '4. 不要编造聊天记录里不存在的人名、地点、事件、数字。',
  '   记录里没提过的细节一律不许自己加。',
  '5. 不要复述原话，要像过了一阵子又想起来那样自然提起。',
  '6. 不要说「刚才」「你之前说」这种机械的指代，直接讲那件事。',
].join('\n')

/**
 * 把最近对话重建成**真实角色**的消息数组，供挂机台词当上下文。
 *
 * 为什么不能把整段记录拼成一条 user 文本：那样模型看到的是「用户转述的聊天记录」，
 * 于是分不清哪句是自己说的 —— 表现为她会对着自己说过的话发问（用户反馈的实际问题）。
 * 按 role 重建后，assistant 的消息就是她自己的话，模型天然不会去追问。
 *
 * 注意 `store.recentMessages` 返回的是时间正序，这里保持正序，
 * 因为 OpenAI 兼容接口要求 messages 按时间顺序排列。
 *
 * @returns {{role:'user'|'assistant', content:string}[]}
 */
export function recentDialogueMessages(messages, limit = 12, maxChars = 1500) {
  if (!Array.isArray(messages)) return []
  const rows = messages
    /*
     * 用 textOfContent 而不是直接读 content：图文消息的 content 是块数组，
     * 直接当字符串用会得到 "[object Object]" 之类的垃圾喂给模型。
     * 挂机台词只参考文字部分就够了 —— 它要的是「聊了什么」，不是「图长什么样」。
     */
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && textOfContent(m?.content).trim())
    .slice(-Math.max(1, limit))
    .map((m) => ({ role: m.role, content: textOfContent(m.content).trim() }))

  /* 按字符预算从最早的开始丢，至少保留最后一条 */
  let total = rows.reduce((n, m) => n + m.content.length, 0)
  while (total > maxChars && rows.length > 1) {
    total -= rows.shift().content.length
  }
  return rows
}

/**
 * 清理模型返回的台词：去掉引号/前缀/多行，限制长度。
 * 模型经常无视「只输出一句话」，这里兜一层。
 */
export function sanitizeChatter(raw, maxLen = 40) {
  let s = String(raw ?? '').trim()
  if (!s) return ''
  /* 去掉 markdown 代码块围栏 */
  s = s.replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '').trim()
  /* 去掉「Yuki：」「台词：」这类前缀 */
  s = s.replace(/^(Yuki|我|回复|台词|输出)\s*[:：]\s*/i, '')
  /* 只取第一行有效内容（模型常无视「只输出一句」） */
  s = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] ?? ''
  /* 去掉列表符 */
  s = s.replace(/^[-•*]\s*/, '').trim()
  /*
   * 去掉成对包裹的引号/括号。
   * 覆盖：ASCII 双引号、单引号、中英文弯引号、直角引号「」、书名号《》
   */
  const pairs = [
    ['"', '"'], ["'", "'"],
    ['\u201c', '\u201d'], ['\u2018', '\u2019'],
    ['\u300c', '\u300d'], ['\u300e', '\u300f'],
    ['\u300a', '\u300b'],
  ]
  let changed = true
  while (changed) {
    changed = false
    for (const [open, close] of pairs) {
      if (s.length > 1 && s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, s.length - close.length).trim()
        changed = true
      }
    }
  }
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`
  return s
}

/**
 * 根据当前时间/状态挑选「情境台词」。
 * 优先级：休息日 > 下班 > 临近下班 > 刚上班 > 早上
 * @returns {{ key: string, pool: string[] } | null}
 */
export function contextualScene(snapshot, now = new Date()) {
  const h = now.getHours()
  const m = now.getMinutes()
  const mins = h * 60 + m

  if (snapshot?.restDay) return { key: 'restDay', pool: LINES.restDay }

  const toMin = (hhmm) => {
    const [hh, mm] = String(hhmm ?? '').split(':').map(Number)
    return (hh || 0) * 60 + (mm || 0)
  }
  const start = toMin(snapshot?.workStart)
  const end = toMin(snapshot?.workEnd)

  if (mins >= end) return { key: 'offWork', pool: LINES.offWork }
  if (mins >= end - 30) return { key: 'nearOffWork', pool: LINES.nearOffWork }
  if (mins >= start && mins <= start + 20) return { key: 'workStart', pool: LINES.workStart }
  if (mins < 10 * 60) return { key: 'morning', pool: LINES.morning }
  return null
}

/* ---------- 表情 / 姿态 ---------- */

/**
 * 立绘注册表。每个 key 对应 `src/renderer/public/yuki-<slug>.png`。
 *
 * 分两类用途：
 *   - 状态类（mood）：由工作/休息状态决定，长期显示
 *   - 表情类（emote）：由互动临时触发，配合台词结束后恢复
 */
export const PET_EXPRESSIONS = {
  /* 状态类 */
  work: 'read', // 抱书看，摸鱼进行中（在「做事」）
  happy: 'pose2', // 站着笑，已赚满 / 心情好
  rest: 'pose3', // 坐椅子上闭眼歇着，休息日
  idle: 'pose4', // 站姿安静，尚未开工

  /* 表情类 */
  shy: 'shy', // 摸头 / 贴贴
  angry: 'angry', // 连点太多
  think: 'think', // 等待回复
  sleep: 'sleep', // 深夜 / 长时间无操作
  jump: 'jump', // 补卡成功（一次补齐多天）
  heart: 'heart', // 打招呼 / 高亲密度
  surprise: 'surprise', // 双击
  shrug: 'shrug', // 久坐提醒 / 下班

  /* 生活化动作：挂机时轮换，显得像真人在旁边做事 */
  snack: 'snack', // 吃零食，摸鱼进行中
  music: 'music', // 戴耳机，挂机听歌
  coffee: 'coffee', // 递咖啡，久坐 / 提醒喝水
  wave: 'wave', // 挥手再见，退出前
  yawn: 'yawn', // 打哈欠，早八 / 深夜
  thumbsup: 'thumbsup', // 竖大拇指，打卡成功

  /* 第二批动作
   * 与 `pose1..4` 这类「状态立绘」不同，这些是**具体行为**，
   * 适合由事件触发，或进挂机池当「她自己在忙」 */
  stretch: 'stretch', // 伸懒腰，久坐之后
  clap: 'clap', // 拍手，打卡成功 / 完成目标
  read: 'read', // 看书，安静陪伴
  nod: 'nod', // 点头认可
  laugh: 'laugh', // 笑，聊到开心的事
  cry: 'cry', // 抱膝哭，被冷落 / 加班太久
  doze: 'pose1', // 趴课桌打盹，挂机太久 / 午后犯困
}

/** 状态类表情（由 snapshot 决定） */
export const MOOD_KEYS = ['work', 'happy', 'rest', 'idle']

/** 全部表情 key（状态 + 表情），供对账用 */
export const PET_EXPRESSIONS_KEYS = Object.keys(PET_EXPRESSIONS)

/** 表情类表情（由互动临时触发） */
export const EMOTE_KEYS = [
  'shy', 'angry', 'think', 'sleep', 'jump', 'heart', 'surprise', 'shrug',
  'snack', 'music', 'coffee', 'wave', 'yawn', 'thumbsup',
  'stretch', 'clap', 'read', 'nod', 'laugh', 'cry', 'doze',
]

/**
 * 挂机轮换的**动作**立绘。
 *
 * 原来 18 张动作图里有 9 张只能靠手动互动触发，不点就永远看不到；
 * 挂机只轮换固定 4 张，其他基本是废资源。现在按亲密度分批解锁 ——
 * 既让图用起来，又给关系推进一个看得见的变化：越熟她在你面前越放松。
 *
 * 这是最低档的池子（刚认识时只敢有这些动作），完整阶梯见上表。
 * 注意每张图都得适配「自己待着」的语义：举手、竖大拇指这类
 * 必须由事件触发（打卡成功），放挂机池里会很突兀，所以不收进来。
 */
export const IDLE_POSES = ['snack', 'music', 'think', 'read']

/** 挂机动作：按关系档位解锁 */
export const IDLE_POSES_BY_VOICE = {
  stranger: IDLE_POSES,
  familiar: [...IDLE_POSES, 'coffee', 'nod', 'doze'],
  friend: [...IDLE_POSES, 'coffee', 'nod', 'doze', 'shrug', 'heart', 'stretch'],
  close: [...IDLE_POSES, 'coffee', 'nod', 'doze', 'shrug', 'heart', 'stretch', 'surprise', 'shy', 'laugh'],
  intimate: [...IDLE_POSES, 'coffee', 'nod', 'doze', 'shrug', 'heart', 'stretch', 'surprise', 'shy', 'laugh', 'sleep', 'yawn'],
}

/**
 * 挂机轮换的**服饰**。
 *
 * 服饰和动作是正交维度，但都进同一个轮换池 —— 她待着的时候不只是换动作，
 * 也会换身衣服，看起来更像有自己生活的真人。
 *
 * 刚认识时只穿常服，熟了才慢慢解锁别的：一上来就泳装/修女很奇怪。
 * 用 `outfitsFor` 取；返回的是服饰 slug，前端按 `outfitFile()` 拼文件名。
 */
export const OUTFITS_BY_VOICE = {
  stranger: [],
  familiar: ['jk'],
  friend: ['jk', 'casual-red', 'casual-lace', 'pajamas'],
  close: ['jk', 'casual-red', 'casual-lace', 'casual-mono', 'casual-dark', 'pajamas', 'camisole', 'longskirt'],
  intimate: OUTFIT_SLUGS,
}

/**
 * 取当前关系档位可用的挂机动作池。
 * 未知档位回落到最低档（宁可少解锁，也不要给新用户看到最亲密的动作）。
 */
export function idlePosesFor(voice = 'stranger') {
  return IDLE_POSES_BY_VOICE[voice] ?? IDLE_POSES_BY_VOICE.stranger
}

/** 取当前关系档位可用的服饰池（可能为空：刚认识时不换装） */
export function outfitsFor(voice = 'stranger') {
  return OUTFITS_BY_VOICE[voice] ?? OUTFITS_BY_VOICE.stranger
}

/**
 * 挂机轮换的完整候选：动作 + 服饰。
 *
 * 服饰项带 `outfit:` 前缀以区分 —— 两者取图逻辑不同
 * （动作走 `expressionFile`，服饰走 `outfitFile`）。
 */
export function idleCandidatesFor(voice = 'stranger') {
  return [...idlePosesFor(voice), ...outfitsFor(voice).map((s) => `outfit:${s}`)]
}

/**
 * 深夜/早八时段把困倦类动作的权重抬高，但**不排除**其他项。
 *
 * 之前用的是硬过滤（`filter(TIRED_POSES)`），代价是：
 * 深夜 23:00–09:00 占一天近 10 小时，期间 snack/music/shrug/heart… 全被排除，
 * 「每个都会轮换用到」直接不成立 —— 满级池从 19 项掉到 12 项，
 * 最低档更是只剩 2 项，轮换几乎看不出变化。
 *
 * 改成加权：困倦项出现概率 × N，其他照旧偶尔出现。
 * 这样既保留了「深夜更困」的感觉，又保证每张图都会被用到。
 */
export const TIRED_POSE_WEIGHT = 4

/**
 * 构造加权抽选池：把权重大于 1 的项重复若干次。
 *
 * 用重复填充而不是改 `pickLine` 签名 —— `pickLine` 是通用工具，
 * 为了一个场景给它加权重参数会污染所有调用方。
 *
 * @param {string[]} candidates 候选池
 * @param {(item:string)=>boolean} isTired 该项是否属于「困倦」类
 * @param {number} [weight]
 */
export function weightedPool(candidates, isTired, weight = TIRED_POSE_WEIGHT) {
  const list = Array.isArray(candidates) ? candidates : []
  if (!(weight > 1)) return [...list]
  const out = []
  for (const item of list) {
    out.push(item)
    if (isTired(item)) {
      /* 额外补 weight-1 份，让概率随份数线性放大 */
      for (let i = 1; i < weight; i++) out.push(item)
    }
  }
  return out
}

/**
 * 早八 / 深夜**加权**显示的动作（不是「只显示这些」）。
 *
 * 时间不匹配会出戏，所以这些时段让打哈欠/睡觉/发呆出现得更频繁；
 * 但其他动作依旧会偶尔出现 —— 硬排除会让一半时间里的轮换池缩水（见 `weightedPool`）。
 */
export const TIRED_POSES = ['yawn', 'sleep', 'think']

/** 早八/深夜时段更适合打哈欠 */
export function isTiredHour(now = new Date()) {
  const h = now.getHours()
  return h < 9 || h >= 23
}

/** 表情 key -> 图片文件名 */
export function expressionFile(key) {
  const slug = PET_EXPRESSIONS[key] ?? PET_EXPRESSIONS.idle
  return `yuki-${slug}.png`
}

/**
 * 挂机候选项 -> 图片文件名。
 *
 * 统一处理动作与服饰两种候选项（服饰带 `outfit:` 前缀），
 * 免得调用方到处判断前缀。未知输入回落到默认状态立绘。
 */
export function poseImageFile(candidate) {
  const s = String(candidate ?? '')
  if (s.startsWith('outfit:')) return outfitFile(s.slice('outfit:'.length))
  if (!s) return expressionFile('idle')
  return expressionFile(s)
}

/**
 * 每种情境该配哪个表情。
 * 抽成表是为了「改台词不影响表情逻辑」，也便于单测覆盖。
 */
export const EMOTE_FOR = {
  hover: 'heart',
  poke: 'idle',
  pet: 'shy',
  petOverload: 'angry',
  doubleTap: 'surprise',
  dragged: 'shrug',
  sedentary: 'coffee', // 久坐提醒顺手递杯咖啡
  morning: 'heart',
  workStart: 'work',
  nearOffWork: 'shrug',
  offWork: 'wave',
  restDay: 'rest',
  idleChatter: 'think',
  checkin: 'clap', // 打卡成功拍手
  /** 补卡成功：一次补一堆漏打的日子，值得蹦一下 */
  checkinBackfill: 'jump',
  chatting: 'think',
  /** 摸鱼进行中偶尔吃零食 */
  snack: 'snack',
  /** 深夜 / 早八打哈欠 */
  tired: 'yawn',
  /** 久坐提醒之后起身伸个懒腰 */
  stretch: 'stretch',
  /** 退出前挥手 */
  quitting: 'wave',
}

/** 久坐提醒时顺便说的话（和递咖啡的姿态配套） */
export const COFFEE_LINES = [
  '给你倒了杯咖啡，顺便站起来走两步？',
  '喝点水吧，我请客 ☕',
  '起来走两步嘛，我等你',
]

/** 情境 key -> 表情 key（给 contextualScene 的返回值用） */
export function emoteForScene(sceneKey) {
  return EMOTE_FOR[sceneKey] ?? null
}

/* ---------- 聊天关键词 -> 立绘动作 ---------- */

/**
 * 聊到相关话题时，让她**临时**摆出对应姿势（几秒后回到常态）。
 *
 * 为什么放在 shared：桌面端是主进程推 emote，手机端要在本地匹配 ——
 * 但两边**认得的话题必须一致**，否则同一句话在两端表现不同。
 *
 * 匹配规则：
 *   - `any` 里任意一个词命中即触发（子串匹配，够用且省算力）
 *   - 每条带 `weight`：多个命中时取权重最高的，避免「既像在笑又像在哭」
 *   - 关键词要**具体**，单字（如「哭」）会误伤「哭死我了」这类夸张用法；
 *     两条以上备选写法时都列上
 *
 * 这些动作都必须在 `PET_EXPRESSIONS` 里有图，否则会出现空白立绘。
 * `smoke.js` 有断言守着这层。
 */
export const CHAT_ACTION_RULES = [
  {
    emote: 'laugh',
    weight: 10,
    any: ['哈哈哈', '笑死', '笑不活了', '乐死', '好好笑', '太逗了', '笑出声', '哈哈'],
  },
  {
    emote: 'cry',
    weight: 9,
    any: ['好难过', '想哭', '哭了', 'emo了', '委屈', '被欺负', '好惨', '心疼'],
  },
  {
    emote: 'heart',
    weight: 9,
    any: ['喜欢你', '想你', '爱你', '比心', '抱抱', '亲亲', '么么', '贴贴'],
  },
  {
    emote: 'angry',
    weight: 8,
    any: ['好气', '气死', '太讨厌', '烦死', '生气', '讨厌你', '不理你了'],
  },
  {
    emote: 'surprise',
    weight: 8,
    any: ['真的假的', '不是吧', '震惊', '居然', '我去', '天呐', '不会吧'],
  },
  {
    emote: 'clap',
    weight: 7,
    any: ['厉害', '太强了', '牛啊', '干得漂亮', '祝贺', '恭喜', '好棒'],
  },
  {
    emote: 'thumbsup',
    weight: 6,
    any: ['加油', '可以的', '没问题', '支持你', '说得对', '赞成'],
  },
  {
    emote: 'think',
    weight: 5,
    any: ['让我想想', '想想看', '思考', '怎么办', '有点纠结', '要不要'],
  },
  {
    emote: 'yawn',
    weight: 6,
    any: ['好困', '困死', '想睡', '打哈欠', '睁不开眼'],
  },
  {
    emote: 'sleep',
    weight: 7,
    any: ['晚安', '去睡了', '睡觉了', '我先睡', '困了睡'],
  },
  {
    emote: 'shy',
    weight: 6,
    any: ['害羞', '不好意思', '别夸了', '脸红', '羞死了'],
  },
  {
    emote: 'shrug',
    weight: 4,
    any: ['随便吧', '无所谓', '没办法', '不知道啊', '算了'],
  },
  {
    emote: 'coffee',
    weight: 5,
    any: ['喝咖啡', '咖啡', '困得不行', '提神', '续命'],
  },
  {
    emote: 'snack',
    weight: 5,
    any: ['吃零食', '好饿', '饿了', '吃点东西', '干饭', '外卖'],
  },
  {
    emote: 'stretch',
    weight: 4,
    any: ['伸懒腰', '腰酸', '坐久了', '好累啊', '累死'],
  },
  {
    emote: 'music',
    weight: 4,
    any: ['听歌', '耳机', '放首歌', '歌单', '在听什么'],
  },
  {
    emote: 'read',
    weight: 4,
    any: ['看书', '读书', '学习', '写作业', '复习', '考试'],
  },
  {
    emote: 'nod',
    weight: 3,
    any: ['嗯嗯', '好的', '明白', '懂了', '知道了'],
  },
]

/**
 * 从一段话里挑出该触发的动作。
 *
 * @param {string} text 用户的输入（或她刚说的话）
 * @param {number} [now] 时间戳，用来避免同一动作连续重复
 * @returns {string|null} emote key，没命中返回 null
 */
export function chatActionFor(text, now = Date.now()) {
  const s = String(text ?? '')
  if (!s) return null
  let best = null
  let bestWeight = 0
  for (const rule of CHAT_ACTION_RULES) {
    if (rule.any.some((kw) => s.includes(kw))) {
      if (rule.weight > bestWeight) {
        bestWeight = rule.weight
        best = rule.emote
      }
    }
  }
  /*
   * 命中后**冷却**：同一动作 20 秒内不重复触发。
   * 不然连发几条「哈哈哈」会一直定格在笑的那个立绘上，
   * 看起来像卡住了。
   */
  if (best) {
    const last = lastChatAction[best] ?? 0
    if (now - last < 20_000) return null
    lastChatAction[best] = now
  }
  return best
}

/** emote -> 上次触发时间戳（冷却用，模块级即可，不需要持久化） */
const lastChatAction = Object.create(null)


/* ---------- 亲密度：关系变近之后说话方式也要跟着变 ---------- */

/**
 * 亲密度档位台词配置。
 *
 * 这是「对话提升亲密度」的第二层意思：点数不该只是个数字。
 * 关系变近后如果说话方式还是老样子，数值涨了也没有感觉。
 *
 * 做法上不做「每档一套完整台词池」——那要写五倍台词，写不细就会显得敷衍。
 * 通用池上挂亲近前缀，只有「形影不离」才切专属池。
 */
export const AFFINITY_VOICE = {
  stranger: { prefix: null, idleScale: 1.15 },
  familiar: { prefix: '诶，', idleScale: 1 },
  /* 好朋友起会主动分享自己的事，话也变多 */
  friend: {
    prefix: null,
    idleScale: 0.9,
    extraIdle: ['今天天气好好，你在窗边吗', '我刚刚走神了一下下', '要不我们摸鱼十分钟'],
  },
  close: {
    prefix: null,
    idleScale: 0.8,
    extraIdle: ['你一来我就知道你今天心情不错', '不用说话我也知道你在摸鱼', '歇会儿吧，我帮你盯着'],
  },
  intimate: {
    prefix: null,
    idleScale: 0.7,
    extraIdle: ['我一直在的', '今天也想和你多待一会儿', '不用理我，我就看看你'],
  },
}

/** 最高档（形影不离）专用的亲近回应，替换掉通用池里的客套话 */
export const AFFINITY_LINES = {
  petIntimate: ['嗯…随便你摸', '诶嘿，今天心情好？', '再摸一下也不是不行'],
  pokeIntimate: ['怎么啦，说', '嗯？我在听', '又想偷懒啦'],
  doubleTapIntimate: ['又来！', '就知道你要戳两下', '手很闲嘛你'],
  hoverIntimate: ['忙完啦？', '要不要歇会儿', '我一直等你说话呢'],
}

/**
 * 按关系档位取台词池。
 *
 * 前缀只加句首，不动原句 —— 维护台词时不用每档抄一遍。
 * 语气词开头的句子不加前缀（「诶嘿…」→「诶，诶嘿…」很怪）。
 */
export function linesFor(key, voice = 'stranger') {
  const base = LINES[key]
  if (!base) return []
  const v = AFFINITY_VOICE[voice]
  if (!v) return base

  if (voice === 'intimate') {
    const intimate = { pet: AFFINITY_LINES.petIntimate, poke: AFFINITY_LINES.pokeIntimate, doubleTap: AFFINITY_LINES.doubleTapIntimate }[key]
    if (intimate) return intimate
    if (key === 'idle') return [...base, ...(v.extraIdle ?? [])]
    return base
  }

  if (!v.prefix) return base
  return base.map((line) => (/^[诶啊哦嗯咦哈嘿]|…$/.test(line) ? line : `${v.prefix}${line}`))
}

/** 悬停搭话专用池：最熟之后换成更主动的问句 */
export function hoverLinesFor(voice) {
  return voice === 'intimate' ? AFFINITY_LINES.hoverIntimate : LINES.poke
}

/**
 * 亲密度对「主动说话频率」的影响：关系越好越黏人。
 * 返回的是间隔倍率 —— 0.7 表示说话比默认勤 30%。
 */
export function idleIntervalScale(voice = 'stranger') {
  const scale = Number(AFFINITY_VOICE[voice]?.idleScale)
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}
