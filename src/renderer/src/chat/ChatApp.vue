<script setup>
/**
 * 对话窗 —— 贴着桌宠弹出的聊天面板。
 * 左上是会话历史，主体是消息流，底部输入框。支持流式回复与「停止生成」。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  state,
  initBridge,
  refresh,
  refreshChatStatus,
  refreshChatSessions,
  openChatSession,
  newChatSession,
  renameChatSession,
  deleteChatSession,
  sendChat,
  abortChat,
  win,
  refreshGallery,
  refreshSessionAffinity,
  consumeUnlock,
  setActiveSession,
  refreshSessionSettings,
  markChatRead,
} from '../stores/app.js'
/* affinityView 是本地口径（比 affinityLevel 多一层 godMode 判定），保留 */
import { affinityView } from '@shared/interactions.js'
import { checkImagesForModel, livePreviewOf } from '@shared/content.js'
import { photoPathsOf } from '@shared/photoMessage.js'
import { pickChatBackground } from '@shared/chatBackground.js'
import { ChatBackgroundMode } from '@shared/moyu.js'
import { useOutfitState } from '../lib/outfit-state.js'

const input = ref('')
/*
 * 解锁弹窗。
 *
 * 从 store.lastUnlock 派生而不是本地 ref：解锁是主进程广播过来的
 * （emit('gallery-unlock')），本地 ref 收不到；而且切会话后
 * 不该再弹上一次的。
 */
const unlock = computed(() => state.lastUnlock ?? null)

/*
 * 解锁装扮时优先显示**自拍照片**（「她发来的照片」的观感），
 * 没生成过照片的 slug 退回立绘。
 *
 * 照片**按需探测**：解锁到来时只探该 slug 的候选路径（每套最多几张），
 * 取最先加载成功的一张。此前是挂载时全量探测 24 套服饰候选 + 23 组
 * 生活照（最多 ~142 个请求，多数 404），且要等全部探测结束弹窗才可用。
 */
const unlockImgSrc = ref('')

function probeImage(rel) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
    img.src = rel
  })
}

/* 弹窗只有 outfit 分支显示 unlockImgSrc（photo/video 走各自的媒体分支），
   非 outfit 解锁不做任何探测；seq 令牌防快速连续解锁时旧探测结果回写 */
let probeSeq = 0
watch(unlock, async (u) => {
  const seq = ++probeSeq
  unlockImgSrc.value = ''
  if (!u || u.kind !== 'outfit') return
  for (const rel of photoPathsOf(u.kind, u.slug)) {
    const ok = await probeImage(rel)
    if (seq !== probeSeq) return
    if (ok) {
      unlockImgSrc.value = rel
      return
    }
  }
  if (seq === probeSeq) unlockImgSrc.value = `yuki-outfit-${u.slug}.png`
})
function closeUnlock() {
  consumeUnlock()
}
const historyOpen = ref(false)
const busy = ref(false)
const editingId = ref(null)
const editingTitle = ref('')
const scrollBox = ref(null)
const textarea = ref(null)

const chat = computed(() => state.chat)
const messages = computed(() => chat.value.messages)
const status = computed(() => chat.value.status)

/** 头像统一用 Yuki（打包进 dist/assets，路径相对 index.html） */
const AVATAR_SRC = 'yuki-avatar.png'
const avatarSrc = computed(() => AVATAR_SRC)

/** 标题显示当前人设名 */
const personaName = computed(() => {
  const id = state.settings.chatPersona
  if (id === 'yuki' || !id) return 'Yuki'
  const found = (state.meta.chatPersonas ?? []).find((p) => p.id === id)
  return found?.label ?? 'Yuki'
})

/* ---------- 亲密度 ---------- */

/**
 * 聊天是提升亲密度最快的途径，所以进度必须显示在聊天窗里 ——
 * 否则用户聊了半天看不到任何反馈，也就不会在意这个数值。
 */
const affinity = computed(() => affinityView(state.affinity?.points ?? 0, state.settings?.godMode))
const affinityPoints = computed(() => state.affinity?.points ?? 0)
/* 后端快照的字段是 gainToday/dailyCap（每日额度对所有来源合计封顶）；
   旧名 chatToday/chatDailyCap 是「只封聊天」时代的遗产，快照里已不再带 */
const chatToday = computed(() => state.affinity?.gainToday ?? 0)
const chatCap = computed(() => state.meta.affinity?.dailyCap ?? 60)
/** 今日得分是否已到顶：到顶后还能聊，只是不再涨点 */
const chatCapped = computed(() => chatToday.value >= chatCap.value && !affinity.value.isMax)

/** 升级时在标题栏闪一下，让「聊得多了」这件事有个明确反馈 */
const levelUpFlash = ref('')
let lastLevelIndex = null
watch(
  () => affinity.value.index,
  (idx) => {
    const name = affinity.value.level.name
    if (lastLevelIndex !== null && idx > lastLevelIndex) {
      levelUpFlash.value = `关系升级 · ${name}`
      window.setTimeout(() => (levelUpFlash.value = ''), 3200)
    }
    lastLevelIndex = idx
  },
  { immediate: false },
)
onMounted(() => {
  /* 首次拿到点数时不该报「升级」，所以初始化在挂载后 */
  lastLevelIndex = affinity.value.index
})

/** 流式中的内容作为一条临时消息显示在末尾 */
/*
 * 流式预览只显示**第一条**（截到分段标记为止）。
 *
 * 不截的话生成过程中会在气泡里看到 `第一句<<<MSG>>>第二句` 这种原始文本
 * —— 标记直接暴露给用户；生成结束又"啪"地重排成多个气泡，观感很跳。
 * 截断之后的观感才是真人聊天：先打完第一条发出去，再接着打下一条。
 */
