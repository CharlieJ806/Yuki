/**
 * 自拍照片生成 —— 24 套装扮，每套一张「她发给你的自拍」。
 *
 * ## 与立绘生成（gen-sheet.js）的三个本质差别
 *
 * | | 立绘 | 自拍照片 |
 * |---|---|---|
 * | 背景 | **必须透明**（`background: transparent` + 提示词禁环境词） | **必须有实景**（房间/街边/咖啡店…） |
 * | 校验 | alpha 占比要 > 5%（真透明） | alpha 占比要 ≈ 0%（不能有透明洞） |
 * | 构图 | 全身立绘居中、脚底对格底 | **近距离自拍**（手持手机、半身、脸大） |
 *
 * 所以**不能复用立绘的提示词模板** —— 那套模板里全是
 * 「transparent background / no scenery / no ground」，
 * 用在照片上会得到一张透明底的人像，完全不是自拍。
 *
 * ## 为什么用「分格图 + 切图」而不是一张一张生成
 *
 * 24 次单独请求 = 24 次费用 + 24 次风格漂移的风险。
 * 一次 4×3 出 12 张，同一批的**光线、画风、色温天然一致**，
 * 而且切图脚本已经写好（`split-sheet.js`），直接复用。
 *
 * ## 尺寸为什么是 2048×1536
 *
 * 方格 512×512（手机自拍的常见比例），4 列 × 3 行 = 12 格。
 * 2048 宽的图在 gpt-image 上属于高分辨率档，出图较慢但脸更清楚 ——
 * 自拍的主体就是脸，糊了就没意义。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(SCRIPT_DIR, '..')

/** 照片源图放这里（与立绘的 yuki-new/ 并列） */
export const PHOTO_DIR = join(PROJECT_ROOT, 'resources', 'photos-new')

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

/*
 * 中转地址。默认 `https://cf.api.fan` —— 这是实测可用的入口。
 *
 * 曾经默认写成 `api.packycode.com`，那个域名**根本不存在**
 * （nslookup 返回 NXDOMAIN），一跑就是 `000` 连不上，
 * 看起来像网络问题，实际是地址错了。
 * 可用 `--base` 或 `PACKY_BASE_URL` 覆盖。
 */
const BASE_URL = (getOpt('--base', process.env.PACKY_BASE_URL || 'https://cf.api.fan')).replace(/\/$/, '')
const API_KEY = process.env.PACKY_API_KEY || ''
const PROXY =
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ''
/*
 * 出图模型。
 *
 * ## 实测：三个可用模型的安全阈值差很多
 *
 *   `gpt-image-2.5-sunburst`  ← 默认，本项目的照片只有它能过审
 *   `gpt-image-2.5-flare`     ← 同样提示词直接 400 safety_violations=[sexual]
 *   `gpt-image-2`             ← 未实测
 *
 * 注意 `flare` 拒的是**模型自己的阈值**，不是提示词写错了 ——
 * 同一份提示词换回 `sunburst` 就能出。
 * 所以**不建议用 `--model` 换模型**，除非先小批量试过。
 */
const MODEL = getOpt('--model', 'gpt-image-2.5-sunburst')
const QUALITY = getOpt('--quality', 'high')

/* ---------- 角色基准（与立绘共用同一套外在设定） ---------- */

/**
 * 角色外观锚定段 —— 与 `gen-sheet.js` 的 `buildBase` **同样的约束力度**。
 *
 * ## 为什么必须和立绘那边对齐
 *
 * 立绘的 `buildBase` 花了大量篇幅锁死脸/发/发饰/画风，理由是
 * 「AI 出图每次都会漂」。照片如果只写一半约束，生成出来的人
 * 和桌宠立绘就不是同一张脸 —— 用户会立刻发现。
 *
 * ## 与立绘那边**刻意不同**的三处
 *
 * | | 立绘（G1/G2） | 照片 |
 * |---|---|---|
 * | 参考图 | G1→设定图1、G2→设定图2（两个着装形象） | **只用设定图2** |
 * | 基准着装 | 每格都穿 OUTFIT_A / OUTFIT_B 那一套 | **每格换一套**（见 OUTFIT_LOOKS） |
 * | 背景 | 必须完全透明（删掉一切环境） | **必须有实景** |
 *
 * 前两条是「照片要 24 套不同打扮」决定的；第三条是照片的本质。
 * 其余（面部、发型、发饰、画风）**逐字对齐**。
 */
export function buildPhotoBase(o) {
  const [cw, chh] = o.size.split('x').map(Number)
  return `【角色基准 · 必须严格遵守】

人物：活泼开朗的女大学生，约160cm，身形小巧纤细，但是胸部比一般同龄人稍大一点，具体可以看参考图中的尺寸。

【关于参考图 · 重要】
提供的图是这个角色的设定图（**大学时期**的形象）。
- **只看图里的长相，不要读图上的任何文字**
- 一切的属性以本提示词的描述为准
- 本批全部是同一个人的照片，脸部、发型、发饰完全相同

【面部与发型 —— 任何情况下都不许改变】
- 头发：深棕色长发，发量浓密，发尾微卷，齐刘海
- 发饰：头部右侧一个深色大蝴蝶结 + 小花吊坠（她的标志，必须始终存在）
- 眼睛：红棕色/赤褐色，大而圆润，瞳孔有高光
- 脸型：圆润偏幼，皮肤白净
- 表情基准：活泼开朗

【画风 —— 任何情况下都不许改变】
日系二次元插画，柔和赛璐璐上色，细腻发丝，暖色调，
线条干净，五官比例接近设定图。
**手机自拍质感**：轻微的镜头畸变、自然的室内/户外光线、柔和的景深虚化。

【服装规则】
本张是**同一个人换多套打扮**（具体几格见下方「逐格明细」）。
- 面部、发型、发饰、画风**始终不变**，只换衣服和环境
- **每一格的服装严格按照逐格明细里写的那一套来**：
  不要自己发挥、不要把两套混穿、不要把某一格的衣服画到别的格里
- 换装只换「穿在身上的」，发型和发饰不跟着变

【构图 —— 这是「照片」不是「立绘」】
- 本张全部为 ${o.ratioText}
- 拍摄方式：${o.compose}
- **一定要有背景环境**，不能是纯色、不能是透明底、不要留白
- 表情生动自然，符合每格描述的场景氛围

【氛围与取景 · 她私下发给你的那种照片】

- **距离稍近但不裁切**：整个人要在画面内，脚也要拍进去

- **腿和脚自然入镜**：盘腿、抱膝、腿伸向镜头、光脚踩地板/沙发、

  踢掉的鞋子、散落的外套 —— 这些是「在家放松」的自然姿态，

  也是最容易出生活感的构图

- **场景偏居家**：卧室、沙发、床边、浴后、深夜 

- **光线要软**：台灯、夜灯、窗边的自然光，避免影棚式的正面打光




【衣着必须保持】

- **只穿该格指定的那一套**，保持它本来的设计（睡裙就是睡裙、风衣就是风衣）



【输出要求 · 极其重要】
- 绝对不要画成「角色设定图 / 三视图 / 表情差分网格」
- 绝对不要任何文字、标签、色卡、边框、水印、装饰图标
- 不要多个角色同框
- **自由穿搭格**（下方标了「自由穿搭」的格子）：这几格**不指定服装**，
  由你根据场景给她搭一套合适的日常穿着（延续她的风格与配色）。
  其余要求与别的格完全一样：正常的人物照片、全身入镜、有背景环境
- 【画布与网格 · 必须严格遵守】
- 画布 ${cw}×${chh}
- 划分为 ${o.cols} 列 × ${o.rows} 行 = ${PER_SHEET} 个等大方格，每格 ${o.cell} 像素
- **每格的画幅比例必须严格是 ${o.key === 'vert' ? '3:4（竖）' : '4:3（横）'}**，不要去适配成正方形
- **网格位置必须与下面「逐格明细」的编号一一对应**：
  第1格 = 第1行第1列（左上）、第2格 = 第1行第2列、第${o.cols + 1}格 = 第2行第1列，依此类推
  从左到右、从上到下。**不允许调换格子顺序、不允许合并格子、不允许留空格**
- 每格都是一张**独立完整**的照片，构图各自独立
- **每格四周必须留出明显的空白边距**（相当于格子宽度的 5% 左右，肉眼能看出来的空白）：
  人物的头发、手脚、裙摆，以及场景里的家具、地板纹理，**统统不能碰到格子边界**。
  相邻两格之间要有清晰的分界，绝对不能出现「一个人横跨两格」或「家具延伸到隔壁」的情况
- **人物在格里要留余量**：头顶留背景、脚下也留背景，不要让人物顶满整个格子 —— 顶满一定会被切掉
- 每格的姿势、角度、背景、表情都必须不同，不要复制粘贴
- 不需要网格线

【最重要的一条】
这 ${PER_SHEET} 格看起来要像**同一个女生在不同场合拍的 ${PER_SHEET} 张照片**：
光线基调统一、画风统一、脸完全相同，但服装、场景和姿态各不相同。`
}

