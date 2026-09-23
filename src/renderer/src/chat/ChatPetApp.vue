<script setup>
/**
 * 对话窗旁的独立小立绘窗口。
 *
 * 为什么单独开窗而不是做在对话窗里：对话框宽只有 420，
 * 立绘浮在消息流右侧必然压到文字（实测确认）。
 * 这个窗口贴着对话框外侧，互不遮挡，也能独立隐藏。
 *
 * 它只负责「显示 + 换装」，不承载对话逻辑。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { state, refresh, initBridge, saveSettings, refreshGallery } from '../stores/app.js'
import { OUTFITS, OUTFIT_SLUGS, DEFAULT_OUTFIT, outfitFile, outfitForTime, outfitInfo } from '@shared/interactions.js'

const pickerOpen = ref(false)

/*
 * 换装清单**只列已解锁的**（与桌宠右键菜单、手机端同一套规则）。
 * 之前列的是 OUTFITS 全量 —— 等于绕过图鉴。
 */
const outfits = computed(() => {
  const unlocked = new Set(state.gallery?.outfit?.unlocked ?? [])
  return OUTFITS.filter((o) => unlocked.has(o.slug))
})

/** 每分钟对一次时间，跨过时段边界才会自动换装 */
const clockTick = ref(Date.now())
let clockTimer = null
let stopBridge = null

/** 已解锁的服饰（图鉴未就绪时保守为「只有初始那套」） */
const unlockedOutfits = computed(() => {
  const list = state.gallery?.outfit?.unlocked
  return new Set(Array.isArray(list) ? list : [DEFAULT_OUTFIT])
})

const currentOutfitSlug = computed(() => {
  if (state.settings.outfitMode !== 'fixed') return outfitForTime(new Date(clockTick.value))
  const s = state.settings.outfitSlug
  if (!OUTFIT_SLUGS.includes(s)) return DEFAULT_OUTFIT
  /*
   * 未解锁的一律回落。
   * 守卫放在**展示求值点**：settings 的写入口不止换装菜单
   * （设置页、IPC、重置都会写），只在菜单挡是绕得过去的。
   */
  if (!unlockedOutfits.value.has(s)) return DEFAULT_OUTFIT
  return s
})
const currentOutfitImage = computed(() => outfitFile(currentOutfitSlug.value))
const currentOutfitLabel = computed(() => outfitInfo(currentOutfitSlug.value).label)

/** 选中一套即固定；选「跟随时间」恢复自动（null 表示自动） */
async function choose(slug) {
  pickerOpen.value = false
  if (slug === null) {
    await saveSettings({ outfitMode: 'auto' })
    return
  }
  /* 再挡一道：菜单没列出来的也不给选 */
  const unlocked = new Set(state.gallery?.outfit?.unlocked ?? [])
  if (!unlocked.has(slug)) return
  await saveSettings({ outfitMode: 'fixed', outfitSlug: slug })
}

onMounted(async () => {
  stopBridge = initBridge()
  await refresh()
  /*
   * 拉图鉴：换装菜单与守卫都依赖「已解锁」这份数据。
   * 不拉的话会保守成「只有初始那套」—— 用户会觉得换装坏了。
   */
  await refreshGallery().catch(() => {})
  clockTimer = window.setInterval(() => (clockTick.value = Date.now()), 60_000)
})

onBeforeUnmount(() => {
  stopBridge?.()
  if (clockTimer) window.clearInterval(clockTimer)
})
</script>

<template>
  <!-- 整窗可拖，方便用户挪开 -->
  <div class="cp-root">
    <div class="cp-stage" @click="pickerOpen = !pickerOpen" title="点击换装">
      <img class="cp-img" :src="currentOutfitImage" :alt="currentOutfitLabel" draggable="false" />
    </div>
    <p class="cp-label">{{ currentOutfitLabel }}</p>

    <!-- 换装面板：向上展开，超出窗口也没关系（transparent 窗） -->
    <transition name="cp-pop">
      <div v-if="pickerOpen" class="cp-picker" @mousedown.stop>
        <button class="cp-item" :class="{ active: state.settings.outfitMode === 'auto' }" @click="choose(null)">
          <span>🕘</span><span>跟随时间</span>
        </button>
        <button
          v-for="o in outfits"
          :key="o.slug"
          class="cp-item"
          :class="{ active: state.settings.outfitMode === 'fixed' && state.settings.outfitSlug === o.slug }"
          :title="o.hint"
          @click="choose(o.slug)"
        >
          <span>{{ o.emoji }}</span><span>{{ o.label }}</span>
        </button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.cp-root {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100vh;
  box-sizing: border-box;
  /* 整窗可拖：这个窗口没有标题栏，拖拽全靠这里 */
  -webkit-app-region: drag;
}

.cp-stage {
  /* 立绘本身可点（换装），所以要把拖拽区域摘出来 */
  -webkit-app-region: no-drag;
  cursor: pointer;
  padding: 4px 6px 0;
  display: grid;
  place-items: center;
}

.cp-img {
  max-width: 100%;
  max-height: 172px;
  object-fit: contain;
  /* 和桌宠一致的轻浮动，避免像静态贴图 */
  animation: cp-breathe 3.6s ease-in-out infinite;
  filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.18));
}
@keyframes cp-breathe {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}

.cp-label {
  margin: 2px 0 6px;
  padding: 2px 9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(0, 0, 0, 0.08);
  font-size: 10.5px;
  font-weight: 700;
  color: #374151;
  -webkit-app-region: no-drag;
}

.cp-picker {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  width: 110px;
  padding: 6px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(0, 0, 0, 0.1);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.2);
  max-height: 214px;
  overflow-y: auto;
  -webkit-app-region: no-drag;
}
.cp-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: #374151;
  font-size: 11px;
  text-align: left;
}
.cp-item:hover {
  background: rgba(0, 0, 0, 0.05);
}
.cp-item.active {
  background: rgb(var(--theme-accent) / 0.14);
  color: rgb(var(--theme-accent));
  font-weight: 700;
}

.cp-pop-enter-active,
.cp-pop-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.cp-pop-enter-from,
.cp-pop-leave-to {
  opacity: 0;
  transform: translate(-50%, 6px);
}
</style>
