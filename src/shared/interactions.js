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

/** 同一天里「聊天」最多贡献多少点，防止无脑刷消息把关系刷满 */
export const CHAT_AFFINITY_DAILY_CAP = 60

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

  let allowed = Math.min(want, room)
  if (opts.chat) {
    const cap = Number(opts.chatCap) || CHAT_AFFINITY_DAILY_CAP
    const used = affinity?.chatDay === today ? Number(affinity.chatToday) || 0 : 0
    allowed = Math.min(allowed, Math.max(0, cap - used))
  }
  return allowed
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
 * slug 必须和 `prepare-yuki.js` 的 `OUTFIT_MAP` 保持一致。
 */
export const OUTFITS = [
  /* 便服系列：都是「出门穿」的，风格不同 */
  { slug: 'casual', label: '便服', emoji: '👕', hint: '白色针织裙，最日常的一套' },
  { slug: 'casual-red', label: '红外套', emoji: '🧥', hint: '红色外套配制服裙' },
  { slug: 'casual-lace', label: '荷边裙', emoji: '👗', hint: '白色荷叶边连衣裙' },
  { slug: 'casual-mono', label: '黑白裙', emoji: '🖤', hint: '白上衣配黑裙' },
  { slug: 'casual-dark', label: '深色制服', emoji: '🎩', hint: '深色制服，有点神秘' },

  /* 睡衣系列：都是「在家躺平穿」的 */
  { slug: 'pajamas', label: '睡裙', emoji: '🛌', hint: '白色蕾丝睡裙' },
  { slug: 'pajamas-black', label: '黑吊带', emoji: '🌙', hint: '黑色吊带配长袜' },
  { slug: 'pajamas-pink', label: '粉吊带', emoji: '🎀', hint: '粉色吊带睡衣' },
  { slug: 'pajamas-bodysuit', label: '连体衣', emoji: '💤', hint: '连体睡衣' },
  { slug: 'pajamas-shorts', label: '短睡裙', emoji: '🌸', hint: '短的粉色睡裙' },

  /* 特色款 */
  { slug: 'homewear', label: '居家清凉', emoji: '🩳', hint: '在家窝着的时候' },
  { slug: 'camisole', label: '吊带', emoji: '✨', hint: '吊带配短裤' },
  { slug: 'longskirt', label: '长裙', emoji: '💃', hint: '紫色长裙，出门约会' },
  { slug: 'qipao', label: '旗袍', emoji: '🧧', hint: '开叉旗袍，正式场合' },
  { slug: 'nun', label: '修女', emoji: '⛪', hint: '修女服，偶尔的神奇搭配' },
  { slug: 'swimsuit', label: '泳装', emoji: '🏖️', hint: '白色沙滩泳装' },
  { slug: 'cosplay', label: 'cosplay', emoji: '🎭', hint: '想换个风格' },

  /* 第二批素材 —— 与 scripts/prepare-yuki.js 的 OUTFIT_FILES 一一对应 */
  { slug: 'jk', label: 'JK 制服', emoji: '🎒', hint: '早八的课，赶时间的打扮' },
  { slug: 'campus', label: '清纯校园', emoji: '🌸', hint: '被当成大一新生的那种' },
  { slug: 'campus-idol', label: '校园偶像', emoji: '🎤', hint: '社团晚会上台的样子' },
  { slug: 'idol', label: '偶像风格', emoji: '🌟', hint: '想当一次舞台主角' },
  { slug: 'maid', label: '女仆', emoji: '🫖', hint: '女仆咖啡店体验' },
  { slug: 'maid-two', label: '女仆装', emoji: '🍰', hint: '女仆装，端着盘子' },
  { slug: 'interview', label: '实习面试', emoji: '💼', hint: '紧张到腿软的那天' },
  { slug: 'ol', label: 'OL 制服', emoji: '🏢', hint: '想象毕业后的样子' },
  { slug: 'stepmom', label: '小妈长裙', emoji: '🥀', hint: '成熟路线的长裙' },
]

/** 默认（时间自动模式下无从判断时）穿哪套 */
export const DEFAULT_OUTFIT = 'casual'

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
  homewear: ['home', 'sleep'],
  casual: ['day', 'eve', 'home'],
  'casual-red': ['day', 'eve'],
  'casual-lace': ['day', 'eve'],
  'casual-mono': ['day', 'eve'],
  'casual-dark': ['day', 'eve'],
  camisole: ['home', 'day'],
  longskirt: ['eve', 'day'],
  qipao: ['eve', 'day'],
  nun: ['day', 'eve'],
  swimsuit: ['day'],
  cosplay: ['day', 'eve'],
  jk: ['day'],
  campus: ['day'],
  'campus-idol': ['day', 'eve'],
  idol: ['eve', 'day'],
  maid: ['day'],
  'maid-two': ['day'],
  interview: ['day'],
  ol: ['day'],
  stepmom: ['eve', 'day'],
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

  /* 没给解锁清单（老调用点）时保持旧行为，避免影响既有测试 */
  if (!Array.isArray(unlocked) || !unlocked.length) {
    if (part === 'sleep') return 'pajamas'
    if (part === 'home') return 'homewear'
    return 'casual'
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
  return pool[(h32 ^ (h32 >>> 16)) % pool.length]
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
  work: 'pose1', // 握拳加油，摸鱼进行中
  happy: 'pose2', // 蹦跳轻快，已赚满 / 心情好
  rest: 'pose3', // 眨眼比心，休息日
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
}

/** 状态类表情（由 snapshot 决定） */
export const MOOD_KEYS = ['work', 'happy', 'rest', 'idle']

/** 表情类表情（由互动临时触发） */
export const EMOTE_KEYS = [
  'shy', 'angry', 'think', 'sleep', 'jump', 'heart', 'surprise', 'shrug',
  'snack', 'music', 'coffee', 'wave', 'yawn', 'thumbsup',
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
export const IDLE_POSES = ['snack', 'music', 'think', 'yawn']

/** 挂机动作：按关系档位解锁 */
export const IDLE_POSES_BY_VOICE = {
  stranger: IDLE_POSES,
  familiar: [...IDLE_POSES, 'coffee'],
  friend: [...IDLE_POSES, 'coffee', 'shrug', 'heart'],
  close: [...IDLE_POSES, 'coffee', 'shrug', 'heart', 'surprise', 'shy'],
  intimate: [...IDLE_POSES, 'coffee', 'shrug', 'heart', 'surprise', 'shy', 'sleep'],
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
  familiar: ['casual'],
  friend: ['casual', 'casual-red', 'casual-lace', 'homewear'],
  close: ['casual', 'casual-red', 'casual-lace', 'casual-mono', 'casual-dark', 'homewear', 'camisole', 'longskirt'],
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
  checkin: 'thumbsup', // 打卡成功竖大拇指
  /** 补卡成功：一次补一堆漏打的日子，值得蹦一下 */
  checkinBackfill: 'jump',
  chatting: 'think',
  /** 摸鱼进行中偶尔吃零食 */
  snack: 'snack',
  /** 深夜 / 早八打哈欠 */
  tired: 'yawn',
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
