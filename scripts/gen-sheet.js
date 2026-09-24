/**
 * 调用 packyapi（或任何 OpenAI 兼容中转）生成**真透明**的方格拼图。
 *
 * 为什么需要这个脚本：
 * Cherry Studio 的绘图界面只暴露了「模型」一个下拉框，没有
 * background / output_format / size 的输入框 —— 参数吃不到，
 * 所以拿回来的图是「画出来的假棋盘格」+ 错误尺寸（实测 1024x1536）。
 *
 * 这个脚本直接把完整参数发到中转，并**自动校验返回的图是否真带 alpha**，
 * 不合格就明确报错，而不是让你事后才发现。
 *
 * 用法：
 *   set PACKY_API_KEY=sk-xxx                    # Windows
 *   export PACKY_API_KEY=sk-xxx                 # bash
 *
 *   # 先自检：确认中转支不支持 transparent 与自定义尺寸
 *   node scripts/gen-sheet.js --probe
 *
 *   # 正式生成
 *   node scripts/gen-sheet.js --group G1
 *   node scripts/gen-sheet.js --group G1 --size 2048x3072
 *
 * 代理：本机出网需走系统代理，脚本读 HTTPS_PROXY/HTTP_PROXY。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { join, dirname, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 路径解析：这个脚本原本在项目的 scripts/ 下，输出到 resources/yuki-new/。
 * 现在也能独立运行（工具包根目录），所以自动探测：
 *   有 resources/yuki-new/  → 用项目的路径
 *   没有                    → 用脚本同级的 参考图/ 当输入、生成的图/ 当输出
 */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(SCRIPT_DIR, '..')

const IN_PROJECT = existsSync(join(PROJECT_ROOT, 'resources', 'yuki-new'))
const ROOT = IN_PROJECT ? PROJECT_ROOT : join(SCRIPT_DIR, '..')
const OUT_DIR = IN_PROJECT
  ? join(PROJECT_ROOT, 'resources', 'yuki-new')
  : join(SCRIPT_DIR, '..', '生成的图')
/** 参考图目录：项目里和输出同目录，工具包里单独一个 参考图/ */
const REF_DIR = IN_PROJECT ? OUT_DIR : join(SCRIPT_DIR, '..', '参考图')

/* ---------- 配置 ---------- */

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

/** 中转的 base URL。默认是 packyapi 常见入口，可在命令行覆盖 */
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
const MODEL = getOpt('--model', 'gpt-image-2.5-sunburst')
/*
 * 默认 1024x1536：与现有素材一致，出图更快更便宜。
 *
 * 每格 341x384 —— 这个尺寸在桌宠 2x 缩放下会略糊，
 * 但用户实测可接受（现有素材也只有 300 高）。
 * 想更清晰就传 --size 2048x3072，每格 683x768。
 *
 * 注意：尺寸本身不是「切不开」的原因。同样 1024x1536 的图，
 * 排版按网格走的能切，自由排布的切不开 —— 关键在提示词里的构图约束。
 */
const SIZE = getOpt('--size', '1024x1536')
const QUALITY = getOpt('--quality', 'high')

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ''

/* ---------- 提示词 ---------- */

/**
 * 通用头部：只锁不随服装变化的部分（脸/发/发饰/画风）。
 *
 * 这一段和末尾的「透明隔离句」是按官方 FAQ 的三条规则写的，别删：
 *
 *   1. 不出现任何环境词（ground / sky / room / forest）——
 *      实测描述场景时真透明率 0/3，只描述主体时 16/16。
 *   2. 末尾必须固定加 `isolated ... on a transparent background, no scenery,
 *      no ground, no shadow`。
 *   3. 参考图自带背景时，必须明确写 `remove the background entirely`——
 *      实测这样写 8/8 成功，不写只有 1/2。
 *
 * 另外要注意：**提示词里说"透明背景"没用**。模型会用「画一个灰白棋盘格」
 * 来响应这个要求，那些仍是不透明像素。真透明只能靠请求里的
 * `background: "transparent"` 参数保证 —— 两者必须配合。
 */
/**
 * 通用头部（用户提供的版本，仅做两处必要修正）。
 *
 * 修正记录：
 *   1. 「女大学中生」→「女大学生」（衍字，会让模型理解成中学生）
 *   2. ~~「每格 683×768 像素」~~ → 683×768 是 2048×3072 的格子，
 *      与本段的 1024×1536 矛盾，按 1024×1536 应为 341×384。
 *
 * 末尾追加了透明隔离句（官方 FAQ 实测：参考图自带背景时，
 * 明确写 remove the background 的透明成功率 8/8，不写只有 1/2）。
 */
