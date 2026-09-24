/**
 * 生活照图鉴 —— 16 组日常场景照片，每组两张（连拍）。
 *
 * ## 这是什么
 *
 * 与「服饰照片」「视频」并列的第三个可解锁类目：
 *   - 服饰照片：她穿某套装扮的自拍（竖构图，绑装扮）
 *   - 视频：她会动的样子
 *   - **生活照：她随手拍的日常生活**（横构图，**不绑装扮**）
 *
 * ## 为什么不绑装扮
 *
 * 服饰照片的解锁是「触发 → 发图 → 顺带解锁那套装扮」，
 * 图与装扮一一对应。生活照拍的是**场景**（放学后、复习到一半、
 * 浴室门口…），穿什么由画面自己决定，与 24 套装扮没有对应关系。
 * 所以判断时**不核对穿着**，只看聊到的场景对不对得上。
 *
 * ## 每组两张
 *
 * 两张是**同一场景的连拍**（光线、坐姿略有不同）—— 发的时候
 * 一起发，像真实聊天里连拍两张过来。
 * 个别组只有一张（坏图已剔除），`photoFiles` 返回候选，
 * 调用方筛出实际存在的即可。
 *
 * ## 一次性
 *
 * 触发过就不再进候选 —— 由调用方传入的 `triggered` 列表保证。
 * 16 组全部触发后，这条线不再调模型。
 *
 * ## 关键词必须互不为子串（构建期断言）
 *
 * 两组关键词若重叠，同一句话会同时命中两组、一起进候选，
 * 模型选哪个是随机的 —— 表现为「聊这件事有时发这组、有时发那组」，
 * 而每组只有一次机会，很快就莫名耗尽。
 * `assertNoKeywordOverlap` 在模块加载时检查，冲突直接抛错。
 */

/**
 * 16 组场景照片。
 *
 * `slug` 与照片文件名对应：`g05` → `photos/life/g05-1.png`、`g05-2.png`。
 *
 * `hint` 给用户看（图鉴里未触发时当线索）。
 * `scene` 给模型看（判断这轮对话是否聊到了这个场景）。
 * `keywords` 本地预筛用，命中才把候选交给模型。
 */
/**
 * 每组生活照的**亲密度门槛**。
 *
 * ## 为什么比服饰低
 *
 * 生活照是「她随手拍的日常」—— 门槛太高会显得她在设防，
 * 而这些照片本来也不私密（在教室、在便利店）。
 *
 * 但**不是全零**：完全没门槛的话，一开局就能收到 23 组，
 * 「收集」这件事就没有过程感了。所以只给「偏私密」的几组加门槛，
 * 其余保持 0。
 *
 * ## 分档
 *
 *   0    公共场所、白天、随便拍的（占大多数）
 *   40   需要一点熟络才给（居家放松的场景，好朋友）
 *   120  更私密的（她在家最放松的样子，默契搭档）
 *
 * **没列在这里的 = 0 门槛。**
 */
export const PHOTO_MIN_POINTS = {
  /* 40（好朋友）：居家放松、不那么「对外」的时刻 */
  g04: 40,
  g07: 40,
  g08: 40,
  g12: 40,
  g15: 40,
  g16: 40,

  /* 120（默契搭档）：最放松的私密时刻 */
  g03: 120,
  g05: 120,
  g06: 120,
}

/** 取某组的门槛（没配 = 0） */
export const photoMinPoints = (slug) => PHOTO_MIN_POINTS[slug] ?? 0