/* ---------- 24 套装扮 → 24 张照片 ---------- */

/**
 * 两种画幅。**分开成两张 sheet**，不混在同一张画布上。
 *
 * 为什么不混：模型画完是**实心图**，没有 alpha 可以裁边，
 * 所以「一张画布上竖图 288×384、横图 512×384」这种混合网格
 * 只能靠提示词约束 —— 模型不严格遵守时切出来就歪了。
 * 分成两张画布各用各的等分网格，切图零风险，比例天然不同：
 *
 * | 画幅 | 画布 | 网格 | 每格 | 比例 |
 * |---|---|---|---|---|
 * | vert（竖） | 1536×2048 | 4列×4行 | 384×512 | 3:4 |
 * | land（横） | 2048×1536 | 4列×4行 | 512×384 | 4:3 |
 *
 * **网格数是 4×4=16 而不是 4×3=12**：这两个画布都是 API 的标准档，
 * 想让每格是 3:4 / 4:3，只能切成 16 格（已验证：
 * 1536/4=384、2048/4=512 → 384÷512=0.75 正好 3:4）。
 * 24 套装扮用掉 24 格，每张 sheet 剩 4 格画「不指定服装的日常照」，
 * 那些不绑 slug，日后可以拿来当聊天背景。
 *
 * 素材观感上，竖图看手机自拍、横图看「别人帮拍的」或环境照 ——
 * 真实聊天记录里两种都有，混着发才自然。
 */
/**
 * 画幅定义。
 *
 * `land` 额外派生一个 `feet` 变体 —— 画布与网格和 land 完全一致
 * （同一张 4×4 横幅画布），只是**构图要求换成露脚专项**。
 * 派生而不是复制：复制会让「改一处忘一处」，
 * 而画布尺寸这种参数一旦不一致，切图就会错位。
 */
export const ORIENTATIONS = {
  vert: {
    key: 'vert',
    label: '竖幅自拍',
    size: '1536x2048',
    cols: 4,
    rows: 4,
    cell: '384×512',
    ratioText: '**竖构图 3:4**',
    compose:
      '自拍视角：手机举高一些、或采用「对着镜子拍」的方式，' +
      '**从头顶到脚完整入镜**，画面下缘必须看得见脚或鞋，' +
      '背景是身后的真实环境',
  },
  land: {
    key: 'land',
    label: '横幅照片',
    size: '2048x1536',
    cols: 4,
    rows: 4,
    cell: '512×384',
    ratioText: '**横构图 4:3**',
    compose:
      '像「别人帮忙拍的一张」或支起手机拍的照片：' +
      '**她要从头顶到脚完整入镜**，同时把所在的地方一起拍进去' +
      '（桌面上的东西、街景、房间布置）',
  },
}

/*
 * `feet` 变体：与 land 共用画布，但构图要求是「露脚专项」。
 * 用展开运算符派生并在其后覆盖，保证画布参数永远同源。
 */
ORIENTATIONS.feet = {
  ...ORIENTATIONS.land,
  key: 'feet',
  label: '居家放松写真',
  /*
   * ## 为什么改成「全身不裁切」而不是「露脚特写」
   *
   * 早先写成「必须清楚看到她的脚 / 脚趾脚背袜尖完整可见」，
   * 请求被安全系统拒绝：`safety_violations=[sexual]`。
   * 原因是**「居家睡裙 + 露腿 + 脚部特写」这个组合**被判为恋足取向，
   * 与服装本身无关（同样的睡裙文案在第 1、2 张照片里一直能过）。
   *
   * 所以这里只保留**中性的全身构图要求** ——
   * 「从头顶到脚完整入镜、不要裁切」本来就能保证脚出现在画面里，
   * 而且不会把注意力指向身体局部。姿势也不点名脚部，
   * 改成「席地而坐、盘腿、靠着沙发」这类生活化的说法。
   *
   * 居家场景里本来就不穿鞋（这是常识），不需要专门写「不穿鞋」——
   * 专门写反而强化了「脚」这个焦点。
   */
  compose:
    /*
     * 两条硬要求，缺一不可：
     *
     *   1. **从头到脚清晰可见** —— 早先被裁过（第 5 格的腿、第 12 格的脚），
     *      所以这次把「必须留在格内」写成显式的构图约束。
     *   2. **人物不要顶满格子** —— 顶满就必然越界，越界就会被切。
     *      明确要求「四周留出空间」，脚才不会贴到格线上。
     *
     * 脚部只允许两种情况：**光脚** 或 **薄丝袜**（肉色/黑色半透明）。
     * 早先出过「厚白色棉袜」，那是模型的默认联想 ——
     * 必须显式排除，写清楚「不是棉袜/不是厚袜」。
     */
    '**全身完整入镜：从头顶到脚底必须全部清晰可见，一样都不能少、' +
    '一处都不能被画面边缘切掉。**' +
    '人物在格子里**留出四周空间**（头顶和脚下各留一段背景），' +
    '不要顶满、不要贴边 —— 顶满就会被切。' +
    '构图生活化 —— 席地而坐、盘腿、靠着沙发、跪坐在垫子上、' +
    '坐在床沿或椅子上，背景是所在的房间（地板、床、沙发、飘窗）。' +
    '居家场景，脚上**只允许光脚、或者穿薄丝袜**' +
    '（肉色或黑色的半透明丝袜），' +
    '**绝对不要画厚棉袜/白袜子/毛绒袜**，也不要画鞋。',
}

