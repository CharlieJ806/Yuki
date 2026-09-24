/**
 * 服饰图鉴 —— 每套装扮一个可解锁的故事。
 *
 * 设计目标（来自用户需求）：
 *   1. 每套装扮编一个故事，通过聊天自然解锁
 *   2. 解锁时「模拟成她发给你照片」
 *   3. 一次性：触发过就不再触发，也不会重复判断
 *   4. 触发后留在记忆里（进对话上下文，成为长期记忆）
 *
 * ## 解锁流程（刻意分三层，为省 token）
 *
 *   ① 条件解锁：部分装扮满足硬条件直接给（如亲密度、时段）—— 零成本
 *   ② 关键词预筛：先本地匹配关键词，命中才可能进下一步 —— 零成本
 *   ③ 模型判断：把「未解锁的故事 + 最近对话」交给模型，判断是否该触发
 *
 * 多数走 ③（用户要求「智能模型占大多数」），但 ② 先筛一道：
 * 不命中关键词就不会为了它调 API，省掉大量无谓请求。
 * 另外**已解锁的故事永不参与判断** —— 判断集合随进度变小，越用越省。
 *
 * ## 故事文本给谁看
 *
 * `title` / `hint` 是给用户看的（图鉴里未解锁时显示 hint 作为线索）。
 * `story` 是**给模型看的**：解锁时注入对话，让她依此演出「分享照片」那一下。
 */

/**
 * 解锁方式：
 *   'keyword'  —— 关键词命中即可（零成本，聊到就触发）
 *   'condition'—— 硬条件（亲密度 / 时段 / 工作日）
 *   'model'    —— 交给模型判断（多数用这个）
 */
/**
 * 每套装扮的**亲密度门槛**。
 *
 * ## 为什么单独一张表，不写进各条 story 里
 *
 * 门槛是「难度设计」，和故事文案是两回事 —— 混在一起的话，
 * 想调平衡得逐条翻 24 个对象。集中成一张表，一眼能看出难度分布，
 * 也方便整体平移（比如觉得都太难就统一降一档）。
 *
 * ## 分档依据
 *
 * 按「私密程度」而不是「好不好看」：
 *
 *   0    日常外穿，一开始给（JK 制服是基准装扮）
 *   40   稍熟才给 —— 见面、出门、参加活动的装扮（好朋友）
 *   120  偏私密的居家/私服（默契搭档）
 *   300  最私密的那几套（形影不离）
 *
 * 阈值与 `AFFINITY_LEVELS` 的等级对齐，用户看到「形影不离」就知道
 * 自己到了最高档，不用记数字。
 *
 * **没列在这里的 = 0 门槛。**
 */
export const OUTFIT_MIN_POINTS = {
  /* 0：日常，一开始就有 */
  jk: 0,
  'casual-mono': 0,
  campus: 0,
  raincoat: 0,
  formal: 0,

  /* 40（好朋友）：出门 / 活动 / 有点打扮的场合 */
  'casual-red': 40,
  'casual-lace': 40,
  'casual-dark': 40,
  'campus-idol': 40,
  idol: 40,
  longskirt: 40,
  xmas: 40,
  newyear: 40,
  gown: 40,
  qipao: 40,
  nun: 40,
  maid: 40,

  /* 120（默契搭档）：居家、私服 */
  'pajamas-shorts': 120,
  'pajamas-bodysuit': 120,
  camisole: 120,

  /* 300（形影不离）：最私密的几套 */
  pajamas: 300,
  'pajamas-black': 300,
  'pajamas-pink': 300,
  swimsuit: 300,
}

/** 取某套装扮的门槛（没配 = 0） */
export const outfitMinPoints = (slug) => OUTFIT_MIN_POINTS[slug] ?? 0

