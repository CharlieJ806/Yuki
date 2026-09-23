<script setup>
/**
 * 图鉴页 —— 装扮与视频的解锁进度。
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
import { computed, onMounted, ref, watch } from 'vue'
import { state, refreshGallery, clearGallery, win } from '../stores/app.js'

const tab = ref('outfit')
const busy = ref(false)
const detail = ref(null)

const gallery = computed(() => state.gallery)
const group = computed(() => gallery.value?.[tab.value] ?? null)
const items = computed(() => group.value?.items ?? [])
const totalAll = computed(() => {
  const g = gallery.value
  if (!g) return 0
  return g.outfit.total + g.video.total
})
const gotAll = computed(() => {
  const g = gallery.value
  if (!g) return 0
  return g.outfit.unlockedCount + g.video.unlockedCount
})

/** 已解锁的立绘/封面路径（产物目录里按 slug 命名） */
const thumbOf = (kind, slug) =>
  kind === 'outfit' ? `yuki-outfit-${slug}.png` : `videos/${slug}.jpg`

/** 条件类的中文描述（与手机端同一套说法） */
function conditionText(c) {
  if (!c) return ''
  const parts = []
  if (c.minPoints != null) parts.push(c.minPoints === 0 ? '初始就有' : `亲密度 ${c.minPoints}`)
  if (c.hoursAfter != null) parts.push(`${c.hoursAfter} 点之后`)
  if (c.hoursBefore != null) parts.push(`${c.hoursBefore} 点之前`)
  if (c.restDayOnly) parts.push('休息日')
  return parts.length ? parts.join(' · ') : '无条件'
}

async function load() {
  busy.value = true
  try {
    await refreshGallery()
  } finally {
    busy.value = false
  }
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

onMounted(load)
/* 切换会话要重拉 —— 每个会话的进度不同 */
watch(() => state.chat.sessionId, load)
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
        v-for="t in [{ k: 'outfit', n: '装扮' }, { k: 'video', n: '视频' }]"
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
        :class="{ locked: !it.got, video: tab === 'video' }"
        @click="detail = { ...it, kind: tab }"
      >
        <div class="thumb">
          <img :src="thumbOf(tab, it.slug)" :alt="it.title" loading="lazy" />
          <span v-if="!it.got" class="lock">?</span>
          <span v-else-if="tab === 'video'" class="play">▶</span>
        </div>
        <p class="title">{{ it.got ? it.title : '？？？' }}</p>
        <p class="hint">{{ it.got ? (it.line || it.story) : it.hint }}</p>
      </article>
    </div>

    <!-- 详情：已解锁看故事与触发词，未解锁只说线索 -->
    <div v-if="detail" class="detail-mask" @click.self="detail = null">
      <div class="detail">
        <button class="close" @click="detail = null">✕</button>
        <img class="detail-img" :src="thumbOf(detail.kind, detail.slug)" :alt="detail.title" />
        <h3>{{ detail.got ? detail.title : '还没解锁' }}</h3>
        <p class="detail-line">{{ detail.got ? detail.story : detail.hint }}</p>

        <div class="rules">
          <p class="rules-title">触发方式</p>
          <p v-if="detail.unlock === 'condition'" class="rules-body">
            <em>{{ conditionText(detail.condition) }}</em>
          </p>
          <p v-else class="rules-body">
            聊到这些话题时可能触发：
            <code v-for="k in detail.keywords" :key="k">{{ k }}</code>
          </p>
          <p class="rules-note">
            具体是否触发由模型判断（宁缺毋滥），所以不是命中就一定给。
          </p>
        </div>
      </div>
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
.card.video .thumb { aspect-ratio: 4 / 3; }
.thumb img { width: 100%; height: 100%; object-fit: contain; }
.card.video .thumb img { object-fit: cover; }
/* 未解锁：剪影 + 问号，比直接藏起来更有「可收集」的感觉 */
.card.locked .thumb img { filter: brightness(0) opacity(.22); }
.lock {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 22px; color: var(--text-3); font-weight: 700;
}
.play {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 30px; height: 30px; border-radius: 50%;
  background: rgba(0,0,0,.45); color: #fff;
  display: grid; place-items: center; font-size: 12px; padding-left: 2px;
}
.title { margin: 7px 8px 2px; font-size: 12px; font-weight: 600; }
.hint {
  margin: 0 8px 9px; font-size: 10.5px; line-height: 1.5;
  color: var(--text-3);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

.detail-mask {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0,0,0,.45);
  display: grid; place-items: center; padding: 24px;
}
.detail {
  position: relative; width: 100%; max-width: 380px;
  max-height: 88vh; overflow-y: auto;
  background: var(--surface, #fff); border-radius: 14px;
  padding: 18px 18px 20px; text-align: center;
}
.close {
  position: absolute; right: 10px; top: 10px;
  border: none; background: transparent; font-size: 15px;
  color: var(--text-3); cursor: pointer;
}
.detail-img { max-width: 100%; max-height: 260px; object-fit: contain; }
.detail h3 { margin: 10px 0 0; font-size: 15px; }
.detail-line { margin: 6px 0 0; font-size: 12.5px; line-height: 1.7; color: var(--text-2); }
.rules {
  margin-top: 14px; padding-top: 12px; text-align: left;
  border-top: 1px solid var(--border);
}
.rules-title { margin: 0 0 6px; font-size: 11.5px; font-weight: 700; color: var(--text-3); }
.rules-body { margin: 0; font-size: 11.5px; line-height: 1.9; color: var(--text-2); }
.rules-body em { font-style: normal; font-weight: 600; color: var(--accent, #14b8a6); }
.rules-body code {
  display: inline-block; padding: 0 5px; margin: 0 3px 3px 0;
  border-radius: 4px; background: rgba(0,0,0,.05);
  font-size: 10.5px; font-family: ui-monospace, monospace;
}
.rules-note { margin: 8px 0 0; font-size: 10.5px; color: var(--text-3); line-height: 1.6; }
</style>
