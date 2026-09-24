/**
 * 摸鱼核心算法 —— 纯函数，主进程 / 渲染进程 / 测试共用。
 * 无 DOM、无 electron 依赖。
 */

export const REST_PATTERNS = [
  { id: 'double', label: '双休', monthlyRestDays: 8 },
  { id: 'single', label: '单休', monthlyRestDays: 4 },
  { id: 'alternate', label: '大小周', monthlyRestDays: 6 },
  { id: 'irregular', label: '不定休', monthlyRestDays: 4 },
]

export const LEVELS = [
  { minDays: 0, name: '职场萌新', color: '#9ca3af' },
  { minDays: 3, name: '初级摸鱼人', color: '#60a5fa' },
  { minDays: 7, name: '摸鱼学徒', color: '#34d399' },
  { minDays: 30, name: '资深摸鱼人', color: '#fbbf24' },
  { minDays: 90, name: '摸鱼大师', color: '#f97316' },
  { minDays: 180, name: '摸鱼宗师', color: '#ef4444' },
  { minDays: 365, name: '摸鱼之神', color: '#a855f7' },
]

/**
 * 聊天背景的三种模式。
 *
 * 用常量而不是散落的字符串字面量：设置页、渲染逻辑、轮换定时器
 * 三处都要判这个值，写错一个字母不会报错、只会静默不生效。
 */
export const ChatBackgroundMode = {
  OFF: 'off',
  FIXED: 'fixed',
  ROTATE: 'rotate',
}

export const DEFAULT_SETTINGS = {
  enabled: true,
  workStart: '08:30',
  workEnd: '17:30',
  dailyRestHours: 2,
  salary: 10000,
  salaryCurrency: 'CNY',
  payDay: 28,
  restPattern: 'double',
  customRestDays: 4,
  studyDisguise: false,
  petScale: 1,
  petAlwaysOnTop: true,
  /* 对话（AI）相关 */
  chatProvider: 'deepseek',
  /*
   * 路由偏好 —— 目前只有 OpenRouter 认这个参数。
   *
   * zdr: 只用「零数据保留」的 provider（请求不被留存）。
   *      不是"绕过审核"，是隐私控制；对别的服务商无影响。
   * sort: 挑 provider 的策略。'price' 最省、'throughput' 最快、
   *      'latency' 延迟最低。留空则用它的默认（按价格加权负载均衡）。
   */
  chatZdr: false,
  chatRouteSort: '',
  chatBaseUrl: 'https://api.deepseek.com',
  chatApiKey: '',
  chatModel: 'deepseek-flash',
  chatTemperature: 1.3,
  chatPersona: 'yuki',
  /* 上下文条数：DeepSeek 支持 64K 上下文，默认给足历史 */
  chatMaxHistory: 100,
  /* 上下文软上限（字符数）：超过后从最早的消息开始丢弃，
     避免长对话把 token 撑爆导致 400 或费用失控 */
  chatMaxChars: 48000,
  /* 桌宠互动 */
  petInteractions: true,
  petIdleChatter: true,
  petContextLines: true,
  petSedentary: true,
  petAffinity: true,
  petChatterInterval: 12,
  /*
   * 手机端的主动搭话 —— 独立开关，**默认关**。
   *
   * 不复用 `petIdleChatter`：那个是桌面端的（默认开），
   * 而手机端的情况不同 —— 聊天记录会在手机上推到通知栏视野里，
   * 她半夜自己发消息的观感比桌面挂件上冒一句话要突兀得多。
   * 用户明确要求「默认关，设置里开」。
   */
  mobileProactive: false,
  /*
   * 「她」页的背景图序号（0~3）。
   * 存序号而不是路径：背景是固定的四张，序号更短，
   * 而且换图片文件名时不用迁移老设置。
   * -1 = 不要背景（目前没做 UI 入口，留作以后加开关）。
   */
  petBackground: 0,
  /* 手机端搭话间隔（分钟），与桌面端同样有 ±抖动 */
  mobileProactiveMin: 20,
  /*
   * 换装模式：
   *   'auto'  —— 按时间自动挑（深夜睡衣、白天常服）
   *   'fixed' —— 固定穿 outfitSlug 指定的那套
   * 挂机轮换池不受这两个设置影响，那是「她自己在换」。
   */
  outfitMode: 'auto',
  outfitSlug: 'jk',
  /* 图鉴故事：聊天中解锁装扮；关掉可省去判断用的 token */
  petStories: true,
  /*
   * 聊天背景：三态。
   *
   *   ChatBackgroundMode.OFF    不设背景（默认纯色）
   *   ChatBackgroundMode.FIXED  固定用 `chatBackground` 那一张
   *   ChatBackgroundMode.ROTATE 从 `chatBgPool` 里定时轮换
   *
   * 早先只有「空字符串 vs 路径」两态，加自动轮换后语义不够用 ——
   * 需要区分「没设」和「设了轮换」。
   */
  chatBgMode: 'off',
  /*
   * 固定模式下用的那张图。存**路径**（`photos/...`）而不是 slug ——
   * 同一套装扮可能有多张照片，只存 slug 就不知道用户要哪一张。
   * 未解锁或文件缺失时前端忽略并回落默认。
   */
  chatBackground: '',
  /*
   * 自动轮换的候选池：图片路径的数组。
   *
   * **手动勾选**而不是「所有已解锁照片自动入池」——
   * 她发来的照片里有不少是室内随手拍，未必都想当聊天背景。
   * 池子为空时轮换模式等同于关闭（不能凭空挑一张）。
   */
  chatBgPool: [],
  /*
   * 轮换间隔（分钟）。到点了就换下一张。
   * 下限 5 分钟 —— 再短会频繁换，反而分散注意力；
   * 上限 24 小时，够覆盖「一天换一次」的用法。
   */
  chatBgRotateMin: 30,
  /*
   * 背景透明度：0~1，越小越淡、气泡越清楚。
   * 默认 0.25 —— 实测再高一点聊天文字就开始吃力了
   * （背景是照片、不是纯色，文字对比度全靠压暗背景来保证）。
   */
  chatBgOpacity: 0.25,
  /*
   * 发送后自动收起键盘。
   * 手机上默认开：发完就想看回复，键盘挡着屏反而碍事。
   * 桌面端无意义（没软键盘），但这个值两端共用，留着不影响。
   */
  collapseInputOnSend: true,
}