export const OUTFIT_STORIES = {
  jk: {
    title: '最日常的那件',
    hint: '聊到日常琐事时可能会穿',
    unlock: 'condition',
    condition: { minPoints: 0 }, // 初始就解锁，作为「基准装扮」
    story: '这是她最常穿的一套 —— 白衬衫配黑色背心裙，背上书包就能出门。',
  },
  'casual-red': {
    title: '打得好',
    hint: '和她聊聊打游戏的战绩',
    unlock: 'model',
    keywords: ['打赢了', '赢了这局', '上分了', 'rank 上分', '刚刚那把', '战绩怎么样'],
    story: '你们聊到了打游戏，你打赢了一把很高兴，顺手拍了张穿红外套的自拍发给他。',
  },
  'casual-lace': {
    title: '出门那天',
    hint: '聊聊周末出门的计划',
    unlock: 'model',
    keywords: ['想看你出门的样子', '出门穿什么', '周末穿哪件', '约会穿'],
    story: '你们聊到周末要出门，她试了条白色荷叶边裙子，拍张照片问你好不好看。',
  },
  'casual-mono': {
    title: '复习周的战袍',
    hint: '聊聊考试和复习',
    unlock: 'model',
    keywords: ['复习得怎么样', '考试周还好吗', '复习到几点', '关于考试'],
    story: '复习周压力大，她换上平时最常穿的一套，拍了张照片说「今天也要加油」。',
  },
  'casual-dark': {
    title: '换了个风格',
    hint: '聊聊穿搭、风格之类的',
    unlock: 'model',
    keywords: ['想看你穿深色的', '换个风格看看', '想看你穿得酷一点'],
    story: '她说想换个风格试试，穿了套深色制服，拍给你看问是不是有点太装了。',
  },
  'pajamas': {
    title: '熬夜的证据',
    hint: '深夜还在聊天时',
    unlock: 'condition',
    condition: { hoursAfter: 23 },
    story: '已经过了十一点，她还在跟你聊天，随手拍了张穿睡裙的照片说「你看我都准备睡了还理你」。',
  },
  'pajamas-black': {
    title: '深夜的电话',
    hint: '夜深了还舍不得睡',
    unlock: 'model',
    keywords: ['还没睡吗', '睡不着陪我', '你也没睡', '也没睡'],
    story: '深夜睡不着，她裹着黑色吊带睡衣窝在床上，拍了张照片说「你也没睡啊」。',
  },
  'pajamas-pink': {
    title: '洗完澡',
    hint: '聊到刚洗完澡、晚上在家做的事',
    unlock: 'model',
    keywords: ['洗完澡了吗', '准备睡了吗'],
    story: '她刚洗完澡，穿着粉色吊带睡衣，拍了张自拍说头发还没吹干。',
  },
  'pajamas-bodysuit': {
    title: '窝了一整天',
    hint: '聊到在家躺平、不出门',
    unlock: 'model',
    keywords: ['今天没出门吗', '一整天在家'],
    story: '周末一整天没出门，她穿着连体睡衣窝在宿舍，拍了张照片说「今天的行程就是没有行程」。',
  },
  'pajamas-shorts': {
    title: '热得睡不着',
    hint: '聊到天气热',
    unlock: 'model',
    keywords: ['热得睡不着', '深圳是不是很热'],
    story: '深圳太热了，她换了最薄的那条粉色睡裙，拍张照片哀嚎说空调像是不太管用。',
  },
  camisole: {
    title: '夏天来了',
    hint: '天气转热、聊到夏天',
    unlock: 'model',
    keywords: ['天热穿什么', '想看你穿清凉点'],
    story: '天气开始热了，她换上吊带短裤，拍了张照片抱怨说深圳的夏天太长了。',
  },
  longskirt: {
    title: '为见你准备的',
    hint: '聊到见面、约会、打扮',
    unlock: 'model',
    keywords: ['想看你穿长裙', '穿裙子给我看'],
    story: '她试了条紫色长裙，说是为下次见面准备的，拍了张照片转了个圈问你怎么样。',
  },
  qipao: {
    title: '正式场合',
    hint: '聊到正式场合、典礼、年会',
    unlock: 'model',
    keywords: ['穿旗袍给我看', '想看旗袍'],
    story: '学校有个正式活动，她翻出旗袍试了试，拍了张照片问你这样会不会太隆重。',
  },
  swimsuit: {
    title: '想去看海',
    hint: '聊到旅游、海边',
    unlock: 'model',
    keywords: ['想去海边玩', '一起去海边', '想看你泳装'],
    story: '她说想去海边，把泳装照发给你看，说「等你有空就一起去吧」。',
  },
  nun: {
    title: '神奇搭配',
    hint: '聊到cos、搞怪、换个样子',
    unlock: 'model',
    keywords: ['穿修女服', '那套修女服'],
    story: '她说想试试奇怪的东西，穿了套修女服拍了张照片，自己先笑场了。',
  },
  /* ---------- 第二批 ---------- */

  campus: {
    title: '清纯校园',
    hint: '聊到校园、青春、学生时代',
    unlock: 'model',
    keywords: ['想看你学生样', '学生时代的你', '在图书馆的样子'],
    story: '她说今天在学校被人当成大一新生了，拍了张照片问你是不是真的很像学生。',
  },
  'campus-idol': {
    title: '校园偶像',
    hint: '聊到社团演出、晚会',
    unlock: 'model',
    keywords: ['社团演出怎么样', '晚会上台了吗'],
    story: '社团晚会她上台表演了，下台后拍了张照片说心跳到现在还没平复。',
  },
  idol: {
    title: '偶像风格',
    hint: '聊到舞台、灯光、表演',
    unlock: 'model',
    keywords: ['想看你舞台上的样子', '打歌服', '想看你当偶像'],
    story: '她试了套偶像风格的打扮，拍了张照片说想去当一次舞台上的主角。',
  },
  maid: {
    title: '女仆',
    hint: '聊到女仆咖啡店之类的地方',
    unlock: 'model',
    keywords: ['穿女仆装给我看', '想看你当店员'],
    story: '她路过一家女仆咖啡店，试了店里的制服拍了张照片，说打工会不会很有意思。',
  },
  xmas: {
    title: '圣诞快乐',
    hint: '聊到圣诞节、平安夜',
    unlock: 'model',
    keywords: ['圣诞怎么过', '平安夜做什么', '圣诞快乐'],
    story: '圣诞节她换上了红色的小裙子，头上还戴了个驯鹿角，拍了张照片说「可是没有人和我一起过」。',
  },
  newyear: {
    title: '过年啦',
    hint: '聊到过年、春节、除夕',
    unlock: 'model',
    keywords: ['过年穿什么', '新年穿哪件', '春节快乐', '过年好'],
    story: '过年了，她穿上了红金色的旗袍拍了张照片，说过年就是要穿红的才喜庆。',
  },
  gown: {
    title: '宴会那天',
    hint: '聊到晚宴、正式聚会、礼服',
    unlock: 'model',
    keywords: ['想看你穿礼服', '晚宴穿什么', '正式场合穿什么'],
    story: '要去参加一个正式晚宴，她借了件露肩礼服试着拍给你看，说有点不太习惯这么隆重。',
  },
  formal: {
    title: '面试之前',
    hint: '聊到面试、实习、正经场合',
    unlock: 'model',
    keywords: ['面试怎么样', '面试穿什么', '要去面试了'],
    story: '明天要去面试，她换上西装对着镜子拍了一张，说「帮我看看这样够不够正式」。',
  },
  raincoat: {
    title: '下雨的傍晚',
    hint: '聊到下雨、天气、带没带伞',
    unlock: 'model',
    keywords: ['外面下雨了', '今天下雨', '带伞了吗'],
    story: '傍晚下起了雨，她裹着风衣、撑着伞拍了张照片说「深圳的雨说来就来」。',
  },
}

