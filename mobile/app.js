/**
 * 手机端应用逻辑。
 *
 * 无框架：这只手机端是一个单页应用，用原生 DOM 就够，
 * 能省掉几十 KB 的运行时（PWA 首屏加载和离线缓存都受益）。
 *
 * 所有业务逻辑都在 `./chat.js`（复用桌面端 shared 模块），
 * 这里只负责 DOM 与交互。
 */
import * as db from './storage.js'
import {
  loadSettings,
  /* 别名导入 —— 下面用本地 saveSettings 包一层（见其定义） */
  saveSettings as saveSettingsRaw,
  allPersonas,
  configStatus,
  sendMessage,
  toDateKey,
  currentAffinity,
  bumpAffinity,
  completeOnce,
} from './chat.js'
import { CHAT_PROVIDERS, ChatBackgroundMode } from '../src/shared/moyu.js'
import { pickChatBackground } from '../src/shared/chatBackground.js'
import { pickTapLine, pickFromBag } from '../src/shared/tapLines.js'
import { formatDate, formatClock, weekendText, checkinStatus } from '../src/shared/dayInfo.js'
import { holidayOf, holidayCountdownText } from '../src/shared/holidays.js'
import { buildChatterRequest, cleanChatter, nextChatterDelay, FALLBACK_CHATTER } from '../src/shared/chatter.js'
import { OUTFIT_STORIES } from '../src/shared/outfitStories.js'
import { VIDEO_STORIES, videoSrc, videoPoster } from '../src/shared/videoStories.js'
import { PHOTO_STORIES, PHOTO_SLUGS } from '../src/shared/photoStories.js'
import { DEFAULT_OUTFIT, OUTFITS, chatActionFor } from '../src/shared/interactions.js'
import { buildPhotoMessages, photoPathsOf } from '../src/shared/photoMessage.js'

const $ = (id) => document.getElementById(id)
/*
 * 立绘路径。
 *
 * `outfitImg` 带版本串（用于直接渲染），`outfitImgRel` 不带
 * （用于存设置、做相等比较 —— 版本串会随构建变，存进去下次就比不上了）。
 *
 * 放在文件靠前的位置：详情弹层（`openViewer`）要用 `outfitImgRel`，
 * 而 `const` 不提升，定义在它后面会抛 TDZ 错误。
 */
const OUTFIT_VER = '__OUTFIT_VER__'
const outfitImg = (slug) => `outfits/yuki-outfit-${slug}.png?v=${OUTFIT_VER}`
const outfitImgRel = (slug) => `outfits/yuki-outfit-${slug}.png`

const el = {
  msgs: $('msgs'),
  empty: $('empty-hint'),
  input: $('input'),
  pending: $('pending'),
  file: $('file'),
  send: $('btn-send'),
  stop: $('btn-stop'),
  status: $('status-line'),
  personaName: $('persona-name'),
  drawer: $('drawer'),
  scrim: $('scrim'),
  sessionList: $('session-list'),
  settings: $('settings'),
  testResult: $('test-result'),
  usage: $('usage-line'),
  gallery: $('gallery'),
  wardrobe: $('wardrobe'),
  reveal: $('reveal'),
  viewer: $('viewer'),
  petpage: $('petpage'),
}

let settings = null
let sessionId = null
/*
 * 发送后是否收起键盘。从设置同步过来，onSend 里要用，
 * 每次读 settings.collapseInputOnSend 也行，但那是异步对象、
 * 频繁读不如缓存一个布尔值清晰。
 */
let suppressKeyboardOnSend = true
let pendingImages = []
let streaming = false
let abortCtrl = null
let lastError = ''

/* ---------- 工具 ---------- */

function fmtTime(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 取消息的纯文本 / 图片（兼容字符串与内容块两种形态） */
const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''))
const imagesOf = (m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'image_url').map((b) => b.image_url.url) : [])

function scrollToBottom() {
  /* 等一帧再滚，否则新消息的高度还没算进去 */
  requestAnimationFrame(() => {
    el.msgs.scrollTop = el.msgs.scrollHeight
  })
}

/**
 * 轻提示（成功类）。和 showError 分开：错误要显眼（红条、留 6 秒），
 * 成功提示一闪而过就行，用同一套会让人误以为出错了。
 */
function toast(msg) {
  let t = document.querySelector('.toast')
  if (!t) {
    t = document.createElement('div')
    t.className = 'toast'
    document.body.appendChild(t)
  }
  t.textContent = msg
  clearTimeout(toast._t)
  /* 加 class 触发过渡（先移除再加，连点两次也能重放动画） */
  t.classList.remove('on')
  void t.offsetWidth
  t.classList.add('on')
  toast._t = setTimeout(() => t.classList.remove('on'), 2200)
}

function showError(msg) {
  lastError = msg
  let bar = document.querySelector('.err-bar')
  if (!bar) {
    bar = document.createElement('div')
    bar.className = 'err-bar'
    el.msgs.parentElement.insertBefore(bar, el.msgs.nextSibling)
  }
  bar.textContent = msg
  clearTimeout(showError._t)
  showError._t = setTimeout(() => bar.remove(), 6000)
}

/* ---------- 渲染 ---------- */

function renderMessage(m) {
  const wrap = document.createElement('div')
  wrap.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant') + (m.error ? ' error' : '')

  const bubble = document.createElement('div')
  bubble.className = 'bubble'

  const imgs = imagesOf(m)
  if (imgs.length) {
    const box = document.createElement('div')
    box.className = 'bubble-images'
    for (const src of imgs) {
      const img = document.createElement('img')
      img.src = src
      img.loading = 'lazy'
      img.addEventListener('click', () => openLightbox(src))
      box.appendChild(img)
    }
    bubble.appendChild(box)
  }
  const t = textOf(m)
  if (t) bubble.appendChild(document.createTextNode(t))

  wrap.appendChild(bubble)
  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = fmtTime(m.createdAt)
  wrap.appendChild(time)
  return wrap
}

function renderMessages(list) {
  el.msgs.innerHTML = ''
  for (const m of list) el.msgs.appendChild(renderMessage(m))
  el.empty.style.display = list.length ? 'none' : ''
  scrollToBottom()
}

/** 流式中的临时气泡（不落库，收到完整回复后替换） */
let liveNode = null
function setLive(text) {
  if (!liveNode) {
    liveNode = document.createElement('div')
    liveNode.className = 'msg assistant'
    const b = document.createElement('div')
    b.className = 'bubble'
    liveNode.appendChild(b)
    el.msgs.appendChild(liveNode)
  }
  liveNode.firstChild.textContent = text
  scrollToBottom()
}

function showTyping() {
  const n = document.createElement('div')
  n.className = 'msg assistant'
  n.id = 'typing'
  n.innerHTML = '<div class="bubble typing"><i></i><i></i><i></i></div>'
  el.msgs.appendChild(n)
  scrollToBottom()
}
const hideTyping = () => $('typing')?.remove()

function openLightbox(src) {
  const box = document.createElement('div')
  box.className = 'lightbox'
  const img = document.createElement('img')
  img.src = src
  box.appendChild(img)
  box.addEventListener('click', () => box.remove())
  document.body.appendChild(box)
}

/* ---------- 详情弹层（回看图鉴里的某一项） ---------- */

/*
 * 与 `showReveal` 的分工：
 *   - `showReveal` 是**解锁瞬间**的一次性提示（带「收下」按钮，看过就关）
 *   - 这里是**随时回看**：可以翻页看多张、设为背景、加入轮换池
 *
 * 两者共用一个 DOM 的话，「收下」这种一次性语义会污染回看场景
 * （回看时冒出个「收下」按钮很怪）。所以各有一套 DOM。
 */

/** 当前正在看的项 */
let viewing = {
  kind: '',
  slug: '',
  title: '',
  line: '',
  /* 这一项实际存在的图（服饰照片可能有多张） */
  images: [],
  index: 0,
}

/**
 * 打开详情。
 *
 * @param {object} item
 * @param {string} item.kind  'outfit' | 'photo' | 'video'
 * @param {string} item.slug
 * @param {string} [item.title]
 * @param {string} [item.line]  触发时她说的那句
 */
function openViewer({ kind, slug, title = '', line = '' }) {
  if (!slug) return
  /*
   * 服饰且**一张照片都没有**时，退回立绘展示 —— 否则详情页是空的，
   * 而用户在换装面板点「详情」就是想看看这套长什么样。
   * 照片存在的话优先给照片（那是「她发来的」观感，信息量也更大）。
   */
  const images = kind === 'video' ? [] : photosFor(kind, slug)
  if (!images.length && kind === 'outfit') images.push(outfitImgRel(slug))
  viewing = {
    kind,
    slug,
    title: title || outfitName(slug),
    line,
    images,
    index: 0,
  }

  const vid = $('viewer-video')
  const img = $('viewer-img')
  const isVideo = kind === 'video'

  $('viewer-title').textContent = viewing.title
  $('viewer-line').textContent = line || ''

  if (isVideo) {
    pauseViewerVideo()
    img.hidden = true
    img.removeAttribute('src')
    vid.hidden = false
    vid.poster = videoPoster(slug, OUTFIT_VER)
    vid.src = videoSrc(slug, OUTFIT_VER)
    $('viewer-count').textContent = ''
    $('viewer-tools').hidden = true
    setNav(false, false)
  } else {
    pauseViewerVideo()
    vid.hidden = true
    vid.removeAttribute('src')
    img.hidden = false
    renderViewerImage()
    $('viewer-tools').hidden = false
  }

  el.viewer.hidden = false
}

/** 按 viewing.index 显示当前那张，并更新翻页按钮与工具条状态 */
function renderViewerImage() {
  const img = $('viewer-img')
  const list = viewing.images
  const n = list.length

  if (!n) {
    /* 没有图（还没探测到 / 生成缺失）—— 别显示裂图 */
    img.removeAttribute('src')
    $('viewer-count').textContent = '照片还没有生成好'
    setNav(false, false)
    $('btn-viewer-bg').hidden = true
    $('btn-viewer-pool').hidden = true
    return
  }

  /* 索引取模：翻到头就绕回去，不用禁用手势 */
  const i = ((viewing.index % n) + n) % n
  viewing.index = i
  const rel = list[i]
  img.src = `${rel}?v=${OUTFIT_VER}`

  $('viewer-count').textContent = n > 1 ? `${i + 1} / ${n}` : ''
  setNav(n > 1, n > 1)

  /*
   * 工具条按当前这张的状态回填。
   * 「设为背景」只对**这一张**生效，所以翻页时要跟着变。
   */
  const bgBtn = $('btn-viewer-bg')
  const poolBtn = $('btn-viewer-pool')
  bgBtn.hidden = false
  poolBtn.hidden = false
  bgBtn.textContent = settings.chatBgMode === 'fixed' && settings.chatBackground === rel ? '取消背景' : '设为背景'
  bgBtn.classList.toggle('on', settings.chatBgMode === 'fixed' && settings.chatBackground === rel)
  const inPool = (settings.chatBgPool ?? []).includes(rel)
  poolBtn.textContent = inPool ? '移出轮换' : '加入轮换'
  poolBtn.classList.toggle('on', inPool)
}

/** 翻页按钮的显隐 —— 单张时两个都藏起来 */
function setNav(showPrev, showNext) {
  $('viewer-prev').hidden = !showPrev
  $('viewer-next').hidden = !showNext
}

function pauseViewerVideo() {
  const vid = $('viewer-video')
  if (!vid) return
  try {
    vid.pause()
    vid.currentTime = 0
  } catch {
    /* 元数据没加载好时设 currentTime 会抛，忽略 */
  }
}

function closeViewer() {
  pauseViewerVideo()
  el.viewer.hidden = true
  viewing = { kind: '', slug: '', title: '', line: '', images: [], index: 0 }
}

/* ---------- 会话 ---------- */

async function refreshStatus() {
  const st = await configStatus(settings)
  el.status.textContent = st.ready ? settings.chatModel : st.reason
  const personas = await allPersonas()
  const p = personas.find((x) => x.id === settings.chatPersona)
  el.personaName.textContent = p?.label ?? 'Yuki'
  el.send.disabled = !st.ready || streaming
  return st
}

async function ensureSession() {
  const list = await db.listSessions()
  if (list.length) return list[0]
  return db.createSession()
}

async function openSession(id) {
  sessionId = id
  openSessionId = id
  const list = await db.listMessages(id)
  renderMessages(list)
  await refreshSessions()
}