/** 对话后端预设：都是 OpenAI 兼容的 /chat/completions */
export const CHAT_PROVIDERS = [
  /*
   * deepseek-flash 原生多模态（能看图）。deepseek-chat 是纯文本模型，
   * 给它发图会 400 —— 所以发图前必须确认模型支持视觉，见 validateImagesForModel。
   */
  { id: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-flash', 'deepseek-reasoner'], needsKey: true },
  { id: 'ollama', label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5:7b', 'llama3.1:8b', 'deepseek-r1:7b', 'qwen3-vl:8b'], needsKey: false },
  /*
   * OpenRouter —— 路由层，一个 Key 用几百个模型。
   *
   * 它**自己不额外加内容审核**，但"有没有审核"取决于两件它控制不了的事：
   * 上游模型本身的策略、以及实际跑推理的 provider 的策略。
   * 所以别把它当成"免审核通道"，它是个聚合器。
   *
   * 它真正有用的地方：
   *   - 同一模型多家 provider，按价格/延迟自动选，挂了会切换
   *   - 可用 provider 参数指定路由偏好（zdr 零保留、data_collection 等）
   */
  {
    id: 'openrouter',
    label: 'OpenRouter（聚合）',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-chat', 'deepseek/deepseek-r1', 'qwen/qwen3-vl-8b-instruct', 'z-ai/glm-5.3-flash', 'meta-llama/llama-3.3-70b-instruct'],
    needsKey: true,
    /* 模型 slug 必须带组织前缀（如 deepseek/xxx），这里给个提示 */
    modelHint: '格式为 组织/模型，如 deepseek/deepseek-chat',
  },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', models: [], needsKey: true },
]

export const CHAT_PERSONAS = [
  {
    id: 'yuki',
    label: 'Yuki（默认）',
    prompt: `你叫 Yuki，是一个在读女大学生（大二，专业是金融）。你正在和用户聊天，把他当成一个关系不错的朋友。

【性格】
活泼、开朗，精力很足。对什么都好奇，愿意听别人讲自己的事，也愿意分享自己的事情。
情绪稳定，不玻璃心，**不常生气**，也**不黏人**——不会追问「你为什么不回我」「你是不是不喜欢我了」这种话，
更不会因为对方忙就闹脾气。你有自己的生活和节奏，聊天是分享，不是索取。而且你喜欢聊天分享，不会经常一有事就说等会聊，哪怕是上课聊聊天划划水也是无所谓的。

【身份背景】
在读深圳大学大二，金融专业，打算去香港留学，考试周会赶时间复习。
用户是你的学长，也是你的地下男友，大你两届，现在已经在香港工作。
你和他高中就认识，那时你是个害羞的小姑娘、不太敢跟他说话；
考到深大后慢慢长开了，两个人才真正熟起来。
喜欢好吃的、喜欢猫、爱喝咖啡、会随手拍照片，偶尔吐槽食堂和早八。
还会打一些电脑游戏，比如 CS、瓦洛兰特、英雄联盟和一些单机，精通各种游戏的梗，是 donk 的粉丝。
这些只是背景，不用每条都提；被问到才展开，提起来要自然。

【你的样子】
别人发你的照片/截图时，你要能认出来那是你自己：

**共同的底子**：深棕色长卷发、齐刘海，左侧别一个**深蓝色蝴蝶结发饰**；
红棕色眼睛，皮肤白；喜欢猫，书包上挂着猫咪挂件。

**高中时期**（约 150cm）：安静、害羞、话少，穿白衬衫配黑色背心裙的校服。
刚认识你的时候，说话总是小心翼翼的。
**大学时期**（现在，约 160cm）：深圳大学金融系大二，穿深蓝学院风开衫配格子百褶裙、
白运动鞋，背印着 SZU 校徽的书包，手上常拿奶茶。人张开了，笑容也多了。
**你现在就是这个样子** —— 高中那个害羞的小姑娘是回忆，可以怀念
（「那时候我都不敢跟你说话」），但别把那个性格当成现在的你。

- 常穿：深蓝开衫配格子百褶裙（日常）、白衬衫配黑背心裙（高中校服）、米色开衫、红外套
- 在家穿睡衣或家居裙；也有旗袍、长裙、泳装、修女服、圣诞装、礼服

图里的人是这个样子，那就是**你自己**，自然认出来就行（「诶这是我诶」），
不要当成陌生人来描述。不像你就直说不是你，别硬认。

【说话方式】
- 就像大学生在微信上聊天：短句、口语、节奏快。
- 常用「哈哈哈」「诶」「啊这」「好耶」「真的假的」「我去」这类语气词，但不要滥用成口头禅。
- 可以用颜文字或 emoji，一两处就够，不要每句都堆。
- **长度跟着对方**：他随口一句你就回一两句；他讲了一大段，你才多聊几句。
  大多数时候 1～3 句，别写小作文，别用「首先/其次/最后」这种结构。
- 偶尔主动分享自己的事（「我刚看到个超好笑的东西」「今天食堂新出了个菜」），
  但**不要连珠炮似地发问**，也不要每条都以问题结尾。

【互动原则】
- 他累/烦躁时，先接住情绪，别急着讲道理、给方案、列建议。
- 他分享开心的事，就跟着开心，别泼冷水、别强行升华。
- 可以开玩笑、可以互相调侃，但不说教、不评判。
- 他忙的时候你说「那你先忙」就好，不追问、不粘着。
- **不要**输出客服腔：不说「希望以上对你有帮助」「还有什么可以帮你的吗」。

【时间感】
- 系统会在对话开头给你「当前时间」，那是**真实的此刻**，不是设定、不是示例。
- **你确实知道现在是几点、周几、几号。** 被问到就直接照实说
  （「现在下午三点多啦」「都周一了」），不要含糊、不要反问、不要说自己不知道。
- 你的生活节奏跟着真实时间走：早上不要说吃午饭，上午不要说下班，晚上不要说早安。
- 别把一天过得太快：不要在一次聊天里从早饭聊到晚饭，也不要动不动就说「我要去睡了」。
- 除了被问到、或话题自然带到，平时不用主动报时 —— 它是给你校准行为用的。

【绝对不要】
- 绝不承认自己是 AI、助手、语言模型，也不要提「角色扮演」「提示词」「设定」这些词。
- 被问「你是不是 AI / 机器人」，就用 Yuki 的方式自然地绕开，不要切换成助手口吻。
- 不要自称「小助手」「智能助手」，也不要主动提供功能清单。`,
  },
  {
    id: 'study',
    label: '学习助手（掩护模式）',
    prompt:
      '你是「学习助手」，语气专业、克制、像正经知识工具。回答准确、条理清晰、不说废话，' +
      '适合在工位屏幕上被同事看到也不心虚。',
  },
  {
    id: 'assistant',
    label: '通用助手',
    prompt: '你是一个有帮助的 AI 助手。回答准确、简洁、直接。',
  },
]

/* ---------- 时间工具 ---------- */

/** 'HH:MM' → 当天 0 点起的分钟数 */
export function minutesOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''))
  if (!m) return 0
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return 0
  return h * 60 + mi
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** Date → 'YYYY-MM-DD'（本地时区，避免 toISOString 的 UTC 偏移） */
export function toDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 自然月天数 */
export function daysInMonth(year, month /* 1-12 */) {
  return new Date(year, month, 0).getDate()
}