export const PHOTO_STORIES = {
  g01: {
    title: '放学后没走',
    hint: '聊到放学、赖在教室不想回家',
    scene: '放学后的空教室，她坐在课桌上，书包还放在旁边',
    keywords: ['放学', '下了课', '留在教室', '不想回家', '还在学校'],
  },
  g02: {
    title: '复习到走神',
    hint: '聊到复习、考试周、看不进书',
    scene: '宿舍地板上铺着坐垫，旁边摊着翻开的课本，她盘腿坐着发呆',
    keywords: ['复习', '考试周', '看不进去', '背不下来', '要考试了'],
  },
  g03: {
    title: '傍晚发呆',
    hint: '聊到傍晚、窗外天色、一个人安静待着',
    scene: '飘窗边，窗帘被风吹起，窗外是傍晚的天色，她侧坐着看外面',
    keywords: ['傍晚', '天黑了', '看窗外', '发呆', '黄昏'],
  },
  g04: {
    title: '赖着不想动',
    hint: '聊到不想动、赖在沙发上、什么都不想干',
    scene: '客厅沙发旁的地毯上，她背靠沙发抱着膝盖坐着',
    keywords: ['不想动', '赖着', '什么都不想干', '好懒', '瘫着'],
  },
  g05: {
    title: '周末下午',
    hint: '聊到周末、午后阳光、一个人在家',
    scene: '木地板上拉出长条的午后阳光，她坐在地上双腿伸开，手撑在身后',
    keywords: ['周末', '午后', '下午没事', '在家待着', '晒太阳'],
  },
  g06: {
    title: '刷手机刷累了',
    hint: '聊到刷手机、看累了、无聊',
    scene: '卧室地毯上散着抱枕，她趴着翻杂志，小腿轻轻抬起',
    keywords: ['刷手机', '看好久了', '好无聊', '看累了', '刷视频'],
  },
  g07: {
    title: '安静待一会儿',
    hint: '聊到想一个人静静、什么都不说',
    scene: '飘窗的坐垫上，她跪坐着回头看镜头，窗外天色安静',
    keywords: ['想静静', '安静一会', '不想说话', '一个人待着', '放空'],
  },
  g08: {
    title: '刚洗完澡',
    hint: '聊到洗澡、洗漱、准备休息',
    scene: '浴室门口的小板凳上，地面还留着水痕，她双手放在膝上坐着',
    keywords: ['洗完澡', '刚洗完', '洗漱完', '冲个澡', '洗完脸'],
  },
  g09: {
    title: '阳台上的午后',
    hint: '聊到阳台、晾衣服、吹风',
    scene: '阳台藤椅上，她一条腿搭在扶手上靠着，晾着的衣服随风轻摆',
    keywords: ['阳台', '晾衣服', '吹风', '晒被子', '风好大'],
  },
  g10: {
    title: '不想写作业',
    hint: '聊到作业、写不下去、拖延',
    scene: '书桌前的地毯上，椅子被推开，她背靠桌腿坐着抱膝',
    keywords: ['作业', '写不下去', '不想写', '拖到最后', '还没写完'],
  },
  g11: {
    title: '爬楼爬累了',
    hint: '聊到爬楼梯、走路累、回家路上',
    scene: '木质楼梯的台阶上，她坐着歇脚，一条腿伸直一条腿曲着',
    keywords: ['爬楼', '好累', '走不动', '回家路上', '腿酸'],
  },
  g12: {
    title: '热得不想动',
    hint: '聊到天热、开空调、夏天难熬',
    scene: '卧室地板的凉席上，旁边开着风扇，她侧躺着不想动',
    keywords: ['好热', '太热了', '开空调', '热化', '夏天难熬'],
  },
  g13: {
    title: '等吃的',
    hint: '聊到做饭、切水果、等吃的',
    scene: '厨房中岛台前，台面上放着切好的水果，她坐在高脚凳上等着',
    keywords: ['切水果', '做饭', '等吃', '厨房', '饿了想吃'],
  },
  g14: {
    title: '在图书馆',
    hint: '聊到图书馆、自习、占了座',
    scene: '图书馆靠窗的座位，桌下铺着地毯，她坐在椅子上一条腿盘起来',
    keywords: ['图书馆', '自习', '占座', '来看书', '在书里'],
  },
  g15: {
    title: '试了件衣服',
    hint: '聊到试衣服、买衣服、镜子',
    scene: '房间的穿衣镜前，她坐在地上对着镜子拍照，双腿向一侧伸开',
    keywords: ['试衣服', '买了件', '新衣服', '镜子前', '搭不搭'],
  },
  g16: {
    title: '追剧到一半',
    hint: '聊到追剧、看综艺、零食',
    scene: '客厅茶几旁摊着零食袋，她侧靠着沙发坐在地上看剧',
    keywords: ['追剧', '看剧', '综艺', '零食', '看一半'],
  },

  /*
   * 以下 7 组来自更早的一次生成（两张旧 sheet 的「自由穿搭格」）——
   * 与 g01~g16 同属生活照，只是场景从居家换成了在外。
   * 每组只有一张（其中一组的那张废了，没补）。
   */
  g17: {
    title: '湖边坐一会儿',
    hint: '聊到学校里的湖、傍晚的云、长椅',
    scene: '校园湖边的长椅上，云被染成橘粉色，她坐着拍前方',
    /* 「傍晚」是 g03 的关键词，这里不能再含 —— 会让同一句话命中两组 */
    keywords: ['湖边', '文山湖', '长椅', '校园里', '湖对面'],
  },
  g18: {
    title: '咖啡店看书',
    hint: '聊到咖啡店、拿铁、一个人看书',
    scene: '咖啡店的木质长桌，一杯拉花拿铁和翻开的书，她坐在窗边抬头看镜头',
    keywords: ['咖啡店', '拿铁', '喝咖啡', '泡咖啡厅', '一个人看书'],
  },
  g19: {
    title: '雨后的操场',
    hint: '聊到下雨、操场、雨停之后',
    scene: '雨后的操场跑道，积水映着天空，她撑着伞站在跑道边',
    keywords: ['雨后', '刚下过雨', '操场', '雨停了', '撑伞'],
  },
  g20: {
    title: '桌前赶东西',
    hint: '聊到临时抱佛脚、赶进度、桌上摊满东西',
    scene: '书桌前摊着笔记本和荧光笔，旁边一杯咖啡，她坐在椅子上回头看镜头',
    keywords: ['赶进度', '临时抱佛脚', '写到半夜', '桌上都是', '开着电脑'],
  },
  g21: {
    title: '出门前',
    hint: '聊到出门、换鞋、准备走了',
    scene: '玄关，刚脱下的帆布鞋摆在脚边，旁边挂着外套，她蹲着系鞋带抬眼',
    keywords: ['要出门了', '准备走了', '换鞋', '出门前', '刚到门口'],
  },
  g22: {
    title: '地铁上',
    hint: '聊到地铁、通勤、路上',
    scene: '地铁车厢里，窗外是后退的城市剪影，她靠着车门单手扶杆站着',
    keywords: ['地铁', '通勤', '在车上', '坐地铁', '路上挤'],
  },
  g23: {
    title: '便利店',
    hint: '聊到便利店、关东煮、夜宵',
    scene: '便利店的关东煮柜台前，暖白灯光，她端着关东煮回头看镜头',
    keywords: ['便利店', '关东煮', '夜宵', '买点吃的', '楼下买'],
  },
}