async function refreshSessions() {
  const list = await db.listSessions()
  el.sessionList.innerHTML = ''
  for (const s of list) {
    const li = document.createElement('li')
    li.className = 'session-item' + (s.id === sessionId ? ' active' : '')
    const n = await db.countMessages(s.id)
    li.innerHTML = `<div style="min-width:0"><div class="t"></div><div class="m">${n} 条 · ${fmtTime(s.updatedAt)}</div></div>
      <button class="session-del" aria-label="删除">🗑</button>`
    li.querySelector('.t').textContent = s.title
    li.addEventListener('click', async (e) => {
      if (e.target.classList.contains('session-del')) {
        if (!confirm(`删除「${s.title}」？`)) return
        await db.deleteSession(s.id)
        const rest = await db.listSessions()
        await openSession(rest.length ? rest[0].id : (await db.createSession()).id)
        return
      }
      closeDrawer()
      await openSession(s.id)
    })
    el.sessionList.appendChild(li)
  }
}

/*
 * 抽屉与设置面板互斥。
 *
 * 之前两者可以同时打开：设置面板底部弹出、抽屉从左侧滑出，
 * 而 scrim（遮罩）只归抽屉管 —— 结果是「两层叠在一起，点哪都关不掉」
 * （用户实测截图）。
 *
 * 现在统一走这两个函数：开一个必关另一个，遮罩跟着谁开着就显示谁。
 */
const openDrawer = () => {
  el.settings.hidden = true
  el.drawer.hidden = false
  el.scrim.hidden = false
}
const closeDrawer = () => {
  el.drawer.hidden = true
  /* 只有设置也没开时才收遮罩 */
  if (el.settings.hidden) el.scrim.hidden = true
}

/* ---------- 图片 ---------- */

/**
 * 压缩后转 data URL。
 *
 * 原图动辄几 MB，base64 还要膨胀 33%，而官方对图片只按尺寸折算 token，
 * 超出部分本来就会被丢掉 —— 压到长边 1280 既不损失模型能用的信息，
 * 又把存储和请求体控制在合理范围（手机流量也友好）。
 */
async function fileToDataUrl(file) {
  if (file.type === 'image/gif') return readAsDataUrl(file)
  const bitmap = await createImageBitmap(file)
  let { width, height } = bitmap
  const scale = Math.min(1, 1280 / Math.max(width, height))
  width = Math.round(width * scale)
  height = Math.round(height * scale)
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff' /* 透明图铺白底，否则转 JPEG 后变黑 */
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()
  return c.toDataURL('image/jpeg', 0.82)
}

const readAsDataUrl = (file) =>
  new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(new Error('读取图片失败'))
    fr.readAsDataURL(file)
  })

