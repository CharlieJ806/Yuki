<script setup>
/**
 * 桌宠右键菜单（共享组件）——同一份实现在两种宿主里渲染：
 *
 * - Electron：内嵌在桌宠窗内（PetApp 以 menuOpen 控制，见 showMenu）；
 * - Tauri：独立透明小窗 petmenu（MenuApp 宿主），光标处弹出、工作区钳制防溢出。
 *
 * 组件只负责展示与动作上报（emit action/close），动作执行归宿主——
 * 「打卡/换装/缩放」等业务走 store 总线，「气泡开关/退出挥手」是桌宠窗
 * 本地行为，两个宿主的收尾方式不同（Electron 关 v-if，Tauri 藏窗口）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { state } from '../stores/app.js'
import {
  OUTFITS,
  OUTFIT_SLUGS,
  DEFAULT_OUTFIT,
  affinityLevel,
  outfitForTime,
  outfitInfo,
} from '@shared/interactions.js'

const emit = defineEmits(['action', 'close'])

/* 连续调理型动作（缩放/换装/气泡）保持菜单打开——连调几档缩放、试穿几套
   衣服不该反复右键；「办完即走」的（打卡/面板/对话/退出）才关 */
const KEEP_OPEN = new Set(['bubble', 'scale', 'scale-reset', 'outfit'])

/** 动作统一出口：先上报动作，再按分类决定是否关菜单，收尾归宿主 */
function act(payload) {
  emit('action', payload)
  if (!KEEP_OPEN.has(payload.type)) emit('close')
}

const scale = computed(() => {
  const s = Number(state.settings.petScale)
  return Number.isFinite(s) && s > 0 ? s : 1
})
const affinity = computed(() => affinityLevel(state.affinity?.points ?? 0))

/* ---------- 换装展示 ---------- */

/*
 * 清单**只列已解锁的**。之前直接列 OUTFITS（全部 26 套）等于绕过图鉴：
 * 右键随手穿上还没解锁的衣服，图鉴的进度、条件、故事全失去意义。
 * 「跟随时间」是自动模式，不受解锁限制（它自己会从已解锁池里挑）。
 */
const clockTick = ref(Date.now())
let clockTimer = null
onMounted(() => {
  /* 自动换装要跨过时段边界，每分钟对一次时间 */
  clockTimer = window.setInterval(() => (clockTick.value = Date.now()), 60_000)
})
onBeforeUnmount(() => window.clearInterval(clockTimer))

const unlockedOutfits = computed(() => new Set(state.gallery?.outfit?.unlocked ?? []))
const outfits = computed(() => OUTFITS.filter((o) => unlockedOutfits.value.has(o.slug)))
const currentOutfitSlug = computed(() => {
  if (state.settings.outfitMode !== 'fixed') return outfitForTime(new Date(clockTick.value))
  const s = state.settings.outfitSlug
  if (!OUTFIT_SLUGS.includes(s)) return DEFAULT_OUTFIT
  if (!unlockedOutfits.value.has(s)) return DEFAULT_OUTFIT
  return s
})
const outfitLabel = computed(() => {
  if (state.settings.outfitMode !== 'fixed') return `${outfitInfo(currentOutfitSlug.value).label}·自动`
  return outfitInfo(currentOutfitSlug.value).label
})
</script>

<template>
  <div class="menu" @mousedown.stop>
    <p class="menu-head">Yuki · {{ affinity.level.name }}</p>

    <button class="menu-item" :disabled="state.checkedInToday" @click="act({ type: 'checkin' })">
      <span class="menu-icon">{{ state.checkedInToday ? '✓' : '✅' }}</span>
      <span class="menu-label">{{ state.checkedInToday ? '今日已打卡' : '立即打卡' }}</span>
      <span v-if="!state.checkedInToday" class="menu-tag">+1 天</span>
    </button>

    <button class="menu-item" @click="act({ type: 'panel' })">
      <span class="menu-icon">📊</span>
      <span class="menu-label">打开摸鱼面板</span>
      <span class="menu-tag">{{ state.todayEarnedText }}</span>
    </button>

    <button class="menu-item" @click="act({ type: 'chat' })">
      <span class="menu-icon">💭</span>
      <span class="menu-label">对话</span>
      <span class="menu-tag">AI</span>
    </button>

    <div class="menu-sep" />

    <!-- 换装：和对话窗共用同一份设置，改哪边都同步 -->
    <div class="menu-outfit">
      <div class="mo-head">
        <span class="mo-label">换装</span>
        <span class="mo-cur">{{ outfitLabel }}</span>
      </div>
      <div class="mo-list">
        <button
          class="mo-item"
          :class="{ active: state.settings.outfitMode === 'auto' }"
          title="按时间自动换（只用已解锁的）"
          @click="act({ type: 'outfit', slug: null })"
        >
          🕘
        </button>
        <button
          v-for="o in outfits"
          :key="o.slug"
          class="mo-item"
          :class="{ active: state.settings.outfitMode === 'fixed' && state.settings.outfitSlug === o.slug }"
          :title="`${o.label} · ${o.hint}`"
          @click="act({ type: 'outfit', slug: o.slug })"
        >
          {{ o.emoji }}
        </button>
      </div>
    </div>

    <div class="menu-sep" />

    <!-- 亲密度：让「摸头」这类互动有个可见的积累反馈 -->
    <div class="menu-affinity">
      <div class="ma-row">
        <span class="ma-label">亲密度</span>
        <span class="ma-value tabular">{{ state.affinity?.points ?? 0 }} · {{ affinity.level.name }}</span>
      </div>
      <div class="ma-bar">
        <div class="ma-fill" :style="{ width: affinity.progress + '%' }" />
      </div>
      <p class="ma-note">
        {{ affinity.isMax ? '已经最亲密啦' : `再互动 ${affinity.toNext} 次升级` }}
        <template v-if="state.affinity?.streakDays > 1"> · 连续 {{ state.affinity.streakDays }} 天</template>
      </p>
      <p class="ma-note">
        今日聊天得分 {{ state.affinity?.chatToday ?? 0 }}/{{ state.meta.affinity?.chatDailyCap ?? 60 }}
        <template v-if="state.affinity?.chatToday >= (state.meta.affinity?.chatDailyCap ?? 60) && !affinity.isMax">
          · 明天继续
        </template>
      </p>
    </div>

    <div class="menu-sep" />

    <button class="menu-item" @click="act({ type: 'bubble' })">
      <span class="menu-icon">💬</span>
      <span class="menu-label">显示 / 隐藏气泡</span>
    </button>

    <div class="menu-sep" />

    <button class="menu-item" @click="act({ type: 'scale', delta: 0.1 })">
      <span class="menu-icon">🔍</span>
      <span class="menu-label">放大显示</span>
      <span class="menu-tag tabular">{{ Math.round(scale * 100) }}%</span>
    </button>
    <button class="menu-item" @click="act({ type: 'scale', delta: -0.1 })">
      <span class="menu-icon">🔎</span>
      <span class="menu-label">缩小显示</span>
      <span class="menu-tag">最小 60%</span>
    </button>

    <div class="menu-sep" />

    <button class="menu-item" :disabled="scale === 1" @click="act({ type: 'scale-reset' })">
      <span class="menu-icon">↺</span>
      <span class="menu-label">恢复默认大小</span>
    </button>
    <button class="menu-item danger" @click="act({ type: 'quit' })">
      <span class="menu-icon">✕</span>
      <span class="menu-label">退出摸鱼桌宠</span>
    </button>

    <p class="menu-foot">拖我移动 · 单击互动 · 双击气泡刷新</p>
  </div>