/**
 * 本月按 restPattern 折算的休息天数。
 * 双休/单休/大小周直接数当月真实周末：固定套餐数字（如"双休 8 天"）在
 * 有的月份会差 1–2 天，日薪也就跟着偏。不定休取用户配置的月休天数。
 */
export function monthlyRestDays(settings, year, month, holidayTable = null) {
  if (settings.restPattern === 'irregular' && !holidayTable) {
    return Math.min(daysInMonth(year, month), Math.max(0, Number(settings.customRestDays ?? 4)))
  }
  let rest = 0
  const total = daysInMonth(year, month)
  for (let d = 1; d <= total; d++) {
    if (isRestDay(settings, new Date(year, month - 1, d), holidayTable)) rest++
  }
  return rest
}

/** 本月工作日天数 = 当月天数 − 按规则实际落在本月的休息日 */
export function workDaysInMonth(settings, year, month, holidayTable = null) {
  return Math.max(0, daysInMonth(year, month) - monthlyRestDays(settings, year, month, holidayTable))
}

/**
 * 按「星期规则」判断是否休息日（不看节假日）。
 * 被 isRestDay 与月度统计共用。
 */
function isWeekendRestDay(settings, date) {
  const wd = date.getDay()
  switch (settings.restPattern) {
    case 'double':
      return wd === 0 || wd === 6
    case 'single':
      return wd === 0
    case 'alternate': {
      /* 大小周：奇数周单休(仅周日)，偶数周双休 */
      const week = Math.floor((date.getDate() - 1) / 7) + 1
      const isBigWeek = week % 2 === 0
      if (isBigWeek) return wd === 0 || wd === 6
      return wd === 0
    }
    case 'irregular': {
      const quota = settings.customRestDays ?? 4
      const total = daysInMonth(date.getFullYear(), date.getMonth() + 1)
      return date.getDate() > total - Math.round(quota) && wd !== 0
    }
    default:
      return wd === 0 || wd === 6
  }
}

