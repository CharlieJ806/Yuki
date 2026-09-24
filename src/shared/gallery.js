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
  PHOTO_STORIES,
  PHOTO_JUDGE_SYSTEM,
  PHOTO_CONDITION_LINES,
  photoKeywordCandidates,
  photoConditionUnlocks,
  buildPhotoJudgePrompt,
  parsePhotoJudge,
} from './photoStories.js'
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
/*
 * 类目顺序即 checkAny 的检查顺序，**一轮最多解锁一个** ——
 * 先命中的赢。生活照放最后：它是「日常随手拍」，
 * 而服饰照片每人只有 1~2 张，错过一次要等很久，优先给它。
 */
export const GALLERY_KINDS = ['outfit', 'video', 'photo']

/**
 * 图鉴类型 → 存储键名。
 *
 * 两端（Electron 主进程 / 手机端 IndexedDB）**必须用同一套键名** ——
 * 将来做备份同步时，键名不同会平白多一层映射，还容易出现
 * 「备份里有但当端读不到」这类难查的问题。
 *
 * 放这里（shared）而不是各端各写一份：之前就是手机端和主进程
 * 各维护一张表，加「背景图」类目时只改了一处，另一端直接抛
 * 「未知的图鉴类型」。单一真相源能从结构上杜绝这种情况。
 */
export const GALLERY_KEYS = {
  outfit: { list: 'unlockedOutfits', mem: 'outfitMemories' },
  video: { list: 'unlockedVideos', mem: 'videoMemories' },
  photo: { list: 'triggeredPhotos', mem: 'photoMemories' },
}

/**
 * 条件类的固定台词。不经过模型，写死更省。
 */
export const STORY_CONDITION_LINES = {
  jk: '这是我平时最常穿的一套，先给你看看～',
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
  /*
   * 生活照：她随手拍的日常（不绑装扮，横构图）。
   * 管线与装扮/视频完全一致，只是判断条件不含「穿着吻合」。
   */
  photo: {
    table: PHOTO_STORIES,
    conditionUnlocks: photoConditionUnlocks,
    keywordCandidates: photoKeywordCandidates,
    judgeSystem: PHOTO_JUDGE_SYSTEM,
    buildJudgePrompt: buildPhotoJudgePrompt,
    parseJudge: parsePhotoJudge,
    conditionLines: PHOTO_CONDITION_LINES,
    defaultLine: '随手拍了一张',
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
export function explainCandidates(text, unlockedByKind = {}, points = 0) {
  const out = {}
  for (const kind of GALLERY_KINDS) {
    const spec = GALLERY_SPECS[kind]
    const unlocked = unlockedByKind[kind] ?? []
    /*
     * `all` 用**无限亲密度**跑一遍，得到「文本本来能命中什么」；
     * `live` 用真实亲密度，得到「现在实际会进模型判断的」。
     * 两者一减，就是「被亲密度门槛卡住的」——
     * 排查「为什么聊到了却没解锁」时，这一步能直接区分
     * 「关键词没命中」和「关系还不够」。
     */
    const all = spec.keywordCandidates(text, [], Number.POSITIVE_INFINITY)
    const live = spec.keywordCandidates(text, unlocked, points)
    out[kind] = {
      /** 文本本来能命中的（不看亲密度） */
      matched: all,
      /** 其中还没解锁、且亲密度够的（= 真正会进模型判断的） */
      candidates: live,
      /** 被跳过的（已解锁，或亲密度不够） */
      skipped: all.filter((s) => !live.includes(s)),
    }
  }
  return out
}
