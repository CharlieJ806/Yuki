/**
 * 图鉴解锁管线 —— 装扮与视频共用的一份实现，两端（PC / 手机）也共用。
 *
 * ## 为什么放在 shared 而不是各端写一份
 *
 * 三层触发管线的逻辑（条件 → 关键词预筛 → 模型判断）与「产出物是照片
 * 还是视频」无关，也与跑在 Electron 主进程还是浏览器里无关。
 * 复制三份（手机装扮 / 手机视频 / PC）的话，改一处忘一处，
 * 就会出现「一端省了 token 另一端没省」或「一端的日上限算错」。
 *
 * 各端只需提供三样东西（见 createGalleryRunner 的 opts）：
 *   - store：读写解锁状态与对话历史
 *   - completeOnce：一次非流式的短生成（用来问模型「该触发哪个」）
 *   - isReady：当前是否配好了模型
 *
 * ## 省 token 的三个设计
 *
 *   ① 条件解锁：硬条件直接给，零成本
 *   ② 关键词预筛：本地匹配，不命中就结束，零成本
 *   ③ 模型判断：只为「候选」调一次 API，且一次判断全部候选
 *
 * 外加一条：**已解锁的永不参与判断** —— 候选集合随进度变小，越用越省。
 */
import {
  OUTFIT_STORIES,
  STORY_JUDGE_SYSTEM,
  keywordCandidates,
  conditionUnlocks,
  buildStoryJudgePrompt,
  parseStoryJudge,
} from './outfitStories.js'
import {
  VIDEO_STORIES,
  VIDEO_JUDGE_SYSTEM,
  VIDEO_CONDITION_LINES,
  videoKeywordCandidates,
  videoConditionUnlocks,
  buildVideoJudgePrompt,
  parseVideoJudge,
} from './videoStories.js'

/** 图鉴类型 → 内容表与各自的判定函数 */
export const GALLERY_KINDS = ['outfit', 'video']

/**
 * 条件类的固定台词。不经过模型，写死更省。
 */
export const STORY_CONDITION_LINES = {
  casual: '这是我平时最常穿的一套，先给你看看～',
  pajamas: '都快睡了还跟你聊，喏，睡衣都换好了',
}

const GALLERY_SPECS = {
  outfit: {
    table: OUTFIT_STORIES,
    conditionUnlocks,
    keywordCandidates,
    judgeSystem: STORY_JUDGE_SYSTEM,
    buildJudgePrompt: buildStoryJudgePrompt,
    parseJudge: parseStoryJudge,
    conditionLines: STORY_CONDITION_LINES,
    defaultLine: '给你看看今天的我',
  },
  video: {
    table: VIDEO_STORIES,
    conditionUnlocks: videoConditionUnlocks,
    keywordCandidates: videoKeywordCandidates,
    judgeSystem: VIDEO_JUDGE_SYSTEM,
    buildJudgePrompt: buildVideoJudgePrompt,
    parseJudge: parseVideoJudge,
    conditionLines: VIDEO_CONDITION_LINES,
    defaultLine: '给你看个东西',
  },
}

export const gallerySpec = (kind) => GALLERY_SPECS[kind] ?? null
export const galleryTable = (kind) => GALLERY_SPECS[kind]?.table ?? {}
export const galleryTotal = (kind) => Object.keys(galleryTable(kind)).length

/**
 * 创建解锁执行器。
 *
 * @param {object} opts
 * @param {(kind:string)=>Promise<string[]>} opts.listUnlocked
 * @param {(kind:string, slug:string, line:string, title:string)=>Promise<any>} opts.unlock
 * @param {()=>Promise<Array<{role:string,content:string}>>} opts.recentMessages 最近对话（纯文本）
 * @param {(args:{system:string,messages:Array})=>Promise<string>} opts.completeOnce
 * @param {()=>Promise<boolean>} opts.isReady 模型是否配好
 * @param {()=>number} [opts.points] 亲密度（供条件解锁用）
 * @param {()=>string} [opts.currentOutfit] 她此刻穿着的 slug —— 判定条件②要用
 */
export function createGalleryRunner(opts) {
  const {
    listUnlocked,
    unlock,
    recentMessages,
    completeOnce,
    isReady,
    points = () => 0,
    currentOutfit = () => '',
  } = opts

  /**
   * 跑一次解锁检查。
   * @returns {Promise<{kind:string, slug:string, line:string, title:string}|null>}
   */
  async function checkOne(kind, { recentText = '', now = new Date() } = {}) {
    const spec = GALLERY_SPECS[kind]
    if (!spec) return null

    const unlocked = await listUnlocked(kind)

    /* ① 条件解锁（零成本） */
    const ctxHits = spec.conditionUnlocks(
      {
        points: points(),
        hour: now.getHours(),
        isRestDay: [0, 6].includes(now.getDay()),
      },
      unlocked,
    )
    if (ctxHits.length) {
      const slug = ctxHits[0]
      const d = spec.table[slug]
      const line = spec.conditionLines[slug] ?? spec.defaultLine
      await unlock(kind, slug, line, d.title)
      return { kind, slug, line, title: d.title }
    }

    /* ② 关键词预筛（零成本）—— 不命中就到此为止，不花 token */
    const candidates = spec.keywordCandidates(recentText, unlocked)
    if (!candidates.length) return null

    /* ③ 模型判断（唯一花钱的一步，且只为候选） */
    if (!(await isReady())) return null

    try {
      const recent = await recentMessages()
      const raw = await completeOnce({
        system: spec.judgeSystem,
        messages: [
          {
            role: 'user',
            /*
             * 传入「她此刻穿着」：条件②「状态吻合」要靠它对账。
             * 不传的话模型只能猜，而它倾向猜「吻合」，等于放水。
             */
            content: spec.buildJudgePrompt(recent, candidates, currentOutfit()),
          },
        ],
        maxTokens: 100,
      })
      const { slug, line } = spec.parseJudge(raw, candidates)
      if (!slug) return null
      const d = spec.table[slug]
      await unlock(kind, slug, line, d.title)
      return { kind, slug, line, title: d.title }
    } catch {
      /* 判断失败绝不该影响正常对话 */
      return null
    }
  }

  /**
   * 依次检查各类型，**一轮最多解锁一个**。
   * 两个都命中会同时弹两次，观感很吵。
   */
  async function checkAny(ctx = {}) {
    for (const kind of GALLERY_KINDS) {
      const hit = await checkOne(kind, ctx)
      if (hit) return hit
    }
    return null
  }

  return { checkOne, checkAny }
}

/**
 * 关键词预筛的调试视图：给定一段文本，看会命中哪些候选。
 * 用来排查「为什么聊了某个话题却没解锁」。
 */
export function explainCandidates(text, unlockedByKind = {}) {
  const out = {}
  for (const kind of GALLERY_KINDS) {
    const spec = GALLERY_SPECS[kind]
    const unlocked = unlockedByKind[kind] ?? []
    const all = spec.keywordCandidates(text, [])
    const live = spec.keywordCandidates(text, unlocked)
    out[kind] = {
      /** 文本本来能命中的 */
      matched: all,
      /** 其中还没解锁的（= 真正会进模型判断的） */
      candidates: live,
      /** 已解锁所以被跳过的 */
      skipped: all.filter((s) => !live.includes(s)),
    }
  }
  return out
}