async function addFiles(files) {
  const list = [...(files ?? [])].filter((f) => f && /^image\//i.test(f.type))
  if (!list.length) return
  const room = 4 - pendingImages.length
  if (room <= 0) return showError('一条消息最多 4 张图')
  for (const f of list.slice(0, room)) {
    try {
      pendingImages.push(await fileToDataUrl(f))
    } catch (err) {
      showError('这张图读不了：' + (err?.message ?? err))
    }
  }
  renderPending()
}

function renderPending() {
  el.pending.hidden = pendingImages.length === 0
  el.pending.innerHTML = ''
  pendingImages.forEach((src, i) => {
    const d = document.createElement('div')
    d.className = 'pending-item'
    const img = document.createElement('img')
    img.src = src
    const btn = document.createElement('button')
    btn.className = 'pending-del'
    btn.textContent = '✕'
    btn.addEventListener('click', () => {
      pendingImages.splice(i, 1)
      renderPending()
    })
    d.append(img, btn)
    el.pending.appendChild(d)
  })
}

/* ---------- 发送 ---------- */

async function onSend() {
  const text = el.input.value.trim()
  const images = [...pendingImages]
  if ((!text && !images.length) || streaming) return

  el.input.value = ''
  el.input.style.height = 'auto'
  pendingImages = []
  renderPending()

  /*
   * 发送后收起输入框（连带收起 iOS 键盘）。
   *
   * 用 blur() 而不是改样式：iOS 上只有失焦才会真正落键盘，
   * 单纯缩短高度键盘还在，用户还得手动点一下才能看回复。
   *
   * 只在**确实有焦点**时才 blur —— 否则会影响「连续发几条」的体验：
   * 用户点发送按钮时如果本来就没聚焦（比如刚点了别处），
   * 无谓的 blur 会把他从别的操作里打断。
   */
  if (suppressKeyboardOnSend && document.activeElement === el.input) {
    el.input.blur()
  }

  streaming = true
  el.send.hidden = true
  el.stop.hidden = false
  abortCtrl = new AbortController()
  showTyping()

  const res = await sendMessage({
    settings,
    sessionId,
    text,
    images,
    signal: abortCtrl.signal,
    onDelta: (full) => {
      hideTyping()
      setLive(full)
    },
  })

  hideTyping()
  liveNode = null
  streaming = false
  el.stop.hidden = true
  el.send.hidden = false
  abortCtrl = null

  if (res.sessionId && res.sessionId !== sessionId) sessionId = res.sessionId

  /* 用户消息可能因为失败没落库，统一从库里重读，避免界面与数据不一致 */
  await openSession(sessionId)
  if (!res.ok && !res.aborted) showError(res.reason)

  /*
   * 解锁了新装扮：先把立绘刷新，再弹「她发来的照片」。
   * 顺序重要 —— 弹窗背后顶部的立绘也应该是新的那套。
   */
  /* 每条消息都会动亲密度，刷新它 */
  await refreshAffinity()

  if (res.unlocked) {
    /*
     * 照片**作为一条真实消息**写进聊天记录（像微信里对方发图那样），
     * 这样往上翻还能重新看到；弹窗只是额外的即时提示。
     *
     * 顺序：先落库并重渲染，再弹窗 —— 弹窗盖在聊天记录之上，
     * 用户关掉弹窗就能看到那条消息在下面。
     */
    await appendUnlockPhoto(sessionId, res.unlocked)
    await refreshPetStrip()
    showReveal(res.unlocked)
  }
}

/**
 * 把解锁到的照片作为一条她的消息插入聊天记录。
 *
 * 只在**装扮**类且**照片确实存在**时插：
 *   - 视频有自己的播放器，不走这条
 *   - 背景图是氛围设置，不是「她发来的东西」
 *   - 没有照片时不插 —— 只剩一句配文会像她突然说了句没头没尾的话
 *     （弹窗那边会自动退回立绘展示，聊天记录保持干净）
 *
 * @returns {Promise<boolean>} 是否插入成功
 */
async function appendUnlockPhoto(sessionId, unlocked) {
  try {
    const kind = unlocked?.kind
    if (kind !== 'outfit' && kind !== 'photo') return false
    const slug = unlocked.slug
    if (!slug) return false

    const paths = photosFor(kind, slug)
    if (!paths.length) return false

    const story = kind === 'photo' ? PHOTO_STORIES[slug]?.title : OUTFIT_STORIES[slug]?.story
    const parts = buildPhotoMessages(unlocked.line || story || '', paths)

    /*
     * 先全部落库（时间戳递增，保证顺序），再**逐条**显示。
     *
     * 顺序不能反过来：先落库再延迟渲染，用户中途切走会话也不会丢消息
     * （重进会话时 `openSession` 会全量重读，全都还在）。
     * 若边落库边渲染，切走时定时器会被清掉，剩下的消息就永远不出现。
     */
    const base = Date.now()
    const saved = []
    for (const part of parts) {
      saved.push(await db.addMessage(sessionId, 'assistant', part.content, { createdAt: base + part.offsetMs }))
    }

    /*
     * 逐条渲染 —— 像她一条条发过来。
     *
     * 用局部 append 而不是 openSession 全量重渲染：
     * 全量重渲染会重建所有节点（图片重新解码），
     * 而且每延迟一条就重来一次，观感是整屏闪。
     */
    for (let i = 0; i < saved.length; i++) {
      if (i > 0) await sleep(parts[i].delayMs)
      /* 期间用户可能切了会话 —— 那就不往当前列表里塞 */
      if (sessionId !== currentOpenSessionId()) break
      el.msgs.appendChild(renderMessage(saved[i]))
      scrollToBottom()
    }
    /*
     * 最后补一次全量刷新：让会话列表的条数、时间跟着更新。
     * 不做的话侧边栏的「N 条」会停在旧值。
     */
    await refreshSessions()
    return true
  } catch (e) {
    console.warn('[unlock-photo] 插入失败', e)
    return false
  }
}

/** 当前打开的会话 id（延迟渲染期间要判断用户有没有切走） */
let openSessionId = ''
function currentOpenSessionId() {
  return openSessionId
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 立绘常驻 + 图鉴 ---------- */

/**
 * 自拍照片路径（解锁装扮时弹出的「她发来的照片」）。
 *
 * 一套装扮对应一张照片；**照片可以分批补**，没生成过的那些
 * 会退化成用立绘兜底（见 `revealPhotoSrc`）——
 * 宁可弹一张立绘，也不要弹一个裂图。
 */
/*
 * 照片路径由 shared 的 photoCandidates / photoPathAt 提供，
 * 不在这里另写一份 —— 弹窗、聊天消息两处都要用，
 * 各写一份迟早会不一致（表现为「弹窗有图但聊天记录是裂图」）。
 * 版本串只在渲染时加：消息内容要落库，存成带 ?v= 会让
 * 「同一张图」在不同版本下变成不同字符串。
 */

/**
 * 相册里已备好的照片路径（`photos/yuki-photo-<slug>[-N].png`）。
 *
 * 启动时探一次：用 `Image` 预加载，加载成功才算「有」。
 * 为什么不靠构建时写死的清单：照片是分批生成的，清单要跟着改；
 * 而浏览器本来就会把 404 的图片缓存住，探测成本极低。
 *
 * 存**路径**而不是 slug —— 一套装扮可能有多张照片，
 * 只记 slug 就没法知道「到底有哪几张」。
 */
const availablePhotos = new Set()

async function probePhotos() {
  /*
   * 探测目标 = 服饰照片 + 生活照。
   * 生活照用的是不同的命名空间（`photos/life/gNN-N.png`），
   * 走 shared 的 photoPathsOf 分派，不在这里另写规则。
   */
  const targets = [
    ...Object.keys(OUTFIT_STORIES).flatMap((slug) => photoPathsOf('outfit', slug)),
    ...PHOTO_SLUGS.flatMap((slug) => photoPathsOf('photo', slug)),
  ]
  const jobs = targets.map(
    (rel) =>
      new Promise((resolve) => {
        const img = new Image()
        img.onload = () => {
          availablePhotos.add(rel)
          resolve()
        }
        img.onerror = () => resolve()
        img.src = `${rel}?v=${OUTFIT_VER}`
      }),
  )
  await Promise.all(jobs)
}

/** 该类目下该 slug 实际存在的所有照片路径（按序号） */
function photosFor(kind, slug) {
  return photoPathsOf(kind, slug).filter((rel) => availablePhotos.has(rel))
}

/** 取解锁弹窗该显示哪张图：优先照片（第 1 张），没有就退回立绘 */
function revealPhotoSrc(kind, slug) {
  const list = photosFor(kind, slug)
  if (!list.length) return kind === 'photo' ? '' : outfitImg(slug)
  return `${list[0]}?v=${OUTFIT_VER}`
}

/**
 * 把当前设置里的背景应用到消息区。
 *
 * 用 CSS 变量 + `background-image` 而不是塞一个 `<img>`：
 * 背景要**跟着消息区一起滚动**（`background-attachment: local`），
 * 单独一个 img 会浮在内容上层挡着点击。
 *
 * 透明度走 CSS 变量（`--bg-opacity`），因为透明度不能只压背景图 ——
 * 照片亮的地方文字会糊，得靠 `.msgs::before` 那层半透明遮罩压暗。
 * 具体见 style.css 的 `.msgs.has-bg`。
 *
 * 未解锁或文件缺失时回落默认（不设背景），不让界面变花。
 */
function applyChatBackground() {
  /*
   * 背景源 = **任何已解锁的照片**（服饰照片 / 生活照都行）。
   * 早先有个独立的「背景图」类目，但它只有一张占位图、也没素材 ——
   * 现在直接用她发过的照片，选择面更广，也不需要另做素材。
   *
   * 「此刻该用哪张」由 shared 的 pickChatBackground 算 ——
   * 两端共用同一份逻辑，否则同一时刻 PC 和手机会显示不同的图
   * （它们读同一份 settings，相位不一致看起来就是「背景在乱跳」）。
   *
   * 存在性判定传 `availablePhotos`：手机端的图要先探测过才敢用，
   * 否则会设成一张裂图背景。
   */
  const pick = pickChatBackground({
    mode: settings.chatBgMode,
    fixed: settings.chatBackground,
    pool: settings.chatBgPool ?? [],
    available: (p) => availablePhotos.has(p),
    rotateMin: settings.chatBgRotateMin,
  })

  if (!pick) {
    el.msgs.classList.remove('has-bg')
    el.msgs.style.removeProperty('--bg-image')
    return
  }
  const opacity = Math.min(0.85, Math.max(0.05, Number(settings.chatBgOpacity) || 0.25))
  el.msgs.style.setProperty('--bg-image', `url("${pick}?v=${OUTFIT_VER}")`)
  el.msgs.style.setProperty('--bg-opacity', String(opacity))
  el.msgs.classList.add('has-bg')
}

/*
 * 轮换定时器。
 *
 * 只在**轮换模式**下跑：其他模式没有「下一张」的概念。
 * 间隔取自设置，但**不精确对齐到时间片边界** —— 那需要算出
 * 「距离下一个整片还有多久」，多一层复杂度，收益只是
 * 「换的时刻更整齐」。用固定间隔轮询已足够（差几十毫秒没人能察觉）。
 *
 * 取 30 秒作为下限轮询间隔：设置里最短是 5 分钟，
 * 30 秒轮询足以保证「最多晚 30 秒」换，开销可忽略。
 */
let bgRotateTimer = null

/**
 * 保存设置 —— 所有写入口都走这里。
 *
 * 包一层是为了**统一同步轮换定时器**：改了 `chatBgMode` / `chatBgPool`
 * 之后定时器要跟着开或关。散在每个调用点各写一次迟早会漏，
 * 而漏的表现是「开了轮换但不换」（定时器没起来，很难查）。
 */
async function saveSettings(patch) {
  const next = await saveSettingsRaw(patch)
  syncBgRotateTimer()
  /* 搭话开关/间隔改了要立刻重排 —— 否则要等下一轮才生效 */
  scheduleChatter()
  return next
}

function syncBgRotateTimer() {
  const wantRotate = settings.chatBgMode === ChatBackgroundMode.ROTATE && (settings.chatBgPool ?? []).length > 0
  if (!wantRotate) {
    if (bgRotateTimer) {
      clearInterval(bgRotateTimer)
      bgRotateTimer = null
    }
    return
  }
  if (bgRotateTimer) return
  bgRotateTimer = setInterval(() => {
    /* 页面不可见时不做事 —— 用户看不到，白算 */
    if (document.hidden) return
    applyChatBackground()
  }, 30_000)
}

/**
 * 聊天关键词触发的临时动作。
 *
 * 命中后把她切成对应姿势并**锁 5 秒**，之后自动回到常态
 * （穿着 / 挂机姿势）。5 秒是试出来的：短了看不清，
 * 长了下一句来了还在演上一个动作，显得迟钝。
 *
 * 用时间戳而不是 `setTimeout` 清状态：定时器和 `refreshPetStrip`
 * 的调用时机容易打架（比如她同时解锁了装扮，那边刷新会把动作顶掉）。
 * 时间戳是**唯一真相**，谁刷新都先看它有没有过期。
 */
let chatActionUntil = 0
let chatActionEmote = ''

function triggerChatAction(text) {
  const emote = chatActionFor(text)
  if (!emote) return
  chatActionEmote = emote
  chatActionUntil = Date.now() + 5000
  refreshPetStrip().catch(() => {})
  /* 到点自己刷新一次，不用调用方操心还原 */
  clearTimeout(chatActionTimer)
  chatActionTimer = setTimeout(() => {
    if (Date.now() >= chatActionUntil) {
      chatActionEmote = ''
      refreshPetStrip().catch(() => {})
    }
  }, 5100)
}
let chatActionTimer = null

/*
 * 点她的反馈**不换立绘**。
 *
 * 一开始做成了「点了切到某个表情立绘」，但那会把「她穿的那套」也换掉 ——
 * 用户花心思解锁的换装就白做了。
 * 改成纯视觉反馈：立绘抖一下 + 飘心 + 气泡台词，底图始终是她当前穿着的样子。
 */

/**
 * 全部可用的动作立绘（24 张）。
 *
 * ## 为什么要列出来而不是「看着办」
 *
 * 之前 `mobilePose` 按时段返回 2~6 张的小池子 —— 本意是「深夜不该蹦跳」，
 * 但结果是**一天里反复看到那几张**，立绘像是卡住了。
 * 用户明确要求「在这 24 张里轮换」，所以这里给全量清单，
 * 昼夜偏好改为**加权**（见 `pickPetPose`）而不是硬过滤。
 *
 * 顺序按「日常 → 情绪」排，不是随机 —— 洗牌袋会打乱，
 * 这里只保证清单稳定且可读。
 */
const ALL_POSES = [
  'pose1', 'pose2', 'pose3', 'pose4',
  'think', 'coffee', 'snack', 'music', 'read',
  'yawn', 'sleep', 'stretch', 'nod', 'wave',
  'heart', 'shy', 'laugh', 'clap', 'thumbsup', 'jump',
  'surprise', 'shrug', 'angry', 'cry',
]

/**
 * 不该在深夜出现的动作 —— 深夜出现会显得很假（凌晨三点在蹦跳）。
 * 这不是硬性禁止，只是**降低权重**：偶尔出现也无妨，但不该占多数。
 */
const NIGHT_UNLIKELY = new Set(['jump', 'clap', 'laugh', 'thumbsup', 'wave'])
/** 白天不太该出现的（一直打瞌睡看着像生病） */
const DAY_UNLIKELY = new Set(['sleep'])

/**
 * 挑一个动作立绘。
 *
 * ## 做法：按昼夜**筛出池子** + 池内洗牌袋
 *
 * 一开始写的是「加权」（不合适的动作也留在池里，只是多塞一份）。
 * 实测那样会**把一轮拉长到 47 次**（24 张 + 23 个双份）——
 * 表现为「连着十几分钟看到的都是重复的几张」，因为一轮根本走不完。
 *
 * 改成先按昼夜过滤、再在池内洗牌：
 *   - 一轮 = 池子大小（白天 23 张、深夜 19 张），**池内绝不重复**
 *   - 昼夜偏好是硬性的（深夜不会蹦跳），但池子仍然足够大
 *
 * 代价是深夜永远看不到那 5 张 —— 但凌晨三点在蹦跳本来就假，
 * 这个取舍是对的。
 *
 * @param {number} hour 当前小时
 */
function pickPetPose(hour) {
  const night = hour >= 22 || hour < 7
  const pool = ALL_POSES.filter((pose) => !(night ? NIGHT_UNLIKELY.has(pose) : DAY_UNLIKELY.has(pose)))
  /* 池子为空的兜底（理论上不会，两张表加起来才 6 张） */
  const safe = pool.length ? pool : ALL_POSES
  return pickFromBag(safe, `petpose:${night ? 'night' : 'day'}`)
}

/**
 * 刷新「她」的全屏页：立绘 + 状态文字。
 *
 * ## 立绘在「动作」和「穿着」之间交替
 *
 * 这两个是正交维度（服饰管穿什么、动作管在干什么），一张图没法同时表达。
 * 用**分钟**做相位（60 秒翻转）—— 配 30 秒的定时器，
 * 保证每次到点都能看到变化，又不会快到闪眼。
 *
 * ## 优先级
 *
 *   ① 关键词动作（`chatActionEmote`，5 秒内）—— 用户刚说了「哈哈哈」，
 *      这一下必须是笑的那张，不能被任何东西顶掉
 *   ② 动作相 / 服饰相交替
 *
 * （点她的反馈**不走这里** —— 那用 CSS 动画叠加，见 `playTapFx`。）
 */
async function refreshPetStrip() {
  /*
   * 两处显示同一份内容：
   *   - `#pet-img` + `#pet-outfit` + `#pet-note`：聊天页顶部的小条
   *   - `#petpage-pet` + `#petpage-note`：全屏页的大立绘
   *
   * 抽成「先算出该显示什么、再往两处写」，避免在两段几乎一样的
   * 代码里各改一遍（那正是会漏改的地方）。
   * 只要有一处存在就继续 —— 全屏页没打开时也有小条要刷。
   */
  const targets = [
    { img: $('pet-img'), note: $('pet-note'), name: $('pet-outfit'), withOutfit: true },
    { img: $('petpage-pet'), note: null, name: null, withOutfit: false },
  ].filter((t) => t.img)
  if (!targets.length) return

  const write = (poseFile, label, noteText) => {
    for (const t of targets) {
      t.img.src = poseFile
      /* 小条只显示她在干什么；全屏页额外显示穿了什么（下面拼） */
      if (t.note) t.note.textContent = noteText
      if (t.withOutfit && t.name) t.name.textContent = label
    }
    /* 全屏页顶部的状态区（立绘上方那块） */
    const doing = $('petpage-doing')
    if (doing) doing.textContent = label
    const meta = $('petpage-meta')
    if (meta) meta.textContent = noteText
  }

  /* ① 关键词动作（5 秒内）—— 用户刚说了「哈哈哈」，必须是笑的那张 */
  if (chatActionEmote && Date.now() < chatActionUntil) {
    const pose = chatActionEmote
    write(`poses/yuki-${pose}.png`, POSE_LABELS[pose] ?? '她', '正在回应你…')
    return
  }
  if (chatActionEmote) chatActionEmote = ''

  const unlocked = await db.listUnlockedOutfits()
  const hour = new Date().getHours()
  const total = Object.keys(OUTFIT_STORIES).length
  const totalVideo = Object.keys(VIDEO_STORIES).length
  const nVideo = (await db.listUnlocked('video')).length
  const progress = `装扮 ${unlocked.length}/${total} · 视频 ${nVideo}/${totalVideo}`

  /* ③ 动作相 / 服饰相交替 —— 两个正交维度，一张图表达不了两件事 */
  const phase = Math.floor(Date.now() / 60_000) % 2 === 0

  if (phase) {
    const pose = pickPetPose(hour)
    if (pose) {
      const label = POSE_LABELS[pose] ?? '她'
      /*
       * 第二行不能重复第一行。标题已经写了「在喝咖啡」，
       * 副标题再写一遍就是废话 —— 这里放**进度和时段**，
       * 才是用户看第二行想知道的事。
       */
      write(`poses/yuki-${pose}.png`, label, `${progress} · ${dayPart(hour)}`)
      return
    }
  }

  /* 服饰相：挑一套已解锁的 */
  let slug = null
  if (settings.outfitMode === 'fixed' && unlocked.includes(settings.outfitSlug)) {
    slug = settings.outfitSlug
  } else if (unlocked.length) {
    /* 深夜/清晨偏睡衣，白天偏便服 —— 与桌面端「自动换装」同一套意图 */
    const preferNight = hour >= 22 || hour < 7
    const pool = unlocked.filter((s) => {
      const isNight = /^pajamas/.test(s)
      return preferNight ? isNight : !isNight
    })
    const list = pool.length ? pool : unlocked
    slug = list[hour % list.length]
  }

  if (!slug) {
    /* 一套都没解锁（理论上不会，jk 是初始给的） */
    write('yuki-avatar.png', 'Yuki', progress)
    return
  }
  write(outfitImg(slug), outfitName(slug), `${progress} · ${dayPart(hour)}`)
}


/**
 * 打开全屏立绘页。
 *
 * 与其它弹层的互斥由这里手工处理（项目没有统一的层级栈，
 * 各处 `open*` 都是先关掉会挡路的那些）。
 */
/* ---------- 顶部信息栏（日期 / 时间 / 周末 / 打卡） ---------- */

/*
 * 时钟每 30 秒对一次。
 * 一秒一次是浪费（只显示到分钟），而严格 60 秒对会让「分钟跳变」
 * 最多延迟 1 秒 —— 30 秒一次既准又不费电。
 */
let clockTimer = null

/*
 * 只在节日**临近**时才把信息栏让给它。
 *
 * 不判断的话，「离春节 140 天」会常年霸占那一行 ——
 * 大多数时候用户更想知道的是「还有几天到周末」。
 * 7 天是个经验值：一周内才让人有「快到了」的感觉。
 */
const HOLIDAY_SHOW_WITHIN_DAYS = 7

function nearHoliday(now) {
  const info = holidayOf(now)
  /* 今天/明天就是节日 —— 无条件显示 */
  if (info?.isHoliday) return true
  const next = holidayCountdownText(now)
  const m = /(\d+) 天\$/.exec(next)
  return m ? Number(m[1]) <= HOLIDAY_SHOW_WITHIN_DAYS : true
}

function startClock() {
  if (clockTimer) return
  const tick = () => {
    const now = new Date()
    const d = $('pinfo-date')
    if (d) d.textContent = formatDate(now)
    const c = $('pinfo-clock')
    if (c) c.textContent = formatClock(now)
    /*
     * 周末倒计时只在**跨天**时才变，但每分钟重算一次的成本可以忽略
     * （纯字符串拼接），不值得为它单独排一个午夜定时器
     * （那个还要处理时区/时钟回拨，更麻烦）。
     */
    const w = $('pinfo-weekend')
    if (w) {
      /*
       * 优先显示**节日倒计时** —— 它比「离周末还有几天」更有信息量，
       * 而且只在快到时才值得占位置。
       *
       * 但「今天是节日」和「明天是节日」都要显示，此时不再看周末；
       * 没有临近节日时才退回周末倒计时。
       */
      const holiday = holidayCountdownText(now)
      w.textContent = holiday && nearHoliday(now) ? holiday : weekendText(now)
    }
  }
  tick()
  clockTimer = setInterval(tick, 30_000)
  /*
   * 从后台回来要立刻对一次 —— 手机冻结定时器期间时间已经走过去了，
   * 不补这一下会显示离开时的旧时间（用户会觉得「时间停了」）。
   */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick()
  })
}

