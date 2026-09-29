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
import { state, refresh, initBridge, refreshGallery } from '../stores/app.js'
import { outfitFile } from '@shared/interactions.js'
import { useOutfitState } from '../lib/outfit-state.js'

const pickerOpen = ref(false)
const rootEl = ref(null)
let fitObserver = null

function togglePicker() {
  pickerOpen.value = !pickerOpen.value
  /*
   * 开合后**主动上报一次**。
   *
   * ResizeObserver 要等过渡动画结束才回调，中间那段时间窗口还挂着旧尺寸；
   * 收起时更不能等 —— 见 reportFit 里为什么收起要报 0。
   */
  reportFit()
}

/* 换装状态收敛在 useOutfitState（与桌宠/右键菜单/对话窗同一套，守卫规则单源） */
const { currentOutfitSlug, currentOutfitLabel, outfits, chooseOutfit: pickOutfit } = useOutfitState()
const currentOutfitImage = computed(() => outfitFile(currentOutfitSlug.value))

let stopBridge = null

/** 选中一套即固定；选「自动穿」恢复自动（null 表示自动） */
async function choose(slug) {
  pickerOpen.value = false
  await pickOutfit(slug)
}

onMounted(async () => {
  stopBridge = initBridge()
  await refresh()
  /*
   * 拉图鉴：换装菜单与守卫都依赖「已解锁」这份数据。
   * 不拉的话会保守成「只有初始那套」—— 用户会觉得换装坏了。
   */
  await refreshGallery().catch(() => {})
  /*
   * 内容贴合：换装面板展开后内容变高，窗口要跟着**向上长**。
   *
   * 不这么做的话面板会被窗口边界裁掉 —— `transparent: true` 只让背景透明，
   * **不代表内容可以溢出**。之前那版就是这么坏的：面板本体被裁没了，
   * 只剩它的 box-shadow 漏进可视区，用户看到「一道阴影」。
   */
  if (typeof ResizeObserver === 'function' && rootEl.value) {
    fitObserver = new ResizeObserver(reportFit)
    fitObserver.observe(rootEl.value)
    reportFit()
  }
})

/**
 * 把内容高度报给壳层。
 *
 * 用 `offsetHeight`（含 padding/border）而不是 `scrollHeight`：
 * 后者会把 overflow 里被藏起来的部分也算进去，面板收起时高度下不去。
 *
 * ## 收起时上报 0，而不是 offsetHeight
 *
 * `.cp-root` 是 `min-height: 100vh`，所以收起状态下量到的 `offsetHeight`
 * **恒 ≥ 当前窗口高度**，而壳层取 `Math.max(CHAT_PET_SIZE.height, height)` ——
 * 于是窗口高度**单调不减**：换装面板开过一次就永久停在 ~360px。
 * 多出来的那块透明区整块是 `-webkit-app-region: drag`，
 * 会静默吞掉桌面和对话框上的点击与拖拽。
 *
 * 壳层的下限兜底（`Math.max(CHAT_PET_SIZE.height, Number(height) || 0)`）
 * 保证 0 会正确回落到 232 的建窗高度。
 */
function reportFit() {
  const el = rootEl.value
  if (!el) return
  /*
   * Tauri 壳尚未实现本接口（`src-tauri` 只有 pet_refit / pet_menu_resize，
   * desk-shim 里也刻意没登记 resizeChatPet）→ Tauri 下静默 no-op，
   * 换装面板仍会被窗口裁掉。补它要同时加 Rust command 并进 generate_handler!，
   * 不在本次修复范围内。
   */
  window.desk?.resizeChatPet?.({ height: pickerOpen.value ? el.offsetHeight : 0 })
}

onBeforeUnmount(() => {
  stopBridge?.()
  /* 自动换装的时钟由 useOutfitState 自管并在其内部 onBeforeUnmount 清理 */
  fitObserver?.disconnect()
})
</script>

<template>
  <!-- 整窗可拖，方便用户挪开。data-tauri-drag-region 给 Tauri（target 自身
       判定：立绘/标签/换装面板都是 target 且不带属性，天然不拖，
       与 Electron 的 no-drag 语义一致） -->
  <div class="cp-root" ref="rootEl" data-tauri-drag-region>
    <!--
      换装面板**排在流里、位于立绘之前**，而不是绝对定位到窗口上方。
      绝对定位到 `bottom: 100%` 会落到窗口边界之外被裁掉 ——
      `transparent: true` 只让背景透明，**不代表内容能溢出窗口**。
      裁剩的只有它的 box-shadow 漏回可视区，于是用户看到「点击后上方一道阴影」。
      放进流之后内容高度自然变高，ResizeObserver 量到就通知壳层向上长。
    -->
    <transition name="cp-pop">
      <div v-if="pickerOpen" class="cp-picker" @mousedown.stop>
        <button class="cp-item" :class="{ active: state.settings.outfitMode === 'auto' }" @click="choose(null)">
          <span>🎲</span><span>自动穿</span>
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

    <div class="cp-stage" @click="togglePicker" title="点击换装">
      <img class="cp-img" :src="currentOutfitImage" :alt="currentOutfitLabel" draggable="false" />
    </div>
    <p class="cp-label">{{ currentOutfitLabel }}</p>
  </div>
</template>

<style scoped>
.cp-root {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  /*
   * `min-height` 而不是 `height` —— 窗口贴合要求这个元素能报出
   * **内容的自然高度**：`height: 100vh` 会把高度锁死在当前窗口尺寸，
   * 面板展开后量到的还是旧值，窗口永远长不高。
   */
  min-height: 100vh;
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

/*
 * 换装面板：**流内元素**（排在立绘之前），不再是绝对定位。
 * 绝对定位到窗口外会被裁掉 —— 见模板里的注释。
 */
.cp-picker {
  width: 110px;
  margin-bottom: 6px;
  padding: 6px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(0, 0, 0, 0.1);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.2);
  max-height: 214px;
  overflow-y: auto;
  flex: none;
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
  transform: translateY(6px);
}
</style>
