<script setup>
/**
 * 桌宠本体：一只会呼吸的摸鱼猫 + 头顶气泡（今日摸鱼收入）。
 * 右键菜单在独立小窗打开（showMenu → 两种壳各自的窗口实现）。
 * 拖拽走主进程 setPosition，避免渲染进程移动窗口时抖动。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  state,
  refresh,
  initBridge,
  addAffinity,
  refresh as refreshState,
  refreshGallery,
  refreshSessionAffinity,
  setActiveSession,
} from '../stores/app.js'
import { formatDuration } from '@shared/moyu.js'
import {
  LINES,
  COFFEE_LINES,
  EMOTE_FOR,
  TIRED_POSES,
  AFFINITY_GAIN,
  OUTFIT_SLUGS,
  DEFAULT_OUTFIT,
  affinityLevel,
  contextualScene,
  hoverLinesFor,
  idleCandidatesFor,
  idleIntervalScale,
  isTiredHour,
  linesFor,
  outfitFile,
  outfitForTime,
  pickLine,
  poseImageFile,
  IDLE_JITTER_MIN,
  IDLE_JITTER_MAX,
  SEDENTARY_INTERVAL_MS,
} from '@shared/interactions.js'

/*
 * 立绘映射统一收在 @shared/interactions.js 的 PET_EXPRESSIONS，
 * 这里不重复定义，避免两处不一致。
 */

const settingsOpen = ref(false)
const reacting = ref(false)
const bubbleOpen = ref(true)

/**
 * 缩放值直接来自设置，不再单独存一份 ref。
 *
 * 之前用 ref 只在 onMounted 赋值一次，外部（设置页/托盘）改了 petScale 后
 * 立绘尺寸不会跟着变，窗口已经是新尺寸但图还是旧大小，点击热区也就对不上。
 */
const scale = computed(() => {
  const s = Number(state.settings.petScale)
  return Number.isFinite(s) && s > 0 ? s : 1
})
const dragging = ref(false)

let timer = null
let stopBridge = null
let snackTimer = null
let outfitClockTimer = null
/** 拖拽结束也会触发 click，用它区分「拖」和「点」 */
let movedByDrag = false

const statusText = computed(() => {
  const s = state.settings
  if (!s.enabled) return '摸鱼进度未开启'
  switch (state.snapshot.statusKind) {
    case 'rest-day':
      return '今日休息，安心躺平'
    case 'before-work':
      return '尚未开工'
    case 'completed':
      return '今日已赚满 💰'
    default:
      return `摸鱼进行中 · 已赚 ${state.todayEarnedText}`
  }
})

/** 状态类心情：由工作/休息状态决定 */
const mood = computed(() => {
  switch (state.snapshot.statusKind) {
    case 'rest-day':
      return 'rest'
    case 'completed':
      return 'happy'
    case 'before-work':
      return 'idle'
    default:
      return state.snapshot.progress >= 0.5 ? 'happy' : 'work'
  }
})

/**
 * 表情类：互动触发后临时覆盖心情，显示几秒再自动恢复。
 * 用 key 而不是文件名，方便和台词一起管理生命周期。
 */
const emote = ref('')
let emoteTimer = null

function setEmote(key, holdMs = 2600) {
  if (!key) return
  emote.value = key
  if (emoteTimer) window.clearTimeout(emoteTimer)
  emoteTimer = window.setTimeout(() => (emote.value = ''), holdMs)
}

/** 最终展示的表情：互动表情 > 挂机姿态 > 状态心情 */
const currentExpression = computed(() => emote.value || idlePose.value || mood.value)

/**
 * 当前穿着（自动模式按时间算，固定模式用设置值）。
 *
 * 桌宠也读这个 —— 右键菜单的「换装」改的就是它。
 * 之前只在对话窗侧边立绘生效，桌宠压根不看这个设置，
 * 于是「右键换装没反应」（用户实测反馈）。
 *
 * clockTick 每分钟推进一次：直接 new Date() 不会触发重渲染，
 * 跨过时段边界（比如 23:00 该换睡衣）就不会自动切换。
 */
const clockTick = ref(Date.now())

/** 已解锁的服饰集合（未拉到图鉴时保守处理为「只有初始那套」） */
const unlockedOutfits = computed(() => {
  const list = state.gallery?.outfit?.unlocked
  /* 图鉴还没拉回来时不能当成「全解锁」—— 宁可少显示也不要漏 */
  return new Set(Array.isArray(list) ? list : [DEFAULT_OUTFIT])
})

