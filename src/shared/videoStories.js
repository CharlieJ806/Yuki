/**
 * 视频图鉴 —— 每段视频一个可解锁的故事。
 *
 * 与服饰图鉴（outfitStories.js）**同构**：同一套三层触发管线
 * （条件 → 关键词预筛 → 模型判断），只是产出物从「一张照片」变成
 * 「一段视频」。刻意不发明第二套机制，否则两边的省 token 逻辑要各维护一遍。
 *
 * ## 为什么单列一组而不是挂到装扮下
 *
 * 视频和装扮是多对多关系：修女栏杆 ↔ 修女装，旗袍高跟鞋 ↔ 旗袍，
 * 但「摸头」「睡裙晚安」不属于任何一套装扮。硬绑上去会造出
 * 「没有装扮的视频放哪」这种无解问题，所以视频独立成组。
 *
 * ## 视频清单（对应 resources/video/）
 *
 * 全部 H.264 / 竖屏 720x960 / 约 5s（海边防晒霜是 10s 横屏 960x720）。
 * 这些参数决定了播放策略：竖屏用 contain 居中，横屏的那条要额外适配。
 */
export const VIDEO_STORIES = {
  headpat: {
    title: '摸摸头',
    hint: '夸夸她、或者她心情好的时候',
    unlock: 'model',
    keywords: ['摸摸你的头', '摸摸头', '想摸头', '揉揉你的头', '想抱抱你'],
    story: '上次你打球很累，她帮你去买水给你擦汗，你夸她真棒，她凑过来让你摸了摸头，眯起眼睛很受用的样子。',
    file: '摸头',
    portrait: '720x960',
  },
  'nun-railing': {
    title: '栏杆边的修女',
    hint: '聊到那套修女服的时候',
    unlock: 'model',
    keywords: ['穿修女服给我看', '那套修女服', '想看你穿修女'],
    story: '想起来你上次穿这套修女服，想钻出栏杆拍照，结果卡住了。',
    file: '修女栏杆',
    portrait: '720x960',
  },
  'qipao-heels-1': {
    title: '旗袍与高跟鞋（一）',
    hint: '聊到正式场合的打扮',
    unlock: 'model',
    keywords: ['穿旗袍给我看', '想看你穿旗袍', '旗袍那套'],
    story: '她穿着旗袍踩上高跟鞋，当模特拍了一组写真，成片很好看，她自己也很满意。',
    file: '旗袍高跟鞋 (1)',
    portrait: '720x960',
  },
  'qipao-heels-2': {
    title: '旗袍与高跟鞋（二）',
    hint: '接着上面那段聊下去',
    unlock: 'model',
    keywords: ['再走两步看看', '转个圈给我看', '旗袍好看'],
    story: '你说好看，她又多拍了几次，为了你都值了。',
    file: '旗袍高跟鞋 (2)',
    portrait: '720x960',
  },
  'beach-sunscreen': {
    title: '海边防晒霜',
    hint: '聊到去海边、出去玩',
    unlock: 'model',
    keywords: ['想去海边玩', '一起去海边', '想看你泳装'],
    story: '你说想去海边，她翻出去年那段在沙滩上涂防晒霜的视频发给你。',
    file: '海边防晒霜',
    portrait: '960x720',
  },
  'pajamas-goodnight': {
    title: '睡裙晚安',
    hint: '深夜道晚安时',
    unlock: 'condition',
    condition: { hoursAfter: 22 },
    story: '夜深了，她穿着睡裙跟你道晚安，发了一小段躺下的视频。',
    file: '睡裙晚安',
    portrait: '720x960',
  },
  'pajamas-tease': {
    title: '睡裙转转',
    hint: '夜里聊到想她了',
    unlock: 'model',
    keywords: ['想你了', '睡不着想找你聊', '想看我穿什么'],
    story: '你说想她了，她穿着睡裙在镜头前转了一圈，问你这样好看吗。',
    file: '睡裙转转',
    portrait: '720x960',
  },

  /* ---------- 第二批 ---------- */

  'comic-con': {
    title: '参加漫展',
    hint: '聊到漫展、线下活动',
    unlock: 'model',
    keywords: ['去漫展了吗', '漫展拍的照片', '想看你逛漫展'],
    story: '她去逛漫展了，举着手机在人群里自拍了一段发给你，说人比想象中多。',
    file: '参加漫展',
    portrait: '720x960',
  },
  'maid-cafe': {
    title: '女仆咖啡',
    hint: '聊到女仆咖啡店',
    unlock: 'model',
    keywords: ['女仆咖啡店怎么样', '想看你当店员'],
    story: '她真的去女仆咖啡店体验了店员，端着托盘给你提供服务。',
    file: '女仆咖啡',
    portrait: '960x720',
  },
  'school-stairs': {
    title: '学校楼梯',
    hint: '聊到下课、赶去下一个教室',
    unlock: 'model',
    keywords: ['下课了吗', '刚下课', '想看你下课的样子'],
    story: '下课铃刚响，她站在楼梯上和你相遇，说又要赶去另一栋楼上课。',
    file: '学校楼梯',
    portrait: '960x720',
  },
  'dorm-selfie': {
    title: '宿舍自拍',
    hint: '聊到宿舍、在寝室待着',
    unlock: 'model',
    keywords: ['你在宿舍吗', '宿舍里拍张', '想看看你宿舍'],
    story: '她窝在宿舍床上拍了段自拍发给你，说今天想你了。',
    file: '宿舍自拍',
    portrait: '720x960',
  },
  'dorm-selfie-2': {
    title: '宿舍自拍（二）',
    hint: '接着宿舍的话题聊',
    unlock: 'model',
    keywords: ['再拍一张宿舍的', '换张宿舍的'],
    story: '你说再拍一张，她换了个姿势又录了一段，说「就这一张了啊」。',
    file: '宿舍自拍2',
    portrait: '720x960',
  },
  'morning-awake': {
    title: '清晨刚醒',
    hint: '早上跟她道早安时',
    unlock: 'condition',
    condition: { hoursBefore: 11 },
    story: '她刚醒，头发还乱着，迷迷糊糊录了一小段发给你说「早」。',
    file: '时候清晨',
    portrait: '720x720',
  },
  'bar-stool': {
    title: '吧台边',
    hint: '聊到晚上出去坐坐、喝一杯',
    unlock: 'model',
    keywords: ['在吧台坐着吗', '晚上去哪喝一杯', '想看你坐吧台'],
    story: '她在吧台边坐下，暖光里录了一小段给你，说这里气氛不错，下次一起来。',
    file: '吧台椅',
    portrait: '720x960',
  },
  'stage-show': {
    title: '舞台演出',
    hint: '聊到演出、上台、表演',
    unlock: 'model',
    keywords: ['上台了吗', '演出怎么样', '想看你上台'],
    story: '她上台表演了，灯光打下来的那一刻录了一小段，说手心全是汗。',
    file: '舞台演出',
    portrait: '720x720',
  },
}