const liveText = computed(() => (chat.value.streaming ? livePreviewOf(chat.value.streamText) : ''))

/* ---------- 图片输入（选文件 / 粘贴 / 拖拽） ---------- */

/** 待发送的图片（data URL）；发送成功后清空 */
const pendingImages = ref([])
const imageError = ref('')
const fileInput = ref(null)
const previewImage = ref('')
const dragActive = ref(false)

/** 单条消息最多几张 —— 太多会挤占上下文（每张最多 1024 token） */
const MAX_IMAGES_PER_MESSAGE = 4

const composerPlaceholder = computed(() => {
  /*
   * 必须 `status.value.ready`，**不能写 `status.ready`**。
   *
   * `status` 是 ComputedRef 对象；`<script setup>` 里没有模板的自动解包，
   * 写成 `status.ready` 拿到的是 undefined —— `!undefined` 恒为 true，
   * 于是这句永远是「请先在设置里配置 API Key」，
   * 哪怕 Key 早就配好了、标题栏也已经显示 deepseek-flash。
   *
   * 极难发现的原因：**同一个 `status` 在模板里是对的**（那边自动解包），
   * 所以同一个元素上 `:disabled="!status.ready"` 正常、只有 placeholder 坏掉，
   * 看起来像是「placeholder 的响应式失效了」。
   */
  if (!status.value.ready) return '请先在设置里配置 API Key'
  if (pendingImages.value.length) return '说点什么（也可以直接发图）…'
  return '和 Yuki 说点什么…  📎 发图 / Ctrl+V 粘贴'
})

/** 从消息里取纯文本 / 图片，兼容纯字符串与块数组两种落库形态 */
function textOf(m) {
  const c = m?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
}
function imagesOf(m) {
  const c = m?.content
  if (!Array.isArray(c)) return []
  return c.filter((b) => b?.type === 'image_url').map((b) => b.image_url?.url ?? '').filter(Boolean)
}

/**
 * 把选中的图片压到合理尺寸再转 data URL。
 *
 * 为什么必须压：原图动辄几 MB，base64 后还会膨胀 33%，
 * 几张就顶到 48 MiB 请求体上限；而且官方对图片只按尺寸折算 token，
 * 超出的细节本来就会被丢掉 —— 压到长边 1280 既不损失模型能用的信息，
 * 又让库体积和请求体都保持在可控范围。
 *
 * 用 canvas 而不是 Electron 原生 API：渲染进程本来就有 DOM，
 * 不需要额外 IPC，也不用把图片先写盘。
 */
async function fileToDataUrl(file) {
  const MAX_EDGE = 1280
  const QUALITY = 0.82

  /* GIF 直接读原文件：canvas 会把动图压成静帧，而且 GIF 本来就可能很小 */
  if (file.type === 'image/gif') return readAsDataUrl(file)

  const bitmap = await createImageBitmap(file)
  let { width, height } = bitmap
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
  width = Math.round(width * scale)
  height = Math.round(height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  /* 透明图（PNG 立绘等）铺白底，否则转 JPEG 后透明区会变黑 */
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()

  return canvas.toDataURL('image/jpeg', QUALITY)
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result ?? ''))
    fr.onerror = () => reject(new Error('读取图片失败'))
    fr.readAsDataURL(file)
  })
}