const currentOutfitSlug = computed(() => {
  if (state.settings.outfitMode !== 'fixed') return outfitForTime(new Date(clockTick.value))
  const s = state.settings.outfitSlug
  if (!OUTFIT_SLUGS.includes(s)) return DEFAULT_OUTFIT
  /*
   * 未解锁的一律回落到默认。
   *
   * 守卫放这里而不是只放在菜单窗的换装入口里：换装写的是 settings，
   * 而 settings 的写入口不止一个（设置页、IPC、将来的重置）。
   * 在**展示用的求值点**挡一道，才是真正绕不过去的。
   * 实测过：只在换装入口挡时，直接调 updateSettings 就能穿上未解锁的。
   */
  if (!unlockedOutfits.value.has(s)) return DEFAULT_OUTFIT
  return s
})

/**
 * 立绘展示的是动作还是服饰？
 *
 * 优先级：**互动/挂机表情 > 手动指定服饰 > 动作轮换**
 *
 * - 摸头、双击这类互动必须立刻有反馈，否则「点了没反应」；
 * - 没有临时表情时，手动选的服饰优先（用户明确选了就该看到）；
 * - 自动模式下按动作轮换（她「在做事」），服饰只在挂机池里随机出现。
 */
const showingOutfit = computed(
  () => state.settings.outfitMode === 'fixed' && !emote.value,
)

/** 当前展示项对应的立绘文件（自动区分动作与服饰） */
const petImage = computed(() =>
  showingOutfit.value ? outfitFile(currentOutfitSlug.value) : poseImageFile(currentExpression.value),
)

/**
 * 播放别的窗口请求的表情（目前只有补卡成功时蹦一下）。
 * seq 递增保证连续同类表情也能重放。
 */
function playRequestedEmote(seq) {
  if (!seq) return
  const req = state.emoteRequest
  if (!req?.key) return
  setEmote(req.key, req.holdMs)
}

const progressPercent = computed(() => state.snapshot.progressPercent ?? 0)
/*
 * 气泡上的「剩余」= 还有多久下班（墙上时钟）。
 * 不用 remainingPaidMinutes —— 那是扣掉午休分摊后的计薪剩余，
 * 会比真实时间少（17:00 时前者 23 分、后者 30 分），看着像算错了。
 */
const remainingText = computed(() => formatDuration(state.snapshot.remainingWorkMinutes ?? 0))

function react() {
  reacting.value = true
  window.setTimeout(() => (reacting.value = false), 420)
}

/* ---------- 互动引擎 ---------- */

/** 临时台词：非空时气泡优先显示它，几秒后回到收益显示 */
const speech = ref('')
let speechTimer = null
let lastLine = null

/** 连续摸头计数：短时间连点会累积，到阈值触发「摸够了」 */
const petStreak = ref(0)
let petStreakTimer = null
let lastClickAt = 0

/**
 * 说一句话，同时切换成对应表情。
 * 台词结束后表情自动恢复，所以调用方只需要给个 emote key。
 */
function say(text, emoteKey = null, holdMs = 3200) {
  if (!text) return
  lastLine = text
  speech.value = text
  if (emoteKey) setEmote(emoteKey, holdMs)
  if (speechTimer) window.clearTimeout(speechTimer)
  speechTimer = window.setTimeout(() => (speech.value = ''), holdMs)
}

/** 互动时给个视觉反馈 + 记亲密度 */
function bump(kind, points = 1) {
  react()
  if (state.settings.petAffinity) addAffinity(points).catch(() => {})
}

const affinity = computed(() => affinityLevel(state.affinity?.points ?? 0))

/**
 * 当前关系档位（interactions.js 里的 voice key）。
 * 台词与主动说话频率都跟着它走 —— 这才是「亲密度提升」的实际效果，
 * 只涨数字不改说话方式的话，用户是感觉不到的。
 */
const voice = computed(() => affinity.value.voice ?? 'stranger')

/** 按关系档位取台词：等级越高，同一场景的说法越亲近 */
function lineFor(key) {
  return pickLine(linesFor(key, voice.value), lastLine, Math.random)
}

/*
 * 每日见面分：只要这天桌宠起来过一次就记 1 点，
 * 让「连续互动天数」不至于因为没动手摸而断掉。
 */
let dailyBonusDone = false

function grantDailyAffinity() {
  if (dailyBonusDone || !state.settings.petAffinity) return
  dailyBonusDone = true
  addAffinity(AFFINITY_GAIN.daily).catch(() => {})
}

/* ---------- 鼠标交互 ---------- */

const hovering = ref(false)
const longPressing = ref(false)
let hoverTimer = null
let longPressTimer = null
let longPressFired = false

function onPetEnter() {
  hovering.value = true
  if (!state.settings.petInteractions) return
  /* 悬停 1.2 秒才搭话，避免鼠标扫过就冒泡 */
  if (hoverTimer) window.clearTimeout(hoverTimer)
  hoverTimer = window.setTimeout(() => {
    if (!speech.value) say(pickLine(hoverLinesFor(voice.value), lastLine, Math.random), EMOTE_FOR.hover)
  }, 1200)
}

