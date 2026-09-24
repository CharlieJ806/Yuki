<script setup>
/**
 * petmenu 窗宿主 —— 桌宠右键菜单的独立小窗（?route=petmenu），两种壳同构：
 *
 * - Tauri：Rust 建 petmenu 窗，pet_menu_show 定位到光标（工作区钳制防溢出）；
 * - Electron：主进程建同规格 BrowserWindow，screen.getCursorScreenPoint 定位。
 *
 * 本窗常驻隐藏，右键时显示；失焦 / Esc 后藏回，不销毁。
 * 动作分两类（开合分类在 PetMenu 的 KEEP_OPEN 集合）：
 * - 关闭类（打卡/面板/对话/退出）：组件上报动作时一并 emit close；
 * - 保持打开类（缩放/换装/气泡）：动作走完菜单不收，便于连续操作。
 * 业务动作（打卡/面板/对话/换装/缩放）走 store 总线；桌宠本地行为
 * （气泡开关、退出挥手）sendPetUi 经 service 广播回桌宠窗执行。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import PetMenu from './PetMenu.vue'
import {
  state,
  refresh,
  doCheckIn,
  initBridge,
  openChatWindow,
  saveSettings,
  refreshGallery,
  setActiveSession,
  sendPetUi,
} from '../stores/app.js'

const hide = () => window.desk?.hidePetMenu?.()

/** 缩放是设置值：算好目标值交给壳层，它会写回设置并同步窗口尺寸。
    乐观值只活在本次调用内（连点取基数用），权威值以 settings 广播为准 */
let optimisticScale = null
async function setScale(next) {
  optimisticScale = Math.max(0.6, Math.min(2, Number(next) || 1))
  try {
    await window.desk?.setPetScale?.(optimisticScale)
    await refresh()
  } finally {
    optimisticScale = null
  }
}

/* 再挡一道未解锁守卫：菜单只列已解锁的，但换装写的是 settings，守卫放在执行点更稳 */
async function applyOutfit(slug) {
  if (slug === null) {
    await saveSettings({ outfitMode: 'auto' })
    return
  }
  const unlocked = new Set(state.gallery?.outfit?.unlocked ?? [])
  if (!unlocked.has(slug)) return
  await saveSettings({ outfitMode: 'fixed', outfitSlug: slug })
}

async function onMenuAction(a) {
  switch (a.type) {
    case 'checkin':
      await doCheckIn()
      break
    case 'panel':
      window.desk?.openPanel?.()
      break
    case 'chat':
      await openChatWindow()
      break
    case 'bubble':
      sendPetUi('toggle-bubble')
      break
    case 'scale': {
      /* 连点以乐观值为基数：等广播回来再算会读到旧值，快速连点就丢步 */
      const base = optimisticScale ?? (Number(state.settings.petScale) || 1)
      await setScale(Number((base + a.delta).toFixed(2)))
      break
    }
    case 'scale-reset':
      await setScale(1)
      break
    case 'outfit':
      await applyOutfit(a.slug)
      break
    case 'quit':
      sendPetUi('quit-wave')
      break
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') hide()
}
function onBlur() {
  hide()
}

/* 窗口贴合：面板高度一变（换装清单/亲密度文案随状态变化）就报给壳层收窗。
   必须观察面板本体——根节点是固定 100vh，永远不触发 ResizeObserver */
const rootEl = ref(null)
let fitObserver = null
let lastH = ''
function reportHeight() {
  const panel = rootEl.value?.firstElementChild
  if (!panel) return
  const h = Math.ceil(panel.offsetHeight) + 16
  if (String(h) === lastH) return
  lastH = String(h)
  window.desk?.resizePetMenu?.(h)
}

let stopBridge = null
onMounted(async () => {
  stopBridge = initBridge()
  await refresh()
  /*
   * 与 PetApp 同款顺序：先取主进程记的「当前活跃会话」再拉图鉴，
   * 否则换装清单会短暂显示成「会话列表第一个」的衣柜。
   */
  try {
    const active = await window.desk?.getActiveSession?.()
    if (active) await setActiveSession(active)
  } catch {
    /* 取不到就按回落逻辑走，不影响显示 */
  }
  await refreshGallery().catch(() => {})
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('blur', onBlur)
  /* 面板高度贴合观测（含首次挂载的那次回调）。observe 后同步先量一次：
     隐藏窗不出帧时 RO 首回调会饿死（同桌宠窗教训） */
  fitObserver = new ResizeObserver(reportHeight)
  if (rootEl.value?.firstElementChild) {
    fitObserver.observe(rootEl.value.firstElementChild)
    reportHeight()
  }
})

onBeforeUnmount(() => {
  stopBridge?.()
  fitObserver?.disconnect()
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('blur', onBlur)
})
</script>

<template>
  <!-- 右键已由自定义菜单接管：菜单窗内一律禁用 WebView2 原生右键菜单 -->
  <div ref="rootEl" class="petmenu-root" @contextmenu.prevent>
    <PetMenu @action="onMenuAction" @close="hide" />
  </div>
</template>

<style scoped>
/* padding 给面板阴影留出发光空间；纵向 flex 让面板横向撑满窗口
   （justify-content: stretch 对主轴无效，会让面板按内容宽收缩、右侧留白），
   超长内容内部滚动 */
.petmenu-root {
  width: 100%;
  height: 100vh;
  box-sizing: border-box;
  padding: 8px;
  display: flex;
  flex-direction: column;
}
</style>