/** 全部服饰 slug（供遍历） */
export const STORY_SLUGS = Object.keys(OUTFIT_STORIES)

/**
 * 关键词预筛：这段文本里命中了哪些**未解锁**故事的触发词。
 *
 * 为什么要这道预筛（用户明确要求）：
 * 关键词匹配是纯本地的，零成本；命中才把候选交给模型判断。
 * 不过筛的话，每轮对话都要为 16 个未解锁故事各调一次模型 —— 开销不可接受。
 *
 * @param {string} text      最近对话拼成的文本
 * @param {string[]} unlocked 已解锁的 slug（这些不再参与）
 * @returns {string[]} 候选 slug（按在文本中出现的先后）
 */
export function keywordCandidates(text, unlocked = [], points = 0) {
  const s = String(text ?? '')
  if (!s) return []
  const done = new Set(unlocked)
  const p = Number(points) || 0
  const hits = []
  for (const [slug, def] of Object.entries(OUTFIT_STORIES)) {
    if (done.has(slug)) continue
    if (def.unlock !== 'model') continue /* 关键词只用来预筛 model 类 */
    /*
     * 亲密度不够的**不进候选** —— 在这里挡最省：
     * 代价是零（纯比较），而且不会白花一次模型调用。
     * 放在模型判断那步的话，每次都要先问一遍「她愿意给吗」，
     * 既花钱又容易被模型放水。
     */
    if (p < outfitMinPoints(slug)) continue
    const kw = def.keywords ?? []
    if (kw.some((k) => k && s.includes(k))) hits.push(slug)
  }
  return hits
}