function buildBase(size) {
  const [w, h] = size.split('x').map(Number)
  const cw = Math.floor(w / 3)
  const ch = Math.floor(h / 4)
  const gap = Math.round(Math.min(cw, ch) * 0.06)
  return `【角色基准 · 必须严格遵守】

人物：活泼开朗的女大学生，约160cm，身形小巧纤细，但是胸部比一般同龄人稍大一点，具体可以看参考图中的尺寸。

【关于参考图 · 重要】
提供的两张图是同一个角色的两张设定图，长相完全一致，都用来参考外表。
- **只看图里的长相，不要读图上的任何文字**（参考图1 上的文字设定有误，请忽略）
- 一切的属性以本提示词的描述为准
- 两张图的区别只是穿了不同的衣服，脸部、发型、发饰完全相同

【面部与发型 —— 任何情况下都不许改变】
- 头发：深棕色长发，发量浓密，发尾微卷，齐刘海
- 发饰：头部右侧一个深色大蝴蝶结 + 小花吊坠（她的标志，必须始终存在）
- 眼睛：红棕色/赤褐色，大而圆润，瞳孔有高光
- 脸型：圆润偏幼，皮肤白净
- 表情基准：活泼开朗

【画风 —— 任何情况下都不许改变】
日系二次元插画，柔和赛璐璐上色，细腻发丝，暖色调，
线条干净，五官比例接近设定图。

【输出要求 · 极其重要】
- 背景：完全透明的 PNG。不要任何背景色、不要阴影、不要地面、不要光斑
- 构图：透明底上的单一角色全身立绘，居中，完整不裁切
- 绝对不要画成「角色设定图 / 三视图 / 表情差分网格」
- 绝对不要任何文字、标签、色卡、边框、装饰图标
- 不要多个角色同框
- 【画布与网格 · 必须严格遵守】
- 画布 ${w}×${h}
- 划分为 3 列 × 4 行 = 12 个等大网格，每格 ${cw}×${ch} 像素
- 每格内画一个独立全身立绘，人物在格内水平居中，脚底对齐格底
- 每格四周留至少 ${gap}px 纯透明隔离带，相邻格的元素绝对不能相碰或跨格
- 阅读顺序：从左到右、从上到下（第1格=左上，第2格=中上，第4格=第二行左）
- 每格姿态、服装、表情都必须不同，不要复制粘贴同一个姿势
- 不需要网格线

【背景处理 · 最关键的一条】
参考图自带完整背景（场景、家具、地面）。你必须：
- 彻底移除背景，只保留角色本身
- 不要保留参考图里的任何场景元素：桌子、椅子、地面、墙面、阴影
- 不要用灰白方格图案来表现"透明"，那是错误做法
- 输出必须是真正的透明通道（alpha=0），不是画上去的棋盘格

isolated subject on a transparent background, no scenery, no ground, no shadow,
remove the background entirely, keep only the character`
}


/**
 * 两套服装，分别对应两张参考图。
 *
 * 为什么分开：设定图1 和设定图2 是**两个不同的角色形象**
 * —— 不只是换衣服，连袜长、鞋型、身高都不同。
 * G1/G2 是「同一个人的状态与动作」，所以要各按自己参考图的着装走，
 * 否则生成出来的形象会和它对应的设定图对不上。
 */
const OUTFIT_A = '深灰黑色背心式连衣裙 + 白色长袖衬衫 + 深色领结 + 深色百褶裙 + 黑色过膝袜 + 黑色制服小皮鞋'
const OUTFIT_B =
  '深蓝色针织开衫外套（左胸有校徽、袖口和下摆有白色条纹）+ 白色衬衫 + 深蓝色领结 + 深蓝紫色格子百褶裙 + 白色短袜 + 白色运动鞋'

/**
 * 每组默认用哪张参考图。
 * G1/G2 是两个不同的着装形象，必须各配各的图，否则生成出来对不上。
 * G3/G4 是「换装」，用哪张都行，统一用第二张（文字设定准确的那张）。
 */
const GROUP_REF = {
  G1: '设定图1.png',
  G2: '设定图2.png',
  G3: '设定图2.png',
  G4: '设定图2.png',
}