function onPetLeave() {
  hovering.value = false
  if (hoverTimer) {
    window.clearTimeout(hoverTimer)
    hoverTimer = null
  }
  if (longPressTimer) {
    window.clearTimeout(longPressTimer)
    longPressTimer = null
  }
  longPressing.value = false
}

function onPointerDown(e) {
  if (e.button !== 0) return
  movedByDrag = false
  dragging.value = true
  window.setTimeout(() => (dragging.value = false), 200)

  /* 长按：按住 700ms 触发贴贴，不和单击冲突 */
  longPressFired = false
  if (!state.settings.petInteractions) return
  if (longPressTimer) window.clearTimeout(longPressTimer)
  longPressTimer = window.setTimeout(() => {
    longPressFired = true
    longPressing.value = true
    bump('pet', AFFINITY_GAIN.pet)
    say(lineFor('pet'), EMOTE_FOR.pet)
  }, 700)
}

function onPointerUp() {
  if (longPressTimer) {
    window.clearTimeout(longPressTimer)
    longPressTimer = null
  }
  if (longPressing.value) {
    window.setTimeout(() => (longPressing.value = false), 300)
  }
}

function onPetClick() {
  if (movedByDrag) {
    movedByDrag = false
    return
  }
  if (longPressFired) {
    longPressFired = false
    return
  }
  if (!state.settings.petInteractions) {
    react()
    return
  }

  /* 连续点击 = 摸头：1.2 秒内的点击累加 */
  const now = Date.now()
  petStreak.value = now - lastClickAt < 1200 ? petStreak.value + 1 : 1
  lastClickAt = now
  if (petStreakTimer) window.clearTimeout(petStreakTimer)
  petStreakTimer = window.setTimeout(() => (petStreak.value = 0), 1500)

  bump('click', AFFINITY_GAIN.click)
  /* 摸到第 4 下开始抱怨，避免无限被戳没反应 */
  if (petStreak.value >= 4) {
    say(lineFor('pet'), EMOTE_FOR.petOverload)
    petStreak.value = 0
  } else if (petStreak.value === 1) {
    say(lineFor('poke'), EMOTE_FOR.poke)
  }
}

function onPetDoubleClick() {
  if (!state.settings.petInteractions) return
  bump('double', AFFINITY_GAIN.double)
  say(lineFor('doubleTap'), EMOTE_FOR.doubleTap)
}

/** 拖拽结束：说一句「放我下来」 */
function onDragEnd() {
  if (!state.settings.petInteractions) return
  say(lineFor('dragged'), EMOTE_FOR.dragged)
}

/* ---------- 拖拽 ----------
 *
 * 不要自己监听 mousemove 再 setPosition：窗口一旦跟着指针移动，光标相对窗口的
 * 位置就在不停变化，Chromium 会在拖拽中途停止派发 mousemove（实测第 1 次移动
 * 之后事件就断了），表现就是「拖不动 / 拖一下就卡住」。
 *
 * 正确做法是交给系统：桌宠元素设为 -webkit-app-region: drag，
 * 由窗口管理器完成拖拽，事件不会被打断；点击互动另用 click 事件区分。
 */

/* ---------- 挂机主动冒泡 & 情境台词 ---------- */

let idleTimer = null
let sedentaryTimer = null
let greetedKey = null
/* 同一时间只允许一个生成请求，避免接口慢时堆叠 */
let chatterPending = false
/** 上一次冒泡用的是「结合最近聊天」还是「台词库」，用于避免连续同类 */
let lastChatterKind = null

/**
 * 挂机冒泡的内容来源。
 *
 * 两种来源混着用，而不是「模型优先、失败才用台词库」：
 * 全用模型会显得飘（而且没配 Key 时完全没话说）；
 * 全用台词库又会脱离你们的实际聊天内容。
 * 大约是「近两日聊天内容 : 台词库」六四开。
 */
const CHATTER_HISTORY_WEIGHT = 0.6

/**
 * 决定这次用哪种来源。
 *
 * 连续两次同源会显得单调：连着两句都在追问聊天内容有压力，
 * 连着两句通用台词又像复读机，所以尽量和上一次错开。
 */
function pickChatterSource() {
  const wantHistory = Math.random() < CHATTER_HISTORY_WEIGHT
  if (lastChatterKind === 'history' && wantHistory) return 'pool'
  if (lastChatterKind === 'pool' && !wantHistory) return 'history'
  return wantHistory ? 'history' : 'pool'
}

/**
 * 挂机冒泡：结合「最近两天聊过什么」或台词库说一句。
 *
 * 生成要走网络，所以先把气泡留空等结果；期间用户点了互动就放弃这一轮。
 */