/** 校验并加入待发送列表 */
async function addFiles(files) {
  imageError.value = ''
  const list = [...(files ?? [])].filter((f) => f && /^image\//i.test(f.type))
  if (!list.length) return

  const room = MAX_IMAGES_PER_MESSAGE - pendingImages.value.length
  if (room <= 0) {
    imageError.value = `一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图`
    return
  }
  if (list.length > room) {
    imageError.value = `一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图，只加了前 ${room} 张`
  }

  for (const file of list.slice(0, room)) {
    try {
      const url = await fileToDataUrl(file)
      pendingImages.value.push(url)
    } catch (err) {
      imageError.value = `这张图读不了：${err?.message ?? err}`
    }
  }
}

function pickImage() {
  fileInput.value?.click()
}

async function onFileChange(e) {
  await addFiles(e.target?.files)
  /* 清空 value，否则连续选同一个文件不会再触发 change */
  if (fileInput.value) fileInput.value.value = ''
}

/** 粘贴：截图直接粘进来 */
async function onPaste(e) {
  const items = [...(e.clipboardData?.items ?? [])]
  const imgs = items.filter((it) => it.kind === 'file' && /^image\//i.test(it.type)).map((it) => it.getAsFile())
  if (!imgs.filter(Boolean).length) return
  /* 有图片就拦下默认粘贴，避免把文件名之类的文本也塞进输入框 */
  e.preventDefault()
  await addFiles(imgs)
}

async function onDrop(e) {
  dragActive.value = false
  await addFiles(e.dataTransfer?.files)
}

function onDragOver() {
  dragActive.value = true
}

function removeImage(i) {
  pendingImages.value.splice(i, 1)
  imageError.value = ''
}

/* ---------- 立绘 / 换装 ---------- */

/**
 * 立绘已经移到独立的 `ChatPetApp` 窗口，这里只显示当前穿着名 +
 * 提供一个直达开关。这样做是因为对话框宽只有 420，
 * 立绘浮在消息流右侧会压到文字。
 *
 * 换装状态收敛在 useOutfitState（与桌宠/立绘窗/右键菜单同一套，
 * 守卫规则单源）—— 此前这里复制的版本漏了「未解锁回落」守卫。
 */
const { currentOutfitLabel, outfits, chooseOutfit: pickOutfit } = useOutfitState()

/*
 * 换装面板：和独立立绘窗里点立绘打开的是同一份设置，改哪边都同步。
 *
 * 之前这个按钮被我改成了「显隐立绘窗」，结果换装入口整个丢了 ——
 * 只剩小窗里「点立绘」一条路，很不明显。现在 👗 回到它该有的语义，
 * 显隐立绘窗改用单独的按钮。
 */
const outfitPickerOpen = ref(false)

async function chooseOutfit(slug) {
  outfitPickerOpen.value = false
  await pickOutfit(slug)
}

const outfitFlash = ref('')

/** 独立的显隐按钮：立绘窗被关掉时给个反馈，免得以为按钮坏了 */
async function toggleSidePet() {
  const visible = await win.chatPetToggle()
  outfitFlash.value = visible === false ? '立绘已隐藏' : '立绘已显示'
  window.setTimeout(() => (outfitFlash.value = ''), 1800)
}

/* 有图即可发送（允许只发图不写字），但不能全空 */
const canSend = computed(
  () => (input.value.trim().length > 0 || pendingImages.value.length > 0) && !chat.value.streaming,
)

function formatTime(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatDay(ts) {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return '今天'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

async function scrollToBottom() {
  await nextTick()
  const el = scrollBox.value
  if (el) el.scrollTop = el.scrollHeight
}

async function onSend() {
  const text = input.value.trim()
  const images = [...pendingImages.value]
  if ((!text && !images.length) || chat.value.streaming) return

  /*
   * 先做本地预检，通过了再清空输入框。
   * 否则模型不支持图片这类错误会在清空之后才返回 —— 用户打的字和图都没了，
   * 还得重新弄一遍。这是纯粹的用户体验问题，但代价很低。
   */
  const localIssue = checkImagesForModel(state.settings.chatModel, images)
  if (localIssue) {
    imageError.value = localIssue
    return
  }

  input.value = ''
  pendingImages.value = []
  imageError.value = ''
  await scrollToBottom()
  const res = await sendChat(text, images)
  /* 落库消息（含作为 assistant 消息落库的错误）由 messages watch 滚到底 */
  return res
}

function onKeydown(e) {
  /* Enter 发送，Shift+Enter 换行 */
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    onSend()
  }
}

async function toggleHistory() {
  historyOpen.value = !historyOpen.value
  if (historyOpen.value) await refreshChatSessions()
}

async function pickSession(id) {
  historyOpen.value = false
  await openChatSession(id)
  /*
   * 每个会话是独立的她：切过去要同步拉该会话的亲密度与图鉴。
   * 不拉的话界面上显示的还是上一个人的数值 —— 亲密度、图鉴进度
   * 都按会话隔离，这是「独立角色」的直接体现。
   */
  await syncSessionState()
  await scrollToBottom()
}

/** 拉当前会话的逐会话状态（亲密度 / 图鉴） */
async function syncSessionState() {
  /*
   * 先告诉主进程「当前活跃会话是谁」—— 桌宠跟着它走。
   * 顺序重要：先设置再拉取，否则拉到的是上一个会话的数据。
   */
  if (state.chat.sessionId) {
    /* setActiveSession 内部已经拉了 gallery/affinity/settings */
    await setActiveSession(state.chat.sessionId)
  } else {
    await Promise.all([refreshSessionAffinity(), refreshGallery(), refreshSessionSettings()])
  }
  /* 人设是逐会话的：切过去要同步输入框顶部的名字 */
  await refreshChatStatus?.().catch?.(() => {})
}

async function onNewSession() {
  historyOpen.value = false
  await newChatSession()
  await scrollToBottom()
  textarea.value?.focus()
}

function startRename(s) {
  editingId.value = s.id
  editingTitle.value = s.title
}

async function commitRename(s) {
  const title = editingTitle.value.trim()
  if (title && title !== s.title) await renameChatSession(s.id, title)
  editingId.value = null
}

async function onDelete(s) {
  if (!confirm(`删除会话「${s.title}」？此操作不可恢复。`)) return
  await deleteChatSession(s.id)
  if (!state.chat.sessionId) await initSession()
}

async function initSession() {
  await refreshChatSessions()
  const first = state.chat.sessions[0]
  if (first) await openChatSession(first.id)
  else await newChatSession()
  await syncSessionState()
}

let stopBridge = null

onMounted(async () => {
  stopBridge = initBridge()
  await refresh()
  await refreshChatStatus()
  await initSession()
  await scrollToBottom()
  textarea.value?.focus()
  /* 自动换装的时钟由 useOutfitState 自管（此处不再重复建定时器） */
})

onBeforeUnmount(() => {
  stopBridge?.()
  /* 自动换装的时钟由 useOutfitState 自管；这里只管背景轮换与未读监听 */
  if (bgTimer) window.clearInterval(bgTimer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('focus', onWindowFocus)
})

/**
 * 对话配置变了要重拉状态。
 *
 * `chatStatus` 只算一次存在 `store.chat.status` 里，而设置保存广播的
 * `state` **不含** chat.status（见 service 的 getState），所以对话窗不会
 * 自己知道用户刚填了 Key。
 *
 * 窗口又是「只 hide 不销毁」的（硬规则），再打开走的是 `chatWindow.show()`，
 * **不重新加载页面**，`onMounted` 不会再跑 ——
 * 于是「填好 Key 再打开对话窗，还是说未填写」。
 *
 * 这里只盯真正影响对话可用性的那几个字段，避免任何设置变动都打一次 IPC。
 * （设置页保存时 `saveSettings` 也会主动刷一次 —— 两条路互为补充：
 * 这条管「值确实变了」，那条管「保存这个动作发生了」。）
 */
watch(
  () => [
    state.settings?.chatApiKey,
    state.settings?.chatBaseUrl,
    state.settings?.chatModel,
    state.settings?.chatProvider,
  ],
  () => {
    refreshChatStatus().catch(() => {})
  },
)

/**
 * 窗口重新获得焦点 / 重新可见时都对一次。
 *
 * 为什么两个都听：`createChatWindow()` 对已存在的窗口做的是
 * `show() + focus()`，而 Chromium 的 Page Visibility 在某些
 * 隐藏/显示路径上并不保证派发 `visibilitychange` ——
 * 只挂那一个的话，「关掉再打开对话窗」可能一次都不刷新，
 * 症状就是用户看到的「一直是请先在设置里配置 API Key」。
 * 两个事件都幂等，重复触发无副作用。
 */
function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    refreshChatStatus().catch(() => {})
    markChatRead().catch(() => {})
  }
}
function onWindowFocus() {
  refreshChatStatus().catch(() => {})
  /* 用户切回对话窗 = 他看到了，清未读 */
  markChatRead().catch(() => {})
}
document.addEventListener('visibilitychange', onVisibilityChange)
window.addEventListener('focus', onWindowFocus)

/* ---------- 聊天背景 ---------- */

/*
 * 与手机端同一套逻辑（`shared/chatBackground.js`）——
 * 两端读同一份 settings，选图算法不一致的话同一时刻会显示不同的图。
 *
 * 「这张图还在不在」以**图鉴快照**为准：`gallery[kind].items[].photos` 是
 * 业务层用 `existsFor()` 核过的实际存在路径（见 service 的 build()），
 * 设置页的 `allPhotoPaths` 用的就是同一份口径。
 *
 * 合并前这里复用的是挂载时全量预探测得到的 `availablePhotos` —— 那张表
 * 在朋友的重构里被换掉了（全量探测最多 ~142 个请求、多数 404，改成解锁时
 * 按需探测）。改读图鉴既不用再扫一遍网络，也不会出现第二份「哪张图存在」
 * 的答案与设置页打架。
 */
const bgAvailable = computed(() => {
  const g = state.gallery
  const out = new Set()
  for (const kind of ['outfit', 'photo']) {
    for (const it of g?.[kind]?.items ?? []) for (const p of it.photos ?? []) out.add(p)
  }
  return out
})

/*
 * 轮换是「按时间片取模」算的，不是存「轮到第几张」——
 * 所以要有一个会走的时钟，computed 才会跟着重算。
 * 不引时钟的话 `pickChatBackground` 里的 `Date.now()` 永远只算第一次。
 */
const bgClock = ref(Date.now())

const chatBg = computed(() =>
  pickChatBackground({
    mode: state.settings?.chatBgMode,
    fixed: state.settings?.chatBackground,
    pool: state.settings?.chatBgPool ?? [],
    available: (p) => bgAvailable.value.has(p),
    rotateMin: state.settings?.chatBgRotateMin,
    now: bgClock.value,
  }),
)

/** 照片保留多少（0.05~0.85）；遮罩 alpha 取它的补数，见 CSS 的 --bg-mask */
const bgOpacity = computed(() => Math.min(0.85, Math.max(0.05, Number(state.settings?.chatBgOpacity) || 0.25)))

const msgsStyle = computed(() => {
  if (!chatBg.value) return null
  /*
   * 必须解析成**绝对 URL**，不能直接塞相对路径。
   *
   * CSS 自定义属性里的 `url()` 是相对**消费它的那条规则所在的样式表**解析的，
   * 不是相对文档。桌面端的组件样式会被 Vite 编译进 `dist/assets/index-*.css`，
   * 于是 `photos/x.png` 被解析成 `dist/assets/photos/x.png` → 404，背景画不出来。
   *
   * 这个坑**只在打包版出现**：dev 模式样式是内联注入的，基准就是文档 URL，
   * 相对路径恰好正确。实测过 —— 同一个路径用 `new Image()` 探测能加载
   * （那是相对文档），但用作背景就是裂的。
   *
   * 手机端没这个问题：它的样式表在产物根目录，正好和文档同级。
   */
  return {
    '--bg-image': `url("${new URL(chatBg.value, location.href).href}")`,
    '--bg-opacity': String(bgOpacity.value),
  }
})

let bgTimer = null

/**
 * 轮换定时器开关。
 *
 * 只在「轮换模式 + 池子非空」时跑 —— 其余时候白算。
 * 集中在一个函数里，而不是散在改动设置的各处：漏一处的表现是
 * 「开了轮换但不换」（定时器没起来），很难查。
 */
function syncBgTimer() {
  const want =
    state.settings?.chatBgMode === ChatBackgroundMode.ROTATE && (state.settings?.chatBgPool ?? []).length > 0
  if (!want) {
    if (bgTimer) {
      window.clearInterval(bgTimer)
      bgTimer = null
    }
    return
  }
  if (bgTimer) return
  /* 半分钟一次足够：换装粒度是分钟级，没必要更密 */
  bgTimer = window.setInterval(() => (bgClock.value = Date.now()), 30_000)
}

watch(() => [state.settings?.chatBgMode, (state.settings?.chatBgPool ?? []).length], syncBgTimer, {
  immediate: true,
})

watch(liveText, scrollToBottom)
/* 深监听整条消息数组的代价随会话长度线性涨（含 base64 图块）；
   流式文本已由 liveText watch 覆盖，这里只跟条数变化 */
watch(() => messages.value.length, scrollToBottom)

/*
 * 我正看着这个窗口时，她说的话**不该算未读**。
 *
 * 未读的定义是「她说的、晚于已读位置的消息」，而打点只在
 * `focus` / `visibilitychange` 时做 —— 回复到达时窗口**早就聚焦了**，
 * 不会再触发这两个事件，于是未读数一路涨、桌宠上一直亮红点，
 * 而人就盯着屏幕看那句话。体验很怪。
 *
 * 所以每次消息列表变化时补一次：窗口在前台且有焦点 → 立刻标已读。
 * 主动找话题发来的消息同样走这里（它也只是往 messages 里加一条）。
 */
watch(
  () => messages.value.length,
  () => {
    if (document.hidden || !document.hasFocus()) return
    markChatRead().catch(() => {})
  },
)
</script>

<template>
  <div class="chat-shell">
    <!-- 标题栏（可拖动窗口）。data-tauri-drag-region 给 Tauri：
         target 自身判定，所以左侧展示元素用 pointer-events:none 穿透（见 CSS） -->
    <header class="chat-head" data-tauri-drag-region>
      <div class="head-left">
        <img class="head-avatar" :src="avatarSrc" alt="Yuki" />
        <div class="head-text">
          <p class="head-title">{{ personaName }}</p>
          <p class="head-sub">
            {{ status.ready ? status.model : '未配置对话接口' }}
          </p>
          <!-- 亲密度：聊天是最主要的加分途径，进度就放在标题下面 -->
          <div class="affinity" :title="`今日得分 ${chatToday}/${chatCap}`">
            <span class="affinity-name">{{ affinity.level.name }}</span>
            <span class="affinity-bar">
              <span class="affinity-fill" :style="{ width: affinity.progress + '%' }" />
            </span>
            <span class="affinity-num tabular">{{ affinityPoints }}</span>
          </div>
        </div>
      </div>
      <div class="head-right">
        <button class="hbtn" :class="{ active: historyOpen }" title="历史对话" @click="toggleHistory">☰</button>
        <button class="hbtn" title="新建对话" @click="onNewSession">＋</button>
        <button class="hbtn" title="关闭" @click="win.hideChat()">✕</button>
      </div>
    </header>

    <!-- 关系升级提示：聊天攒够分数时的明确反馈 -->
    <transition name="fade">
      <p v-if="levelUpFlash" class="levelup">{{ levelUpFlash }}</p>
    </transition>

    <!-- 未配置提示 -->
    <div v-if="!status.ready" class="notice">
      <p class="notice-title">还不能对话</p>
      <p class="notice-body">{{ status.reason }}</p>
      <button class="btn btn-primary" @click="win.openPanel()">打开设置</button>
    </div>

    <!-- 换装 + 立绘窗开关：立绘本体在独立小窗里，这里只放入口 -->
    <div class="outfit-bar">
      <button class="outfit-entry" title="换装" @click="outfitPickerOpen = !outfitPickerOpen">
        👗 {{ currentOutfitLabel }}
      </button>
      <button class="outfit-eye" :title="'显示/隐藏旁边的立绘小窗'" @click="toggleSidePet">🪟</button>
      <span v-if="outfitFlash" class="outfit-flash">{{ outfitFlash }}</span>

      <transition name="fade">
        <div v-if="outfitPickerOpen" class="chat-outfit-picker">
          <button
            class="cop-item"
            :class="{ active: state.settings.outfitMode === 'auto' }"
            @click="chooseOutfit(null)"
          >
            <span>🎲</span><span>自动穿</span>
          </button>
          <button
            v-for="o in outfits"
            :key="o.slug"
            class="cop-item"
            :class="{ active: state.settings.outfitMode === 'fixed' && state.settings.outfitSlug === o.slug }"
            :title="o.hint"
            @click="chooseOutfit(o.slug)"
          >
            <span>{{ o.emoji }}</span><span>{{ o.label }}</span>
          </button>
        </div>
      </transition>
    </div>

    <!-- 历史会话 -->
    <transition name="slide">
      <aside v-if="historyOpen" class="history">
        <div class="history-head">
          <span>历史对话（{{ chat.sessions.length }}）</span>
          <button class="hbtn small" @click="historyOpen = false">✕</button>
        </div>
        <ul v-if="chat.sessions.length" class="history-list">
          <li
            v-for="s in chat.sessions"
            :key="s.id"
            class="history-item"
            :class="{ active: s.id === chat.sessionId }"
            @click="pickSession(s.id)"
          >
            <div class="hi-main">
              <input
                v-if="editingId === s.id"
                v-model="editingTitle"
                class="hi-input"
                @click.stop
                @keydown.enter="commitRename(s)"
                @keydown.esc="editingId = null"
                @blur="commitRename(s)"
              />
              <p v-else class="hi-title">{{ s.title }}</p>
              <p class="hi-meta tabular">
                {{ s.messageCount }} 条 · {{ formatDay(s.updatedAt) }}
              </p>
            </div>
            <div class="hi-actions" @click.stop>
              <button class="hi-btn" title="重命名" @click="startRename(s)">✎</button>
              <button class="hi-btn danger" title="删除" @click="onDelete(s)">🗑</button>
            </div>
          </li>
        </ul>
        <p v-else class="history-empty">还没有对话记录</p>
      </aside>
    </transition>

    <!-- 消息流 -->
    <div ref="scrollBox" class="msgs" :class="{ 'has-bg': !!chatBg }" :style="msgsStyle">
      <p v-if="!messages.length && !liveText" class="empty-hint">
        和 Yuki 打个招呼吧～<br />
        <span class="dim">Enter 发送 · Shift+Enter 换行</span>
      </p>

      <div
        v-for="m in messages"
        :key="m.id"
        class="msg"
        :class="[m.role, { error: m.error }]"
      >
        <img v-if="m.role === 'assistant'" class="msg-avatar" :src="avatarSrc" alt="" />
        <div class="bubble">
          <div v-if="imagesOf(m).length" class="bubble-images">
            <img v-for="(src, i) in imagesOf(m)" :key="i" :src="src" alt="" @click="previewImage = src" />
          </div>
          <p v-if="textOf(m)" class="bubble-text">{{ textOf(m) }}</p>
        </div>
        <span class="msg-time tabular">{{ formatTime(m.createdAt) }}</span>
      </div>

      <!-- 正在流式输出的内容 -->
      <div v-if="liveText" class="msg assistant">
        <img class="msg-avatar" :src="avatarSrc" alt="" />
        <div class="bubble">
          <p class="bubble-text">{{ liveText }}<span class="caret" /></p>
        </div>
      </div>
      <div v-else-if="chat.streaming" class="msg assistant">
        <img class="msg-avatar" :src="avatarSrc" alt="" />
        <div class="bubble typing"><span /><span /><span /></div>
      </div>
    </div>

    <!-- 输入区 -->
    <footer class="composer" @dragover.prevent="onDragOver" @drop.prevent="onDrop">
      <!-- 待发送的图片缩略图 -->
      <div v-if="pendingImages.length" class="pending">
        <div v-for="(img, i) in pendingImages" :key="i" class="pending-item">
          <img :src="img" alt="" />
          <button class="pending-del" title="移除" @click="removeImage(i)">✕</button>
        </div>
        <span class="pending-count">{{ pendingImages.length }} 张 · 将随消息发出</span>
      </div>

      <p v-if="imageError" class="image-err">{{ imageError }}</p>

      <div class="composer-row">
        <button
          class="attach"
          :disabled="!status.ready"
          title="发图片（也可以直接 Ctrl+V 粘贴截图，或把图片拖进来）"
          @click="pickImage"
        >
          📎
        </button>
        <textarea
          ref="textarea"
          v-model="input"
          class="input"
          rows="1"
          :placeholder="composerPlaceholder"
          :disabled="!status.ready"
          @keydown="onKeydown"
          @paste="onPaste"
        />
        <button v-if="chat.streaming" class="send stop" title="停止生成" @click="abortChat()">■</button>
        <button v-else class="send" :disabled="!canSend" title="发送 (Enter)" @click="onSend">↑</button>
      </div>
      <input ref="fileInput" class="file-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple @change="onFileChange" />
    </footer>

    <p v-if="state.lastError" class="err">{{ state.lastError }}</p>

    <!-- 点开大图 -->
    <div v-if="previewImage" class="img-preview" @click="previewImage = ''">
      <img :src="previewImage" alt="" />
    </div>

    <!--
      解锁弹窗：模拟「她发来照片」。
      手机上也是这个交互，两边保持一致。
    -->
    <div v-if="unlock" class="unlock-mask" @click.self="closeUnlock">
      <div class="unlock-card">
        <p class="unlock-badge">✨ 解锁新装扮</p>
        <img class="unlock-img" :src="unlockImgSrc" :alt="unlock.title" />
        <p class="unlock-title">{{ unlock.title }}</p>
        <p class="unlock-line">{{ unlock.line }}</p>
        <button class="unlock-ok" @click="closeUnlock">收下</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---------- 解锁弹窗 ---------- */
.unlock-mask {
  position: fixed; inset: 0; z-index: 70;
  background: rgba(0, 0, 0, .72);
  -webkit-backdrop-filter: blur(5px);
  backdrop-filter: blur(5px);
  display: grid; place-items: center; padding: 22px;
}
.unlock-card {
  position: relative; z-index: 1;
  width: 100%; max-width: 320px; max-height: 90vh; overflow-y: auto;
  padding: 18px 16px 16px; border-radius: 16px;
  /* 不透明底：立绘是透明 PNG，透明底会让背后的聊天文字透出来 */
  background: rgb(var(--surface-rgb, 255 255 255));
  text-align: center;
}
.unlock-badge { margin: 0 0 10px; font-size: 12px; font-weight: 700; color: rgb(var(--theme-accent)); }
.unlock-img { max-width: 100%; max-height: 240px; object-fit: contain; background: rgb(var(--surface-rgb, 255 255 255)); }
.unlock-title { margin: 11px 0 0; font-size: 15px; font-weight: 700; }
.unlock-line { margin: 6px 0 15px; font-size: 13px; line-height: 1.65; color: var(--text-2); }
.unlock-ok {
  width: 100%; padding: 10px; border: none; border-radius: 10px;
  background: rgb(var(--theme-accent)); color: #fff;
  font-size: 13.5px; font-weight: 600; cursor: pointer;
}
.chat-shell {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  box-sizing: border-box;
  border-radius: 16px;
  overflow: hidden;
  /* 聊天背景的遮罩色取这个 —— 与壳层底色一致，压暗后才不会有色差 */
  --chat-bg: #ffffff;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(0, 0, 0, 0.1);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(16px);
}

/* ---------- 标题栏 ---------- */
.chat-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.07);
  /* Electron：整条标题栏交给系统拖拽 */
  -webkit-app-region: drag;
  /* Tauri：data-tauri-drag-region 按 target 自身判定，
     左侧纯展示元素（头像/文案/亲密度）穿透，让 mousedown 落在标题栏自身 */
}
.head-left {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  /* 见 .chat-head：Tauri 下展示区不拦截鼠标（Electron 下无副作用，
     它本来就继承 drag） */
  pointer-events: none;
}
.head-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  flex: 0 0 auto;
  object-fit: cover;
  background: rgb(var(--theme-accent) / 0.12);
  border: 1.5px solid rgb(var(--theme-accent) / 0.35);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #d1d5db;
  flex: 0 0 auto;
}
.dot.ok {
  background: rgb(var(--theme-accent));
  box-shadow: 0 0 0 3px rgb(var(--theme-accent) / 0.16);
}
.head-text {
  min-width: 0;
}
.head-title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: #16181d;
}
.head-sub {
  margin: 1px 0 0;
  font-size: 10.5px;
  color: #9ca3af;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.head-right {
  display: flex;
  gap: 4px;
  /* Electron：按钮区显式排除拖拽；
     Tauri：按钮是 target 且不带 drag 属性，天然不拖，无需处理 */
  -webkit-app-region: no-drag;
}