/*
 * 打卡记录存 meta，键 `checkinDays`：`YYYY-MM-DD` 的数组。
 *
 * 为什么不建新表：IndexedDB 加 objectStore 要改版本号、处理
 * onupgradeneeded，而这份数据就是「一串日期」—— 一个数组完全够，
 * 读写也只有全量替换，不涉及并发。
 */
const CHECKIN_KEY = 'checkinDays'

async function readCheckinDays() {
  const raw = await db.getMeta(CHECKIN_KEY, [])
  return Array.isArray(raw) ? raw : []
}

/** 刷新打卡按钮与天数显示 */
async function refreshCheckin() {
  const days = await readCheckinDays()
  const st = checkinStatus({ days })

  const btn = $('btn-checkin')
  const label = $('pinfo-days')
  if (btn) {
    btn.textContent = st.today ? '已打卡' : '打卡'
    /* `done` 类只改样式；按钮仍可点（重复点静默忽略，不弹错） */
    btn.classList.toggle('done', st.today)
  }
  if (label) {
    label.textContent = st.today ? `已连续 ${st.streak} 天` : st.total ? `累计 ${st.total} 天` : ''
  }
}

/**
 * 打卡。
 *
 * 重复打卡**静默忽略**（不弹「今天已经打过」）——
 * 按钮点完就变成「已打卡」态，再点本来就不该发生；
 * 真发生了说明是误触，弹提示反而吵。
 */
async function onCheckin() {
  const days = await readCheckinDays()
  const today = toDateKey(new Date())
  if (days.includes(today)) return

  /*
   * 全量替换而不是 push 后写回 —— 整体覆盖，不存在
   * 「读到旧的再写回」把并发更新冲掉的问题（这份数据只有这一处写）。
   */
  await db.setMeta(CHECKIN_KEY, [...days, today])
  await refreshCheckin()

  /* 打卡是个有仪式感的动作，光数字变一下太静了 */
  playTapFx('double')
  showBubble('今天也来啦～')
}

/* ---------- 立绘页背景 ---------- */

/*
 * 可用的背景（场景空镜，无人物的那四张）。
 *
 * 放在 `public/bg/` 而不是复用 `photos/life/` 里那几张：
 * 那几个文件**是有人物的**（她坐在书桌前、在玄关系鞋带…），
 * 拿来当立绘页背景会和前景的立绘打架 —— 屏幕上出现两个「她」。
 */
const PET_BACKGROUNDS = ['bg/desk.png', 'bg/entry.png', 'bg/metro.png', 'bg/store.png']

/**
 * 应用背景。
 *
 * @param {number} index 背景序号（会取模，越界不报错）
 */
function applyPetBackground(index) {
  const bg = $('petpage-bg')
  const dim = $('petpage-bg-dim')
  if (!bg) return

  /*
   * 允许 -1 表示「不要背景」。
   * 用取模的话 -1 会变成最后一张，所以先单独判。
   */
  if (index < 0 || !PET_BACKGROUNDS.length) {
    bg.classList.remove('on')
    dim?.classList.remove('on')
    return
  }

  const i = index % PET_BACKGROUNDS.length
  /*
   * 图片挂在 **CSS 变量**上而不是 bg.style.backgroundImage ——
   * 真正的图是画在 `.petpage-bg::before` 里的（为了做模糊+放大盖边缘），
   * 伪元素取不到 JS 的元素引用，只能用变量把 URL 传进去。
   */
  bg.style.setProperty('--pet-bg', `url("${PET_BACKGROUNDS[i]}?v=${OUTFIT_VER}")`)
  bg.classList.add('on')
  dim?.classList.add('on')
}

/**
 * 切到下一张背景。
 *
 * 循环 4 张。存进 settings 而不是只放内存 ——
 * 用户挑中某张后，下次打开应该还在那张，而不是跳回第一张。
 */
async function cyclePetBackground() {
  const cur = Number(settings.petBackground) || 0
  const next = (cur + 1) % PET_BACKGROUNDS.length
  settings = await saveSettings({ petBackground: next })
  applyPetBackground(next)
  toast(`背景 ${next + 1}/${PET_BACKGROUNDS.length}`)
}

async function openPetPage() {
  closeDrawer()
  el.settings.hidden = true
  el.gallery.hidden = true

  el.petpage.hidden = false
  /* 打开时立刻刷一次 —— 等 30 秒的 ticker 才更新会看到旧图 */
  await refreshPetStrip()
  await refreshAffinity()
  refreshCheckin().catch(() => {})
  applyPetBackground(Number(settings.petBackground) || 0)
  /*
   * 顺手判断「是不是很久没点她了」，决定用哪套点击台词。
   * 放这里而不是点击时算：点击要立刻反应，读 IndexedDB 是异步的，
   * 会拖慢第一声回应。
   */
  await refreshReturnState()
}

const closePetPage = () => {
  el.petpage.hidden = true
  hideBubble()
  /* 顺手收起 ⋯ 菜单 —— 不然下次进来它还开着 */
  const menu = $('petpage-menu')
  if (menu) menu.hidden = true
}

/**
 * 上次点她的时间 —— 用来判断「你终于想起我了」那套台词。
 *
 * 存 meta（IndexedDB），不用内存变量：页面刷新后仍要知道
 * 「她等了你多久」，否则每次刷新都从头计时。
 */
async function refreshReturnState() {
  lastTapAt = await db.getMeta('lastTapAt', 0)
}

let lastTapAt = 0

/** 超过这个时长没点她 → 用「你回来了」那套台词 */
const RETURN_AFTER_MS = 10 * 60 * 1000

/**
 * 在立绘上方显示一句话。
 *
 * 用独立的隐藏/显示而不是插进 DOM 再删：反复创建销毁节点
 * 会让气泡的进入动画每次都重放，看起来在闪。
 */
let bubbleTimer = null
function showBubble(text) {
  const box = $('petpage-bubble')
  if (!box || !text) return
  box.textContent = text
  box.hidden = false
  /* 重新触发进场动画（同一个节点改内容不会自动重放） */
  box.style.animation = 'none'
  void box.offsetWidth
  box.style.animation = ''
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(hideBubble, 3200)
}

const hideBubble = () => {
  clearTimeout(bubbleTimer)
  const box = $('petpage-bubble')
  if (box) box.hidden = true
}

/**
 * 点她 —— 出反应。
 *
 * ## 三种点击
 *
 *   - 单击：`tap`，最常用
 *   - 双击：`double`，快两下
 *   - 长按/连续：`hold`，按住不放或点得飞快
 *
 * 「连续」用**点击间隔**判定（而不是真的监听长按）——
 * 手机上长按会触发系统手势（选中、放大、菜单），拦起来很脏。
 * 间隔 < 350ms 就算连续，效果一样但干净得多。
 *
 * ## 加亲密度
 *
 * `AFFINITY_GAIN` 里 click/double/pet 早就定义好了，但手机端从来没调用过
 * —— 现在接上。走 app.js 的 `saveSettings` 包装之外的另一条路径：
 * 亲密度有自己的 `bumpAffinity`（带日上限），直接用。
 */
async function onPetTap() {
  const now = Date.now()
  const gap = now - lastTapAt
  const kind = gap < 350 ? 'hold' : 'tap'

  lastTapAt = now
  await db.setMeta('lastTapAt', now)

  const a = await currentAffinity()
  const line = pickTapLine({ kind: gap > RETURN_AFTER_MS ? 'return' : kind, points: a.points ?? 0 })

  /* 视觉反馈：抖一下 + 飘心（**不换立绘**） */
  playTapFx(kind)
  showBubble(line)

  /* 加亲密度 —— 失败不影响互动（看不清进度条也得能点） */
  bumpAffinity(kind === 'hold' ? 'pet' : 'click').then(refreshAffinity).catch(() => {})
}

/** 双击：语义上比单击更进一步 */
async function onPetDoubleTap() {
  const now = Date.now()
  lastTapAt = now
  await db.setMeta('lastTapAt', now)

  const a = await currentAffinity()
  const line = pickTapLine({ kind: 'double', points: a.points ?? 0 })

  playTapFx('double')
  showBubble(line)
  bumpAffinity('double').then(refreshAffinity).catch(() => {})
}

/**
 * 点击的视觉反馈 —— 立绘抖一下 + 顶上飘几个心。
 *
 * ## 为什么不动立绘
 *
 * 早先的实现是「点了切到某个表情立绘」，但那会**把她穿的那套一起换掉**，
 * 用户解锁/挑选的换装就白做了。
 * 现在的做法只叠加动画层，底图始终是她当前穿着的样子 ——
 * 视觉上「有反应」，但不会和换装冲突。
 *
 * ## 三个元素各自的重置
 *
 * CSS 动画要**先移除类、强制重排、再加回**才会重放；
 * 直接重复加同一个类，第二次点击是没有任何反应的。
 */
function playTapFx(kind) {
  const img = $('petpage-pet')
  if (img) {
    img.classList.remove('tapped')
    /* 强制重排 —— 不加这一句，连续点击时动画不会重放 */
    void img.offsetWidth
    img.classList.add('tapped')
    /* 动画结束就摘掉，避免类一直挂着（那会永久覆盖呼吸动画） */
    setTimeout(() => img.classList.remove('tapped'), 380)
  }

  const fx = $('petpage-fx')
  if (!fx) return

  /*
   * 飘心数量按点击强度给：单击 1 个、双击 3 个、连续摸 4 个。
   * 位置在立绘中部随机散开 —— 固定在头顶会显得像「冒汗」。
   */
  const n = kind === 'double' ? 3 : kind === 'hold' ? 4 : 1
  const glyphs = kind === 'hold' ? ['💫', '✨', '💗'] : ['💗', '💕', '✨']
  for (let i = 0; i < n; i++) {
    const span = document.createElement('span')
    span.textContent = glyphs[Math.floor(Math.random() * glyphs.length)]
    span.style.left = `${34 + Math.random() * 32}%`
    span.style.top = `${34 + Math.random() * 20}%`
    /* 错开出现时间，一次性全冒出来像贴纸 */
    span.style.animationDelay = `${i * 90}ms`
    fx.appendChild(span)
    /* 动画 1.1s + 延迟，到点自己移除（不清会越积越多） */
    setTimeout(() => span.remove(), 1300 + i * 90)
  }
}

/**
 * 让她说句话（按钮触发）。
 *
 * 与挂机自动搭话的区别：这个是**用户主动要她说**，
 * 所以不受「设置里开关是否打开」的限制 —— 关掉自动搭话
 * 只是别自己冒出来，不是禁止用户问。
 */
async function onAskHerToSpeak() {
  const btn = $('btn-petpage-say')
  if (btn) btn.disabled = true
  showBubble('……')
  try {
    const line = await generateChatterLine()
    showBubble(line || '嗯…我在的')
  } finally {
    if (btn) btn.disabled = false
  }
}