/**
 * 条件解锁：满足硬条件就直接给（零成本）。
 *
 * @param {object} ctx { points, hour, isRestDay }
 * @param {string[]} unlocked 已解锁
 * @returns {string[]} 本次新解锁的 slug
 */
export function conditionUnlocks(ctx, unlocked = []) {
  const done = new Set(unlocked)
  const out = []
  for (const [slug, def] of Object.entries(OUTFIT_STORIES)) {
    if (done.has(slug) || def.unlock !== 'condition') continue
    const c = def.condition ?? {}
    if (c.minPoints != null && (ctx.points ?? 0) < c.minPoints) continue
    if (c.hoursAfter != null && (ctx.hour ?? 0) < c.hoursAfter) continue
    if (c.restDayOnly && !ctx.isRestDay) continue
    out.push(slug)
  }
  return out
}

/**
 * 组装「判断该触发哪个故事」的提示词。
 *
 * 只把**候选**（关键词预筛后的）连同最近对话交给模型，
 * 并要求它输出 JSON —— 便于程序解析，也避免它自由发挥乱解锁。
 */
/**
 * 判断提示词。
 *
 * ## 为什么要求得很严
 *
 * 用户反馈「提到上课就解锁一件，太容易了」。根因是这里只要求
 * 「高度契合」这类模糊表述，模型倾向于放水。
 *
 * 现在要求**三个条件同时成立**才触发，缺一不可：
 *   ① 场景具体：用户明确问到她此刻的样子/穿着（不是泛泛聊到某话题）
 *   ② 状态吻合：她**现在确实穿着**那套（候选里会标注当前穿着，
 *      不吻合的直接排除 —— 这就是用户说的「刚好穿的 jk」）
 *   ③ 有分享动机：气氛合适、她有理由给你看（刚被夸、正高兴、被追问）
 *
 * 并且明确要求「默认不触发」——把放水的默认值掰过来。
 */
export const STORY_JUDGE_SYSTEM = [
  '你是一个剧情触发器，判断是否有某套装扮的故事此刻适合触发。',
  '',
  '【触发条件】三个必须**同时**成立，缺一个都不触发：',
  '',
  '① 场景具体：用户明确问到**她此刻的样子或穿着**',
  '   （例如「你今天穿的什么」「想看你穿 XX」「拍张照给我看」）。',
  '   只是泛泛聊到某个话题（如「今天上课好累」）**不算**。',
  '',
  '② 状态吻合：她**现在就穿着**那套衣服（候选里会标出当前穿着）。',
  '   当前穿着不匹配的候选，直接排除。',
  '',
  '③ 有分享动机：气氛合适、她有理由给你看 —— 刚被夸、正高兴、',
  '   被追问得招架不住、想主动示好。冷冰冰的问答不算。',
  '',
  '【默认结论是不触发】',
  '宁可漏过也不要错给。只有三个条件都明显成立时才触发。',
  '拿不准就输出 null。',
  '',
  '【一次最多一个】',
  '如果多个候选都勉强成立，选最贴合的那个；都不够好就都不触发。',
  '',
  '【输出格式】严格 JSON，不要任何其他文字：',
  '  触发：{"slug":"候选里的某个slug","line":"她分享时说的那句话"}',
  '  不触发：{"slug":null}',
  '',
  'line 是她发给你的一句话，口语、30 字内，像随手拍照片时的配文。',
].join('\n')