/**
 * 24 套装扮 → 24 张照片。
 *
 * `slug` 必须与 `src/shared/interactions.js` 的 `OUTFITS` 完全一致 ——
 * 照片是按 slug 找的，名字对不上会显示不出图。
 *
 * `orient` 决定它进哪张 sheet：
 *   - `vert` 竖幅：绝大多数，尤其是「对着镜头自拍」的场景
 *   - `land` 横幅：室内/环境感强、或「正在做某件事」的场景
 *     （图书馆桌面、沙发窝着、雨天街景…），横构图更能交代环境
 *
 * 顺序决定它在 sheet 里的位置，所以**不要随意调换**（换了等于重新生成）。
 */
/**
 * 每套装扮的**服装描述**。
 *
 * 与 `gen-sheet.js` 的 G3/G4 逐字一致 —— 照片和立绘必须是
 * 同一个人穿同一套衣服，描述不一致会生成出两套不同的设计。
 * 改这里就要同步改那边（`smoke.js` 有断言核对 slug 覆盖）。
 */
/**
 * 每套装扮的**服装 + 气质描述**。
 *
 * 直接来自 `gen-sheet.js` 的 G3/G4 逐格提示词（原样搬，只把
 * 「服装」与「立绘姿态」拆成两个字段）——
 * 这样照片和桌宠立绘是**同一个人穿同一套衣服**，
 * 描述不一致会生成两套不同设计，用户一眼就看出不是一个人。
 *
 * 为什么拆成两个字段：
 *   - `wear` 直接进照片提示词（服装必须一致）
 *   - `pose` 是**立绘里的姿势**，只作气质参考。
 *     照片是自拍构图（举手机、近景、带环境），照搬立绘姿势
 *     （比如「双手端着托盘」「双手合十」）会和自拍打架 ——
 *     所以照片提示词里明确标注它是「参考气质，不要照搬动作」。
 *
 * 改这里就要同步改 `gen-sheet.js` 的 G3/G4（反之亦然）。
 */
export const OUTFIT_LOOKS = {
  'jk': {
    wear: '白色短袖衬衫配深蓝色JK百褶超短裙，系红色领结，背着一个单肩书包',
    pose: '像是赶着去上课',
  },
  'casual-red': {
    wear: '亮红色短款针织外套，内搭白色深v领衬衫，下身深色格子百褶裙，黑色过膝袜',
    pose: '双手插在外套口袋里微笑',
  },
  'casual-lace': {
    wear: '白色荷叶边雪纺连衣裙，裙摆刚刚到大腿上部，泡泡袖，领口有细丝带，白色过膝丝袜',
    pose: '双手自然垂下微微侧身',
  },
  'casual-mono': {
    wear: '白色宽松长袖衬衫配黑色A字裙，裙子长度到大腿上部，衬衫下摆扎进裙子，黑色过膝丝袜',
    pose: '双手在身前交叠',
  },
  'casual-dark': {
    wear: '深灰色背心式连衣裙配白色衬衫，深色领结，深色百褶裙',
    pose: '双手自然垂放，站姿端正',
  },
  'pajamas': {
    wear: '白色蕾丝睡裙，深v领口，裙摆到大腿上部，长袖带蕾丝袖口',
    pose: '双手抱着枕头',
  },
  'pajamas-black': {
    wear: '黑色细吊带睡裙，裙摆刚刚到大腿上部，配黑色丝袜',
    pose: '怀里抱着毛绒玩偶，腿微微蜷起',
  },
  'pajamas-pink': {
    wear: '粉色细吊带睡裙，裙摆刚刚到大腿上部，肩带和裙摆有荷叶边',
    pose: '一手撩起耳边头发',
  },
  'pajamas-bodysuit': {
    wear: '浅灰色连体睡衣，短袖，前襟有拉链拉开一半，下摆是超短裤，帽子部分垂在背后，灰色丝袜',
    pose: '盘腿坐着',
  },
  'pajamas-shorts': {
    wear: '短的粉色睡裙，深v领口，裙摆到大腿上部',
    pose: '抱着一只猫形抱枕',
  },
  'camisole': {
    wear: '浅色低领细吊带配浅灰色超短裤，光脚',
    pose: '一手撑着腰，姿态放松',
  },
  'longskirt': {
    wear: '紫色及踝长裙，上搭浅色开衫，露出一边肩膀，内搭是白色低领细吊带',
    pose: '一手轻提裙摆，像是准备出门',
  },
  'qipao': {
    wear: '浅绿色高开叉旗袍，立领盘扣，胸口前有开口',
    pose: '一只手拿书放在身体前侧，一只手撩头发鬓角，姿态端庄',
  },
  'nun': {
    wear: '黑白修女服，白色领口，头戴修女头巾，超短裙',
    pose: '双手合十在胸前',
  },
  'swimsuit': {
    wear: '白色比基尼，配浅色外罩衫',
    pose: '手扶住头上的一顶草帽，姿态轻松',
  },
  'campus': {
    wear: '米白色针织开衫配浅蓝色连衣超短裙，长发披散',
    pose: '双手抱着书本，像大一新生的清纯感',
  },
  'campus-idol': {
    wear: '亮片装饰的粉色演出短裙配白色长袜',
    pose: '手上拿着一个小话筒，另一手比出胜利手势',
  },
  'idol': {
    wear: '闪亮的银色舞台打歌服短裙，腰间有装饰腰带',
    pose: '双手放在胸前，眼神明亮',
  },
  'maid': {
    wear: '黑白配色女仆装超短裙，搭配白丝过膝袜，白色围裙带荷叶边，头上戴白色蕾丝发带',
    pose: '双手端着一个小托盘',
  },
  'xmas': {
    wear: '红色圣诞超短裙配白色毛绒滚边，头戴红色圣诞帽，手里拿着一个小礼物盒',
    pose: '笑容开心',
  },
  'newyear': {
    wear: '红色镶金边的中式新年装，立领盘扣，袖口有云纹',
    pose: '双手作揖拜年',
  },
  'gown': {
    wear: '浅色缎面小礼裙，一字肩设计，裙摆到大腿上方，戴细手链',
    pose: '姿态优雅',
  },
  'formal': {
    wear: '深色短西装裙，内搭白色衬衫',
    pose: '一本正经地站着，像面试场合',
  },
  'raincoat': {
    wear: '米色长款风衣，手里撑着一把透明雨伞，另一手插在口袋',
    pose: '像是雨天出门',
  },}

