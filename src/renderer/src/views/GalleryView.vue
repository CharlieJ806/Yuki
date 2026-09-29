<script setup>
/**
 * 图鉴页 —— 装扮与生活照的解锁进度。
 *
 * ## 每个会话一份
 *
 * 图鉴是**逐会话**的（每个会话是独立的她），所以这里读的是
 * 当前会话（面板窗没有「当前会话」的概念，回落到列表第一个）的快照。
 * 否则会显示出上一个人的进度。
 *
 * ## 数据来源
 *
 * 内容表（标题/线索/关键词/故事）只有主进程能 import，
 * 所以整份快照由主进程组装后下发，前端只负责渲染 ——
 * 前端自己拼的话，两端会各写一套，而且拿不到那些数据。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { state, refreshGallery, clearGallery, saveSettings } from '../stores/app.js'
import { ChatBackgroundMode } from '@shared/moyu.js'
import { outfitConditionParts } from '@shared/outfitStories.js'

const tab = ref('outfit')
const busy = ref(false)
const detail = ref(null)

const gallery = computed(() => state.gallery)
const group = computed(() => gallery.value?.[tab.value] ?? null)
const items = computed(() => group.value?.items ?? [])
/*
 * 两个类目一起算总数。
 * 用固定清单而不是 `Object.values(gallery)` ——
 * 后者会把 `sessionId` 这类非类目字段也算进去。
 */
const KINDS = ['outfit', 'photo']
const totalAll = computed(() => {
  const g = gallery.value
  if (!g) return 0
  return KINDS.reduce((n, k) => n + (g[k]?.total ?? 0), 0)
})
const gotAll = computed(() => {
  const g = gallery.value
  if (!g) return 0
  return KINDS.reduce((n, k) => n + (g[k]?.unlockedCount ?? 0), 0)
})

/**
 * 缩略图路径。
 *
 * 优先用**实际存在的照片**（由主进程探测后随快照下发）——
 * 那是「她发来的照片」，比立绘更能代表这一项。
 * 没有照片才退回立绘。
 */
const thumbOf = (it) => {
  if (it?.photos?.length) return it.photos[0]
  if (it?.kind === 'photo') return ''
  return `yuki-outfit-${it.slug}.png`
}

/**
 * 条件类的中文描述（与手机端同一套说法）。
 *
 * 文案口径统一在 shared 的 `outfitConditionParts` 里 —— 亲密度门槛
 * 从 `OUTFIT_MIN_POINTS` 推算，不能读故事对象的 `condition.minPoints`
 * （那个字段已删除，读它会让「还差 300 点」这种事在界面上消失）。
 */
function conditionText(slug, condition) {
  return outfitConditionParts(slug, condition).join(' · ')
}

async function load() {
  busy.value = true
  try {
    await refreshGallery()
  } finally {
    busy.value = false
  }
}

/*
 * 详情里要显示的图。
 *
 * 优先用主进程探测过的**实际照片**；照片为空时退回立绘/封面 ——
 * 服饰照片是分批生成的，没生成过的那几套不能给个裂图。
 */
const detailImages = computed(() => {
  const d = detail.value
  if (!d || !d.got) return []
  if (d.photos?.length) return d.photos
  if (d.kind === 'photo') return []
  return [`yuki-outfit-${d.slug}.png`]
})

const imageIndex = ref(0)

/* 换一项就回到第一张 —— 不然会停在上一次的页码上，看着像「少了几张」 */
watch(detail, () => {
  imageIndex.value = 0
})

const currentImage = computed(() => detailImages.value[imageIndex.value] ?? '')

/** 翻页（取模循环，到头绕回去） */
function stepImage(delta) {
  const n = detailImages.value.length
  if (!n) return
  imageIndex.value = ((imageIndex.value + delta) % n + n) % n
}

const closeDetail = () => {
  detail.value = null
}

/* ---------- 设为聊天背景 / 加入轮换 ---------- */

/*
 * 与手机端同一套语义：这两件事都作用在「当前正在看的那张」上。
 * 存在 settings 里的是**路径**而不是 slug —— 同一套装扮可能有多张照片，
 * 只存 slug 就不知道用户要哪一张。
 */

/** 当前这张图的路径（多张时取正在看的那张） */
const currentPath = computed(() => detailImages.value[imageIndex.value] ?? '')

/** 只有真实存在的照片才能当背景；退回立绘的那些不算 */
const canUseAsBg = computed(() => Boolean(detail.value?.got && detail.value?.photos?.length && currentPath.value))