const GROUPS = {
  G1: {
    label: '状态与情绪',
    names: 'pose4,pose1,pose3,pose2,shy,angry,surprise,heart,shrug,thumbsup,stretch,clap',
    body: `【每格内容 —— 每格都穿同一套（对应参考图1 的角色着装）：${OUTFIT_A}】

第1格：标准站姿，双手轻搭身前，微微侧头看向前面，表情平静放松
第2格：坐在桌前伏案，双手放在桌面上，身体略前倾，眉头微蹙很专注
第3格：放松地坐着，身体微微后靠，眼睛闭上像在打盹，嘴角放松
第4格：站着开心地笑，肩膀放松，双手在身前轻轻交叠，眼睛弯起来
第5格：害羞，脸颊泛红，一只手抬起放在脸颊边，视线不好意思地偏向左下方
第6格：生气，鼓着腮帮子，双臂抱在胸前，眉毛下压
第7格：惊讶，眼睛睁得很大，身体微微向后仰，一只手抬到胸口
第8格：双手在胸前比出一个爱心，笑容温柔，眼睛弯弯
第9格：无奈地摊开双手耸肩，嘴角微弯叹气，头略微歪向一侧
第10格：竖起大拇指，露出鼓励的笑容，另一只手自然垂下
第11格：双手十指交叉向上伸展伸懒腰，身体微微后仰，闭上眼睛很舒适
第12格：开心地鼓掌，双手在胸前合拍，笑容明亮`,
  },
  G2: {
    label: '日常动作',
    names: 'think,sleep,yawn,snack,coffee,music,read,nod,wave,jump,cry,laugh',
    body: `【每格内容 —— 每格都穿同一套（对应参考图2 的角色着装）：${OUTFIT_B}】

第1格：一根手指抵着下巴在思考，头微微歪向一侧，眼神看向斜上方
第2格：闭着眼睛睡觉，抱着膝盖蜷坐，头靠在膝上，呼吸平缓
第3格：打着哈欠，一只手捂着嘴，眼睛半闭，眼角有困倦感
第4格：在吃零食，一只手拿着小包装袋，另一只手捏着一块点心送到嘴边
第5格：双手捧着一个白色马克杯，杯口有热气，低头轻轻吹气
第6格：戴着耳机听歌，眼睛微微闭上，身体随节奏轻轻晃动
第7格：双手捧着一本打开的书在阅读，低头看着书页
第8格：轻轻点头表示同意，表情温和，眼睛看着前方
第9格：抬起右手挥手打招呼，笑容明亮，身体略微侧转
第10格：跳起来，双手向上举起，双腿离地弯曲，笑容兴奋
第11格：委屈地想哭，眼睛泛着水光，下唇微抿，双手握在胸前
第12格：被逗笑了，一只手捂着嘴笑，眼睛眯成弯月，肩膀微颤`,
  },
  G3: {
    label: '服装①日常与居家',
    names: 'casual-red,casual-lace,casual-mono,casual-dark,longskirt,camisole,pajamas,pajamas-black,pajamas-pink,pajamas-bodysuit,pajamas-shorts,jk',
    body: `【换装规则】保持面部、发型、发饰、画风完全不变，只更换服装。

第1格：穿亮红色短款针织外套，内搭白色深v领衬衫，下身深色格子百褶裙，黑色过膝袜，双手插在外套口袋里微笑
第2格：穿白色荷叶边雪纺连衣裙，裙摆刚刚到大腿上部，泡泡袖，领口有细丝带，双手自然垂下微微侧身，白色过膝丝袜
第3格：穿白色宽松长袖衬衫配黑色A字裙，裙子长度到大腿上部，衬衫下摆扎进裙子，双手在身前交叠，黑色过膝丝袜
第4格：穿深灰色背心式连衣裙配白色衬衫，深色领结，深色百褶裙，双手自然垂放，站姿端正
第5格：穿紫色及踝长裙，上搭浅色开衫，露出一边肩膀，内搭是白色低领细吊带，一手轻提裙摆，像是准备出门
第6格：穿浅色低龄细吊带配浅灰色超短裤，光脚，一手撑着腰，姿态放松
第7格：穿白色蕾丝睡裙，深v领口，裙摆到大腿上部，长袖带蕾丝袖口，双手抱着枕头
第8格：穿黑色细吊带睡裙，裙摆刚刚到大腿上部，配黑色丝袜，怀里抱着毛绒玩偶，腿微微蜷起
第9格：穿粉色细吊带睡裙，裙摆刚刚到大腿上部，肩带和裙摆有荷叶边，一手撩起耳边头发
第10格：穿浅灰色连体睡衣，短袖，前襟有拉链，拉开一半，下摆是超短裤，帽子部分垂在背后，盘腿坐着，灰色丝袜
第11格：穿短的粉色睡裙，深v领口，裙摆到大腿上部，抱着一只猫形抱枕
第12格：穿白色短袖衬衫配深蓝色JK百褶超短裙，系红色领结，背着一个单肩书包，像是赶着去上课`,
  },
  G4: {
    label: '服装②校园与特色',
    names: 'campus,campus-idol,idol,maid,qipao,nun,swimsuit,xmas,newyear,gown,formal,raincoat',
    body: `【换装规则】保持面部、发型、发饰、画风完全不变，只更换服装。

第1格：穿米白色针织开衫配浅蓝色连衣超短裙，长发披散，双手抱着书本，像大一新生的清纯感
第2格：穿亮片装饰的粉色演出短裙配白色长袜，手上拿着一个小话筒，另一手比出胜利手势
第3格：穿闪亮的银色舞台打歌服短裙，腰间有装饰腰带，双手放在胸前，眼神明亮
第4格：穿黑白配色女仆装，超短裙，搭配白丝过膝袜，白色围裙带荷叶边，头上戴白色蕾丝发带，双手端着一个小托盘
第5格：穿浅绿色高开叉旗袍，立领盘扣，胸口前有开口露出乳沟，一只手拿书放在身体前侧，一只手撩头发鬓角，开叉侧腿向前迈出一小步露出大腿，姿态端庄
第6格：穿黑白修女服，白色领口，头戴修女头巾，双手合十在胸前，超短裙
第7格：穿白色比基尼，配浅色外罩衫，手扶住头上的一顶草帽，姿态轻松
第8格：穿红色圣诞超短裙配白色毛绒滚边，头戴红色圣诞帽，手里拿着一个小礼物盒，笑容开心
第9格：穿红色镶金边的中式新年装，立领盘扣，袖口有云纹，双手作揖拜年
第10格：穿浅色缎面小礼裙，一字肩设计，裙摆到大腿上方，戴细手链，姿态优雅
第11格：穿深色短西装裙，内搭白色衬衫，一本正经地站着，像面试场合
第12格：穿米色长款风衣，手里撑着一把透明雨伞，另一手插在口袋，像是雨天出门`,
  },
}