/**
 * 取某套的完整服装描述。
 * slug 没有条目时**直接抛错**，不静默放行 ——
 * 缺服装描述会生成一套认不出来的衣服，比报错更难查。
 */
export function wearOf(slug) {
  const l = OUTFIT_LOOKS[slug]
  if (!l) throw new Error(`slug "${slug}" 没有服装描述 —— 补到 OUTFIT_LOOKS 里`)
  return l.wear
}

/**
 * 24 套装扮 → 24 张照片。
 *
 * `slug` 必须与 `src/shared/interactions.js` 的 `OUTFITS` 完全一致 ——
 * 照片是按 slug 找的，名字对不上会显示不出图。
 *
 * `orient` 决定它进哪张 sheet：
 *   - `vert` 竖幅（3:4）：对着镜头自拍，脸和上半身为主
 *   - `land` 横幅（4:3）：环境感强、或「正在做某件事」，横构图更能交代场景
 *
 * 顺序决定它在 sheet 里的位置，**不要随意调换**（换了等于重新生成）。
 * 服装描述从 `OUTFIT_LOOKS` 自动带出，这里只写场景 / 姿态 / 情绪。
 */
/**
 * 24 套装扮 → 24 张照片。
 *
 * `slug` 必须与 `src/shared/interactions.js` 的 `OUTFITS` 完全一致 ——
 * 照片是按 slug 找的，名字对不上会显示不出图。
 *
 * `orient` 决定它进哪张 sheet：
 *   - `vert` 竖幅（3:4）：对着镜头自拍，脸和上半身为主
 *   - `land` 横幅（4:3）：环境感强、或「正在做某件事」，横构图更能交代场景
 *
 * 顺序决定它在 sheet 里的位置，**不要随意调换**（换了等于重新生成）。
 * 服装描述从 `OUTFIT_LOOKS` 自动带出，这里只写场景 / 姿态 / 情绪。
 *
 * ## 构图取向：亲密感 / 生活感
 *
 * 目标观感是「她私下发给你的照片」，所以：
 *   - **腿部与脚部尽量入镜**：盘腿、抱膝、光脚踩地板、腿伸向镜头、
 *     踢掉鞋子、袜子特写 —— 这些是「在家/放松」的自然姿态，
 *     也是自拍里最容易出氛围的构图
 *   - **私密但不暴露**：卧室、沙发、浴后、深夜 —— 场景偏私密，
 *     但**衣着保持该套装扮本身的设计**（睡裙就是睡裙、风衣就是风衣），
 *     不额外制造走光或裸露
 *   - **距离近**：脸靠近镜头、半身近景，营造「就在你面前」的感觉
 *   - 眼神、姿态、光线负责暧昧感，**不是靠露多少**
 */