const bgIsCurrent = computed(
  () => state.settings?.chatBgMode === ChatBackgroundMode.FIXED && state.settings?.chatBackground === currentPath.value,
)

const inPool = computed(() => (state.settings?.chatBgPool ?? []).includes(currentPath.value))

async function toggleBackground() {
  const rel = currentPath.value
  if (!rel) return
  const off = bgIsCurrent.value
  /* 关掉时把 chatBackground 也清空，别留个指不到的值 */
  await saveSettings({
    chatBgMode: off ? ChatBackgroundMode.OFF : ChatBackgroundMode.FIXED,
    chatBackground: off ? '' : rel,
  })
}

async function togglePool() {
  const rel = currentPath.value
  if (!rel) return
  const pool = state.settings?.chatBgPool ?? []
  const next = pool.includes(rel) ? pool.filter((p) => p !== rel) : [...pool, rel]
  /*
   * 池子被清空且正在轮换 → 自动退回关闭。
   * 不自动退的话，界面显示「自动轮换」但永远没有背景，用户会以为功能坏了。
   */
  const patch = { chatBgPool: next }
  if (!next.length && state.settings?.chatBgMode === ChatBackgroundMode.ROTATE) patch.chatBgMode = ChatBackgroundMode.OFF
  await saveSettings(patch)
}

/**
 * 键盘操作。
 *
 * 面板窗是桌面应用，用户会自然地按 Esc 想关掉 ——
 * 之前只能拿鼠标点右上角的 ✕（而且图片放大后要跨半个屏幕去够它）。
 * 左右方向键同理：多张照片时不该只能点那两个小箭头。
 *
 * 挂在 window 上而不是容器上：容器没有焦点，`@keydown` 收不到事件，
 * 除非再加 tabindex + autofocus —— 那会在打开时抢走焦点，
 * 反而让输入类快捷键（比如别处的 Esc）行为变怪。
 */
function onKey(e) {
  if (!detail.value) return
  if (e.key === 'Escape') closeDetail()
  else if (e.key === 'ArrowLeft') stepImage(-1)
  else if (e.key === 'ArrowRight') stepImage(1)
}