/**
 * 生成一句搭话台词（调模型，失败回落写死的短句）。
 *
 * @returns {Promise<string>}
 */
async function generateChatterLine() {
  try {
    const history = await db.recentMessages(sessionId, 20)
    const req = buildChatterRequest({ history })
    const raw = await completeOnce({
      settings,
      system: req.system,
      messages: req.messages,
      maxTokens: 80,
    })
    const line = cleanChatter(raw)
    if (line) return line
  } catch (e) {
    console.warn('[chatter] 生成失败', e)
  }
  return FALLBACK_CHATTER[Math.floor(Math.random() * FALLBACK_CHATTER.length)]
}

/* ---------- 主动搭话（挂机时她自己开口） ---------- */

/*
 * 默认**关**（`mobileProactive`）。开着时：
 *   到点了 → 调模型生成一句 → 同时做两件事：
 *     ① 在立绘页显示气泡（如果正开着）
 *     ② 落一条 assistant 消息进聊天记录
 *
 * 为什么要落记录：用户要求「两者都做」。
 * 只显示气泡的话，切走了就再也看不到了；落记录才像「她真的发了消息」。
 *
 * 只在前台跑（`document.hidden` 时不排下一轮）——
 * 手机后台会冻结定时器，硬排也没意义。
 */
let chatterTimer = null

function stopChatterTimer() {
  if (chatterTimer) {
    clearTimeout(chatterTimer)
    chatterTimer = null
  }
}

/**
 * 排下一轮主动搭话。
 *
 * 用 `setTimeout` 递归而不是 `setInterval`：每轮的间隔都不同（带抖动），
 * 而且要拿到「上一轮的结果」再决定下一次 —— interval 做不到。
 */
function scheduleChatter() {
  stopChatterTimer()
  if (!settings.mobileProactive) return

  const delay = nextChatterDelay({
    intervalMin: settings.mobileProactiveMin,
    voice: currentVoice,
  })
  chatterTimer = setTimeout(async () => {
    if (document.hidden) {
      /* 后台不搭话，回到前台再重新排（visibilitychange 里会调） */
      chatterTimer = null
      return
    }
    await speakProactively()
    scheduleChatter()
  }, delay)
}

/**
 * 她主动说一句 —— 显示 + 落记录。
 */
async function speakProactively() {
  /*
   * 用户正在打字（或输入框有内容）时不打断 ——
   * 他已经在说话了，她抢先开口会显得很吵。
   */
  if ((el.input?.value ?? '').trim()) return
  /* 正在流式回复中也不插队 */
  if (streaming) return

  const line = await generateChatterLine()
  if (!line) return

  /* ① 立绘页开着就显示气泡 */
  if (!el.petpage?.hidden) showBubble(line)

  /* ② 落一条消息进当前会话 */
  try {
    const msg = await db.addMessage(sessionId, 'assistant', line)
    await openSession(sessionId)
    lastProactiveAt = Date.now()
    /* 落到别的会话时刷新列表，让侧栏的排序/摘要跟上 */
    await refreshSessions()
    return msg
  } catch (e) {
    console.warn('[chatter] 落库失败', e)
  }
}

/** 上次主动开口的时间 —— 用于「刚说完就别急着再说」 */
let lastProactiveAt = 0

/** 她此刻的关系档（给搭话间隔做「越熟越黏」的倍率） */
let currentVoice = 'familiar'

/**
 * 刷新关系档 —— 亲密度变了就跟着变。
 * 只缓存一个字符串，避免每轮搭话都去读一次 IndexedDB。
 */
async function refreshVoice() {
  try {
    const a = await currentAffinity()
    currentVoice = a?.level?.voice ?? 'familiar'
  } catch {
    /* 取不到就用默认档，不影响搭话本身 */
  }
}

/**
 * 刷新亲密度显示。
 *
 * 单独一个函数而不是塞进 refreshPetStrip：亲密度在**每次发消息后**
 * 都要更新（那时立绘不一定换），两者触发时机不同。
 */
async function refreshAffinity() {
  try {
    const a = await currentAffinity()
    /*
     * 两处都要刷：聊天页顶部的小条、以及「她」的全屏页。
     * 用 querySelectorAll 而不是 getElementById —— 亲密度显示了两次，
     * id 是唯一的，只能靠 class 选择。
     */
    const fills = document.querySelectorAll('.affinity-fill')
    const texts = document.querySelectorAll('.affinity-text')
    if (!fills.length || !texts.length) return

    const pct = `${Math.round(a.progress)}%`
    const label = a.isMax
      ? `${a.level.name} · 已到顶（${a.points}）`
      : `${a.level.name} · 再 ${a.toNext} 点升级`

    for (const fill of fills) {
      fill.style.width = pct
      /* 到顶后进度条满格，用不同色调区分「已满」和「进行中」 */
      fill.dataset.max = a.isMax ? '1' : ''
    }
    for (const text of texts) text.textContent = label

    /* 关系档影响搭话间隔 —— 顺手更新，省一次 IndexedDB 读 */
    currentVoice = a?.level?.voice ?? currentVoice
  } catch {
    /* 亲密度显示失败不该影响其它 UI */
  }
}

const dayPart = (h) => (h < 12 ? '上午' : h < 18 ? '下午' : '晚上')

/** 动作的中文名，给顶部说明用 */
const POSE_LABELS = {
  snack: '在吃零食',
  music: '在听歌',
  think: '在想事情',
  yawn: '打了个哈欠',
  coffee: '在喝咖啡',
  shrug: '有点无奈',
  heart: '比了个心',
  surprise: '被惊到了',
  shy: '有点害羞',
  sleep: '在打瞌睡',
  wave: '在挥手',
  thumbsup: '赞',
  jump: '很高兴',
  angry: '有点生气',
  pose1: '趴着打盹',
  pose2: '在笑',
  pose3: '在歇着',
  pose4: '站着',
  stretch: '在伸懒腰',
  clap: '在拍手',
  read: '在看书',
  nod: '点了点头',
  laugh: '笑得很开心',
  cry: '有点难过',
  doze: '趴着发呆',
}

/**
 * 按时间挑一个动作。
 *
 * 深夜不该出现「蹦蹦跳跳」，早上不该「打瞌睡」——
 * 和服饰那边的昼夜逻辑保持一致，否则会出现
 * 「穿着睡衣却在跳」这种明显违和的组合。
 */
function mobilePose(hour) {
  const lateNight = hour >= 23 || hour < 6
  const earlyMorning = hour >= 6 && hour < 9
  const workHours = hour >= 9 && hour < 18
  const evening = hour >= 18 && hour < 23

  let pool
  if (lateNight) pool = ['sleep', 'yawn']
  else if (earlyMorning) pool = ['yawn', 'coffee', 'snack']
  else if (workHours) pool = ['think', 'coffee', 'snack', 'music']
  else if (evening) pool = ['music', 'heart', 'snack', 'shrug', 'read', 'pose3']
  else pool = ['pose4', 'snack', 'music', 'read', 'doze']

  /*
   * 按 5 分钟一档轮换动作池。
   * 用整分钟会每 60 秒就跳一个动作，太躁；5 分钟一换既稳定，
   * 配合服饰相的交替也足够让人看到变化。
   */
  return pool[Math.floor(Date.now() / 300_000) % pool.length]
}

/** slug -> 展示名（优先用故事标题，退回服饰 label） */
function outfitName(slug) {
  return OUTFIT_STORIES[slug]?.title ?? OUTFITS.find((o) => o.slug === slug)?.label ?? slug
}

async function openGallery() {
  closeDrawer()
  el.settings.hidden = true

  const [outfits, videos, photos] = await Promise.all([
    db.listUnlocked('outfit'),
    db.listUnlocked('video'),
    db.listUnlocked('photo'),
  ])
  const totalOutfit = Object.keys(OUTFIT_STORIES).length
  const totalVideo = Object.keys(VIDEO_STORIES).length
  const totalPhoto = Object.keys(PHOTO_STORIES).length
  $('gallery-count').textContent = `${outfits.length + videos.length + photos.length}/${totalOutfit + totalVideo + totalPhoto}`
  $('gallery-tip').textContent =
    outfits.length >= totalOutfit && videos.length >= totalVideo && photos.length >= totalPhoto
      ? '全部收集完成 —— 她愿意给你看的都在这了。'
      : '和她聊天时会自然地解锁 —— 聊到相关话题，她会主动发照片或视频给你。'

  const grid = $('gallery-grid')
  grid.innerHTML = ''

  /* 两组用同一段渲染逻辑，只在「产物类型」和「内容表」上分叉 */
  const groups = [
    {
      kind: 'outfit',
      label: '装扮',
      got: outfits,
      total: totalOutfit,
      table: OUTFIT_STORIES,
      mem: await db.listMemories('outfit'),
      thumb: (slug) => outfitImg(slug),
      /* 该组实际存在的照片路径 —— 背景选择要用（视频组没有） */
      photos: (slug) => photosFor('outfit', slug),
      empty: '还没有解锁任何装扮',
    },
    {
      kind: 'video',
      label: '视频',
      got: videos,
      total: totalVideo,
      table: VIDEO_STORIES,
      mem: await db.listMemories('video'),
      thumb: (slug) => videoPoster(slug, OUTFIT_VER),
      empty: '还没有解锁任何视频',
    },
    {
      kind: 'photo',
      label: '生活照',
      got: photos,
      total: totalPhoto,
      table: PHOTO_STORIES,
      mem: await db.listMemories('photo'),
      thumb: (slug) => `${photosFor('photo', slug)[0]}?v=${OUTFIT_VER}`,
      photos: (slug) => photosFor('photo', slug),
      empty: '还没有收到任何生活照',
    },
  ]

  for (const g of groups) {
    const head = document.createElement('p')
    head.className = 'g-group'
    head.innerHTML = `${g.label} <b>${g.got.length}/${g.total}</b>`
    grid.appendChild(head)

    for (const [slug, def] of Object.entries(g.table)) {
      const got = g.got.includes(slug)
      /* 正被用作背景的那张，角标提示要用到 —— 取这一格显示的具体路径 */
      const shownPath = g.kind === 'video' ? '' : (g.photos ?? (() => []))(slug)[0] ?? ''
      const d = document.createElement('div')
      d.className = 'g-item' + (got ? '' : ' locked') + (g.kind === 'video' ? ' g-video' : '')
      /*
       * 不用 loading="lazy"：图鉴在这个可滚动面板里，浏览器对
       * 「视口外但面板内」的懒加载判定不可靠 —— 实测滚到底仍有大量图不加载，
       * 呈现为图鉴里的空白格子。小图一次加载完更稳，
       * 而且这些都是本地同源资源，代价可接受。
       */
      d.innerHTML = `
        <img src="${g.thumb(slug)}" alt="" decoding="async" />
        ${got ? '' : '<span class="g-lock">?</span>'}
        ${got && g.kind === 'video' ? '<span class="g-play">▶</span>' : ''}
        <p class="g-title"></p>
        <p class="g-hint"></p>`
      /*
       * 角标：这一格里的图**正被用作聊天背景**时提示。
       * 固定模式比 `chatBackground`，轮换模式比池子 ——
       * 轮换时「当前显示的是哪张」随时在变，标出来会闪，
       * 所以改成标「在轮换池里」。
       */
      if (got && shownPath) {
        const onBg =
          (settings.chatBgMode === ChatBackgroundMode.FIXED && settings.chatBackground === shownPath) ||
          (settings.chatBgMode === ChatBackgroundMode.ROTATE &&
            (settings.chatBgPool ?? []).includes(shownPath))
        if (onBg) d.classList.add('g-on')
      }
      d.querySelector('.g-title').textContent = got ? def.title : '？？？'
      /* 已解锁：显示触发时她说的那句（记忆），而不是干巴巴的「已解锁」 */
      d.querySelector('.g-hint').textContent = got
        ? (g.mem[slug]?.line || def.story || '已解锁')
        : def.hint
      if (got) {
        /*
         * 点整格 = 打开详情（大图 / 视频）。
         *
         * 早先是「点缩略图设背景、点标题看大图」—— 按位置分两种动作，
         * 但用户根本不知道有这个区分（缩略图占了格子大部分面积，
         * 想设背景的人反而不容易点中标题区）。
         * 现在统一成「点开看详情」，设为背景挪到详情页里的按钮。
         */
        d.addEventListener('click', () =>
          openViewer({ kind: g.kind, slug, line: g.mem[slug]?.line || def.story || '', title: def.title }),
        )
      }
      grid.appendChild(d)
    }
  }

  renderRules()
  el.gallery.hidden = false
}