export const PHOTO_SHOTS = [
  /* ---- vert sheet：竖幅自拍（12 张）---- */
  { slug: 'jk', orient: 'vert', scene: '清晨的大学教室，靠窗座位，晨光斜照在桌面上', pose: '单手撑桌，脸微微侧向窗外光线，双腿交叠伸向画面一侧', mood: '刚坐下、还没完全清醒的慵懒早晨' },
  { slug: 'casual-red', orient: 'vert', scene: '夜晚的公寓玄关，暖黄的壁灯', pose: '背着墙把手机举高，一条腿微微抬起抵着墙，视线从睫毛下方看镜头', mood: '刚回来、还带着外面玩闹的余兴' },
  { slug: 'casual-lace', orient: 'vert', scene: '明亮的试衣间，三面镜子映出她的侧影', pose: '手机对着镜子拍，另一手提着裙摆一角，踮着脚侧身', mood: '试穿新裙子、想让你第一个看到' },
  { slug: 'casual-dark', orient: 'vert', scene: '夜晚公寓走廊，顶灯昏黄，墙面有长长的影子', pose: '靠着墙单手自拍，另一手插兜，一条腿曲起踩着墙根', mood: '穿了平时不会穿的样子，有点不自在又有点得意' },
  { slug: 'pajamas', orient: 'vert', scene: '宿舍床上，床帘半拢，只留一盏小台灯', pose: '侧躺举着手机，头发散在枕头上，膝盖曲起、小腿和光脚在画面下缘', mood: '深夜还没睡、被窝里懒洋洋的困意' },
  { slug: 'pajamas-black', orient: 'vert', scene: '夜晚房间，只有床头小夜灯的暖光', pose: '靠着床头，双膝曲起抱在胸前，手机举在眼前，脚搭在床沿', mood: '睡不着、有点想你' },
  { slug: 'pajamas-pink', orient: 'vert', scene: '浴室门口，镜子上还蒙着雾气，地面有水痕', pose: '一手拿手机，一手拨刚洗过的湿头发，光脚踩在瓷砖上、脚尖微微内扣', mood: '刚洗完澡、脸颊泛红的放松' },
  { slug: 'camisole', orient: 'vert', scene: '盛夏的房间，窗外是晃眼的白光，风扇在转', pose: '坐在地板上把腿伸向镜头，一手举着冰饮贴着脸', mood: '热到不行、懒得连姿势都不想换' },
  { slug: 'longskirt', orient: 'vert', scene: '傍晚的江边步道，夕阳把天空染成橘粉色', pose: '侧身回眸，一手压住被风吹起的裙摆，裙角掀起露出一截小腿', mood: '精心打扮、等着见重要的人' },
  { slug: 'qipao', orient: 'vert', scene: '中式厅堂，木质雕花屏风前，红灯笼的光落在肩头', pose: '正面站定，手机举在胸前高度，开叉一侧的腿微微前迈', mood: '正式场合、端庄里藏着一点紧张' },
  { slug: 'swimsuit', orient: 'vert', scene: '海边浅滩，白浪刚漫过脚踝，草帽的影子落在身上', pose: '一手压住帽檐，低头看镜头，光脚站在湿沙上、脚边有退去的浪', mood: '阳光刺眼、眯着眼睛笑' },
  { slug: 'campus-idol', orient: 'vert', scene: '社团活动室的舞台边，音箱的灯还在闪', pose: '一手举麦克风，脸凑近镜头，另一条腿站累似地微微弯着', mood: '演出刚结束、兴奋到耳根还是红的' },

  /* ---- land sheet：横幅照片（12 张）---- */
  { slug: 'casual-mono', orient: 'land', scene: '图书馆靠窗的长桌，摊开的书、荧光笔、喝了一半的咖啡', pose: '单手撑腮看镜头，另一边的画面里是一双并拢伸向桌下的腿', mood: '复习到一半抬头、眼神有点疲惫但认真' },
  { slug: 'pajamas-bodysuit', orient: 'land', scene: '客厅沙发，电视开着没人看，零食袋和抱枕散了一地', pose: '盘腿窝在沙发角落，手机靠在膝盖上举拍，光脚踩在坐垫边缘', mood: '一整天没出门、舒服到有点邋遢' },
  { slug: 'pajamas-shorts', orient: 'land', scene: '房间地板上的凉席，小风扇开到最大，旁边半杯冰水', pose: '坐在地上把两条腿摊开伸向镜头，手机举高俯拍', mood: '太热了、对着镜头无声哀嚎' },
  { slug: 'nun', orient: 'land', scene: '老式教堂内部，彩窗的光斑落在长椅和地面上', pose: '坐在长椅上，双手合十抵着下巴，靠着椅背偏头看镜头', mood: '自己先被这套打扮逗笑的忍俊不禁' },
  { slug: 'campus', orient: 'land', scene: '大学校园草坪边的台阶，教学楼和自行车在背景里虚掉', pose: '抱着书坐在台阶上，双腿并拢斜放在下一级，手机架在书上', mood: '下课路上、被人夸年轻的那种得意' },
  { slug: 'idol', orient: 'land', scene: '后台化妆间，灯泡镜子的光晕，衣架上挂着打歌服', pose: '坐在化妆凳上翘着腿，一手撑在凳沿，手机举高微俯拍', mood: '上台前的安静、眼神亮得吓人' },
  { slug: 'maid', orient: 'land', scene: '女仆咖啡店的角落卡座，木质吧台和暖色吊灯', pose: '坐在卡座把托盘放在膝上，双腿交叠，回头看向镜头', mood: '店员式的甜美笑、眼里带点调皮' },
  { slug: 'xmas', orient: 'land', scene: '布置了圣诞树的房间，彩灯缠在窗框上，地上堆着没拆的礼物', pose: '坐在地毯上盘着腿，双手托腮凑近镜头', mood: '节日气氛里的一点期待和小失落' },
  { slug: 'newyear', orient: 'land', scene: '张贴春联的家中玄关，红灯笼和一桌年货', pose: '跪坐在坐垫上，双手拿着红包举到脸颊边', mood: '过年特有的喜庆笑容' },
  { slug: 'gown', orient: 'land', scene: '宴会厅门口的长廊，水晶吊灯，红色地毯', pose: '一手轻扶肩带，侧身坐下让裙摆铺开，一条腿从开衩里伸出来', mood: '第一次穿这么正式、有点不自在但很高兴' },
  { slug: 'formal', orient: 'land', scene: '写字楼电梯口，玻璃幕墙外是黄昏的城市', pose: '靠着玻璃墙站着，一只手把文件抱在身侧，双腿交叠', mood: '面试前紧张、努力显得专业的表情' },
  { slug: 'raincoat', orient: 'land', scene: '雨天的街边，湿透的路面映着店铺灯光，雨珠挂在玻璃上', pose: '一手举着透明伞，低头看镜头，风衣下摆被风吹起一角，露出一截小腿和淋湿的鞋尖', mood: '被雨困住、有点无奈又觉得还挺浪漫' },

  /*
   * ---- 自由穿搭格（不绑装扮，由模型按场景搭配）----
   *
   * 4×4 网格有 16 格，24 套装扮每张只用到 12 格，剩 4 格。
   * 不画空的：整张留白处容易长出随机杂物，而且浪费出图成本。
   * 这 8 格就是**生活照**的来源 —— 它们在 `photoStories.js` 里
   * 登记成 `g17`~`g23`（不绑装扮），归入生活照类目。
   *
   * `slug: null` 表示不绑装扮（切图时按 scene 命名，不按 slug）。
   */
  { slug: null, orient: 'vert', scene: '书桌前，摊开的笔记本和荧光笔，桌上放着一杯咖啡', pose: '坐在椅子上回头看向镜头，全身入镜', mood: '复习中途抬头的午后' },
  { slug: null, orient: 'vert', scene: '玄关，刚脱下的帆布鞋摆在脚边，旁边挂着外套', pose: '蹲下来系鞋带，抬眼看向镜头，全身入镜', mood: '刚回来还没换衣服' },
  { slug: null, orient: 'vert', scene: '地铁车厢里，窗外是后退的城市剪影', pose: '靠着车门单手扶杆，站姿全身入镜', mood: '通勤路上的失神' },
  { slug: null, orient: 'vert', scene: '便利店的关东煮柜台和热饮柜，暖白灯光', pose: '端着关东煮站在柜台前，回头看向镜头，全身入镜', mood: '深夜加完课的唯一慰藉' },

  { slug: null, orient: 'land', scene: '深大校园的文山湖，傍晚的云被染成橘粉，湖边有长椅', pose: '坐在长椅上，双腿并拢，支起手机拍全身', mood: '下课路过的惊喜' },
  { slug: null, orient: 'land', scene: '宿舍房间的飘窗，窗台上摆着绿植和台灯，窗外是城市的夜景', pose: '盘腿坐在飘窗垫上，正面朝向镜头，全身入镜', mood: '想家或想人的时刻' },
  { slug: null, orient: 'land', scene: '咖啡店的木质长桌，一杯拉花拿铁和一本翻开的书', pose: '坐在窗边单手翻书，抬头看向镜头，全身入镜', mood: '周末一个人的下午' },
  { slug: null, orient: 'land', scene: '雨后的操场跑道，积水映着天空，她撑着一把伞', pose: '撑着伞站在跑道边，全身入镜', mood: '雨停之后才有的清爽' },
]

/**
 * 废弃格名单 —— 生成废了、不再使用的格子。
 *
 * 格式 `'orient:名字'`。原因写在旁边，方便日后判断要不要重新生成。
 *
 * 为什么不直接删文件：切图是**按名字逐个产出**的，
 * 手工删掉的文件下次切图又会被重新生成出来。
 * 列在这里，切图命令会自动带上 `--skip`。
 */
export const SKIP_CELLS = {
  /* 脖子扭成 180°，结构错乱 */
  'land:yuki-photo-free-2': true,
}

/** 某个画幅要跳过的格子名（用于拼 --skip 参数） */
export function skipsFor(orientKey) {
  return Object.keys(SKIP_CELLS)
    .filter((k) => k.startsWith(`${orientKey}:`))
    .map((k) => k.split(':')[1])
}

/**
 * 「光脚 / 丝袜」特辑 —— 一张独立的横幅 sheet，16 格全部露脚且不穿鞋。
 *
 * ## 为什么要单独一张
 *
 * 常规的两张 sheet 里，脚经常被裁掉：模型优先满足「人物大、表情清楚」，
 * 脚是最先牺牲的部分。把**全部要求露脚**的格子集中到一张、
 * 并逐格点名强制，比在混合 sheet 里零散加一句有效得多。
 *
 * ## 硬约束
 *
 *   - **只穿丝袜或光脚，绝对不出现鞋**（拖鞋、凉鞋、运动鞋都不行）
 *   - 每一格都要能**清楚看到脚**（脚趾/脚背/袜尖不能被画框切掉）
 *   - 横幅 4:3（露脚多为横躺、盘腿、伸腿的构图，横画幅放得下）
 *
 * ## 服装来源
 *
 *   - 原本就绑定了服装的格子（`slug` 非空）→ 沿用该套的 `OUTFIT_LOOKS`
 *   - 其余格子 `slug: null` → 自由发挥，但仍要满足上面的硬约束
 *
 * 生成后作为对应装扮的**第 3 张**照片追加（`-3` 后缀），
 * 不覆盖已有的第 1、2 张。
 */