/* ---------- 亲密度（标题栏） ---------- */
.affinity {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 3px;
}
.affinity-name {
  flex: 0 0 auto;
  font-size: 9.5px;
  color: rgb(var(--theme-accent));
  font-weight: 700;
}
.affinity-bar {
  flex: 1 1 auto;
  min-width: 36px;
  height: 4px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.08);
  overflow: hidden;
}
.affinity-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: rgb(var(--theme-accent));
  transition: width 0.35s ease;
}
.affinity-num {
  flex: 0 0 auto;
  font-size: 9.5px;
  color: #9ca3af;
}

/* 关系升级提示：浮在消息流上方，不挤占布局 */
.levelup {
  position: absolute;
  top: 62px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  margin: 0;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgb(var(--theme-accent));
  color: #fff;
  font-size: 11.5px;
  font-weight: 700;
  box-shadow: 0 6px 18px rgb(var(--theme-accent) / 0.35);
  pointer-events: none;
}
/* ---------- 换装入口 ---------- */
.outfit-bar {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 12px 0;
}
.outfit-entry {
  padding: 4px 11px;
  border-radius: 999px;
  border: 1px solid rgb(var(--theme-accent) / 0.35);
  background: rgb(var(--theme-accent) / 0.08);
  color: rgb(var(--theme-accent));
  font-size: 11px;
  font-weight: 600;
}
.outfit-entry:hover {
  background: rgb(var(--theme-accent) / 0.16);
}
.outfit-eye {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.9);
  font-size: 11px;
  line-height: 1;
}
.outfit-eye:hover {
  border-color: rgb(var(--theme-accent) / 0.5);
}
.outfit-flash {
  font-size: 10.5px;
  color: #9ca3af;
}

