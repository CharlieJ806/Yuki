/**
 * 解锁照片 —— 「她主动发来自拍」。
 *
 * ## 效果目标
 *
 * 装扮解锁时，不能只在弹窗里展示，还要让照片**作为真实消息
 * 出现在聊天记录里**（像微信里对方发图那样）。弹窗保留，
 * 但聊天框里也要有 —— 用户往上翻能重新看到。
 *
 * ## 两类照片，两套命名
 *
 *   服饰照片（绑装扮）：`photos/yuki-photo-<slug>.png`、`-2.png`…
 *   生活照（不绑装扮）：`photos/life/<gNN>-1.png`、`-2.png`
 *
 * 分开是因为 slug 命名空间不同 —— 服饰照片的 slug 是装扮名，
 * 生活照的是组号（`g01`…）。混在同一层容易在调试时看错文件。
 * 由 `photoPathsOf(kind, slug)` 统一分派，调用方不用关心。
 *
 * 为什么编号从**第 1 张不带后缀**：现有素材就是这个名字，
 * 保持兼容可以让「只拍了一张」的情况零成本。
 *
 * ## 为什么单独一个模块
 *
 * 两端都要做同一件事（主进程 / 手机端），而「照片存不存在」
 * 这个判断在两端**方式不同**：
 *   - 主进程：文件系统，`existsSync`
 *   - 手机端：预加载探测（静态资源没法同步判断）
 *
 * 所以这里只放**两端一致的部分**：命名规则、消息构造。
 * 判存在性交给调用方（见 `photoPaths` 的用法）。
 */

import { photoFiles } from './photoStories.js'

/** 一套装扮最多几张照片（超过这个数的后缀不再尝试） */
export const MAX_PHOTOS_PER_OUTFIT = 4

/**
 * 按序号拼照片路径。
 * @param {string} slug 装扮 slug
 * @param {number} index 第几张，从 1 开始
 */
export function photoPathAt(slug, index) {
  return index <= 1 ? `photos/yuki-photo-${slug}.png` : `photos/yuki-photo-${slug}-${index}.png`
}

/**
 * 一套装扮的所有候选照片路径（从 1 到 MAX_PHOTOS_PER_OUTFIT）。
 *
 * **不做存在性判断** —— 那是调用方的事（文件系统 / 图片探测）。
 * 返回候选列表，调用方筛出实际存在的。
 */
export function photoCandidates(slug) {
  const out = []
  for (let i = 1; i <= MAX_PHOTOS_PER_OUTFIT; i++) out.push(photoPathAt(slug, i))
  return out
}

/**
 * 按类目取候选照片路径。
 *
 * 两类照片命名规则不同（见文件头），调用方只需要给 `kind` 和 `slug`。
 *
 * @param {'outfit'|'photo'} kind
 * @param {string} slug 服饰照片是装扮 slug；生活照是组号（g01…）
 */
export function photoPathsOf(kind, slug) {
  if (kind === 'photo') return photoFiles(slug)
  return photoCandidates(slug)
}

/** 兼容旧调用：第 1 张的路径 */
export function photoPath(slug) {
  return photoPathAt(slug, 1)
}

/**
 * 拼「她发来照片」的 assistant 消息内容。
 *
 * 内容格式是 OpenAI 的块数组（`[{type:'text'}, {type:'image_url'}…]`），
 * 与用户自己发图时用的格式一致 —— 这样：
 *   1. 渲染层已有的 `imagesOf()` 直接能识别并渲染（多张会横排）
 *   2. 回传给模型时是标准格式，她能「记得」自己发过
 *
 * @param {string}   slug     装扮 slug
 * @param {string}   caption  配文（一般是该装扮的 story）
 * @param {string[]} imgPaths 图片相对路径，**至少一张**
 */
export function buildPhotoMessage(slug, caption, imgPaths) {
  const list = (Array.isArray(imgPaths) ? imgPaths : [imgPaths]).filter(Boolean)
  const text = String(caption ?? '').trim()
  return [
    { type: 'text', text: text || '给你看看今天的我。' },
    /* 用相对路径而不是 data URL：照片是静态资源，
       转 base64 会让消息体积翻几倍（每张 300KB+），
       IndexedDB 撑不住，也没必要 —— 图片本来就在本地。 */
    ...list.map((url) => ({ type: 'image_url', image_url: { url } })),
  ]
}