/* ---------- HTTP ---------- */

/**
 * 为什么用 curl 而不是 Node 的 fetch：
 *
 * 这个中转是 New API（响应头带 x-oneapi-request-id）。实测它对
 * multipart 请求要求 `Expect: 100-continue`，而这个头是被禁用的请求头，
 * Node 的 fetch/undici 会直接抛 `NotSupportedError: expect header not supported`。
 *
 * 同样的字段、同样的边界格式：
 *   curl  → HTTP 200（生成成功）
 *   fetch → HTTP 400「未指定模型名称，模型名称不能为空」
 *
 * 所以编辑类请求交给系统自带的 curl.exe（Windows 10+ / macOS / Linux 都有）。
 * 生成类请求是纯 JSON，fetch 可以正常用，但这里统一走 curl 少一种失败模式。
 */

/**
 * 发一次 multipart 或 JSON 请求。
 * @returns {{status:number, body:string}}
 */
function curlRequest(url, { json, form, timeoutSec = 600 } = {}) {
  const args = ['-s', '-X', 'POST', url]
  /* 走代理：本机出网需要，curl 认小写 http_proxy/https_proxy */
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

  /* -w 把状态码写在响应体末尾，用一个不可能出现的分隔符切开 */
  const SEP = '\n__HTTP_STATUS__:'
  args.push('-w', `${SEP}%{http_code}`, '--max-time', String(timeoutSec))

  let out
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  } catch (e) {
    /* curl 非 0 退出（超时、连不上）—— 把 stderr 带出来 */
    throw new Error(`curl 失败：${e.stderr?.toString().slice(0, 300) || e.message}`)
  }

  const idx = out.lastIndexOf(SEP)
  if (idx < 0) throw new Error(`curl 返回异常：${out.slice(0, 200)}`)
  return {
    status: Number(out.slice(idx + SEP.length).trim()),
    body: out.slice(0, idx),
  }
}