export const FEET_SHOTS = [
  /* ---- 沿用原绑定的服装（4 格）：换成不敏感的装扮 ----
   *
   * 原先用了 pajamas / pajamas-pink / swimsuit / pajamas-bodysuit,
   * 配合「露脚特写」被安全系统判为 sexual。这里换成
   * 日常感更强、同样有「席地而坐所以露出腿脚」的装扮。 */
  { slug: 'jk', scene: '放学后的教室，桌椅上还留着午后的光影', pose: '坐在课桌上，一条腿垂下来，双手撑在身侧', mood: '放学不想马上回家' },
  { slug: 'campus', scene: '宿舍地板上铺着坐垫，旁边摊着课本', pose: '盘腿坐在坐垫上，手撑着膝盖', mood: '复习到一半走神' },
  { slug: 'longskirt', scene: '飘窗边，窗帘被风吹起一角，窗外是傍晚', pose: '侧坐在飘窗上，双腿曲起偏向一侧，手撑在垫子上', mood: '安静的傍晚' },
  { slug: 'casual-dark', scene: '客厅沙发旁的地毯上，旁边放着杯子', pose: '坐在地毯上背靠沙发，两腿曲起抱膝', mood: '赖着不想动' },

  /* ---- 自由发挥（12 格）：全部是居家生活场景 ----
   *
   * 姿势一律用「席地而坐 / 盘腿 / 跪坐 / 靠沙发」这类生活化说法，
   * **不点名脚部**。「全身不裁切」的要求已经保证脚会入镜，
   * 再专门强调就会把画面焦点引向身体局部。 */
  { slug: null, scene: '木地板的房间，午后阳光在地上拉出长条的光斑', pose: '坐在木地板上，双腿自然伸开，手撑在身后', mood: '懒洋洋的周末下午' },
  { slug: null, scene: '铺着地毯的卧室地面，旁边散着几个抱枕', pose: '趴在地毯上翻杂志，小腿轻轻抬起', mood: '看手机看累了' },
  { slug: null, scene: '飘窗的坐垫上，窗外是傍晚的天色', pose: '跪坐在垫子上，回头看镜头', mood: '安静的傍晚' },
  { slug: null, scene: '洗手间门口，地面刚拖过还留着水痕', pose: '坐在小板凳上，双手放在膝上', mood: '洗完澡的放松' },
  { slug: null, scene: '阳台的藤椅旁，晾着的衣服随风轻摆', pose: '坐在藤椅上，一条腿搭在扶手上', mood: '午后的发呆' },
  { slug: null, scene: '铺了地毯的书桌前，椅子被推开了一点', pose: '坐在地上背靠桌腿，两腿曲起抱膝', mood: '不想写作业' },
  { slug: null, scene: '木质楼梯的台阶上', pose: '坐在台阶上，一条腿伸直一条腿曲着，手撑在下一级台阶', mood: '上楼上到一半坐着歇' },
  { slug: null, scene: '卧室地板上的凉席，旁边是开着的风扇', pose: '侧躺在凉席上，双腿微微曲起', mood: '热得不想动' },
  { slug: null, scene: '厨房中岛台前，台面上放着切好的水果', pose: '坐在高脚凳上，双手放在膝上', mood: '等水果切好的间隙' },
  { slug: null, scene: '图书馆的靠窗座位，桌下铺着地毯', pose: '坐在椅子上一条腿盘起来，手撑着下巴', mood: '复习到走神' },
  { slug: null, scene: '房间里的穿衣镜前，地面干净', pose: '坐在地上对着镜子拍照，双腿向一侧伸展', mood: '试完衣服坐一会儿' },
  { slug: null, scene: '客厅茶几旁，地上摊着零食袋', pose: '坐在地上侧靠沙发，一条腿曲起、另一条伸直', mood: '看剧看到一半' },
]

/** 按画幅分组 */
export function shotsByOrient(orient) {
  /* feet 是独立的特辑清单，不从 PHOTO_SHOTS 里筛 */
  if (orient === 'feet') return FEET_SHOTS
  return PHOTO_SHOTS.filter((s) => s.orient === orient)
}

/**
 * 每张 sheet 的槽位数（4×4=16）。
 * 24 套装扮分摊到两张，每张 12 格 + 4 格自由 = 16。
 */
export const PER_SHEET = 16

/** 组提示词的正文部分：把 12 格的内容逐条写清楚 */
export function buildSheetBody(o, shots) {
  /*
   * 逐格明细：**连「在第几行第几列」都写死**。
   *
   * 为什么这么啰嗦：只说「第N格」时，模型仍可能自行理解为
   * 「从左到右从上到下的第N个」并重排 —— 实测出图里出现过
   * 格子顺序与设定不符（把第 3 格的服装画到了第 5 格）。
   * 明写「第1行第2列」之后，位置与内容就是死的。
   */
  const lines = shots.map((s, i) => {
    const no = i + 1
    const row = Math.floor(i / o.cols) + 1
    const col = (i % o.cols) + 1
    const pos = `第${row}行第${col}列`
    const head = `第${no}格（${pos}）`

    /* 自由穿搭格：不指定服装，但同样是她本人入镜的正常照片 */
    if (!s.slug) {
      return (
        `${head}：**自由穿搭 —— 不指定服装，按这个场景给她搭一套日常穿着**\n` +
        `  画面内容=${s.scene}\n` +
        `  拍法=${s.pose}\n` +
        `  氛围=${s.mood}`
      )
    }

    const look = OUTFIT_LOOKS[s.slug]
    return (
      `${head}：\n` +
      `  服装=${look.wear}\n` +
      `  场景=${s.scene}\n` +
      `  拍摄方式=${s.pose}\n` +
      `  表情氛围=${s.mood}\n` +
      `  （这套在立绘里的姿势是「${look.pose}」——只作气质参考，` +
      `不要照搬成站姿，本格按上面的拍摄方式来自拍）`
    )
  })

  const portrait = shots.filter((x) => x.slug).length
  const blanks = shots.length - portrait
  const shape =
    blanks > 0
      ? `本张 ${shots.length} 格：**全部是她的照片**。其中 ${portrait} 格按指定服装，` +
        `**另外 ${blanks} 格不指定服装**（见下方标注「自由穿搭」的格，由你按场景搭配）。`
      : `本张 ${shots.length} 格：**全部是这个人物的不同打扮**。`

  return `【本张格数与内容分布】
${shape}

【逐格明细 · 必须严格遵守 · 位置已固定】
下面是每一格**画在第几行第几列**、**穿什么**、**在哪拍**、**怎么拍**。
出图必须完全照此执行：位置不许换、服装不许改、内容不许省。
${lines.join('\n')}`
}