async function speakIdleLine() {
  const fallback = () => {
    lastChatterKind = 'pool'
    return lineFor('idle')
  }

  if (pickChatterSource() === 'pool') return fallback()
  if (chatterPending) return fallback()

  chatterPending = true
  try {
    const res = await window.desk.chatChatterLine?.()
    /* 请求期间用户已经互动过，这次就别插话了 */
    if (speech.value) return ''
    /*
     * 接口没配、近两天没聊天、生成失败 —— 一律回到台词库，
     * 挂机冒泡不该因为接口抖动就整个哑掉。
     */
    if (res?.ok && res.line) {
      lastChatterKind = 'history'
      return res.line
    }
    return fallback()
  } catch {
    return fallback()
  } finally {
    chatterPending = false
  }
}

function scheduleIdleChatter() {
  if (idleTimer) window.clearTimeout(idleTimer)
  if (!state.settings.petIdleChatter) return
  /*
   * 基准分钟数来自设置，实际间隔做 ±抖动，避免像定时机器人。
   * 不要加固定下限：以前 Math.max(IDLE_MIN_MS, base*0.6) 会让
   * 任何小于 ~13 分钟的设置被 8 分钟下限吃掉，用户改成 2 分钟也没用。
   * 这里只保证一个很小的安全底线（30 秒），防止设置成 0 时刷屏。
   *
   * 再乘一层关系倍率：越熟越黏人，是亲密度在「行为」上的体现。
   */
  const base =
    Math.max(0.5, Number(state.settings.petChatterInterval) || 12) * 60 * 1000 * idleIntervalScale(voice.value)
  const lo = Math.max(30_000, base * IDLE_JITTER_MIN)
  const hi = Math.max(lo, base * IDLE_JITTER_MAX)
  const delay = lo + Math.random() * (hi - lo)
  idleTimer = window.setTimeout(async () => {
    if (!speech.value) {
      const line = await speakIdleLine()
      /* 等接口期间用户可能已经互动，再确认一次 */
      if (line && !speech.value) say(line, EMOTE_FOR.idleChatter, 5000)
    }
    scheduleIdleChatter()
  }, delay)
}

/** 情境台词：每个场景一天只主动说一次，否则会烦 */
function maybeContextLine(now = new Date()) {
  if (!state.settings.petContextLines) return
  if (speech.value) return
  const scene = contextualScene(
    { ...state.snapshot, workStart: state.settings.workStart, workEnd: state.settings.workEnd },
    now,
  )
  if (!scene) return
  const dayKey = `${new Date().toDateString()}#${scene.key}`
  if (greetedKey === dayKey) return
  greetedKey = dayKey
  say(pickLine(linesFor(scene.key, voice.value), lastLine, Math.random), EMOTE_FOR[scene.key] ?? null, 4500)
}

function startSedentaryTimer() {
  if (sedentaryTimer) window.clearInterval(sedentaryTimer)
  sedentaryTimer = window.setInterval(() => {
    if (!state.settings.petSedentary) return
    if (!state.snapshot.isWorkingNow) return
    if (speech.value) return
    say(pickLine([...COFFEE_LINES, ...linesFor('sedentary', voice.value)], lastLine, Math.random), EMOTE_FOR.sedentary, 5000)
  }, SEDENTARY_INTERVAL_MS)
}

/**
 * 挂机时的姿态轮换。
 *
 * 长时间显示同一个立绘会像静态图；每隔一段时间在「吃零食 / 戴耳机 / 思考 / 打哈欠」
 * 之间换一个，看起来像真人在旁边做自己的事。
 * 深夜和早八优先打哈欠。
 */
const idlePose = ref('')
let idlePoseTimer = null
let lastPose = null

function rotateIdlePose() {
  if (!state.settings.petInteractions) return
  /* 有台词/表情时不抢画面 */
  if (speech.value || emote.value) return
  /*
   * 手动指定了衣服就不再轮换动作 —— 否则轮换会把用户选的服饰顶掉，
   * 表现为「换了装但一会儿又变回去了」。挂机池里的服饰项本来就随机出现，
   * 固定模式下交给用户自己决定穿什么。
   */
  if (state.settings.outfitMode === 'fixed') return

  /*
   * 候选池 = 解锁的动作 + 解锁的服饰。
   * 亲密度越高池子越大：刚认识时只有 4 个动作、不换装；
   * 到「形影不离」时 10 个动作 + 9 套衣服一起轮换。
   */
  const unlocked = idleCandidatesFor(voice.value)
  if (!unlocked.length) return

  /*
   * 深夜/早八把困倦类动作的权重抬高，但**不排除**其他项 ——
   * 硬过滤会让 23:00–09:00（一天近 10 小时）的池子从 19 项缩到 12 项，
   * 「每张图都会轮换到」就不成立了。服饰不受时段影响（穿什么跟困不困无关）。
   */
  const tiredNow = isTiredHour()
  const usable = tiredNow
    ? weightedPool(unlocked, (k) => !k.startsWith('outfit:') && TIRED_POSES.includes(k))
    : unlocked

  const next = pickLine(usable, lastPose, Math.random)
  lastPose = next
  idlePose.value = next
  /* 维持 20-50 秒再换，太频繁会显得躁动 */
  const hold = 20_000 + Math.random() * 30_000
  if (idlePoseTimer) window.clearTimeout(idlePoseTimer)
  idlePoseTimer = window.setTimeout(() => {
    idlePose.value = ''
    idlePoseTimer = window.setTimeout(rotateIdlePose, 30_000 + Math.random() * 60_000)
  }, hold)
}