/** 下载 URL 到 Buffer（同时用于拉取返回的图片） */
function curlDownload(url, timeoutSec = 300) {
  const args = ['-s', '--max-time', String(timeoutSec)]
  if (PROXY) args.push('-x', PROXY)
  args.push(url)
  return execFileSync('curl', args, { maxBuffer: 512 * 1024 * 1024 })
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/* ---------- PNG 读写（只为缩放参考图，零依赖） ---------- */

function readPngSimple(file) {
  const buf = readFileSync(file)
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels) throw new Error(`参考图只支持 RGB/RGBA PNG，当前 colorType=${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const ft = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[x] = v & 255
    }
  }
  return { width, height, channels, pixels }
}

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePng(w, h, rgba) {
  const stride = w * 4
  const raw = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 参考图（设定图），用来锁角色。
 *
 * 默认传全部存在的设定图。用 `--ref 设定图2.png` 只传指定的一张 ——
 * 实测双图容易触发上游 500（`do request failed`），单图更稳。
 *
 * 上传前必须先缩小：原图 2.07MB 传上去上游会 500（实测）。
 * 缩到长边 800 以内约 1.2MB，既够模型认清角色，又能稳定上传。
 */
function findRefs(pickOverride) {
  const pick = pickOverride ?? getOpt('--ref', '')
  const want = pick ? [pick] : ['设定图1.png', '设定图2.png']
  const refs = []
  for (const f of want) {
    const p = join(REF_DIR, f)
    if (existsSync(p)) refs.push(p)
    else if (pick) throw new Error(`找不到参考图 ${f}（在 ${REF_DIR} 下）`)
  }
  return refs
}

/** 最近邻缩放 PNG（只为压体积，质量损失对「当参考图」无影响） */
function shrinkPng(file, maxSide = 800) {
  const src = readPngSimple(file)
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height))
  if (scale >= 1) return { buf: readFileSync(file), w: src.width, h: src.height }

  const nw = Math.round(src.width * scale)
  const nh = Math.round(src.height * scale)
  const out = Buffer.alloc(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(src.width - 1, Math.round(x / scale))
      const sy = Math.min(src.height - 1, Math.round(y / scale))
      const si = (sy * src.width + sx) * src.channels
      const di = (y * nw + x) * 4
      out[di] = src.pixels[si]
      out[di + 1] = src.pixels[si + 1]
      out[di + 2] = src.pixels[si + 2]
      out[di + 3] = src.channels === 4 ? src.pixels[si + 3] : 255
    }
  }
  return { buf: encodePng(nw, nh, out), w: nw, h: nh }
}

/* ---------- 透明校验 ---------- */

/**
 * 验一张 PNG 是不是**真透明**。
 *
 * 只看「有没有 alpha 通道」不够：有些不透明 PNG 也写 colorType=6 但 alpha 全 255。
 * 所以这里连 alpha 的实际分布一起看 —— 必须存在真正的全透明像素。
 */
function inspectPng(buf) {
  let pos = 8
  let w = 0
  let h = 0
  let colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }

  const hasAlpha = colorType === 6 || colorType === 4
  if (!hasAlpha) {
    return { width: w, height: h, colorType, hasAlpha: false, transparentPixels: 0 }
  }

  /* 解出来数一下透明像素占比 */
  const channels = colorType === 6 ? 4 : 2
  let transparent = 0
  let total = 0
  try {
    const raw = inflateSync(Buffer.concat(idat))
    const stride = w * channels
    let rp = 0
    const prev = Buffer.alloc(stride)
    const cur = Buffer.alloc(stride)

    for (let y = 0; y < h; y++) {
      const ft = raw[rp++]
      const line = raw.subarray(rp, rp + stride)
      rp += stride
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? cur[x - channels] : 0
        const b = prev[x]
        const c = x >= channels ? prev[x - channels] : 0
        let v = line[x]
        if (ft === 1) v += a
        else if (ft === 2) v += b
        else if (ft === 3) v += (a + b) >> 1
        else if (ft === 4) {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        }
        cur[x] = v & 255
      }
      /* 采样 alpha 通道：每行每 7 个像素取一个，够判断占比量级 */
      for (let x = channels - 1; x < stride; x += channels * 7) {
        total++
        if (cur[x] < 8) transparent++
      }
      cur.copy(prev)
    }
  } catch {
    return { width: w, height: h, colorType, hasAlpha: true, transparentPixels: -1 }
  }
  return { width: w, height: h, colorType, hasAlpha: true, transparentPixels: transparent / Math.max(total, 1) }
}

/* ---------- 主流程 ---------- */

async function probe() {
  console.log('中转自检')
  console.log('─'.repeat(56))
  console.log(`  base    ${BASE_URL}`)
  console.log(`  model   ${MODEL}`)
  console.log(`  size    请求 ${SIZE}`)
  console.log(`  proxy   ${PROXY || '(未配)'}`)
  console.log('─'.repeat(56))
  if (!API_KEY) throw new Error('缺少 PACKY_API_KEY')

  const body = {
    model: MODEL,
    prompt: '一个红色圆形，放在完全透明的背景上，不要任何背景色',
    size: SIZE,
    quality: QUALITY,
    background: 'transparent',
    output_format: 'png',
    n: 1,
  }

  console.log('\n发送测试请求…')
  const { status, body: text } = curlRequest(`${BASE_URL}/v1/images/generations`, { json: body })

  if (status < 200 || status >= 300) {
    console.log(`\nHTTP ${status}`)
    console.log(text.slice(0, 500))
    console.log('\n可能原因：')
    console.log('  · base URL 不对（packyapi 的域名请在其后台确认）')
    console.log('  · 不支持 background/output_format 这两个参数')
    console.log('  · key 无效或额度不足')
    return
  }

  let json
  try {
    json = JSON.parse(text)
  } catch {
    console.log('返回非 JSON：', text.slice(0, 300))
    return
  }

  const item = json?.data?.[0]
  const b64 = item?.b64_json
  const url = item?.url
  let buf = null
  if (b64) buf = Buffer.from(b64, 'base64')
  else if (url) buf = curlDownload(url)

  if (!buf) {
    console.log('没有拿到图片数据。返回结构：')
    console.log(JSON.stringify(json).slice(0, 400))
    return
  }

  const info = inspectPng(buf)
  console.log()
  console.log('结果：')
  console.log(`  实际尺寸     ${info.width}x${info.height}   ${info.width + 'x' + info.height === SIZE ? '✅' : '❌ 与请求不符'}`)
  console.log(`  colorType    ${info.colorType} (6=RGBA 4=灰度+A)`)
  console.log(`  alpha 通道   ${info.hasAlpha ? '✅ 有' : '❌ 无'}`)
  const pct = info.transparentPixels * 100
  console.log(`  透明像素占比 ${info.transparentPixels < 0 ? '?' : pct.toFixed(1) + '%'}  ${pct > 5 ? '✅ 真透明' : '❌ 背景没透明'}`)
  console.log()
  if (info.hasAlpha && pct > 5 && `${info.width}x${info.height}` === SIZE) {
    console.log('✅ 中转支持 transparent 与自定义尺寸，可以正式生成。')
  } else {
    console.log('❌ 参数没完全生效。先解决再批量生成，否则 4 张全废。')
  }

  const p = join(OUT_DIR, '_probe.png')
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(p, buf)
  console.log(`\n测试图已存到 ${p}，可以打开确认。`)
}

/**
 * 真正执行一次生成，返回结果信息。
 * queue 模式会反复调它，所以这里不做「是否确认」的判断 ——
 * 确认逻辑放在调用方（单次模式的 --yes、或 queue 的交互提示）。
 */
async function generateOnce(group, refPick) {
  const g = GROUPS[group]
  if (!g) throw new Error(`未知分组 ${group}，可选：${Object.keys(GROUPS).join(', ')}`)

  const prompt = [buildBase(SIZE), g.body].join('\n\n')
  const refs = findRefs(refPick)

  console.log(`生成 ${group} · ${g.label}`)
  console.log('─'.repeat(56))
  console.log(`  尺寸      ${SIZE}`)
  console.log(`  质量      ${QUALITY}`)
  console.log(`  参考图    ${refs.length} 张${refs.length ? '（' + refs.map((p) => basename(p)).join(', ') + '）' : ''}`)
  console.log(`  提示词    ${prompt.length} 字`)
  console.log(`  输出      ${join(OUT_DIR, `${group}-${g.label}.png`)}`)
  console.log('─'.repeat(56))

  /*
   * 有参考图走 edits（multipart），没有走 generations（JSON）。
   * 这是 OpenAI 的接口约定，中转一般照做。
   */
  let res
  let text
  if (refs.length) {
    /*
     * 走 multipart 上传参考图。
     *
     * 两个踩过的坑：
     * 1. 用 Node 内置的 File（不是 Blob）—— 部分中转只认带 filename 的 part，
     *    Blob 附带的 filename 可能被丢掉，服务端拿不到 model 字段。
     * 2. 手动设 Content-Type 会覆盖掉 boundary，必须让 fetch 自己生成。
     */
    /*
     * 走 multipart 上传参考图。
     * 用数组描述 fields，交给 curlRequest 拼 -F 参数 —— 不用 FormData，
     * 因为要绕开 fetch（见 curlRequest 的注释）。
     */
    const fields = [
      { name: 'model', value: MODEL },
      { name: 'prompt', value: prompt },
      { name: 'size', value: SIZE },
      { name: 'quality', value: QUALITY },
      { name: 'background', value: 'transparent' },
      { name: 'output_format', value: 'png' },
      { name: 'n', value: '1' },
    ]
    const tmpDir = join(ROOT, '.tmp-refs')
    mkdirSync(tmpDir, { recursive: true })
    for (const r of refs) {
      const { buf } = shrinkPng(r)
      console.log(`  ${basename(r)} 压缩后 ${(buf.length / 1024 / 1024).toFixed(2)}MB`)
      const tmp = join(tmpDir, basename(r))
      writeFileSync(tmp, buf)
      fields.push({ name: 'image[]', file: tmp, type: 'image/png' })
    }
    console.log('\n上传参考图并请求生成…')
    const r1 = curlRequest(`${BASE_URL}/v1/images/edits`, { form: fields })
    res = { status: r1.status, ok: r1.status >= 200 && r1.status < 300 }
    text = r1.body
  } else {
    const body = {
      model: MODEL,
      prompt,
      size: SIZE,
      quality: QUALITY,
      background: 'transparent',
      output_format: 'png',
      n: 1,
    }
    console.log('\n请求生成（无参考图）…')
    const r2 = curlRequest(`${BASE_URL}/v1/images/generations`, { json: body })
    res = { status: r2.status, ok: r2.status >= 200 && r2.status < 300 }
    text = r2.body
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 400)}`)

  const json = JSON.parse(text)
  const item = json?.data?.[0]
  let buf = null
  if (item?.b64_json) buf = Buffer.from(item.b64_json, 'base64')
  else if (item?.url) buf = curlDownload(item.url)
  if (!buf) throw new Error(`没拿到图片数据：${JSON.stringify(json).slice(0, 300)}`)

  const info = inspectPng(buf)
  mkdirSync(OUT_DIR, { recursive: true })
  const dest = join(OUT_DIR, `${group}-${g.label}.png`)
  writeFileSync(dest, buf)

  const pct = info.transparentPixels * 100
  console.log(`\n已保存 ${dest}`)
  console.log(`  尺寸 ${info.width}x${info.height} ${info.width + 'x' + info.height === SIZE ? '✅' : '❌'}`)
  console.log(`  透明 ${info.hasAlpha ? pct.toFixed(1) + '% ✅' : '无 alpha ❌'}`)
  console.log()
  console.log('切图：')
  console.log(`  node scripts/split-sheet.js "${dest}" --grid 3x4 --out .tmp-split --trim \\`)
  console.log(`    --names ${g.names}`)

  return { dest, info, pct, group, label: g.label }
}