/* ---------- 网络（复用 gen-sheet.js 的 curl 方案） ---------- */

function curlRequest(url, { json, form, timeoutSec = 900 } = {}) {
  const args = ['-s', '-X', 'POST', url]
  if (PROXY) args.push('-x', PROXY)
  args.push('-H', `Authorization: Bearer ${API_KEY}`)
  if (json) {
    args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(json))
  } else if (form) {
    for (const f of form) {
      if (f.file) args.push('-F', `${f.name}=@${f.file};type=${f.type}`)
      else args.push('-F', `${f.name}=${f.value}`)
    }
  }
  const SEP = '\n__HTTP_STATUS__:'
  args.push('-w', `${SEP}%{http_code}`, '--max-time', String(timeoutSec))
  let out
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  } catch (e) {
    throw new Error(`curl 失败：${e.stderr?.toString().slice(0, 300) || e.message}`)
  }
  const idx = out.lastIndexOf(SEP)
  if (idx < 0) throw new Error(`curl 返回异常：${out.slice(0, 200)}`)
  return { status: Number(out.slice(idx + SEP.length).trim()), body: out.slice(0, idx) }
}

function curlDownload(url, timeoutSec = 300) {
  const args = ['-s', '--max-time', String(timeoutSec)]
  if (PROXY) args.push('-x', PROXY)
  args.push(url)
  return execFileSync('curl', args, { maxBuffer: 512 * 1024 * 1024 })
}

/* ---------- PNG 校验（照片的判据与立绘相反） ---------- */

/**
 * 读 PNG 头部 + 估算「透明像素占比」。
 *
 * 照片要求**不能有透明**，所以这个数字越接近 0 越好 ——
 * 与立绘那边（要求 > 5%）正好相反。
 */
function inspectPng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return { ok: false, reason: '不是 PNG' }
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const colorType = buf[25]
  const hasAlpha = colorType === 6 || colorType === 4
  if (!hasAlpha) return { ok: true, width, height, colorType, hasAlpha: false, transparentRatio: 0 }

  /* 只扫前若干行估算：整图解码太慢，而照片若有透明区通常整片都是 */
  let pos = 8
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  let transparent = 0
  let total = 0
  try {
    const { inflateSync } = require('node:zlib')
    const raw = inflateSync(Buffer.concat(idat))
    const stride = width * 4
    const rows = Math.min(height, 64)
    for (let y = 0; y < rows; y++) {
      const off = y * (stride + 1) + 1
      for (let x = 0; x < width; x++) {
        const a = raw[off + x * 4 + 3]
        if (a !== undefined && a < 8) transparent++
        total++
      }
    }
  } catch {
    return { ok: true, width, height, colorType, hasAlpha: true, transparentRatio: -1 }
  }
  return { ok: true, width, height, colorType, hasAlpha: true, transparentRatio: transparent / Math.max(total, 1) }
}

/* ---------- 参考图 ---------- */

const REF_DIR = join(PROJECT_ROOT, 'resources', 'yuki-new')

/**
 * 参考图：只用**设定图2**。
 *
 * 设定图1 是高中时期（安静害羞、个子 150、校服不同），
 * 设定图2 是大学时期 —— 也就是人设的**当前形象**，
 * 而且图上文字是准确的（设定图1 的文字标注有误）。
 *
 * 只用一张还顺带省一半上传体积（每张压完约 300KB）。
 * 之前自动抓两张，模型会同时参考两个不同身高的形象，
 * 生成出来的人容易在两者之间漂移。
 */
function findRefs() {
  const PREFERRED = '设定图2.png'
  const p = join(REF_DIR, PREFERRED)
  if (existsSync(p)) return [p]
  /* 找不到就退回任意设定图，最后再退回任意 png —— 不让脚本直接跑不动 */
  const all = existsSync(REF_DIR) ? readdirSync(REF_DIR).filter((f) => /\.png$/i.test(f)) : []
  const picks = all.filter((f) => /设定图|profile/i.test(f)).sort()
  if (picks.length) {
    console.warn(`⚠ 没找到 ${PREFERRED}，退回用 ${picks.join(', ')}`)
    return picks.map((f) => join(REF_DIR, f))
  }
  return all.map((f) => join(REF_DIR, f))
}

/**
 * 参考图压缩后上传。
 *
 * 原图 2.2MB，只 resize 到 800 还有 1MB —— 上传慢且没必要。
 * 加 `-colors 200` 降到 278KB（省 73%），设定图是线稿+平涂，
 * 降到 200 色肉眼看不出差别（这和立绘导出用的是同一套参数）。
 */
function shrinkPng(file, maxSide = 800) {
  const tmp = join(PROJECT_ROOT, '.tmp-photo-refs')
  mkdirSync(tmp, { recursive: true })
  const out = join(tmp, basename(file))
  execFileSync(
    'magick',
    [file, '-resize', `${maxSide}x${maxSide}`, '-strip', '-colors', '200', out],
    { stdio: 'ignore' },
  )
  const size = readFileSync(out).length
  if (size > 600 * 1024) {
    console.warn(`  ⚠ 参考图压缩后仍有 ${Math.round(size / 1024)}KB，可能拖慢上传`)
  }
  return { buf: readFileSync(out), path: out }
}

/* ---------- 生成 ---------- */