/* 换装面板：向下展开，列全部 17 套 */
.chat-outfit-picker {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 6px;
  z-index: 20;
  width: 168px;
  padding: 6px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.99);
  border: 1px solid rgba(0, 0, 0, 0.12);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.2);
  max-height: 232px;
  overflow-y: auto;
}
.cop-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 7px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: #374151;
  font-size: 11.5px;
  text-align: left;
}
.cop-item:hover {
  background: rgba(0, 0, 0, 0.05);
}
.cop-item.active {
  background: rgb(var(--theme-accent) / 0.14);
  color: rgb(var(--theme-accent));
  font-weight: 700;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translate(-50%, -6px);
}
.hbtn {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: #6b7280;
  font-size: 13px;
  line-height: 1;
}
.hbtn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: rgb(var(--theme-accent));
}
.hbtn.active {
  background: rgb(var(--theme-accent) / 0.14);
  color: rgb(var(--theme-accent));
}
.hbtn.small {
  width: 22px;
  height: 22px;
  font-size: 11px;
}

/* ---------- 未配置提示 ---------- */
.notice {
  flex: 0 0 auto;
  margin: 10px 12px 0;
  padding: 10px 12px;
  border-radius: 11px;
  background: rgba(251, 191, 36, 0.14);
  border: 1px solid rgba(251, 191, 36, 0.4);
}
.notice-title {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: #92400e;
}
.notice-body {
  margin: 3px 0 8px;
  font-size: 11.5px;
  color: #a16207;
  line-height: 1.5;
}