export const VIDEO_SLUGS = Object.keys(VIDEO_STORIES)

/**
 * 关键词预筛 —— 与服饰版同构。
 *
 * 已解锁的**永不参与**：判断集合随进度变小，越用越省 token。
 * 只有 `unlock: 'model'` 的才走关键词（条件类的零成本直接给）。
 */
export function videoKeywordCandidates(text, unlocked = []) {
  const s = String(text ?? '')
  if (!s) return []
  const done = new Set(unlocked)
  const hits = []
  for (const [slug, def] of Object.entries(VIDEO_STORIES)) {
    if (done.has(slug) || def.unlock !== 'model') continue
    if ((def.keywords ?? []).some((k) => k && s.includes(k))) hits.push(slug)
  }
  return hits
}

/** 条件解锁（零成本） */
export function videoConditionUnlocks(ctx, unlocked = []) {
  const done = new Set(unlocked)
  const out = []
  for (const [slug, def] of Object.entries(VIDEO_STORIES)) {
    if (done.has(slug) || def.unlock !== 'condition') continue
    const c = def.condition ?? {}
    if (c.minPoints != null && (ctx.points ?? 0) < c.minPoints) continue
    if (c.hoursAfter != null && (ctx.hour ?? 0) < c.hoursAfter) continue
    /*
     * hoursBefore 是「凌晨」的意思（如清晨视频要 11 点前）。
     *
     * 这条以前**漏实现了** —— 条件写在数据里、判定里却没有，
     * 于是「清晨刚醒」那段视频任何时候都会解锁（实测报过
     * 「叫一下名字就解锁视频」，这是其中一半原因）。
     */
    if (c.hoursBefore != null && (ctx.hour ?? 0) >= c.hoursBefore) continue
    if (c.restDayOnly && !ctx.isRestDay) continue
    out.push(slug)
  }
  return out
}

