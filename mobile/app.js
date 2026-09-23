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
  saveSettings,
  allPersonas,
  configStatus,
  sendMessage,
  toDateKey,
} from './chat.js'
import { CHAT_PROVIDERS } from '../src/shared/moyu.js'
import { OUTFIT_STORIES } from '../src/shared/outfitStories.js'
import { currentAffinity, bumpAffinity } from './chat.js'
import { VIDEO_STORIES, videoSrc, videoPoster } from '../src/shared/videoStories.js'
import { OUTFITS } from '../src/shared/interactions.js'

const $ = (id) => document.getElementById(id)
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
    await refreshPetStrip()
    showReveal(res.unlocked)
  }
}

/* ---------- 立绘常驻 + 图鉴 ---------- */

/**
 * 服饰立绘路径。
 *
 * 带一个版本查询串：立绘是**静态资源但不带 hash**，
 * 浏览器会按 URL 长期缓存。改图之后（比如这次去水印），
 * 老用户手里仍是旧图 —— 本地调试时更是直接看不到改动。
 * 版本串在每次构建时由 build.js 注入，改图即换 URL。
 */
const OUTFIT_VER = '__OUTFIT_VER__'
const outfitImg = (slug) => `outfits/yuki-outfit-${slug}.png?v=${OUTFIT_VER}`

/**
 * 顶部立绘：优先显示「当前穿着」。
 *
 * 穿着规则和桌面端一致（跟随时间 / 手动固定），
 * 但**只在她已解锁的装扮里选** —— 没解锁就不该出现。
 */