/**
 * 渲染「触发规则一览」。
 *
 * 规则硬编码在 src/shared/outfitStories.js 与 videoStories.js 里，
 * 手机端没法在线改 —— 但**必须能看**，否则图鉴只给一句模糊线索，
 * 条件类的（如「23 点后」）用户根本猜不到。
 * 这里把两份表的实际内容摊开，所见即代码里的真实规则，不会不同步。
 */
function renderRules() {
  const box = $('rules-body')
  if (!box) return
  const groups = [
    { label: '装扮', table: OUTFIT_STORIES },
    { label: '视频', table: VIDEO_STORIES },
  ]
  const html = groups
    .map((g) => {
      const rows = Object.entries(g.table)
        .map(([, d]) => {
          const how =
            d.unlock === 'condition'
              ? conditionText(d.condition)
              : (d.keywords ?? []).map((k) => `<code>${esc(k)}</code>`).join(' ')
          return `<div class="rule-row">
            <p class="rule-title">${esc(d.title)}</p>
            <p class="rule-how">${how}</p>
          </div>`
        })
        .join('')
      return `<p class="rule-group">${g.label}</p>${rows}`
    })
    .join('')
  box.innerHTML =
    html +
    `<p class="rule-foot">
      规则写在 <code>src/shared/outfitStories.js</code> 与
      <code>videoStories.js</code>，改完重新构建即可生效。
    </p>`
}

/** 条件的中文描述 */
function conditionText(c = {}) {
  const parts = []
  if (c.minPoints != null) parts.push(c.minPoints === 0 ? '初始就有' : `亲密度 ${c.minPoints}`)
  if (c.hoursAfter != null) parts.push(`${c.hoursAfter} 点之后`)
  if (c.restDayOnly) parts.push('休息日')
  return parts.length ? `<em>${parts.join(' · ')}</em>` : '<em>无条件</em>'
}

/** 转义，防止故事文案里的尖括号破坏结构 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

const closeGallery = () => { el.gallery.hidden = true }

/**
 * 显示/隐藏「还没配置」提示条。
 *
 * 替代原来的「自动弹满屏设置面板」：引导目的达到了，
 * 但不会挡住顶部的换装/图鉴按钮。
 */
async function refreshSetupHint() {
  const el2 = $('setup-hint')
  if (!el2) return
  const ready = (await configStatus(settings)).ready
  el2.hidden = ready
}

/* ---------- 换装 ---------- */

/**
 * 换装面板：**只列已解锁的**。
 *
 * 之前只能在图鉴里看，没法指定穿哪套 —— 用户看到心仪的衣服却穿不上。
 * 未解锁的不列，否则等于绕过解锁机制（PC 端踩过这个坑：
 * 右键菜单列了全部 26 套，图鉴的进度与条件全失去意义）。
 */
/*
 * 立绘页是否是「从抽屉进来的」。
 *
 * 用于换装的返回：从立绘页点换装 → 关掉换装后应该**回到立绘页**，
 * 而不是裸的聊天页（那会让用户觉得「我点了一下就迷路了」）。
 * 但从抽屉直接点「换装」进来时，关掉就该回聊天页 —— 那里没有立绘页可回。
 */
let petPageBelow = false

async function openWardrobe() {
  closeDrawer()
  el.settings.hidden = true
  el.gallery.hidden = true
  /*
   * 记下是不是从立绘页进来的 —— 关掉时要回到那里。
   * 先把立绘页藏起来：换装面板 z-index(40) 比它(45) 低，
   * 不藏的话面板会被压在下面点不到。
   */
  petPageBelow = !el.petpage.hidden
  el.petpage.hidden = true

  const unlocked = await db.listUnlockedOutfits()
  const total = Object.keys(OUTFIT_STORIES).length
  $('wardrobe-count').textContent = `${unlocked.length}/${total}`
  $('wardrobe-tip').textContent =
    unlocked.length >= total
      ? '全部解锁了，随便穿。'
      : '只显示已解锁的 —— 和她聊天可以解锁更多。'

  const grid = $('wardrobe-grid')
  grid.innerHTML = ''

  /* 「自动」永远在第一个：按时间和解锁进度轮换 */
  const auto = document.createElement('button')
  const isAuto = settings.outfitMode !== 'fixed'
  auto.className = 'w-item' + (isAuto ? ' on' : '')
  auto.innerHTML = '<span class="w-emoji">🕘</span><span class="w-label">自动</span>'
  auto.addEventListener('click', async () => {
    settings = await saveSettings({ outfitMode: 'auto' })
    await refreshPetStrip()
    await openWardrobe()
  })
  grid.appendChild(auto)

  const mem = await db.listMemories('outfit')
  for (const slug of unlocked) {
    const def = OUTFIT_STORIES[slug]
    const info = OUTFITS.find((o) => o.slug === slug)
    const on = settings.outfitMode === 'fixed' && settings.outfitSlug === slug
    const btn = document.createElement('button')
    btn.className = 'w-item' + (on ? ' on' : '')
    btn.innerHTML = `
      <img src="${outfitImg(slug)}" alt="" decoding="async" />
      <span class="w-label"></span>
      <span class="w-view" role="button" aria-label="查看详情">⤢</span>`
    btn.querySelector('.w-label').textContent = def?.title ?? info?.label ?? slug
    /*
     * 一个格子两个动作：
     *   点**图片** = 穿上（高频操作，放在最顺手的区域）
     *   点右上角 ⤢ = 看详情（大立绘 + 她在这一套里的照片）
     *
     * 早先整格都是「穿上」，用户看不到这套衣服长什么样 ——
     * 缩略图太小，而图鉴里能看到的那张照片在这里完全够不着。
     */
    btn.addEventListener('click', async (ev) => {
      const hitView = ev.target instanceof HTMLElement && ev.target.classList.contains('w-view')
      if (hitView) {
        openViewer({
          kind: 'outfit',
          slug,
          title: def?.title ?? info?.label ?? slug,
          line: mem[slug]?.line ?? def?.story ?? '',
        })
        return
      }
      settings = await saveSettings({ outfitMode: 'fixed', outfitSlug: slug })
      await refreshPetStrip()
      await openWardrobe()
    })
    grid.appendChild(btn)
  }
  el.wardrobe.hidden = false
}

const closeWardrobe = () => {
  el.wardrobe.hidden = true
  /* 从立绘页进来的就回去，否则留空的聊天页即可 */
  if (petPageBelow) {
    petPageBelow = false
    openPetPage()
  }
}

/**
 * 解锁时的「她发来照片 / 视频」全屏展示。
 *
 * 两者共用一张卡片，靠 `kind` 切换显示——做成两个弹窗会出现
 * 「两个都弹出来」的竞态，而且关闭逻辑要各写一遍。
 */
function showReveal({ kind = 'outfit', slug, line, title }, badge) {
  /*
   * 没有 slug 就不该弹 —— 弹出来是一张空卡片挡住整个界面，
   * 用户只会觉得「按钮全坏了」。宁可什么都不显示。
   */
  if (!slug) {
    console.warn('[reveal] 缺少 slug，跳过展示')
    return
  }
  const isVideo = kind === 'video'
  const img = $('reveal-img')
  const vid = $('reveal-video')

  const fallbackBadge = isVideo ? '🎬 解锁新视频' : kind === 'photo' ? '📷 收到新照片' : '✨ 解锁新装扮'
  $('reveal-badge').textContent = badge ?? fallbackBadge

  if (isVideo) {
    img.hidden = true
    img.removeAttribute('src')
    vid.hidden = false
    vid.poster = videoPoster(slug, OUTFIT_VER)
    vid.src = videoSrc(slug, OUTFIT_VER)
  } else {
    /* 先停掉可能还在播的视频，避免关掉弹窗后声音继续 */
    pauseRevealVideo()
    vid.hidden = true
    vid.removeAttribute('src')
    img.hidden = false
    /*
     * 服饰照片 → 优先显示**自拍照片**（「她发来的照片」的观感），
     * 没生成过的退回立绘；生活照 → 显示那张（它本来就没有立绘可退）。
     */
    img.src = revealPhotoSrc(kind, slug)
  }

  $('reveal-title').textContent = title || (isVideo ? slug : outfitName(slug))
  $('reveal-line').textContent = line || ''
  el.reveal.hidden = false
}

/** 关掉视频播放（弹窗关闭 / 切到照片时都要调用，否则声音会继续） */
function pauseRevealVideo() {
  const vid = $('reveal-video')
  if (!vid) return
  try {
    vid.pause()
    vid.currentTime = 0
  } catch {
    /* 尚未加载出元数据时设置 currentTime 会抛，忽略即可 */
  }
}

const closeReveal = () => {
  pauseRevealVideo()
  el.reveal.hidden = true
}

/* ---------- 设置：服务商相关 ---------- */

/** 按实际地址判断是不是 OpenRouter（以地址为准，别信下拉选了什么） */
const isOpenRouter = () => /openrouter\.ai/i.test($('f-baseUrl').value.trim())

/**
 * 刷新提示文案与 OpenRouter 选项的显隐。
 *
 * 模型写法和建议因服务商而异，写死 DeepSeek 那套会误导
 * （比如在 OpenRouter 上填 `deepseek-flash` 是错的，要 `deepseek/deepseek-chat`）。
 */
function refreshProviderHints() {
  const id = $('f-provider').value
  const or = isOpenRouter()
  const orBox = $('or-options')
  if (orBox) orBox.hidden = !or

  const hint = $('model-hint')
  if (!hint) return
  if (id === 'openrouter' || or) {
    hint.textContent = '格式为 组织/模型，如 deepseek/deepseek-chat。看图选带 vl 的，如 qwen/qwen3-vl-8b-instruct'
  } else if (id === 'ollama') {
    hint.textContent = '填 ollama 里的模型名，如 qwen2.5:7b。看图需拉多模态模型'
  } else if (id === 'deepseek') {
    hint.textContent = '要让她看图就填 deepseek-flash（原生多模态）'
  } else {
    hint.textContent = '填目标服务商支持的模型名'
  }
}

/**
 * 切服务商：带出默认地址，并**清理不再适用的模型名**。
 *
 * 不同服务商的模型名不通用：`deepseek-flash` 在 DeepSeek 上对，
 * 直接拿到 OpenRouter 会 404（那边要 `deepseek/deepseek-chat`）。
 * 留着旧值会让用户点「保存」后一直报错，却看不出为什么 ——
 * 所以切过去时如果当前模型不在新服务商的候选里，就清空并提示。
 */
function onProviderPicked() {
  const p = CHAT_PROVIDERS.find((x) => x.id === $('f-provider').value)
  if (p?.baseUrl) $('f-baseUrl').value = p.baseUrl

  const modelEl = $('f-model')
  const cur = modelEl.value.trim()
  const known = p?.models ?? []
  /*
   * 只在「新服务商有候选清单」且「当前值不在其中」时清空。
   * 自定义服务商没有候选清单，用户填什么就留什么。
   */
  if (cur && known.length && !known.includes(cur)) {
    modelEl.value = known[0] ?? ''
  }
  refreshProviderHints()
}

/* ---------- 设置 ---------- */