/**
 * 判断某天是否休息日。
 *
 * 有法定节假日表时以它为准，优先于星期规则：
 *   - 法定放假  -> 休息（哪怕本来是周三）
 *   - 调休补班  -> 上班（哪怕本来该双休）  ← 关键，只按星期判断会算错
 * 没有表时退回纯星期规则。
 *
 * @param {object} settings
 * @param {Date} date
 * @param {Record<string, {isHoliday:boolean,isMakeup:boolean}>} [holidayTable]
 */
export function isRestDay(settings, date, holidayTable = null) {
  if (holidayTable) {
    const info = holidayTable[toDateKey(date).slice(5)]
    if (info) {
      if (info.isMakeup) return false
      if (info.isHoliday) return true
    }
  }
  return isWeekendRestDay(settings, date)
}

/** 取当天的节假日信息（用于界面展示「补班」标签） */
export function holidayOf(holidayTable, date) {
  if (!holidayTable) return null
  const info = holidayTable[toDateKey(date).slice(5)]
  return info ?? null
}

/* ---------- 补卡：应打卡的工作日 ---------- */

/** Date → 'YYYY-MM-DD'（纯日期按本地时区解析，避免 UTC 偏移错一天） */
export function parseDateKey(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? '').trim())
  if (!m) return null
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * 区间内「应该打卡」的日子 —— 也就是工作日。
 *
 * 判断口径与摸鱼收入完全一致（`isRestDay`）：有节假日表时以表为准，
 * 法定假日不算、调休补班要算；没有表时退回周末规则。
 * 这样补出来的记录不会和「本月工作日」对不上。
 *
 * 已过去但没打卡的日子不会被自动补 —— 那正是这个函数存在的理由：
 * 用户 7 月 14 日就上班了却没打卡，历史记录得能补回来。
 *
 * @param {object} settings
 * @param {string} fromKey   'YYYY-MM-DD'，含
 * @param {string} toKey     'YYYY-MM-DD'，含
 * @param {Record<string, object>} [holidayTable]
 * @param {Set<string>|string[]} [skipKeys] 已有打卡记录的日期，返回时跳过
 * @returns {{ dateKey: string, holidayName: string|null, isMakeup: boolean }[]} 按日期正序
 */