/**
 * 把一次解锁的照片拆成**多条消息** —— 每条一张图，配文单独一条。
 *
 * ## 为什么拆开
 *
 * 早先是「一条消息里塞 N 张图 + 一句配文」，聊天里看起来是一坨。
 * 真实聊天里她发连拍是**一张一条**地发过来的，配文还常在最前面。
 * 拆开之后：配文先出现，然后照片一张张跟上来。
 *
 * ## 返回顺序 = 落库顺序 = 显示顺序
 *
 * 调用方必须**按返回顺序依次落库**，并给每条一个**递增的时间戳**
 * （见下面 `offset` 的说明）。返回的每一项是一条完整的消息内容
 * （OpenAI 块数组），可直接交给 `store.addMessage`。
 *
 * ## 配文在前
 *
 * 顺序是「先说一句话，再甩照片」—— 这是真实聊天里最常见的形态
 * （照片是对那句话的补充）。
 *
 * @param {string}   caption 她发照片时说的那句话；空则不产出配文那条
 * @param {string[]} imgPaths 图片相对路径
 * @param {object}   [opts]
 * @param {number}   [opts.offset] 时间戳偏移基准，见返回值说明
 * @returns {Array<{content:Array, delayMs:number}>}
 *   `content` 是一条消息的内容块数组；
 *   `delayMs` 是这条**相对上一条**应延迟多少毫秒（模拟她一条条发）。
 */
export function buildPhotoMessages(caption, imgPaths, { offset = 0 } = {}) {
  const list = (Array.isArray(imgPaths) ? imgPaths : [imgPaths]).filter(Boolean)
  const text = String(caption ?? '').trim()
  const out = []

  /*
   * 配文那条：**不带图**。
   * 这样它在渲染层就是一个纯文字气泡，而不是「文字 + 图」的混合块 ——
   * 混合块会让气泡长度按最宽的那张图算，配文短的时候看着很空。
   */
  if (text) out.push({ content: [{ type: 'text', text }], delayMs: 0 })

  /*
   * 每条图一条消息。第一张紧跟配文（或紧跟上一条），
   * 之后每张之间再延迟 —— 连拍总得有个间隔才像真人。
   * 延迟值走随机，固定值会显出机械感。
   */
  list.forEach((url, i) => {
    out.push({
      content: [{ type: 'image_url', image_url: { url } }],
      delayMs: i === 0 ? 0 : PHOTO_GAP_MS[0] + Math.round(Math.random() * (PHOTO_GAP_MS[1] - PHOTO_GAP_MS[0])),
    })
  })

  /*
   * `offset` 参与时间戳：由调用方传入已用掉的毫秒数。
   * 之所以需要：`createdAt` 是毫秒级 `Date.now()`，一次性落库的多条
   * 很可能落在**同一毫秒**，而列表按 `ORDER BY createdAt ASC` 排 ——
   * 并列时顺序不保证，照片会乱序。
   * 这里给每条算出它该有的偏移，调用方加到自己取的时间基准上即可。
   * （`delayMs` 也一并累加，让「时间戳的先后」与「视觉出现的先后」一致。）
   */
  let acc = offset
  return out.map((m, i) => {
    acc += m.delayMs
    /*
     * 凡是非首条，至少 +1ms。
     *
     * 光靠 delayMs 不够：配文与紧接的第一张图 delayMs 都是 0，
     * 会拿到同一个 offset，落库后 `createdAt` 并列 ——
     * 而列表按 createdAt 排序，并列时顺序不保证，照片可能跑到配文前面。
     * 加 1ms 是最小的、不影响显示（时间戳只显示到分钟）的区分。
     */
    if (i > 0) acc = Math.max(acc, i)
    return { ...m, offsetMs: acc }
  })
}

/*
 * 连拍两张之间的间隔（毫秒）。
 * 下限不能太小 —— 太小就没「一张张发过来」的感觉；
 * 上限不能太大 —— 1.5 秒以上用户会以为卡住了。
 */
const PHOTO_GAP_MS = [350, 900]

/** 一条消息里是不是「她发的照片」 */
export function isPhotoMessage(m) {
  if (!m || m.role !== 'assistant') return false
  const content = m.content
  if (!Array.isArray(content)) return false
  return content.some((b) => b?.type === 'image_url')
}