/** 摸鱼进行中偶尔吃个零食 */
function startSnackTimer() {
  const tick = () => {
    if (
      state.settings.petInteractions &&
      state.snapshot.isWorkingNow &&
      !speech.value &&
      !emote.value
    ) {
      emote.value = 'snack'
      const hold = 6000 + Math.random() * 6000
      window.setTimeout(() => {
        if (emote.value === 'snack') emote.value = ''
      }, hold)
    }
    snackTimer = window.setTimeout(tick, 4 * 60_000 + Math.random() * 6 * 60_000)
  }
  snackTimer = window.setTimeout(tick, 3 * 60_000)
}

/** 退出前挥个手 */
async function quitWithWave() {
  speech.value = '那我先走啦，回头见 👋'
  setEmote(EMOTE_FOR.quitting, 1200)
  /* 留出挥手和台词的时间再退，否则用户看不到 */
  window.setTimeout(() => window.desk?.quit?.(), 1200)
}

/* ---------- 右键菜单与窗口贴合 ---------- */

/** 渲染层跑在哪个壳里（拖拽机制与 refit 通道不同） */
const isTauri = Boolean(window.__TAURI__)

/** 菜单在独立小窗打开（两种壳同构）：Tauri 走 Rust 命令，Electron 走主进程窗口 */
function showMenu() {
  window.desk?.showPetMenu?.()
}

/**
 * 把手拖拽（仅左键）：Tauri 用 startDragging 交接系统拖拽。
 *
 * 不用 CSS -webkit-app-region 的原因：合成器级的 drag 区会把右键也吞掉，
 * 页面收不到 contextmenu，弹出的原生菜单无法拦截。startDragging 是同一
 * 套系统机制（不存在「事件断流」问题，被禁的是 mousemove+setPosition），
 * 但只有左键触发，右键正常冒泡到根节点的自定义菜单。
 * Electron 仍走 CSS app-region（见 is-tauri 分支样式）。
 */
function onGripDrag() {
  if (isTauri) window.__TAURI__.window.getCurrentWindow().startDragging()
}

/** 消费菜单窗转来的桌宠本地行为指令（气泡开关/退出挥手） */
function onPetUi(action) {
  if (action === 'toggle-bubble') bubbleOpen.value = !bubbleOpen.value
  if (action === 'quit-wave') quitWithWave()
}

/* ---------- 窗口贴合（所见即所得） ----------
 *
 * 尺寸真值源是渲染层布局：ResizeObserver 盯 .stage（气泡+把手+立绘的内容列），
 * 内容尺寸一变（气泡开关/台词换行/缩放）就把「内容 + 内边距」报给壳层，
 * 壳层按右下角锚定重设窗口。去重防抖：尺寸没变不发、同帧合并。
 * 气泡固定宽 144 —— 内容尺寸与窗口尺寸解耦，观测不会形成反馈回路。
 */
const stageEl = ref(null)
let fitObserver = null
let lastFit = ''

function reportFit() {
  const stage = stageEl.value
  if (!stage) return
  const w = Math.ceil(stage.offsetWidth) + 16
  const h = Math.ceil(stage.offsetHeight) + 16
  const key = `${w}x${h}`
  if (key === lastFit) return
  lastFit = key
  const size = { width: w, height: h }
  if (isTauri) window.__TAURI__.core.invoke('pet_refit', size).catch(() => {})
  else window.desk?.refitPet?.(size)
}