async function openSettings() {
  /* 和抽屉互斥：设置是底部弹出的 sheet，和左侧抽屉叠在一起会互相挡 */
  closeDrawer()
  el.drawer.hidden = true
  el.settings.hidden = false
  /*
   * **不显示遮罩**：设置是底部 sheet，自带 ✕ 且支持点空白关闭，
   * 再加一层遮罩会显得多余。
   *
   * 但这里有个代价必须知道：面板占屏 86%，**顶部那一条是点不到下面按钮的**。
   * 用户实测报过「换装图标点了没用」—— 其实是被设置面板挡住了，
   * 而界面上没有任何提示。所以面板顶部留出明确空白区（见 .sheet），
   * 让「点空白关闭」这条路径一眼可见。
   */
  el.scrim.hidden = true
  /* 服务商下拉：从预设来，CHAT_PROVIDERS 是两端共用的唯一真相 */
  const psel = $('f-provider')
  if (psel && !psel.options.length) {
    for (const p of CHAT_PROVIDERS) {
      const o = document.createElement('option')
      o.value = p.id
      o.textContent = p.label
      psel.appendChild(o)
    }
  }
  if (psel) psel.value = settings.chatProvider || 'custom'
  $('f-baseUrl').value = settings.chatBaseUrl || ''
  $('f-apiKey').value = settings.chatApiKey || ''
  $('f-model').value = settings.chatModel || ''
  $('f-zdr').checked = !!settings.chatZdr
  $('f-routeSort').value = settings.chatRouteSort || ''
  refreshProviderHints()
  $('f-workStart').value = settings.workStart || '09:00'
  $('f-workEnd').value = settings.workEnd || '18:00'
  $('f-maxHistory').value = settings.maxHistory ?? settings.chatMaxHistory ?? 100
  $('f-petStories').checked = settings.petStories !== false
  $('f-collapse').checked = settings.collapseInputOnSend !== false
  const bgOp = Math.round((Number(settings.chatBgOpacity) || 0.25) * 100)
  $('f-bgOpacity').value = String(bgOp)
  $('f-bgOpacity-val').textContent = `${bgOp}%`

  /* 背景模式 + 轮换间隔：回填当前值，并说明池子里有几张 */
  $('f-proactive').checked = settings.mobileProactive === true
  $('f-proactiveMin').value = String(settings.mobileProactiveMin ?? 20)
  syncProactiveMinVisibility()
  $('f-bgMode').value = settings.chatBgMode ?? 'off'
  $('f-bgRotateMin').value = String(settings.chatBgRotateMin ?? 30)
  refreshBgPoolInfo()
  el.testResult.textContent = ''

  const personas = await allPersonas()
  const sel = $('f-persona')
  sel.innerHTML = ''
  for (const p of personas) {
    const o = document.createElement('option')
    o.value = p.id
    o.textContent = p.label + (p.custom ? '（自定义）' : '')
    sel.appendChild(o)
  }
  sel.value = settings.chatPersona

  const usage = await db.usageBytes()
  el.usage.textContent = usage == null ? '' : `本机已用约 ${(usage / 1024 / 1024).toFixed(1)} MB`
}
const closeSettings = () => {
  el.settings.hidden = true
  if (el.drawer.hidden) el.scrim.hidden = true
}

/**
 * 更新「轮换池里有几张」的说明，并按模式显隐间隔选择器。
 *
 * 池子为空时**必须明确说出来** —— 否则用户选了「自动轮换」
 * 却一直没背景，只会以为功能坏了（实际是没往池子里放图）。
 */
/**
 * 搭话间隔只在开关打开时才显示。
 * 关着还显示一个「间隔」下拉框会让人以为已经生效了。
 */
function syncProactiveMinVisibility() {
  const on = $('f-proactive')?.checked ?? false
  const field = $('field-proactive-min')
  if (field) field.hidden = !on
}

function refreshBgPoolInfo() {
  const pool = (settings.chatBgPool ?? []).filter((p) => availablePhotos.has(p))
  const mode = $('f-bgMode')?.value ?? settings.chatBgMode
  const field = $('field-bgRotate')
  if (field) field.hidden = mode !== ChatBackgroundMode.ROTATE
  const info = $('f-bgPool-info')
  if (!info) return
  if (mode !== ChatBackgroundMode.ROTATE) {
    info.textContent = ''
    return
  }
  info.textContent = pool.length
    ? `轮换池里有 ${pool.length} 张`
    : '轮换池还是空的 —— 去图鉴里点开一张照片，选「加入轮换」'
}

async function onSaveSettings() {
  settings = await saveSettings({
    chatProvider: $('f-provider').value,
    chatBaseUrl: $('f-baseUrl').value.trim(),
    chatZdr: $('f-zdr').checked,
    chatRouteSort: $('f-routeSort').value,
    chatApiKey: $('f-apiKey').value.trim(),
    chatModel: $('f-model').value.trim(),
    workStart: $('f-workStart').value,
    workEnd: $('f-workEnd').value,
    chatMaxHistory: Number($('f-maxHistory').value) || 100,
    chatPersona: $('f-persona').value,
    petStories: $('f-petStories').checked,
    collapseInputOnSend: $('f-collapse').checked,
    mobileProactive: $('f-proactive').checked,
    mobileProactiveMin: Number($('f-proactiveMin').value) || 20,
    chatBgMode: $('f-bgMode').value,
    chatBgRotateMin: Number($('f-bgRotateMin').value) || 30,
    chatBgOpacity: (Number($('f-bgOpacity').value) || 25) / 100,
  })
  /* 同步到运行时变量，否则开关要等下次冷启动才生效 */
  suppressKeyboardOnSend = settings.collapseInputOnSend !== false
  /* 透明度改完立刻生效，不用关面板再看 */
  applyChatBackground()
  await refreshStatus()
  await refreshSetupHint()
  closeSettings()
}

/** 测试连接：一次非流式短请求，能最快暴露 Key / 地址问题 */
async function onTest() {
  el.testResult.textContent = '测试中…'
  const probe = {
    ...settings,
    chatProvider: $('f-provider').value,
    chatBaseUrl: $('f-baseUrl').value.trim(),
    chatZdr: $('f-zdr').checked,
    chatRouteSort: $('f-routeSort').value,
    chatApiKey: $('f-apiKey').value.trim(),
    chatModel: $('f-model').value.trim(),
  }
  const st = await configStatus(probe)
  if (!st.ready) {
    el.testResult.textContent = '✗ ' + st.reason
    return
  }
  try {
    const res = await fetch(`${st.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(st.cfg.apiKey ? { Authorization: `Bearer ${st.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: st.cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4, stream: false }),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      el.testResult.textContent = `✗ 接口返回 ${res.status}${t ? '：' + t.slice(0, 120) : ''}`
      return
    }
    const j = await res.json().catch(() => null)
    el.testResult.textContent = `✓ 连接正常（model=${j?.model ?? st.cfg.model}）`
  } catch (err) {
    el.testResult.textContent = `✗ 连不上：${err?.message ?? err}`
  }
}

/* ---------- 启动 ---------- */

function autoGrow() {
  el.input.style.height = 'auto'
  el.input.style.height = Math.min(el.input.scrollHeight, 120) + 'px'
}

/* ---------- 备份 / 恢复 ---------- */

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

async function onExportBackup() {
  const note = $('backup-note')
  try {
    const data = await db.exportAll()
    const nMsg = (data.data.messages ?? []).length
    db.downloadJson(data, `yuki-backup-${stamp()}.json`)
    note.textContent = `已导出 ${nMsg} 条消息。文件里含 API Key，别随便发给别人。`
  } catch (err) {
    note.textContent = `导出失败：${err?.message ?? err}`
  }
}

async function onImportBackup() {
  const note = $('backup-note')
  try {
    const payload = await db.pickJsonFile()
    if (!payload) return
    const nMsg = (payload.data?.messages ?? []).length
    const nSess = (payload.data?.sessions ?? []).length
    const mode = confirm(
      `备份里有 ${nSess} 个会话、${nMsg} 条消息。\n\n` +
        '确定 = 合并（保留现有数据，同 ID 以备份为准）\n' +
        '取消 = 覆盖（先清空本机再写入）',
    )
      ? 'merge'
      : 'replace'

    const res = await db.importAll(payload, mode)
    if (!res.ok) {
      note.textContent = `导入失败：${res.error}`
      return
    }
    note.textContent = `导入成功（${mode === 'merge' ? '合并' : '覆盖'}），正在重载…`
    setTimeout(() => location.reload(), 700)
  } catch (err) {
    note.textContent = `导入失败：${err?.message ?? err}`
  }
}

/**
 * 绑定 DOM 事件。
 *
 * ## 为什么每个都走 on() 而不是裸 addEventListener
 *
 * 任何一个元素取不到就抛 TypeError，**后面所有绑定全部中断** ——
 * 表现为「页面能渲染，但按钮全都没反应」。这在实际发生过：
 * Service Worker 缓存了旧 index.html，而 JS 是新的，
 * `$('btn-gallery')` 取到 null → 抛错 → 连「关闭设置」都点不动。
 *
 * 所以：取不到就跳过并**报出缺失的 id**，让其余绑定照常工作 ——
 * 部分功能缺失远好过整个界面变成死的。缺哪个也一眼能看到。
 */
function on(id, event, handler) {
  const node = document.getElementById(id)
  if (!node) {
    console.warn(`[bind] 缺少元素 #${id}，跳过其 ${event} 绑定（HTML 与 JS 版本可能不一致）`)
    return null
  }
  node.addEventListener(event, handler)
  return node
}