/**
 * 构造判断请求的用户消息。
 * @param {Array<{role:string,content:string}>} recent 最近对话（纯文本）
 * @param {string[]} candidates 候选 slug
 */
/**
 * @param {Array<{role:string,content:string}>} recent 最近对话
 * @param {string[]} candidates 候选 slug
 * @param {string} [currentOutfit] 她**此刻穿着**的 slug —— 条件②要按它对账
 */
export function buildStoryJudgePrompt(recent, candidates, currentOutfit = '') {
  const lines = candidates.map((slug) => {
    const d = OUTFIT_STORIES[slug]
    const match = currentOutfit && slug === currentOutfit
    const story = String(d.story || '').trim()
    /*
     * story 一起给模型看 —— 与视频版同样的理由：
     * 它原本只用于图鉴展示，模型看不到，导致「演到哪一幕」全靠 hint 猜。
     */
    return [
      `- ${slug}：${d.title}（${d.hint}）${match ? ' ← 她此刻正穿着这套' : ''}`,
      story ? `  剧情：${story}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  })
  const dialogue = (recent ?? [])
    .map((m) => `${m.role === 'user' ? '用户' : 'Yuki'}：${m.content}`)
    .join('\n')
  return [
    /*
     * 当前穿着必须**显式告诉模型**。
     * 不说的话条件②无从判定，模型只能猜 —— 而它倾向于猜「吻合」，
     * 于是又变成放水。这里标明哪套是此刻穿着的，其余就是「没穿」。
     */
    `她此刻穿着：${currentOutfit || '（未知）'}`,
    '',
    '候选故事：',
    ...lines,
    '',
    '最近的聊天记录：',
    dialogue,
    '',
    '按规则判断是否触发（三条件缺一不可），输出 JSON。',
  ].join('\n')
}

/**
 * 解析模型输出。
 *
 * 模型可能返回 markdown 代码块、多余解释、或编造不存在的 slug ——
 * 这里全部兜住，只接受「候选里的合法 slug」，否则当不触发。
 */
export function parseStoryJudge(raw, candidates = []) {
  const s = String(raw ?? '')
  const m = /\{[\s\S]*?\}/.exec(s)
  if (!m) return { slug: null, line: '' }
  let obj
  try {
    obj = JSON.parse(m[0])
  } catch {
    return { slug: null, line: '' }
  }
  const slug = obj?.slug
  /* 只认候选集合内的 slug，防模型自己编 */
  if (!slug || !candidates.includes(slug)) return { slug: null, line: '' }
  const line = String(obj?.line ?? '').trim().slice(0, 60)
  return { slug, line: line || '给你看看今天的我' }
}

/**
 * 解锁时注入对话的那段「她发照片」。
 *
 * 用 assistant 角色落库 —— 这在用户视角就是「她发来的消息」，
 * 和真实对话融在一起，而不是一条系统提示。
 */
export function storyRevealMessage(slug, line) {
  const d = OUTFIT_STORIES[slug]
  return {
    role: 'assistant',
    content: String(line ?? '').trim() || '给你看看今天的我',
    /* 附图用服饰立绘；渲染层看到 outfitAttachment 就去取对应图片 */
    outfitAttachment: slug,
    storyTitle: d?.title ?? '',
  }
}