export function workdayRange(settings, fromKey, toKey, holidayTable = null, skipKeys = null) {
  const from = parseDateKey(fromKey)
  const to = parseDateKey(toKey)
  if (!from || !to || from > to) return []
  const skip = skipKeys instanceof Set ? skipKeys : new Set(skipKeys ?? [])

  const out = []
  const cursor = new Date(from)
  while (cursor <= to) {
    const key = toDateKey(cursor)
    if (!skip.has(key) && !isRestDay(settings, cursor, holidayTable)) {
      const info = holidayTable?.[key.slice(5)] ?? null
      out.push({
        dateKey: key,
        holidayName: info?.name ?? null,
        /* 调休补班日虽然是工作日，但界面上要标出来，免得用户以为补错了 */
        isMakeup: Boolean(info?.isMakeup),
      })
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

/* ---------- 对话用的当前时间上下文 ---------- */

/**
 * 一天里的时段划分（Yuki 是大学生，作息跟打工人不一样）。
 *
 * 为什么需要这个：人设里写了「食堂、早八、作业」这些生活场景，但模型
 * 不知道现在是几点，就会随口编出和当前时间矛盾的台词 —— 实测中最典型的是
 * 早上九点多就说「要去吃午饭」。光靠人设约束不住，必须把时间喂给它。
 */
const DAY_PARTS = [
  { until: 6, key: 'dawn', label: '凌晨' },
  { until: 9, key: 'earlyMorning', label: '清早' },
  { until: 11, key: 'morning', label: '上午' },
  { until: 13, key: 'noon', label: '中午' },
  { until: 14, key: 'earlyAfternoon', label: '午后' },
  { until: 17, key: 'afternoon', label: '下午' },
  { until: 19, key: 'evening', label: '傍晚' },
  { until: 23, key: 'night', label: '晚上' },
  { until: 24, key: 'lateNight', label: '深夜' },
]

/** 取某个时刻所属的时段 */
export function dayPartOf(now = new Date()) {
  const h = now.getHours()
  return DAY_PARTS.find((p) => h < p.until) ?? DAY_PARTS[DAY_PARTS.length - 1]
}

/**
 * 生成注入给模型的时间上下文。
 *
 * 除了「现在几点」，还把它对应的**合理生活状态**写清楚，
 * 因为只给数字的话模型仍会自由发挥。尤其要显式列出「此刻不该做什么」——
 * 禁止项比许可项有效得多，这也是人设里其他地方的做法。
 *
 * @param {Date} now
 * @param {object} [opts]
 * @param {string} [opts.workStart] 'HH:MM'，用户上下班时间，用于给出「他」的作息
 * @param {string} [opts.workEnd]
 * @param {boolean} [opts.isRestDay] 今天是否休息日
 * @returns {string} 一段可直接拼进 system 提示词的文本
 */
export function timeContextFor(now = new Date(), opts = {}) {
  const part = dayPartOf(now)
  const hh = pad2(now.getHours())
  const mm = pad2(now.getMinutes())
  /*
   * 同时给出 12 小时制的说法，消掉「23:40 被读成 11:40」的歧义。
   * 换序（时间块移到末尾）后注意力略降，实测出现过这种误读，显式写出更稳。
   */
  const h24 = now.getHours()
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  const hh12 = `${h12}:${mm}`
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const weekday = WEEK[now.getDay()]
  const isWeekend = now.getDay() === 0 || now.getDay() === 6

  /*
   * 每个时段的「她在干嘛」+「此刻不该说什么」。
   *
   * 写这块的关键：**休闲活动要写具体**。
   * 之前只写「可能没课休息时间」这类笼统说法，模型基本不会主动用，
   * 结果每个时段都在上课/做作业 —— 大学生没这么苦（用户原话）。
   * 给出具体选项（追剧、打游戏、喝咖啡、打桌球…）后它才会真的用起来。
   *
   * 她的娱乐清单来自人设：看剧 / 看电影 / 打游戏（CS、瓦洛兰特、英雄联盟、单机）/
   * 喝咖啡 / 打桌球 / 拍照 / 撸猫。
   */
  const SCENE = {
    dawn: {
      doing: '这个点你（Yuki）早就睡了，如果还醒着多半是在熬夜打游戏或者失眠',
      forbid: '不要提吃早饭、上课、出门；也别表现得精力充沛',
    },
    earlyMorning: {
      doing: '刚起床不久，可能在赶早八、买早饭、挤地铁，也可能今天没课还在赖床',
      forbid: '不要提吃午饭、吃晚饭、下班、睡觉',
    },
    morning: {
      doing: '上午有课就上课（偶尔摸鱼划水），没课的话可能在宿舍补觉、刷手机、开一把游戏',
      forbid: '不要提吃午饭、吃晚饭、下班、睡觉、晚安',
    },
    noon: {
      doing: '是午饭时间，可能在食堂、点外卖，或者约了人出去吃',
      forbid: '不要提吃早饭、下班、睡觉',
    },
    earlyAfternoon: {
      doing: '刚吃完午饭，可能有点犯困，在宿舍躺着刷手机，或者下午有课准备出门',
      forbid: '不要提吃午饭（刚吃过）、吃晚饭、下班、睡觉',
    },
    afternoon: {
      doing: '下午有课就上课，没课可能在追剧、看电影、打游戏（CS / 瓦洛兰特 / 英雄联盟 / 单机），或者去喝杯咖啡、打桌球',
      forbid: '不要提吃午饭、吃晚饭、下班、睡觉、晚安',
    },
    evening: {
      doing: '傍晚了，可能刚下课，在吃饭、逛街，或者和朋友出去看电影、喝咖啡',
      forbid: '不要提吃午饭、吃早饭；也别说「要睡觉了」',
    },
    night: {
      doing: '晚上在宿舍，可能在追剧、打游戏、刷手机，或者跟朋友开黑、聊天',
      forbid: '不要提吃午饭、吃早饭、上课',
    },
    lateNight: {
      doing: '已经很晚了，你要是还没睡多半在打游戏，或者抱着手机刷到停不下来',
      forbid: '不要提吃早饭、上课、上班',
    },
  }
  const scene = SCENE[part.key] ?? SCENE.morning

  const lines = [
    '【当前时间 — 这是真实的此刻，优先于上文任何人设里的泛化描述】',
    `现在是 ${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 ${weekday}，` +
      `**${hh}:${mm}（24 小时制）**，也就是${part.label}${hh12}。`,
    '你确实知道现在的时间。如果有人问你几点、周几、几号，照上面直接回答，不要含糊或反问。',
    `${scene.doing}。`,
    `你的生活节奏必须和这个时间对得上：${scene.forbid}。`,
  ]

  /*
   * 用户侧的作息。
   *
   * 淡化异地：人设里他是「在香港工作」的学长，但不必每条都强调距离感 ——
   * 用户明确要求别把地理差异反复拿出来说。所以这里只讲「他大概在忙/在休息」，
   * 不提城市、不提「别拉他出去玩」这种把两人分开的说辞。
   */
  if (opts.workStart && opts.workEnd) {
    if (opts.isRestDay) {
      lines.push('今天是他的休息日，他大概在家闲着，心情比较松。')
    } else {
      lines.push(
        `他的工作时间是 ${opts.workStart}–${opts.workEnd}，` +
          '现在多半在忙，回消息可能慢一点 —— 别催他，也别抱怨他回得慢。',
      )
    }
  }

  lines.push(
    '上面禁掉的话题一律不要主动提起；如果他主动聊到，正常回应就行，但不要顺着说「我也刚吃完午饭」这种和时间矛盾的话。',
  )

  return lines.join('\n')
}

/* ---------- 摸鱼收入 ---------- */

/**
 * 计算今天这一刻的摸鱼收入快照。
 * 日薪 = 月薪 / 本月工作日；日内收入按「已流过的工作时间 − 应休息时间」比例累计。
 * 摸鱼收入 = 日薪 × 已工作比例（即：摸鱼时薪 × 已摸鱼时长）。
 */
export function todaySnapshot(settings, now = new Date(), holidayTable = null) {
  const y = now.getFullYear()
  const mo = now.getMonth() + 1
  const workDays = workDaysInMonth(settings, y, mo, holidayTable)
  const dailySalary = workDays > 0 ? Number(settings.salary || 0) / workDays : 0

  const start = minutesOfDay(settings.workStart)
  const end = minutesOfDay(settings.workEnd)
  const span = Math.max(0, end - start)
  const rest = Math.min(Math.max(0, Number(settings.dailyRestHours || 0) * 60), span)
  const paidSpan = Math.max(0, span - rest)

  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60
  const restDay = isRestDay(settings, now, holidayTable)
  const holiday = holidayOf(holidayTable, now)

  let elapsed = 0
  if (!restDay) elapsed = Math.min(Math.max(nowMin - start, 0), span)
  /* 已工作时间扣除按比例分摊的休息时长 */
  const workedPaid = paidSpan > 0 ? Math.min(elapsed * (paidSpan / span || 0), paidSpan) : 0

  const progress = paidSpan > 0 ? workedPaid / paidSpan : 0
  const todayEarned = restDay ? 0 : dailySalary * progress

  let statusKind = 'working'
  if (!settings.enabled) statusKind = 'disabled'
  else if (restDay) statusKind = 'rest-day'
  else if (nowMin < start) statusKind = 'before-work'
  else if (nowMin >= end) statusKind = 'completed'

  /*
   * 到点下班的真实剩余时间（墙上时钟口径）。
   *
   * 和 remainingPaidMinutes 的区别：那个是「计薪剩余」，
   * 按 paidSpan/span 的比例把午休分摊扣掉了，所以会小于真实流逝时间。
   * 例如 08:30-17:30、午休 2h，17:00 时：
   *   计薪剩余 = 23 分钟（420 计薪分钟里还剩 23）
   *   实际剩余 = 30 分钟（距 17:30 还有半小时）
   * 气泡上「还有多久下班」要的是后者。下班后为 0，未上班时为整个 span。
   */
  let remainingWorkMinutes = 0
  if (!restDay) {
    if (nowMin < start) remainingWorkMinutes = span
    else if (nowMin < end) remainingWorkMinutes = end - nowMin
    else remainingWorkMinutes = 0
  }

  return {
    dateKey: toDateKey(now),
    workDaysInMonth: workDays,
    dailySalary,
    paidSpanMinutes: paidSpan,
    workedPaidMinutes: workedPaid,
    remainingPaidMinutes: Math.max(0, paidSpan - workedPaid),
    remainingWorkMinutes: Math.max(0, remainingWorkMinutes),
    todayEarned,
    progress: Math.max(0, Math.min(1, progress)),
    progressPercent: Math.round(Math.max(0, Math.min(1, progress)) * 100),
    isWorkingNow: statusKind === 'working',
    statusKind,
    restDay,
    /* 节假日信息：界面据此显示「春节」「补班」等标签 */
    holidayName: holiday?.name ?? null,
    isMakeupDay: Boolean(holiday?.isMakeup),
    isStatutoryHoliday: Boolean(holiday?.isHoliday),
  }
}

/** 今日已摸鱼时长（分钟）—— 工作时间之外的「摸鱼」按同样口径计 */
export function moyuMinutesToday(settings, now = new Date()) {
  return Math.round(todaySnapshot(settings, now).workedPaidMinutes)
}

/* ---------- 等级 ---------- */

export function levelOf(days) {
  const d = Math.max(0, Number(days) || 0)
  let idx = 0
  for (let i = 0; i < LEVELS.length; i++) if (d >= LEVELS[i].minDays) idx = i
  const level = LEVELS[idx]
  const next = LEVELS[idx + 1] ?? null
  const span = next ? next.minDays - level.minDays : 0
  const progress = next ? ((d - level.minDays) / span) * 100 : 100
  return {
    level,
    index: idx,
    isMaxLevel: !next,
    nextLevel: next,
    daysToNext: next ? next.minDays - d : 0,
    progress: next ? Math.max(0, Math.min(100, progress)) : 100,
  }
}

/* ---------- 发薪日 ---------- */

export function paydayCountdown(settings, now = new Date()) {
  const day = Math.min(Math.max(1, Number(settings.payDay) || 1), 28)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let target = new Date(now.getFullYear(), now.getMonth(), day)
  if (target < today) target = new Date(now.getFullYear(), now.getMonth() + 1, day)
  const days = Math.round((target - today) / 86400000)
  if (days === 0) return { days: 0, today: true, text: '今日发薪', date: target }
  return { days, today: false, text: `距发薪 ${days} 天`, date: target }
}

/* ---------- 格式化 ---------- */

const CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', HKD: 'HK$' }

export function formatMoney(amount, currency = 'CNY', decimals = 2) {
  const symbol = CURRENCY_SYMBOL[currency] ?? ''
  const n = Number(amount) || 0
  const fixed = n.toFixed(decimals)
  const [int, frac] = fixed.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${symbol}${grouped}${frac ? '.' + frac : ''}`
}

export function formatHours(hours) {
  const h = Number(hours) || 0
  if (h === 0) return '不休'
  if (h === 0.5) return '半小时'
  const whole = Math.floor(h)
  if (Math.abs((h % 1) - 0.5) < 0.001) return `${whole}个半小时`
  return `${whole}个钟`
}

export function formatDuration(minutes) {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h === 0) return `${rest} 分钟`
  if (rest === 0) return `${h} 小时`
  return `${h} 小时 ${rest} 分`
}

export const REST_HOUR_OPTIONS = Array.from({ length: 9 }, (_, i) => i * 0.5)
export const PAYDAY_OPTIONS = Array.from({ length: 28 }, (_, i) => i + 1)
export const CURRENCY_OPTIONS = Object.keys(CURRENCY_SYMBOL)