/* ---------- 逐张模式 ---------- */

/**
 * 一次跑一张，每张出完就停下来等确认。
 *
 * 为什么要有这个模式：出图是要花钱的，一张 1024x1536+high 约 $0.165。
 * 单次模式（--group X）只能在跑之前确认一次，一旦参数不对就是白花。
 * 逐张模式让每张出完都能先看图，不满意当场重跑，不用等 4 张全跑完才发现问题。
 *
 * 交互：
 *   Enter  继续下一张
 *   r      重跑当前这张
 *   q      退出（保留已生成的）
 */
async function queue() {
  const order = ['G1', 'G2', 'G3', 'G4']
  const from = getOpt('--from', 'G1').toUpperCase()
  const startIdx = order.indexOf(from)
  if (startIdx < 0) throw new Error(`--from 只能是 ${order.join(' / ')}`)
  if (!API_KEY) throw new Error('缺少 PACKY_API_KEY')

  const rl = makeAsk()

  console.log('逐张生成模式')
  console.log('─'.repeat(56))
  console.log(`  顺序      ${order.slice(startIdx).join(' → ')}`)
  console.log(`  尺寸      ${SIZE}   质量 ${QUALITY}`)
  console.log(`  参考图    G1 用设定图1，G2~G4 用设定图2`)
  console.log(`  交互      生成前 Enter 开始 · s 跳过 · q 退出`)
  console.log(`            生成后 Enter 继续 · r 重跑`)
  console.log('─'.repeat(56))
  console.log()

  /*
   * 先确认、再生成。
   *
   * 之前写成「先生成、跑完再问」，那样有两个问题：
   *   1. 第一张无论如何都会跑掉，没有后悔的机会
   *   2. 参数配错（比如参考图挂错了）也要等花钱之后才发现
   * 现在每张都先打印将要用的参数，确认后才真正请求。
   */
  for (let i = startIdx; i < order.length; i++) {
    const group = order[i]
    const g = GROUPS[group]
    const ref = GROUP_REF[group]

    for (;;) {
      const refs = findRefs(ref)
      console.log(`\n[${i + 1}/${order.length}] ${group} · ${g.label}`)
      console.log('─'.repeat(56))
      console.log(`  尺寸      ${SIZE}   质量 ${QUALITY}`)
      console.log(`  参考图    ${refs.map((p) => basename(p)).join(', ')}`)
      console.log(`  输出      ${join(OUT_DIR, `${group}-${g.label}.png`)}`)
      console.log(`  切图名    ${g.names}`)
      console.log('─'.repeat(56))

      process.stdout.write('\n开始生成这一张？[Enter=生成 / s=跳过 / q=退出] ')
      const answer = await rl.line()
      const a = answer.trim().toLowerCase()

      if (a === 'q') {
        rl.close()
        console.log('\n已退出。已生成的图保留在输出目录。')
        return
      }
      if (a === 's') {
        console.log('跳过这一张。')
        break
      }

      /* Enter 或任何其他输入 → 生成 */
      try {
        await generateOnce(group, ref)
      } catch (e) {
        console.error(`\n✗ 失败：${e.message}`)
        console.error('  这一张没成功。修好问题后可以重跑整条命令。')
      }

      /*
       * 生成后停一下，让人看清结果再决定。
       * 这里只提供「重跑」和「继续」，因为「跳过」在生成前才有意义。
       */
      process.stdout.write('\n这张满意吗？[Enter=继续下一张 / r=重跑这张] ')
      const after = await rl.line()
      if (after.trim().toLowerCase() !== 'r') break
      console.log('\n重跑这一张…')
    }
  }

  rl.close()
  console.log('\n全部 4 组跑完。')
  console.log('接下来可以切图：')
  console.log('  node scripts/split-sheet.js "生成的图/G1-状态与情绪.png" --grid 3x4 --out .tmp-split --trim \\')
  console.log('    --names pose4,pose1,pose3,pose2,shy,angry,surprise,heart,shrug,thumbsup,stretch,clap')
}