/** 判断用的系统提示 —— 与服饰版分开，因为产出物不同（视频 vs 照片） */
export const VIDEO_JUDGE_SYSTEM = [
  '你是一个剧情触发器。根据最近的聊天记录，判断是否有某段「视频」此刻适合发出去。',
  '',
  '规则：',
  '1. 只在聊天内容**确实和某个候选视频高度契合**时才触发，宁缺毋滥。',
  '2. 一次最多触发一个。',
  '3. 输出严格 JSON，不要任何其他文字：',
  '   触发：{"slug":"候选里的某个slug","line":"她发视频时说的那句话"}',
  '   不触发：{"slug":null}',
  '4. line 是她发给用户的**一句话**，口语、不超过 30 字，像随手发视频时的配文。',
].join('\n')

export function buildVideoJudgePrompt(recent, candidates) {
  /*
   * story 必须一起给模型看。
   *
   * 它原本只用在图鉴里展示给用户 —— 模型看不到剧情，
   * 于是「演到哪一幕」完全靠 hint 猜，用户精心写的剧情形同虚设。
   * 现在把它作为判断依据：聊的内容越贴近这段剧情，越该触发。
   */
  const lines = candidates.map((slug) => {
    const d = VIDEO_STORIES[slug]
    const story = String(d.story || '').trim()
    return [`- ${slug}：${d.title}（${d.hint}）`, story ? `  剧情：${story}` : '']
      .filter(Boolean)
      .join('\n')
  })
  const dialogue = (recent ?? [])
    .map((m) => `${m.role === 'user' ? '用户' : 'Yuki'}：${m.content}`)
    .join('\n')
  return [
    '候选视频：',
    ...lines,
    '',
    '最近的聊天记录：',
    dialogue,
    '',
    '判断是否触发，按规则输出 JSON。',
  ].join('\n')
}

/**
 * 解析模型输出。
 * 只认候选集合内的合法 slug —— 防模型自己编一个不存在的视频出来。
 */
export function parseVideoJudge(raw, candidates = []) {
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
  if (!slug || !candidates.includes(slug)) return { slug: null, line: '' }
  const line = String(obj?.line ?? '').trim().slice(0, 60)
  return { slug, line: line || '给你看个东西' }
}

/** 条件类视频的固定台词（不经过模型，写死更省） */
export const VIDEO_CONDITION_LINES = {
  'pajamas-goodnight': '那我先睡啦，晚安～',
}

/** 视频文件的产物路径（构建时把 resources/video 处理成 dist-mobile/videos/） */
export function videoSrc(slug, version = '') {
  const d = VIDEO_STORIES[slug]
  if (!d) return ''
  const base = `videos/${slug}.mp4`
  return version ? `${base}?v=${version}` : base
}

/** 视频封面（构建时抽首帧） */
export function videoPoster(slug, version = '') {
  const base = `videos/${slug}.jpg`
  return version ? `${base}?v=${version}` : base
}