/* ---------- 历史 ---------- */
.history {
  position: absolute;
  inset: 47px 0 0 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: rgba(252, 252, 253, 0.99);
  backdrop-filter: blur(18px);
}
.history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  font-size: 11.5px;
  font-weight: 700;
  color: #6b7280;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}
.history-list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  flex: 1;
}
.history-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 9px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.13s ease;
}
.history-item:hover {
  background: rgba(0, 0, 0, 0.045);
}
.history-item.active {
  background: rgb(var(--theme-accent) / 0.12);
}
.hi-main {
  flex: 1;
  min-width: 0;
}
.hi-title {
  margin: 0;
  font-size: 12.5px;
  color: #16181d;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hi-meta {
  margin: 2px 0 0;
  font-size: 10px;
  color: #9ca3af;
}
.hi-input {
  width: 100%;
  height: 24px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid rgb(var(--theme-accent));
  background: #fff;
  font-size: 12.5px;
  outline: none;
}
.hi-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.13s ease;
}
.history-item:hover .hi-actions {
  opacity: 1;
}
.hi-btn {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #9ca3af;
  font-size: 11px;
}
.hi-btn:hover {
  background: rgba(0, 0, 0, 0.07);
  color: #16181d;
}
.hi-btn.danger:hover {
  color: #dc2626;
}
.history-empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: #9ca3af;
}