onMounted(async () => {
  stopBridge = initBridge()
  await refresh()
  /*
   * 先取主进程记的「当前活跃会话」，再拉该会话的图鉴与穿着。
   *
   * 顺序不能反：桌宠自己不知道用户在聊哪个会话，
   * 不先同步就会回落到「会话列表第一个」，显示成别人的衣服。
   * 之后由 session-active 广播驱动更新（切会话时自动跟随）。
   */
  try {
    const active = await window.desk?.getActiveSession?.()
    if (active) await setActiveSession(active)
  } catch {
    /* 取不到就按回落逻辑走，不影响显示 */
  }
  await refreshGallery().catch(() => {})
  /* 见面即记一笔：保证「连续互动天数」不因为没动手摸而断掉 */
  grantDailyAffinity()
  timer = window.setInterval(refresh, 15_000)
  /* 窗口贴合观测：内容尺寸一变就报给壳层（含首次挂载的那次回调）。
     observe 后必须同步先量一次——WebView2 对静态页面不出新帧时，
     RO 的首次回调会被饿死（实测：启动后窗不贴合，右键产帧后才好） */
  fitObserver = new ResizeObserver(reportFit)
  if (stageEl.value) {
    fitObserver.observe(stageEl.value)
    reportFit()
  }
  /* 自动换装要跨过时段边界，每分钟对一次时间 */
  outfitClockTimer = window.setInterval(() => (clockTick.value = Date.now()), 60_000)
  /* 消费跨窗口的表情指令（例如面板里点了补卡） */
  watch(() => state.emoteRequest?.seq, playRequestedEmote, { immediate: true })
  /* 消费菜单窗转来的桌宠本地行为指令（气泡开关/退出挥手） */
  watch(() => state.petUiRequest?.seq, () => onPetUi(state.petUiRequest?.action), { immediate: true })

  /* 互动相关定时器 */
  scheduleIdleChatter()
  startSedentaryTimer()
  startSnackTimer()
  /* 开局先显示一会儿挂机姿态，避免一直是站姿 */
  window.setTimeout(rotateIdlePose, 12_000)
  /* 启动后延迟几秒打个招呼（走情境台词，没有场景就不说） */
  window.setTimeout(() => maybeContextLine(), 4000)
})

onBeforeUnmount(() => {
  stopBridge?.()
  if (timer) window.clearInterval(timer)
  if (idleTimer) window.clearTimeout(idleTimer)
  if (sedentaryTimer) window.clearInterval(sedentaryTimer)
  if (speechTimer) window.clearTimeout(speechTimer)
  if (hoverTimer) window.clearTimeout(hoverTimer)
  if (longPressTimer) window.clearTimeout(longPressTimer)
  if (idlePoseTimer) window.clearTimeout(idlePoseTimer)
  if (snackTimer) window.clearTimeout(snackTimer)
  if (outfitClockTimer) window.clearInterval(outfitClockTimer)
  fitObserver?.disconnect()
})
</script>

<template>
  <div
    class="pet-root"
    :class="{ 'is-tauri': isTauri }"
    :style="{ '--pet-scale': scale }"
    @contextmenu.prevent="showMenu"
  >
    <!-- 右键菜单在独立小窗打开（showMenu），本窗只保留气泡与桌宠本体 -->
    <div class="stage" ref="stageEl">
      <transition name="pop">
        <div v-if="bubbleOpen" class="bubble" :class="{ speaking: Boolean(speech) }" @dblclick="refresh">
          <div class="bubble-head">
            <span class="bubble-title">
              {{ speech ? 'Yuki' : state.settings.studyDisguise ? '今日学习进度' : '今日摸鱼收入' }}
            </span>
            <span class="bubble-dot" :class="state.snapshot.statusKind" />
          </div>

          <!-- 台词优先：有话说时气泡显示台词，说完自动回到收益 -->
          <p v-if="speech" class="bubble-speech">{{ speech }}</p>
          <template v-else>
            <p class="bubble-amount tabular">{{ state.todayEarnedText }}</p>
            <div class="bubble-bar">
              <div class="bubble-fill" :style="{ width: progressPercent + '%' }" />
            </div>
            <p class="bubble-meta tabular">{{ statusText }}</p>
            <p class="bubble-sub tabular">
              剩余 {{ remainingText }} · {{ affinity.level.name }}
            </p>
          </template>
        </div>
      </transition>

      <div class="pet-wrap">
        <!--
          拖拽把手必须和 .pet **完全不重叠**。
          Electron 文档原文：no-drag「reenables pointer events by excluding a
          rectangular area from a draggable region」—— 它不是只标记自己那块，
          而是从重叠的 drag 区域里**挖掉**一块矩形。
          .pet 为了可点击设了 no-drag，只要把手和它有任何重叠，
          把手那部分 drag 区就被挖掉，拖拽失效（实测复现 + 逐条 CSS 二分确认）。
          所以把手单独占一行，排在被缩放前的容器里、桌宠正上方。
        -->
        <!--
          拖拽把手必须和 .pet **完全不重叠**。
          Electron 文档原文：no-drag「reenables pointer events by excluding a
          rectangular area from a draggable region」—— 它不是只标记自己那块，
          而是从重叠的 drag 区域里**挖掉**一块矩形。
          .pet 为了可点击设了 no-drag，只要把手和它有任何重叠，
          把手那部分 drag 区就被挖掉，拖拽失效（实测复现 + 逐条 CSS 二分确认）。
          所以把手单独占一行，排在被缩放前的容器里、桌宠正上方。

          Tauri（WebView2）语义差异：data-tauri-drag-region 按「事件 target
          自身」判定，且拖拽检测是 document 级 mousedown 监听 —— 所以
          ① 把手内部三个装饰点用 pointer-events:none 穿透，保证 target
             始终是把手本身（Electron 的 app-region 是子元素继承，无需处理）；
          ② 把手上不能有任何 mousedown.stop —— 会阻断拖拽监听
             （Electron 下该 stop 本来就是死代码：drag 区不派发 DOM 事件）。
        -->
        <span
          class="pet-grip"
          title="按住这里拖动窗口 · 右键打开菜单"
          v-bind="isTauri ? {} : { 'data-tauri-drag-region': true }"
          @mousedown.left.prevent="onGripDrag"
          @click.stop
          @dblclick.stop
        ><i /><i /><i /></span>

        <div
          class="pet"
          :class="[mood, { reacting, hovering, longPressing }]"
          @mousedown="onPointerDown"
          @mouseup="onPointerUp"
          @mouseenter="onPetEnter"
          @mouseleave="onPetLeave"
          @click="onPetClick"
          @dblclick="onPetDoubleClick"
          title="单击互动 · 双击 · 右键菜单 · 拖上面小把手可移动"
        >
          <img class="pet-img" :src="petImage" alt="Yuki" draggable="false" />
          <span class="pet-shadow" />
        </div>
      </div>
    </div>

    <p v-if="state.lastError" class="err">{{ state.lastError }}</p>
  </div>