/** 全部组 id（供遍历） */
export const PHOTO_SLUGS = Object.keys(PHOTO_STORIES)

/**
 * 组 id + 序号 → 照片路径（相对 `public/`）。
 *
 * 与服饰照片（`photos/yuki-photo-<slug>-N.png`）分开放在 `photos/life/`：
 * 两者命名空间不同 —— 服饰照片的 `slug` 是装扮名，这里是组号，
 * 混在同一层容易在调试时看错文件。
 */
export function photoFilesAt(slug, index) {
  return `photos/life/${slug}-${index}.png`
}

/** 一组的候选照片路径（两张连拍） */
export function photoFiles(slug) {
  return [photoFilesAt(slug, 1), photoFilesAt(slug, 2)]
}

/**
 * 构建期断言：任意两组的关键词不能互为子串。
 *
 * 判据是**完整关键词的包含关系**（`ka.includes(kb)`）——
 * 比如 A 有「洗完澡」、B 有「刚洗完澡」，后者这句话会同时命中两组。
 * 只看单字词会误报（「热」是「好热」的子串，但两者本就该是同一组）。
 *
 * 只在模块加载时跑一次，纯字符串比较，成本可忽略。
 */
export function assertNoKeywordOverlap() {
  const pairs = []
  for (const [a, da] of Object.entries(PHOTO_STORIES)) {
    for (const [b, db] of Object.entries(PHOTO_STORIES)) {
      if (a >= b) continue
      for (const ka of da.keywords ?? []) {
        for (const kb of db.keywords ?? []) {
          if (ka === kb || ka.includes(kb) || kb.includes(ka)) {
            pairs.push(`${a}「${ka}」 ↔ ${b}「${kb}」`)
          }
        }
      }
    }
  }
  if (pairs.length) {
    throw new Error(
      `photoStories：关键词冲突（同一句话会同时命中两组，导致随机触发）：\n  ${pairs.join('\n  ')}`,
    )
  }
}

/* 模块加载时立刻检查 —— 写错了当场炸，不要等跑到线上才发现 */
assertNoKeywordOverlap()