function bind() {
  /* 用 on() 包一层：单个元素缺失不再拖垮其它绑定 */
  on('btn-menu', 'click', openDrawer)
  on('btn-close-drawer', 'click', closeDrawer)
  el.scrim?.addEventListener('click', closeDrawer)
  on('btn-new', 'click', async () => {
    closeDrawer()
    const s = await db.createSession()
    await openSession(s.id)
    el.input.focus()
  })

  on('btn-gallery', 'click', openGallery)
  const psel = $('f-provider')
  if (psel) psel.addEventListener('change', onProviderPicked)
  const burl = $('f-baseUrl')
  if (burl) burl.addEventListener('input', refreshProviderHints)
  on('setup-hint', 'click', openSettings)
  /*
   * 换装按钮已从顶栏搬进「她」的全屏页（顶栏只留 图鉴 / 设置）。
   * 入口在抽屉里（见 #drawer 的「她」那一项）。
   */
  on('btn-open-petpage', 'click', openPetPage)
  /* 换装只有全屏页一个入口（抽屉里的那个已移除，避免重复入口） */
  on('btn-petpage-wardrobe', 'click', openWardrobe)
  on('btn-petpage-say', 'click', async () => {
    $('petpage-menu').hidden = true
    await onAskHerToSpeak()
  })
  /* ⋯ 菜单：展开 / 收起 */
  on('btn-petpage-more', 'click', (e) => {
    /* 阻止冒泡 —— 否则会立刻被下面的「点别处收起」捕获，闪一下就没了 */
    e.stopPropagation()
    const menu = $('petpage-menu')
    if (menu) menu.hidden = !menu.hidden
  })
  /*
   * 点菜单以外的地方收起。
   *
   * 用 `e.stopPropagation()` + 冒泡到 document 的写法，
   * 而不是给每个元素加「点击关闭」—— 后者要列一堆元素，漏一个就有盲区。
   */
  document.addEventListener('click', (e) => {
    const menu = $('petpage-menu')
    if (!menu || menu.hidden) return
    /* 点菜单自身不算「外面」 */
    if (menu.contains(e.target)) return
    menu.hidden = true
  })

  on('btn-petpage-bg', 'click', async () => {
    $('petpage-menu').hidden = true
    await cyclePetBackground()
  })
  /*
   * 底部「聊天」= 关掉这一页 + 聚焦输入框。
   *
   * 语义上这是「跳转」而不是「关闭」—— 用户离开这一页的下一步
   * 几乎总是回去说话，所以顺手把光标放进输入框，少一次点击。
   */
  on('btn-checkin', 'click', onCheckin)
  on('btn-petpage-chat', 'click', () => {
    closePetPage()
    el.input?.focus()
  })
  /*
   * 点她 = 互动。
   *
   * 单击与双击都要绑：手机上 `dblclick` 在部分浏览器有 300ms 延迟，
   * 但这里**不能**为了「立刻响应」而放弃双击 —— 单击已经由
   * `click` 处理并给反应，双击只是把台词换成更热络的那套。
   * 两者同时触发是可接受的（先「干嘛」再「诶诶诶两下！」反而自然）。
   */
  const petImg = $('petpage-pet')
  if (petImg) {
    petImg.addEventListener('click', onPetTap)
    petImg.addEventListener('dblclick', onPetDoubleTap)
    /*
     * 阻止长按弹出系统菜单（「存储图片 / 在新标签打开」）。
     * 手机上长按立绘几乎必然触发，一弹就把互动打断。
     */
    petImg.addEventListener('contextmenu', (e) => e.preventDefault())
  }
  on('btn-close-wardrobe', 'click', closeWardrobe)
  el.wardrobe?.addEventListener('click', (e) => {
    if (e.target === el.wardrobe) closeWardrobe()
  })
  on('btn-close-gallery', 'click', closeGallery)
  el.gallery?.addEventListener('click', (e) => {
    /* 点面板外的遮罩关闭（gallery 外层就是全屏遮罩） */
    if (e.target === el.gallery) closeGallery()
  })
  on('btn-reveal-ok', 'click', closeReveal)
  el.reveal?.addEventListener('click', (e) => {
    if (e.target === el.reveal) closeReveal()
  })

  /* 详情弹层 */
  on('btn-viewer-close', 'click', closeViewer)
  /*
   * 点图片以外的区域关闭 —— 但**点图本身不关**：
   * 看大图时点图是「我想看清楚」，不是「我要退出」。
   */
  el.viewer?.addEventListener('click', (e) => {
    if (e.target === el.viewer || e.target === $('viewer-stage')) closeViewer()
  })
  on('viewer-prev', 'click', () => {
    viewing.index -= 1
    renderViewerImage()
  })
  on('viewer-next', 'click', () => {
    viewing.index += 1
    renderViewerImage()
  })
  on('btn-viewer-bg', 'click', async () => {
    const rel = viewing.images[viewing.index]
    if (!rel) return
    const off = settings.chatBgMode === 'fixed' && settings.chatBackground === rel
    settings = await saveSettings({
      chatBgMode: off ? ChatBackgroundMode.OFF : ChatBackgroundMode.FIXED,
      chatBackground: off ? '' : rel,
    })
    applyChatBackground()
    renderViewerImage()
    toast(off ? '已取消背景' : '已设为聊天背景')
  })
  on('btn-viewer-pool', 'click', async () => {
    const rel = viewing.images[viewing.index]
    if (!rel) return
    const pool = settings.chatBgPool ?? []
    const inPool = pool.includes(rel)
    const next = inPool ? pool.filter((p) => p !== rel) : [...pool, rel]
    settings = await saveSettings({ chatBgPool: next })
    /*
     * 池子空了且正在轮换 → 自动退回关闭。
     * 不自动退的话，界面显示「自动轮换」但永远没背景 ——
     * 用户会以为功能坏了。
     */
    if (!next.length && settings.chatBgMode === ChatBackgroundMode.ROTATE) {
      settings = await saveSettings({ chatBgMode: ChatBackgroundMode.OFF })
      applyChatBackground()
      toast('轮换池空了，已关闭自动轮换')
    } else {
      applyChatBackground()
      toast(inPool ? '已移出轮换' : '已加入轮换')
    }
    await openGallery()
    renderViewerImage()
  })

  on('btn-settings', 'click', openSettings)
  on('btn-close-settings', 'click', closeSettings)
  /*
   * 点面板外的区域也能关掉。
   * 之前只有「✕」一个出口，而它和抽屉叠在一起时容易被挡住 ——
   * 用户实测「根本关不掉」。
   */
  el.settings?.addEventListener('click', (e) => {
    if (e.target === el.settings) closeSettings()
  })
  /* 安卓返回键 / 桌面 Esc 也能关，符合直觉 */
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (!el.viewer?.hidden) closeViewer()
    else if (!el.reveal?.hidden) closeReveal()
    else if (!el.petpage?.hidden) closePetPage()
    else if (!el.wardrobe?.hidden) closeWardrobe()
    else if (!el.gallery?.hidden) closeGallery()
    else if (!el.settings?.hidden) closeSettings()
    else if (!el.drawer?.hidden) closeDrawer()
  })
  on('btn-save-settings', 'click', onSaveSettings)
  on('btn-test', 'click', onTest)
  on('btn-export', 'click', onExportBackup)
  on('btn-import', 'click', onImportBackup)

  on('btn-wipe', 'click', async () => {
    /*
     * 清空前先提醒备份。
     *
     * 不清空没法验证「清空」这条路径，但用户很可能没意识到
     * 连对话和她记住的事都会没 —— 所以把导出按钮写进确认框里，
     * 让他有机会反悔。
     */
    const ok = confirm(
      '这会删除本机所有对话、她的记忆和图鉴进度，且无法恢复。\n\n' +
        '建议先「导出备份」。确定要继续吗？',
    )
    if (!ok) return
    await db.wipeAll()
    await db.clearUnlocks()
    location.reload()
  })

  /*
   * 透明度滑杆：拖动时**即时预览**（不等保存）。
   *
   * 只改 CSS 变量不写库 —— 拖的过程中会触发几十次事件，
   * 每次落库既费 IO 又会让「取消」变得没有意义（用户可能只是想试试）。
   * 真正的持久化在「保存」里。
   */
  const bgOp = $('f-bgOpacity')
  if (bgOp) {
    const preview = () => {
      const v = Math.min(0.85, Math.max(0.05, (Number(bgOp.value) || 25) / 100))
      $('f-bgOpacity-val').textContent = `${Math.round(v * 100)}%`
      el.msgs.style.setProperty('--bg-opacity', String(v))
    }
    bgOp.addEventListener('input', preview)
    bgOp.addEventListener('change', preview)
  }

  /*
   * 背景模式与轮换间隔：**改完立刻生效**（不用点保存）。
   *
   * 理由同透明度那两行：这是「看一眼就知道对不对」的设置，
   * 强迫用户再点一次保存才会觉得「没生效」。
   * 这里先就地存一次，面板上的保存按钮仍可整体再存一遍（幂等）。
   */
  /* 开关状态立刻反映到间隔的显隐上（不等到保存） */
  $('f-proactive')?.addEventListener('change', syncProactiveMinVisibility)

  const bgMode = $('f-bgMode')
  if (bgMode) {
    bgMode.addEventListener('change', async () => {
      settings = await saveSettings({ chatBgMode: bgMode.value })
      applyChatBackground()
      refreshBgPoolInfo()
    })
  }
  const bgRot = $('f-bgRotateMin')
  if (bgRot) {
    bgRot.addEventListener('change', async () => {
      settings = await saveSettings({ chatBgRotateMin: Number(bgRot.value) || 30 })
      applyChatBackground()
    })
  }

  /*
   * 从后台切回前台时重算一次背景。
   *
   * 手机浏览器在后台会冻结定时器，回来时不重算就会停在
   * 「离开前那张」—— 时间片早过了，用户会觉得轮换卡住了。
   */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    applyChatBackground()
    /*
     * 回前台时重排搭话。
     * 后台期间定时器会被浏览器冻结（或直接不触发），
     * 不重排的话回来就再也不主动说话了。
     */
    scheduleChatter()
  })

  el.send?.addEventListener('click', onSend)
  el.stop?.addEventListener('click', () => abortCtrl?.abort())
  on('btn-attach', 'click', () => el.file.click())
  el.file?.addEventListener('change', async (e) => {
    await addFiles(e.target.files)
    e.target.value = ''
  })

  el.input.addEventListener('input', autoGrow)
  /*
   * 关键词动作挂在**输入**上，不挂在「发送」上。
   *
   * 挂发送会有两个问题：
   *   1. 没配 API Key 时发送是禁用的，动作永远触发不了 ——
   *      用户打了一句「哈哈哈」却看不到任何反应，像是坏了
   *   2. 发送那一刻她正在切换立绘，和「发送中」的 typing 状态抢画面
   *
   * 挂输入则是一边打一边就有反应，反馈更即时，也不依赖网络。
   * 冷却（20 秒）保证不会每敲一个字都重放。
   */
  el.input.addEventListener('input', () => triggerChatAction(el.input.value))
  el.input.addEventListener('keydown', (e) => {
    /* 移动端输入法里 Enter 通常是换行，所以只在无换行键设备上发送 */
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      onSend()
    }
  })
  /* 粘贴图片（桌面浏览器调试时也有用） */
  el.input.addEventListener('paste', async (e) => {
    const items = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file')
    if (!items.length) return
    e.preventDefault()
    await addFiles(items.map((i) => i.getAsFile()))
  })
}

async function main() {
  bind()
  settings = await loadSettings()
  suppressKeyboardOnSend = settings.collapseInputOnSend !== false

  /*
   * 初始内容：第一次打开就送「本该初始就有」的条目。
   *
   * 装扮那边是 DEFAULT_OUTFIT（不给的话图鉴全空、顶部立绘无图）。
   * 背景图同理 —— 表里 unlock:'condition' 且 minPoints 为 0 的
   * 属于「基础款」，不等聊天就该给，否则用户进图鉴看到一片锁定，
   * 会以为功能坏了。
   *
   * 统一在这里处理，而不是每加一个类目就抄一段 —— 抄漏了正是
   * 上次加背景图时手机端直接报错的原因。
   */
  const unlocked = await db.listUnlocked()
  if (!unlocked.includes(DEFAULT_OUTFIT)) {
    await db.unlockOutfit(DEFAULT_OUTFIT, OUTFIT_STORIES[DEFAULT_OUTFIT]?.story ?? '这是我平时最常穿的一套', OUTFIT_STORIES[DEFAULT_OUTFIT]?.title ?? '常服')
  }
  sessionId = (await ensureSession()).id
  await openSession(sessionId)
  await refreshStatus()
  await refreshPetStrip()
  /*
   * 背景的可用性要靠**探测结果**判断，所以先探再应用。
   * 顺序不能反 —— 早先是「先应用再探测」，刚开页面时
   * 探测还没完成，`availablePhotos` 是空的，背景就被当成无效清掉了。
   */
  await probePhotos().catch(() => {})
  applyChatBackground()
  syncBgRotateTimer()
  /* 关系档影响搭话间隔（越熟越黏），启动时先取一次 */
  await refreshVoice()
  scheduleChatter()
  await refreshAffinity()
  startPetStripTicker()
  /* 顶部信息栏：时钟 + 打卡状态 */
  startClock()
  refreshCheckin().catch(() => {})
  requestPersistentStorage()
  /*
   * 配置不全时**不自动弹设置面板**。
   *
   * 原来直接 openSettings() —— 面板占屏 86%，把顶部按钮全挡住，
   * 而界面上没有任何「外面点不了」的提示，用户以为图标坏了
   * （实测报过「换装图标点了没用」）。
   * 改成显示一条不挡操作的提示条，点它才打开设置。
   */
  await refreshSetupHint()
}

/**
 * 申请「持久化存储」。
 *
 * 默认可清除的（best-effort）存储，浏览器在磁盘紧张时会**自行回收** ——
 * 用户什么都没做，对话就没了。申请成 persistent 后不会被自动清理，
 * 只有用户主动清除才会删。
 *
 * Chrome 会按「是否加书签 / 是否常访问」静默决定，不弹窗；
 * 被拒也不影响使用，所以失败不用提示。
 */
async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return
    if (await navigator.storage.persisted()) return
    await navigator.storage.persist()
  } catch {
    /* 拿不到就算了，不影响功能 */
  }
}

/**
 * 定时刷新立绘。
 *
 * 不加这个的话她永远停在初始化那一刻的姿势 —— 交替逻辑写了也不会生效，
 * 用户盯着看只会觉得是张静态贴图。30 秒一次：够频繁到能察觉「她会动」，
 * 又不至于一直重绘。
 *
 * 只在页面**可见**时刷新：切到后台还在跑定时器是白耗电，
 * 而且回来时会看到姿势变了，反而像 bug。回到前台立刻补一次。
 */
function startPetStripTicker() {
  const TICK = 30_000
  let timer = null

  const tick = () => {
    if (document.hidden) return
    refreshPetStrip().catch(() => {})
  }

  const start = () => {
    if (timer) return
    timer = setInterval(tick, TICK)
  }
  const stop = () => {
    clearInterval(timer)
    timer = null
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop()
    else {
      /* 回到前台先立即对上当前时间，再恢复定时 */
      tick()
      start()
    }
  })
  start()
}

main()

/*
 * 注册 Service Worker，并**主动**检查更新。
 *
 * 只写 register() 是不够的：浏览器默认只在导航时顺带查一次 sw.js，
 * 且对 sw.js 自身的 HTTP 缓存容忍到 24 小时。更糟的是旧版 SW 是纯
 * cache-first —— 它可能把 sw.js 这个请求也吃掉，导致**更新永远发现不了**，
 * 用户只能手动清站点数据。
 *
 * 所以这里做两件事：
 *   1. updateViaCache: 'none' —— sw.js 不参与 HTTP 缓存，每次都取新的
 *   2. 加载后主动 update()，发现新版本就走 install/activate 流程
 *      （新 SW 在 activate 时会自动重载页面，用户无感）
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      await reg.update()
      /* 新 SW 装好后提示它立即接管，不必等所有标签页关闭 */
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing
        if (!sw) return
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage({ type: 'SKIP_WAITING' })
          }
        })
      })
    } catch {
      /* 注册失败不影响正常使用（只是没有离线能力） */
    }
  })
}