</template>

<style scoped>
.pet-root {
  position: relative;
  width: 100%;
  /* 用 100vh 而不是 100%：不依赖父链高度是否正确传递，
     避免哪天 #app 或 body 没撑满时布局又塌到顶部 */
  height: 100vh;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: flex-end;
  gap: 6px;
  padding: 8px;
  overflow: hidden;
  /*
   * 这里刻意**不写** -webkit-app-region。
   *
   * Chromium 按 DOM 祖先判定 app-region：祖先显式设了 no-drag 会盖掉
   * 后代把手上的 drag。曾经在这里写 no-drag，导致拖拽把手完全失效。
   * 不写时默认就不是拖拽区，同时不会压住后代的 drag。
   */
}

/* 气泡 + 桌宠：固定在窗口底部，给上方的菜单留出空间 */
.stage {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  /* 菜单展开时也不被压缩，保证桌宠始终完整可见 */
  flex-shrink: 0;
}

/* ---------- 气泡 ---------- */
.bubble {
  /* 定宽：内容尺寸与窗口尺寸解耦，窗口贴合（refit）的观测值才稳定 */
  width: 144px;
  background: rgba(255, 255, 255, 0.93);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(0, 0, 0, 0.07);
  border-radius: 14px;
  padding: 9px 11px 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
  margin-bottom: 4px;
}
.bubble-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.bubble-title {
  font-size: 11px;
  font-weight: 700;
  color: #4b5563;
}
.bubble-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #d1d5db;
}
.bubble-dot.working {
  background: #fbbf24;
}
.bubble-dot.completed,
.bubble-dot.rest-day {
  background: rgb(var(--theme-accent));
}
.bubble-amount {
  font-size: 21px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: rgb(var(--theme-accent));
  margin: 2px 0 6px;
  line-height: 1;
}
.bubble-bar {
  height: 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.08);
  overflow: hidden;
}
.bubble-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, rgb(var(--theme-accent)), rgb(var(--theme-accent-light)));
  transition: width 0.6s ease;
}
.bubble-meta {
  font-size: 10.5px;
  color: #4b5563;
  margin: 6px 0 0;
}
/* 说话时气泡强调一下，并给台词留足行高 */
.bubble.speaking {
  border-color: rgb(var(--theme-accent) / 0.45);
}
.bubble-speech {
  margin: 4px 0 2px;
  font-size: 13px;
  line-height: 1.6;
  color: #1f2937;
  word-break: break-word;
  /* 三行封顶：窗高按内容包围盒收紧后，超长台词不能把气泡顶出窗口 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
.bubble-sub {
  font-size: 10px;
  color: #9ca3af;
  margin: 2px 0 0;
}

/* ---------- 宠物 ---------- */
.pet {
  position: relative;
  flex: 0 0 auto;
  /* 立绘是竖向的（约 0.87 宽高比），容器跟着调整免得留大片空白 */
  width: calc(118px * var(--pet-scale, 1));
  height: calc(136px * var(--pet-scale, 1));
  cursor: pointer;
  transition: transform 0.2s ease;
  /*
   * 关键：这里**不能**设 -webkit-app-region: drag。
   * 设了之后整个桌宠区域交给窗口管理器做拖拽，系统会吃掉鼠标消息，
   * 结果 click / dblclick / mouseenter 全部收不到 —— 实测真实鼠标点击毫无反应
   *（CDP 合成事件不走系统拖拽路径，所以自动化测试发现不了）。
   *
   * 现在的方案：立绘区域保持可点击，另给一个小拖拽把手（.pet-grip）负责移动窗口。
   */
  -webkit-app-region: no-drag;
}
.pet:active {
  cursor: grabbing;
}
/* 悬停：轻微放大，暗示「可以互动」 */
.pet.hovering {
  transform: translateY(-2px) scale(1.04);
}
/* 长按贴贴：晃一晃 */
.pet.longPressing {
  animation: snuggle 0.5s ease-in-out infinite;
}
@keyframes snuggle {
  0%,
  100% {
    transform: rotate(-3deg) scale(1.03);
  }
  50% {
    transform: rotate(3deg) scale(1.03);
  }
}
/* drag 区域内的交互元素必须显式排除，否则收不到点击/右键 */
.pet .pet-img {
  -webkit-app-region: no-drag;
}

/*
 * 桌宠外层容器：竖排「把手 + 桌宠」，让两者的盒子**零重叠**。
 *
 * 这是拖拽能生效的关键：.pet 必须设 no-drag 才能接收点击，
 * 而 no-drag 会把它覆盖的矩形从 drag 区域里挖掉。
 * 只要把手和 .pet 的盒子有任何交叠，把手那块的 drag 就被挖没了。
 * 所以把手不做绝对定位，而是自己占一行，物理上碰不到 .pet。
 *
 * 注意这里**不能**设 no-drag —— 会把把手的 drag 一起挖掉。
 */
.pet-wrap {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

/*
 * 拖拽把手：独占一行，位于桌宠正上方。
 *
 * 走过的弯路（都用 --debug-draggable-regions 实测排除）：
 *   - top:-2px 绝对定位 → 跑到容器外，命中不到
 *   - opacity:0 靠 hover 显形 → 透明元素的 drag 区不可靠
 *   - 嵌在 .pet 内部 → 祖先 no-drag 把 drag 挖掉
 *   - 绝对定位盖在 .pet 上方 → 与 .pet 盒子重叠，drag 依然被挖掉
 * 现在：常驻可见 + 独立一行 + 与 .pet 零重叠。
 */
.pet-grip {
  flex: 0 0 auto;
  width: 40px;
  height: 11px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.5);
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  transition: background 0.16s ease;
  /* 只有这一小块负责移动窗口。双运行时注解：
     -webkit-app-region 给 Electron（合成器级拖拽）；
     Tauri 下改为 JS startDragging（.is-tauri 分支关掉 CSS drag）——
     合成器级 drag 区会把右键也吞掉，页面收不到 contextmenu，
     自定义菜单在把手上就打不开。 */
  -webkit-app-region: drag;
  app-region: drag;
}
/* Tauri：CSS drag 停用（模板也不再带 data-tauri-drag-region），
   左键 mousedown 显式 startDragging，右键正常冒泡到自定义菜单 */
.is-tauri .pet-grip {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.pet-grip:hover {
  background: rgba(0, 0, 0, 0.28);
}
.pet-grip:active {
  cursor: grabbing;
}
.pet-grip i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.9);
  /* Tauri 按 target 自身判定拖拽：装饰点必须穿透，否则点在点上拖不动 */
  pointer-events: none;
}
.pet.dragging {
  cursor: grabbing;
  transform: scale(1.04);
}
.pet.reacting {
  animation: bounce 0.42s ease;
}
.pet.happy,
.pet.rich {
  animation: bob 1.8s ease-in-out infinite;
}
.pet.work {
  animation: sway 2.6s ease-in-out infinite;
}
.pet.sleep {
  animation: breath 3.4s ease-in-out infinite;
}
.pet.idle {
  animation: breathe-idle 3s ease-in-out infinite;
}