async function onClear() {
  if (!confirm('清空**当前会话**的图鉴进度？其它会话不受影响。')) return
  busy.value = true
  try {
    await clearGallery()
    detail.value = null
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  load()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
/* 切换会话要重拉 —— 每个会话的进度不同 */
watch(() => state.chat.sessionId, load)
/* 换会话时把查看器关掉：那个会话的项在新会话里未必解锁 */
watch(() => state.chat.sessionId, closeDetail)
</script>

<template>
  <div class="gallery-view">
    <header class="head">
      <div>
        <h2>图鉴</h2>
        <p class="sub">
          <template v-if="gallery">
            {{ gotAll }} / {{ totalAll }} —— 和当前会话的她聊天会自然解锁
          </template>
          <template v-else>还没有会话</template>
        </p>
      </div>
      <button class="btn ghost" :disabled="busy" @click="onClear">清空本会话进度</button>
    </header>

    <div class="tabs">
      <button
        v-for="t in [
          { k: 'outfit', n: '装扮' },
          { k: 'photo', n: '生活照' },
        ]"
        :key="t.k"
        class="tab"
        :class="{ on: tab === t.k }"
        @click="tab = t.k"
      >
        {{ t.n }}
        <b v-if="gallery">{{ gallery[t.k].unlockedCount }}/{{ gallery[t.k].total }}</b>
      </button>
    </div>

    <div v-if="!gallery" class="empty">还没有会话，先去对话窗开一个吧</div>

    <div v-else class="grid">
      <article
        v-for="it in items"
        :key="it.slug"
        class="card"
        :class="{ locked: !it.got }"
        @click="detail = { ...it, kind: tab }"
      >
        <div class="thumb">
          <img
            v-if="thumbOf({ ...it, kind: tab })"
            :src="thumbOf({ ...it, kind: tab })"
            :alt="it.title"
            loading="lazy"
          />
          <span v-if="!it.got" class="lock">?</span>
          <!-- 已解锁的可点开全屏大图；给个放大角标，否则没人知道能点 -->
          <span v-else class="zoom" title="点开看大图">⤢</span>
        </div>
        <p class="title">{{ it.got ? it.title : '？？？' }}</p>
        <p class="hint">{{ it.got ? (it.line || it.story) : it.hint }}</p>
      </article>
    </div>

    <!--
      全屏查看器：点整格直接进来（跳过中间那层窄卡片）。
      文字与触发规则放在底部 —— 完整保留原来详情卡的信息，
      但不占图片的地方。

      未解锁的项也走同一层：图位显示问号剪影 + 线索。
      不用两个组件，是因为「锁着的长什么样」和「解锁的长什么样」
      只差一个图位，分两套必然慢慢走偏。
    -->
    <div v-if="detail" class="viewer" @click.self="closeDetail">
      <header class="viewer-head">
        <span class="viewer-title">{{ detail.got ? detail.title : '还没解锁' }}</span>
        <button class="icon-btn" title="关闭 (Esc)" @click="closeDetail">✕</button>
      </header>

      <div class="viewer-stage">
        <button
          v-if="detailImages.length > 1"
          class="nav prev"
          title="上一张 (←)"
          @click.stop="stepImage(-1)"
        >
          ‹
        </button>

        <img v-if="currentImage" class="viewer-img" :src="currentImage" :alt="detail.title" />

        <!-- 未解锁 / 该项还没有图：给剪影而不是裂图 -->
        <div v-else class="viewer-empty">
          <span class="viewer-lock">?</span>
          <p>{{ detail.hint }}</p>
        </div>

        <button
          v-if="detailImages.length > 1"
          class="nav next"
          title="下一张 (→)"
          @click.stop="stepImage(1)"
        >
          ›
        </button>
      </div>

      <footer class="viewer-foot">
        <p v-if="detailImages.length > 1" class="viewer-count">
          {{ imageIndex + 1 }} / {{ detailImages.length }}
        </p>
        <p v-if="detail.got" class="viewer-line">{{ detail.line || detail.story }}</p>

        <!-- 只有真照片能当背景（退回立绘的那些不算） -->
        <div v-if="canUseAsBg" class="viewer-tools">
          <button class="btn" :class="{ on: bgIsCurrent }" @click="toggleBackground">
            {{ bgIsCurrent ? '取消背景' : '设为背景' }}
          </button>
          <button class="btn" :class="{ on: inPool }" @click="togglePool">
            {{ inPool ? '移出轮换' : '加入轮换' }}
          </button>
        </div>

        <div class="rules">
          <p class="rules-title">触发方式</p>
          <p v-if="!detail.got" class="rules-body">
            {{ detail.hint }}
          </p>
          <p v-else-if="detail.unlock === 'condition'" class="rules-body">
            <em>{{ conditionText(detail.slug, detail.condition) }}</em>
          </p>
          <p v-else class="rules-body">
            聊到这些话题时可能触发：
            <code v-for="k in detail.keywords" :key="k">{{ k }}</code>
          </p>
          <p class="rules-note">
            具体是否触发由模型判断（宁缺毋滥），所以不是命中就一定给。
          </p>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.gallery-view { padding: 20px 22px 32px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.head h2 { margin: 0; font-size: 18px; }
.sub { margin: 4px 0 0; font-size: 12px; color: var(--text-3); }
.btn.ghost {
  background: transparent; border: 1px solid var(--border);
  color: var(--text-2); border-radius: 9px; padding: 7px 12px;
  font-size: 12px; cursor: pointer;
}
.btn.ghost:hover { border-color: var(--text-3); }

.tabs { display: flex; gap: 8px; margin: 16px 0 14px; }
.tab {
  border: 1px solid var(--border); background: transparent;
  border-radius: 9px; padding: 6px 13px; font-size: 12.5px;
  color: var(--text-2); cursor: pointer;
}
.tab.on { background: var(--accent-soft, rgba(20,184,166,.12)); border-color: var(--accent, #14b8a6); color: var(--accent, #14b8a6); font-weight: 600; }
.tab b { margin-left: 5px; font-weight: 600; opacity: .75; }

.empty { padding: 40px 0; text-align: center; color: var(--text-3); font-size: 13px; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: 12px;
}
.card {
  cursor: pointer; border-radius: 11px; overflow: hidden;
  background: var(--surface-2, rgba(0,0,0,.02));
  border: 1px solid var(--border);
  transition: transform .14s, border-color .14s;
}
.card:hover { transform: translateY(-2px); border-color: var(--text-3); }
.thumb { position: relative; aspect-ratio: 3 / 4; display: grid; place-items: center; overflow: hidden; }
.thumb img { width: 100%; height: 100%; object-fit: contain; }
/* 未解锁：剪影 + 问号，比直接藏起来更有「可收集」的感觉 */
.card.locked .thumb img { filter: brightness(0) opacity(.22); }
.lock {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 22px; color: var(--text-3); font-weight: 700;
}
/* 放大角标：平时淡，hover 时明显 —— 一直亮会盖住图片内容 */
.zoom {
  position: absolute; right: 5px; bottom: 5px;
  width: 20px; height: 20px; border-radius: 6px;
  display: grid; place-items: center; font-size: 11px;
  background: rgba(0, 0, 0, .5); color: #fff;
  opacity: 0; transition: opacity .14s;
}
.card:hover .zoom { opacity: .85; }
.title { margin: 7px 8px 2px; font-size: 12px; font-weight: 600; }
.hint {
  margin: 0 8px 9px; font-size: 10.5px; line-height: 1.5;
  color: var(--text-3);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

/*
 * 全屏查看器。
 *
 * 取代原来的「380px 窄卡片 + 最高 300px 的图」—— 那个尺寸下
 * 立绘和照片都看不清，"查看大图"名不副实。移动端的同款是全屏的，
 * 两端从此一致。
 *
 * 用 flex 纵向三段（头 / 图 / 尾）而不是绝对定位：
 * 图区 `flex:1` 自动吃掉剩余高度，文字多长都不会把图挤没。
 */
.viewer {
  position: fixed; inset: 0; z-index: 60;
  display: flex; flex-direction: column;
  background: rgba(0, 0, 0, 0.92);
  color: #fff;
  padding: 14px 16px 16px;
}

.viewer-head {
  flex: none;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.viewer-title { font-size: 15px; font-weight: 600; }
.icon-btn {
  border: none; background: transparent; color: #fff;
  font-size: 16px; line-height: 1; cursor: pointer; padding: 4px 8px;
  border-radius: 7px; opacity: .8;
}
.icon-btn:hover { opacity: 1; background: rgba(255, 255, 255, .12); }

.viewer-stage {
  position: relative;
  flex: 1; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  margin: 8px 0;
}
.viewer-img {
  max-width: 100%; max-height: 100%;
  object-fit: contain;
  border-radius: 8px;
}
/* 未解锁 / 该项还没有图：剪影 + 线索，不给裂图 */
.viewer-empty {
  display: grid; place-items: center; gap: 10px;
  color: rgba(255, 255, 255, .6); text-align: center; padding: 0 24px;
}
.viewer-lock { font-size: 46px; font-weight: 700; opacity: .5; }
.viewer-empty p { margin: 0; font-size: 12.5px; line-height: 1.7; max-width: 420px; }

/*
 * 翻页按钮压在图片两侧。
 * 半透明底而不是纯箭头 —— 浅色照片上白箭头会看不见。
 */
.nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 34px; height: 34px; border: 0; border-radius: 50%;
  background: rgba(0, 0, 0, .5); color: #fff;
  font-size: 20px; line-height: 1; cursor: pointer;
  display: grid; place-items: center;
}
.nav.prev { left: 4px; }
.nav.next { right: 4px; }
.nav:hover { background: rgba(0, 0, 0, .78); }

.viewer-foot {
  flex: none; text-align: center;
  max-height: 38vh; overflow-y: auto;
}
.viewer-count { margin: 0 0 2px; font-size: 11.5px; opacity: .7; }
.viewer-line { margin: 0 0 8px; font-size: 13px; line-height: 1.7; opacity: .92; }

/* 设为背景 / 加入轮换 —— 和手机端同一套语义，压在文字上方 */
.viewer-tools {
  display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;
  margin: 0 0 4px;
}
.viewer-tools .btn {
  border: 1px solid rgba(255, 255, 255, .3);
  background: rgba(255, 255, 255, .1);
  color: #fff; border-radius: 9px; padding: 6px 14px;
  font-size: 12.5px; cursor: pointer;
}
.viewer-tools .btn:hover { background: rgba(255, 255, 255, .2); }
.viewer-tools .btn.on {
  border-color: #5eead4; background: rgba(94, 234, 212, .18); color: #5eead4; font-weight: 600;
}

.rules {
  margin-top: 10px; padding-top: 10px; text-align: left;
  border-top: 1px solid rgba(255, 255, 255, .18);
}
.rules-title { margin: 0 0 6px; font-size: 11.5px; font-weight: 700; opacity: .7; }
.rules-body { margin: 0; font-size: 11.5px; line-height: 1.9; opacity: .9; }
.rules-body em { font-style: normal; font-weight: 600; color: #5eead4; }
.rules-body code {
  display: inline-block; padding: 0 5px; margin: 0 3px 3px 0;
  border-radius: 4px; background: rgba(255, 255, 255, .14);
  font-size: 10.5px; font-family: ui-monospace, monospace;
}
.rules-note { margin: 8px 0 0; font-size: 10.5px; opacity: .6; line-height: 1.6; }
</style>