async function refreshPetStrip() {
  const unlocked = await db.listUnlockedOutfits()
  const hour = new Date().getHours()
  const total = Object.keys(OUTFIT_STORIES).length
  const totalVideo = Object.keys(VIDEO_STORIES).length
  const nVideo = (await db.listUnlocked('video')).length
  const progress = `装扮 ${unlocked.length}/${total} · 视频 ${nVideo}/${totalVideo}`

  /*
   * 立绘在「穿着」和「动作」之间交替。
   *
   * 这两个是正交维度（服饰管穿什么、动作管在干什么），
   * 桌面端早就这么做了 —— 但手机端之前只用服饰，
   * 18 个动作立绘一个都没上，站在那里永远一个姿势，很像贴图。
   *
   * 交替而不是叠加：立绘是一张图，没法同时表达两件事。
   * 用**分钟**做相位（60 秒翻转一次）—— 配 30 秒的定时器，
   * 保证每次到点都能看到变化，又不会快到闪眼。
   * 早先用 `% 2` 配合 30 秒定时器，实际两分钟才换一次，太迟钝。
   */
  const phase = Math.floor(Date.now() / 60_000) % 2 === 0

  if (phase) {
    const pose = mobilePose(hour)
    const img = $('pet-img')
    if (pose) {
      img.src = `poses/yuki-${pose}.png`
      $('pet-outfit').textContent = POSE_LABELS[pose] ?? '她'
      $('pet-note').textContent = `${progress} · ${dayPart(hour)}`
      return
    }
  }

  /* 服饰相：挑一套已解锁的 */
  let slug = null
  if (settings.outfitMode === 'fixed' && unlocked.includes(settings.outfitSlug)) {
    slug = settings.outfitSlug
  } else if (unlocked.length) {
    /* 按时间挑：深夜/清晨用睡衣类，白天用便服类 */
    const preferNight = hour >= 22 || hour < 7
    const pool = unlocked.filter((s) => {
      const isNight = /^pajamas/.test(s)
      return preferNight ? isNight : !isNight
    })
    const list = pool.length ? pool : unlocked
    slug = list[hour % list.length]
  }

  const img = $('pet-img')
  if (!slug) {
    /* 一套都没解锁（理论上不会，casual 是初始给的） */
    img.src = 'yuki-avatar.png'
    $('pet-outfit').textContent = 'Yuki'
    $('pet-note').textContent = progress
    return
  }
  img.src = outfitImg(slug)
  $('pet-outfit').textContent = outfitName(slug)
  $('pet-note').textContent = `${progress} · ${dayPart(hour)}`
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
    const fill = $('affinity-fill')
    const text = $('affinity-text')
    if (!fill || !text) return
    fill.style.width = `${Math.round(a.progress)}%`
    text.textContent = a.isMax
      ? `${a.level.name} · 已到顶（${a.points}）`
      : `${a.level.name} · 再 ${a.toNext} 点升级`
    /* 到顶后进度条满格，用不同色调区分「已满」和「进行中」 */
    fill.dataset.max = a.isMax ? '1' : ''
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
  pose1: '握拳',
  pose2: '蹦蹦跳跳',
  pose3: '眨眼',
  pose4: '站姿',
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
  else if (evening) pool = ['music', 'heart', 'snack', 'shrug', 'pose3']
  else pool = ['pose4', 'snack', 'music']

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

  const [outfits, videos] = await Promise.all([db.listUnlocked('outfit'), db.listUnlocked('video')])
  const totalOutfit = Object.keys(OUTFIT_STORIES).length
  const totalVideo = Object.keys(VIDEO_STORIES).length
  $('gallery-count').textContent = `${outfits.length + videos.length}/${totalOutfit + totalVideo}`
  $('gallery-tip').textContent =
    outfits.length >= totalOutfit && videos.length >= totalVideo
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
  ]

  for (const g of groups) {
    const head = document.createElement('p')
    head.className = 'g-group'
    head.innerHTML = `${g.label} <b>${g.got.length}/${g.total}</b>`
    grid.appendChild(head)

    for (const [slug, def] of Object.entries(g.table)) {
      const got = g.got.includes(slug)
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
      d.querySelector('.g-title').textContent = got ? def.title : '？？？'
      /* 已解锁：显示触发时她说的那句（记忆），而不是干巴巴的「已解锁」 */
      d.querySelector('.g-hint').textContent = got
        ? (g.mem[slug]?.line || def.story || '已解锁')
        : def.hint
      if (got) {
        d.addEventListener('click', () =>
          showReveal(
            { kind: g.kind, slug, line: def.story ?? '', title: def.title },
            g.kind === 'video' ? '已收下的视频' : '已收下的照片',
          ),
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
async function openWardrobe() {
  closeDrawer()
  el.settings.hidden = true
  el.gallery.hidden = true

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
      <span class="w-label"></span>`
    btn.querySelector('.w-label').textContent = def?.title ?? info?.label ?? slug
    btn.addEventListener('click', async () => {
      settings = await saveSettings({ outfitMode: 'fixed', outfitSlug: slug })
      await refreshPetStrip()
      await openWardrobe()
    })
    grid.appendChild(btn)
  }
  el.wardrobe.hidden = false
}

const closeWardrobe = () => { el.wardrobe.hidden = true }

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

  $('reveal-badge').textContent = badge ?? (isVideo ? '🎬 解锁新视频' : '✨ 解锁新装扮')

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
    img.src = outfitImg(slug)
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
  })
  /* 同步到运行时变量，否则开关要等下次冷启动才生效 */
  suppressKeyboardOnSend = settings.collapseInputOnSend !== false
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
  on('btn-wardrobe', 'click', openWardrobe)
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
    if (!el.reveal?.hidden) closeReveal()
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

  el.send?.addEventListener('click', onSend)
  el.stop?.addEventListener('click', () => abortCtrl?.abort())
  on('btn-attach', 'click', () => el.file.click())
  el.file?.addEventListener('change', async (e) => {
    await addFiles(e.target.files)
    e.target.value = ''
  })

  el.input.addEventListener('input', autoGrow)
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
   * 初始装扮：第一次打开就送 casual。
   * 否则图鉴里一套都没有、顶部立绘也无图可显示 —— 用户会以为坏了。
   */
  const unlocked = await db.listUnlocked()
  if (!unlocked.includes('casual')) {
    await db.unlockOutfit('casual', OUTFIT_STORIES.casual?.story ?? '这是我平时最常穿的一套', OUTFIT_STORIES.casual?.title ?? '便服')
  }

  sessionId = (await ensureSession()).id
  await openSession(sessionId)
  await refreshStatus()
  await refreshPetStrip()
  await refreshAffinity()
  startPetStripTicker()
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