/**
 * 按行读 stdin。
 *
 * 为什么不直接用 readline 的 question()：管道输入（`printf "s\ns\nq\n" | node …`）
 * 会在 rl.question 注册之前就把数据推过来，那一行就被丢掉，
 * 表现为「第二张卡住不动」（实测踩到）。人在终端敲键时不会触发，
 * 但脚本要能被自动化测试，所以必须处理。
 *
 * 做法：自己缓存输入、按行切开、有消费需求时立即兑现。
 */
function makeAsk() {
  const lines = []
  let waiter = null
  let buf = ''

  process.stdin.setEncoding('utf8')
  process.stdin.resume()
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (waiter) {
        const w = waiter
        waiter = null
        w(line)
      } else {
        lines.push(line)
      }
    }
  })

  return {
    /** 读一行；已有缓存就立刻返回，否则等下一个 data 事件 */
    line() {
      if (lines.length) return Promise.resolve(lines.shift())
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    close() {
      process.stdin.pause()
    },
  }
}

/* ---------- 单次模式 ---------- */

async function single(group) {
  if (!API_KEY) throw new Error('缺少 PACKY_API_KEY')

  /* 出图是要花钱的，没加 --yes 就只打印不请求，避免误触烧额度 */
  if (!hasFlag('--yes')) {
    const g = GROUPS[group]
    if (!g) throw new Error(`未知分组 ${group}，可选：${Object.keys(GROUPS).join(', ')}`)
    const refs = findRefs()
    console.log(`生成 ${group} · ${g.label}`)
    console.log('─'.repeat(56))
    console.log(`  尺寸      ${SIZE}`)
    console.log(`  参考图    ${refs.map((p) => basename(p)).join(', ') || '(无)'}`)
    console.log('─'.repeat(56))
    console.log()
    console.log('⚠ 这会真实调用 API 并产生费用。')
    console.log('  确认无误后加上 --yes 重跑，或改用逐张模式：')
    console.log(`    node scripts/gen-sheet.js --group ${group} --yes`)
    console.log(`    node scripts/gen-sheet.js --queue`)
    return
  }

  await generateOnce(group, null)
}

/* ---------- 入口 ---------- */

const main = hasFlag('--probe')
  ? probe
  : hasFlag('--queue')
    ? queue
    : () => single(getOpt('--group', 'G1'))

main().catch((e) => {
  console.error(`\n失败：${e.message}`)
  process.exit(1)
})