/* ---------- 消息 ---------- */
.msgs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/*
 * 聊天背景（图鉴里点开一张照片 → 「设为背景」）。
 *
 * 与手机端同一套做法，**别改回 `background-attachment: local`** ——
 * 那个值会把「背景定位区」从可见框换成可滚动溢出区，而 `cover`
 * 按定位区缩放，照片会被放大好几倍（移动端实测 7 倍）。
 * 详见 docs/DESIGN.md「聊天背景的比例坑」。
 *
 * 遮罩并进背景层（一个半透明底色渐变压在照片上），而不是用 ::before：
 * 滚动容器内的绝对定位元素会跟着内容一起滚，遮罩出了第一屏就没了。
 * 并进背景层后两层共用同一定位区，比例与遮罩范围天然一致。
 */
.msgs.has-bg {
  --bg-mask: color-mix(in srgb, var(--chat-bg, #fff) calc((1 - var(--bg-opacity, 0.25)) * 100%), transparent);
  background-image:
    linear-gradient(var(--bg-mask), var(--bg-mask)),
    var(--bg-image, none);
  background-size: cover, cover;
  background-position: center, center;
  background-repeat: no-repeat, no-repeat;
}
.empty-hint {
  margin: auto;
  text-align: center;
  font-size: 12.5px;
  color: #9ca3af;
  line-height: 1.9;
}
.dim {
  font-size: 11px;
  color: #c3c8d0;
}

.msg {
  display: flex;
  flex-direction: column;
  max-width: 84%;
}
.msg.user {
  align-self: flex-end;
  align-items: flex-end;
}
.msg.assistant {
  align-self: flex-start;
  align-items: flex-start;
}
/* 助手头像与气泡同一行，靠底对齐更自然 */
.msg.assistant {
  display: grid;
  grid-template-columns: 26px 1fr;
  grid-template-areas:
    'avatar bubble'
    '. time';
  gap: 4px 7px;
  align-items: end;
}
.msg-avatar {
  grid-area: avatar;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  object-fit: cover;
  align-self: end;
  margin-bottom: 2px;
  background: rgba(0, 0, 0, 0.04);
}
.msg.assistant .bubble {
  grid-area: bubble;
}
.msg.assistant .msg-time {
  grid-area: time;
}
.bubble {
  padding: 8px 11px;
  border-radius: 13px;
  font-size: 12.8px;
  line-height: 1.62;
  word-break: break-word;
  white-space: pre-wrap;
}
.msg.user .bubble {
  background: rgb(var(--theme-accent));
  color: #fff;
  border-bottom-right-radius: 5px;
}
.msg.assistant .bubble {
  background: rgba(0, 0, 0, 0.05);
  color: #16181d;
  border-bottom-left-radius: 5px;
}
.msg.error .bubble {
  background: rgba(220, 38, 38, 0.1);
  color: #b91c1c;
}
.bubble-text {
  margin: 0;
}
.msg-time {
  margin: 3px 2px 0;
  font-size: 9.5px;
  color: #c3c8d0;
}
.caret {
  display: inline-block;
  width: 6px;
  height: 13px;
  margin-left: 2px;
  vertical-align: -2px;
  background: rgb(var(--theme-accent));
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.typing {
  display: flex;
  gap: 4px;
  padding: 11px 13px;
}
.typing span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #b6bcc6;
  animation: bounce 1.2s ease-in-out infinite;
}
.typing span:nth-child(2) {
  animation-delay: 0.15s;
}
.typing span:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.5;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

/* ---------- 输入 ---------- */
.composer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px 12px;
  border-top: 1px solid rgba(0, 0, 0, 0.07);
}
.composer-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

/* ---------- 图片输入 ---------- */
.pending {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.pending-item {
  position: relative;
  width: 46px;
  height: 46px;
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #f3f4f6;
}
.pending-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pending-del {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 15px;
  height: 15px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 9px;
  line-height: 1;
  display: grid;
  place-items: center;
}
.pending-del:hover {
  background: #dc2626;
}
.pending-count {
  font-size: 10.5px;
  color: #9ca3af;
}
.image-err {
  margin: 0;
  font-size: 10.5px;
  color: #b91c1c;
}
/* 原生 file input 只用来触发选择，不参与布局 */
.file-input {
  display: none;
}
.attach {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  border-radius: 11px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.9);
  font-size: 15px;
  line-height: 1;
}
.attach:hover:not(:disabled) {
  border-color: rgb(var(--theme-accent) / 0.5);
  background: rgb(var(--theme-accent) / 0.1);
}
.attach:disabled {
  opacity: 0.45;
}

/* 消息里的图片 */
.bubble-images {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 5px;
}
/* 同时给 max-width/max-height、不设 aspect-ratio：
   照片有 3:4 和 4:3 两种，写死比例会把其中一种压变形 */
.bubble-images img {
  max-width: 240px;
  max-height: 240px;
  border-radius: 9px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  cursor: zoom-in;
}
/* 多张（连拍）时缩小并排，避免叠起来占满一屏 */
.bubble-images:has(> img:nth-child(2)) { flex-wrap: nowrap; }
.bubble-images:has(> img:nth-child(2)) img {
  max-width: 150px;
  max-height: 200px;
  min-width: 0;
}

/* 点开大图 */
.img-preview {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.82);
  cursor: zoom-out;
}
.img-preview img {
  max-width: 100%;
  max-height: 100%;
  border-radius: 8px;
}
.input {
  flex: 1;
  min-height: 36px;
  max-height: 120px;
  padding: 9px 11px;
  border-radius: 11px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
  color: #16181d;
  font-size: 12.8px;
  line-height: 1.5;
  resize: none;
  outline: none;
  font-family: inherit;
}
.input:focus {
  border-color: rgb(var(--theme-accent));
}
.input:disabled {
  background: #f7f7f9;
  color: #9ca3af;
}
.send {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  border-radius: 11px;
  border: none;
  background: rgb(var(--theme-accent));
  color: #fff;
  font-size: 15px;
  line-height: 1;
  transition: all 0.15s ease;
}
.send:hover:not(:disabled) {
  filter: brightness(1.08);
}
.send:disabled {
  background: #d1d5db;
  cursor: not-allowed;
}
.send.stop {
  background: #ef4444;
}

.err {
  position: absolute;
  left: 12px;
  bottom: 58px;
  font-size: 10px;
  color: #dc2626;
  max-width: calc(100% - 24px);
}

/* ---------- 过渡 ---------- */
.slide-enter-active,
.slide-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
