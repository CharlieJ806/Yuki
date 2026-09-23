<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { state, refresh, loadMeta, initBridge, win } from '../stores/app.js'
import Sidebar from '../components/Sidebar.vue'
import HomeView from '../views/HomeView.vue'
import LabView from '../views/LabView.vue'
import RecordsView from '../views/RecordsView.vue'
import GalleryView from '../views/GalleryView.vue'
import SettingsView from '../views/SettingsView.vue'

const route = ref('home')
const collapsed = ref(false)
let stopBridge = null
let timer = null

const NAV = [
  { key: 'home', name: '主页', icon: '🏠' },
  { key: 'lab', name: '摸鱼研究院', icon: '🧪' },
  { key: 'gallery', name: '图鉴', icon: '👗' },
  { key: 'records', name: '打卡记录', icon: '📅' },
  { key: 'settings', name: '设置', icon: '⚙️' },
]
const VIEWS = {
  home: HomeView,
  gallery: GalleryView,
  lab: LabView,
  records: RecordsView,
  settings: SettingsView,
}

const currentView = computed(() => VIEWS[route.value] ?? HomeView)
const currentTitle = computed(() => NAV.find((n) => n.key === route.value)?.name ?? '主页')

const brand = computed(() => (state.settings.studyDisguise ? 'Study Desk' : '摸鱼桌宠'))
const tagline = computed(() => (state.settings.studyDisguise ? '专注当下，持续精进' : '只要胆子大，一周七天假'))

function toggleCollapse() {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem('panel-collapsed', String(collapsed.value))
  } catch {
    /* storage 不可用时忽略 */
  }
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark')
  try {
    localStorage.setItem('panel-dark', dark ? '1' : '0')
  } catch {
    /* ignore */
  }
}

onMounted(async () => {
  try {
    collapsed.value = localStorage.getItem('panel-collapsed') === 'true'
    if (localStorage.getItem('panel-dark') === '1') document.documentElement.classList.add('dark')
  } catch {
    /* ignore */
  }
  stopBridge = initBridge()
  await loadMeta()
  await refresh()
  timer = window.setInterval(refresh, 30_000)
})

onBeforeUnmount(() => {
  stopBridge?.()
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <div class="shell" :class="{ collapsed }">
    <Sidebar
      :nav="NAV"
      :active="route"
      :collapsed="collapsed"
      :brand="brand"
      :tagline="tagline"
      @navigate="route = $event"
      @toggle-collapse="toggleCollapse"
    />

    <main class="main">
      <header class="topbar">
        <div class="topbar-left">
          <h2>{{ currentTitle }}</h2>
          <span class="crumb">{{ brand }} · {{ state.backend === 'electron' ? '桌面版' : '预览模式' }}</span>
        </div>
        <div class="topbar-right">
          <span class="chip tabular">今日 {{ state.todayEarnedText }}</span>
          <span class="chip tabular">{{ state.level.level.name }} · {{ state.days }} 天</span>
          <button class="icon-btn" title="切换主题" @click="toggleTheme">◐</button>
          <button class="icon-btn" title="隐藏面板" @click="win.hidePanel()">—</button>
        </div>
      </header>

      <div class="content">
        <component :is="currentView" @navigate="route = $event" />
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-page);
  color: var(--text-1);
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.topbar {
  height: 62px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 22px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
}
.topbar-left h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}
.crumb {
  font-size: 11px;
  color: var(--text-3);
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.chip {
  font-size: 11.5px;
  padding: 5px 10px;
  border-radius: 999px;
  background: var(--theme-accent-soft);
  color: rgb(var(--theme-accent));
  font-weight: 600;
  white-space: nowrap;
}
html.dark .chip {
  background: rgb(var(--theme-accent) / 0.14);
}
.icon-btn {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text-2);
  line-height: 1;
}
.icon-btn:hover {
  color: rgb(var(--theme-accent));
  border-color: rgb(var(--theme-accent));
}

.content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 22px 28px;
}
</style>
