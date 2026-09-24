<script setup>
/**
 * petmenu 窗宿主 —— 桌宠右键菜单的独立小窗（?route=petmenu），两种壳同构：
 *
 * - Tauri：Rust 建 petmenu 窗，pet_menu_show 定位到光标（工作区钳制防溢出）；
 * - Electron：主进程建同规格 BrowserWindow，screen.getCursorScreenPoint 定位。
 *
 * 本窗常驻隐藏，右键时显示；任意动作 / 失焦 / Esc 后藏回，不销毁。
 * 动作分两类：
 * - 业务（打卡/面板/对话/换装/缩放）：走 store 总线，与桌宠窗内同一套通道；
 * - 桌宠本地行为（气泡开关、退出挥手）：sendPetUi 经 service 广播回桌宠窗执行。
 */
import { onBeforeUnmount, onMounted } from 'vue'
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

/** 缩放是设置值：算好目标值交给壳层，它会写回设置并同步窗口尺寸 */
async function setScale(next) {
  await window.desk?.setPetScale?.(next)
  await refresh()
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
  try {
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
      case 'scale':
        await setScale(Math.max(0.6, Math.min(2, Number((Number(state.settings.petScale) + a.delta).toFixed(2)))))
        break
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
  } finally {
    hide()
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') hide()
}
function onBlur() {
  hide()
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
})

onBeforeUnmount(() => {
  stopBridge?.()
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('blur', onBlur)
})
</script>

<template>
  <div class="petmenu-root">
    <PetMenu @action="onMenuAction" @close="hide" />
  </div>
</template>

<style scoped>
/* padding 给面板阴影留出发光空间；flex 让面板自适应内容高度、超长内部滚动 */
.petmenu-root {
  width: 100%;
  height: 100vh;
  box-sizing: border-box;
  padding: 8px;
  display: flex;
  justify-content: stretch;
}
</style>