/* 立绘是位图，用留白营造轻快感；不加投影，避免透明边缘发灰 */
.pet-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: bottom;
  user-select: none;
  pointer-events: none;
  -webkit-user-drag: none;
  filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.14));
}
.pet-shadow {
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 54px;
  height: 9px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.14);
  filter: blur(4px);
  transform: translateX(-50%);
}

@keyframes bounce {
  0% {
    transform: translateY(0) scale(1);
  }
  35% {
    transform: translateY(-12px) scale(1.06);
  }
  70% {
    transform: translateY(2px) scale(0.97);
  }
  100% {
    transform: translateY(0) scale(1);
  }
}
@keyframes bob {
  0%,
  100% {
    transform: translateY(0) rotate(-1.5deg);
  }
  50% {
    transform: translateY(-5px) rotate(1.5deg);
  }
}
@keyframes sway {
  0%,
  100% {
    transform: rotate(-2deg);
  }
  50% {
    transform: rotate(2deg);
  }
}
@keyframes breath {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.035);
  }
}
@keyframes breathe-idle {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-2px);
  }
}
@keyframes wag {
  0%,
  100% {
    transform: rotate(-6deg);
  }
  50% {
    transform: rotate(10deg);
  }
}

.err {
  position: absolute;
  left: 6px;
  bottom: 2px;
  font-size: 10px;
  color: #dc2626;
  max-width: calc(100% - 12px);
}

/* ---------- 过渡 ---------- */
.pop-enter-active,
.pop-leave-active {
  transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.94);
}
</style>