/**
 * 关键词预筛：这段文本命中了哪些**未触发过**的组。
 *
 * 本地匹配零成本，命中才把候选交给模型 ——
 * 不过筛的话每轮对话都要为 16 个未触发组各调一次模型，开销不可接受。
 *
 * @param {string} text 最近对话拼成的文本
 * @param {string[]} triggered 已触发的组 id（这些不再参与）
 */
export function photoKeywordCandidates(text, triggered = [], points = 0) {
  const s = String(text ?? '')
  if (!s) return []
  const done = new Set(triggered)
  const p = Number(points) || 0
  const hits = []
  for (const [slug, def] of Object.entries(PHOTO_STORIES)) {
    if (done.has(slug)) continue
    /* 亲密度不够的不进候选（理由同服饰：在这里挡零成本） */
    if (p < photoMinPoints(slug)) continue
    if ((def.keywords ?? []).some((k) => k && s.includes(k))) hits.push(slug)
  }
  return hits
}

/**
 * 条件解锁：生活照**不支持**条件解锁。
 *
 * 服饰里有的装扮「初始就该有」（比如 jk 作为基准装扮），
 * 生活照没有这种「基准」，全部要靠聊天触发 —— 否则一开局
 * 就白送几张，失去了「聊到了才发」的意义。
 */
export const PHOTO_CONDITION_LINES = {}

export function photoConditionUnlocks() {
  return []
}

/**
 * 判定用的系统提示词。
 *
 * ## 与服饰版的关键差别
 *
 * 这里**没有**「她此刻正穿着那套」这一条 —— 生活照不绑装扮，
 * 场景对得上就够了。所以只要求两条：
 *
 *   ① 场景吻合：这轮确实聊到了候选描述的那个场景
 *   ② 有分享动机：气氛合适，她有理由随手拍一张发过来
 *
 * 仍然要求「默认不触发」，避免放水 —— 与服饰版同样的理由：
 * 条件写得模糊，模型会倾向猜「吻合」。
 */
export const PHOTO_JUDGE_SYSTEM = [
  '你是一个剧情触发器，判断是否有某组生活照此刻适合发出来。',
  '',
  '【触发条件】两个必须**同时**成立，缺一个都不触发：',
  '',
  '① 场景吻合：这轮对话确实聊到了候选里描述的那个场景。',
  '   注意是**这轮真的聊到了**，不是泛泛相关。',
  '   （例如候选是「刚洗完澡」，那得聊到洗澡/洗漱才算；',
  '    只聊到「今天好累」不算。）',
  '',
  '② 有分享动机：气氛合适，她有理由随手拍一张发过来 ——',
  '   刚被问到、正想分享、顺着话题接一句。冷冰冰的问答不算。',
  '',
  '【默认结论是不触发】',
  '宁可漏过也不要错给。拿不准就输出 null。',
  '',
  '【一次最多一组】',
  '如果多组都勉强成立，选最贴合的那个；都不够好就都不触发。',
  '',
  '【输出格式】严格 JSON，不要任何其他文字：',
  '  触发：{"slug":"候选里的某个slug","line":"她发照片时说的那句话"}',
  '  不触发：{"slug":null}',
  '',
  'line 是她发给你的一句话，口语、30 字内，像随手拍照片时的配文。',
].join('\n')

/**
 * 构造判定请求的用户消息。
 *
 * @param {Array<{role:string,content:string}>} recent 最近对话（纯文本）
 * @param {string[]} candidates 候选组 id
 */
export function buildPhotoJudgePrompt(recent, candidates) {
  const lines = candidates.map((slug) => {
    const d = PHOTO_STORIES[slug]
    return `- ${slug}：${d.title}（${d.hint}）\n  场景：${d.scene}`
  })
  const dialogue = (recent ?? [])
    .map((m) => `${m.role === 'user' ? '用户' : 'Yuki'}：${m.content}`)
    .join('\n')
  return [
    '候选生活照：',
    ...lines,
    '',
    '最近的聊天记录：',
    dialogue,
    '',
    '按规则判断是否触发（两条件缺一不可），输出 JSON。',
  ].join('\n')
}

/**
 * 解析模型输出。
 *
 * 模型可能返回 markdown 代码块、多余解释、或编造不存在的 slug ——
 * 全部兜住，只接受「候选集合内的合法 slug」，否则当不触发。
 */
export function parsePhotoJudge(raw, candidates = []) {
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
  return { slug, line: line || '随手拍了一张' }
}