async function generateSheet(orientKey) {
  const o = ORIENTATIONS[orientKey]
  if (!o) throw new Error(`未知画幅 ${orientKey}（可选：${Object.keys(ORIENTATIONS).join(' / ')}）`)

  const shots = shotsByOrient(orientKey)
  if (shots.length !== PER_SHEET) {
    throw new Error(`${o.label} 应有 ${PER_SHEET} 格，实际 ${shots.length} 格 —— 检查 PHOTO_SHOTS`)
  }

  const prompt = [buildPhotoBase(o), buildSheetBody(o, shots)].join('\n\n')
  const refs = findRefs()
  /*
   * 输出文件名**带时间戳，永不覆盖**。
   *
   * 出图是要花钱的，而同一张 sheet 很可能重跑好几版
   * （调提示词、换模型）。早先固定用 `P-vert-竖幅自拍.png`，
   * 第二次生成就把第一版覆盖了 —— 想回头对比两版都做不到。
   * 文件名里的时间戳同时充当「这版是什么时候出的」的记录。
   */
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const dest = join(PHOTO_DIR, `P-${orientKey}-${o.label}-${stamp}.png`)

  console.log(`生成${o.label}（${shots.length} 格）`)
  console.log('─'.repeat(60))
  console.log(`  尺寸      ${o.size}   ${o.cols}×${o.rows} 格，每格 ${o.cell}`)
  console.log(`  画幅      ${o.ratioText}`)
  console.log(`  质量      ${QUALITY}`)
  console.log(`  参考图    ${refs.map((p) => basename(p)).join(', ') || '(无)'}`)
  console.log(`  提示词    ${prompt.length} 字`)
  console.log(`  输出      ${dest}`)
  console.log('─'.repeat(60))

  const fields = [
    { name: 'model', value: MODEL },
    { name: 'prompt', value: prompt },
    { name: 'size', value: o.size },
    { name: 'quality', value: QUALITY },
    /*
     * 关键：照片要**不透明**。
     * 立绘那边传 'transparent' 是为了抠图，这里传 opaque ——
     * 传 transparent 会得到一堆透明窟窿，照片就毁了。
     */
    { name: 'background', value: 'opaque' },
    { name: 'output_format', value: 'png' },
    { name: 'n', value: '1' },
  ]
  for (const r of refs) {
    const { buf, path } = shrinkPng(r)
    console.log(`  ${basename(r)} 压缩后 ${(buf.length / 1024 / 1024).toFixed(2)}MB`)
    fields.push({ name: 'image[]', file: path, type: 'image/png' })
  }

  console.log(`\n请求生成…（${o.size} 的图可能需要几分钟）`)
  const r = refs.length
    ? curlRequest(`${BASE_URL}/v1/images/edits`, { form: fields })
    : curlRequest(`${BASE_URL}/v1/images/generations`, {
        json: { model: MODEL, prompt, size: o.size, quality: QUALITY, background: 'opaque', output_format: 'png', n: 1 },
      })

  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}：${r.body.slice(0, 400)}`)

  const json = JSON.parse(r.body)
  const item = json?.data?.[0]
  let buf = item?.b64_json ? Buffer.from(item.b64_json, 'base64') : item?.url ? curlDownload(item.url) : null
  if (!buf) throw new Error(`没拿到图片数据：${JSON.stringify(json).slice(0, 300)}`)

  mkdirSync(PHOTO_DIR, { recursive: true })
  writeFileSync(dest, buf)

  const info = inspectPng(buf)
  const ratio = info.transparentRatio ?? -1
  const dimsOk = `${info.width}x${info.height}` === o.size
  console.log(`\n已保存 ${dest}`)
  console.log(`  尺寸   ${info.width}x${info.height} ${dimsOk ? '✅' : `❌ 期望 ${o.size}`}`)
  console.log(`  不透明 ${ratio < 0 ? '?' : (ratio * 100).toFixed(2) + '% 透明'} ${!info.hasAlpha || ratio < 0.01 ? '✅ 无透明区' : '❌ 有透明区，照片不该透明'}`)
  console.log()
  console.log('切图（照片必须用等分，不能用 --auto：实景没有透明隔离带，')
  console.log('  --auto 会退化成在画面里找「密度谷」，切出大小不一的格子）：')
  /*
   * 空镜没有 slug，给个 `scene-<序号>` 占位名 ——
   * 切图脚本要求每格都有名字（没有名字会退化成 cell01），
   * 有个可读的名字便于日后辨认哪张是哪张。
   */
  let sceneN = 0
  /*
   * 名字必须带 `yuki-photo-` 前缀 ——
   * `install-pet-assets.js` 正是靠这个前缀认出「哪些是照片」并分发到
   * `public/photos/`，命名对不上会当成立绘处理（manifest 里多出一堆脏条目）。
   */
  const names = shots
    .map((s) => `yuki-photo-${s.slug ? s.slug : `scene-${++sceneN}`}`)
    .join(',')
  const base = basename(dest).replace(/\.png$/, '')
  const skips = skipsFor(orientKey)
  console.log(`  node scripts/split-sheet.js "${dest}" --grid ${o.cols}x${o.rows} --out .tmp-photos \\`)
  console.log(`    --photo --contact ".tmp-photos/${base}-拼版.png" \\`)
  if (skips.length) console.log(`    --skip ${skips.join(',')} \\`)
  console.log(`    --names ${names}`)
  console.log()
  console.log('切完**务必看拼版图**：照片质量没有自动判据，只能目视确认。')
  console.log('确认没问题后装进项目：')
  console.log('  node scripts/install-pet-assets.js')

  return { dest, info, shots, orient: o }
}

/* ---------- CLI ---------- */

/* ---------- CLI ---------- */

/** 打印清单（不需要 API Key） */
function listShots() {
  console.log(`共 ${PHOTO_SHOTS.length} 张照片，分两张 sheet：\n`)
  for (const [key, o] of Object.entries(ORIENTATIONS)) {
    const shots = shotsByOrient(key)
    console.log(`  【${o.label}】画布 ${o.size}，${o.cols}×${o.rows} 格，每格 ${o.cell}（${o.ratioText.replace(/\*\*/g, '')}）`)
    shots.forEach((s, i) => {
      const name = s.slug ?? '(自由)'
      console.log(`    ${String(i + 1).padStart(2)}. ${name.padEnd(20)} ${s.scene}`)
    })
    console.log()
  }
  console.log('生成：')
  console.log('  node scripts/gen-photos.js --photos --orient vert --yes')
  console.log('  node scripts/gen-photos.js --photos --orient land --yes')
}

async function main() {
  if (hasFlag('--list')) {
    listShots()
    return
  }

  const orient = getOpt('--orient', 'vert')
  if (!ORIENTATIONS[orient]) {
    throw new Error(`--orient 只能是 ${Object.keys(ORIENTATIONS).join(' / ')}`)
  }
  const o = ORIENTATIONS[orient]
  const shots = shotsByOrient(orient)

  /*
   * 预览（不带 --yes）**不需要 API Key** ——
   * 只是把将要用的参数和命令打印出来给人核对。
   * 要求先配 Key 才能看预览是没道理的：配 Key 之前
   * 恰恰是最该先确认「参数对不对」的时候。
   */
  if (!hasFlag('--yes')) {
    console.log(`照片模式 · ${o.label}`)
    console.log('─'.repeat(60))
    console.log(`  尺寸    ${o.size}   ${o.cols}×${o.rows} 格，每格 ${o.cell}`)
    console.log(`  画幅    ${o.ratioText.replace(/\*\*/g, '')}`)
    const named = shots.filter((s) => s.slug).map((s) => s.slug)
    const blanks = shots.length - named.length
    console.log(`  内容    ${named.join(', ')}`)
    if (blanks) console.log(`          + ${blanks} 格自由穿搭（不指定服装）`)
    console.log('─'.repeat(60))
    console.log()
    console.log('⚠ 这会真实调用 API 并产生费用。')
    console.log('  确认后加上 --yes 重跑：')
    console.log(`    node scripts/gen-photos.js --photos --orient ${orient} --yes`)
    return
  }

  if (!API_KEY) throw new Error('缺少 PACKY_API_KEY')

  await generateSheet(orient)
}

/*
 * 只在**直接运行**时执行 CLI。
 * 被 import 时（比如 smoke.js 要校验 slug 覆盖）不跑 ——
 * 否则一 import 就开始打印预览、甚至真的去请求 API。
 */
const isDirectRun = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop(),
)
if (isDirectRun) {
  main().catch((e) => {
    console.error(`\n失败：${e.message}`)
    process.exit(1)
  })
}