</template>

<style scoped>
/*
 * 菜单面板本体。内嵌宿主（PetApp）里它是 flex 列中的普通块，跟随
 * justify-content: flex-end 排在气泡/桌宠上方；独立窗宿主（MenuApp）里
 * 外层根给 100vh + padding，面板自适应内容高度、超长内部滚动。
 */
.menu {
  flex: 0 1 auto;
  min-height: 0;
  max-height: 100%;
  align-self: stretch;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 0, 0, 0.22) transparent;
  padding: 6px;
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
  backdrop-filter: blur(14px);
  z-index: 10;
}
.menu::-webkit-scrollbar {
  width: 6px;
}
.menu::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 3px;
}
.menu::-webkit-scrollbar-track {
  background: transparent;
}
.menu-head {
  margin: 2px 0 6px;
  padding: 0 9px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #9ca3af;
}
.menu-foot {
  margin: 6px 0 1px;
  padding: 5px 9px 0;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  font-size: 10px;
  color: #b0b6bf;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 9px;
  border: none;
  background: transparent;
  border-radius: 9px;
  font-size: 12.5px;
  color: #16181d;
  text-align: left;
  transition: background 0.13s ease;
}
.menu-item:hover:not(:disabled) {
  background: rgba(20, 184, 166, 0.12);
}
.menu-item:disabled {
  color: #9ca3af;
  cursor: default;
}
.menu-item.danger {
  color: #dc2626;
}
.menu-item.danger:hover:not(:disabled) {
  background: rgba(220, 38, 38, 0.1);
}

.menu-icon {
  flex: 0 0 16px;
  font-size: 12.5px;
  text-align: center;
  line-height: 1;
}
.menu-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
}
.menu-tag {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: #9ca3af;
  white-space: nowrap;
}
.menu-item:hover:not(:disabled) .menu-tag {
  color: rgb(var(--theme-accent));
}
.menu-sep {
  height: 1px;
  margin: 5px 7px;
  background: rgba(0, 0, 0, 0.07);
}
/* ---------- 菜单里的换装 ---------- */
.menu-outfit {
  padding: 6px 9px 7px;
}
.mo-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 5px;
}
.mo-label {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--text-2);
}
.mo-cur {
  font-size: 10px;
  color: rgb(var(--theme-accent));
  font-weight: 700;
}
/* 已解锁的多套衣服一行放不下，允许换行 */
.mo-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.mo-item {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  font-size: 13px;
  line-height: 1;
  display: grid;
  place-items: center;
}
.mo-item:hover {
  border-color: rgb(var(--theme-accent) / 0.5);
}
.mo-item.active {
  border-color: rgb(var(--theme-accent));
  background: var(--theme-accent-soft);
}

/* ---------- 菜单里的亲密度 ---------- */
.menu-affinity {
  padding: 7px 9px 8px;
}
.ma-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.ma-label {
  font-size: 11px;
  color: #6b7280;
}
.ma-value {
  font-size: 10.5px;
  font-weight: 700;
  color: #16181d;
}
.ma-bar {
  height: 5px;
  margin-top: 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.08);
  overflow: hidden;
}
.ma-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #fb7185, #f472b6);
  transition: width 0.5s ease;
}
.ma-note {
  margin: 5px 0 0;
  font-size: 9.5px;
  color: #9ca3af;
}
</style>
