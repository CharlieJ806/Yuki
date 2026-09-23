<script setup>
/**
 * 侧边栏 —— 对齐 momoyu 结构：
 * 顶部品牌 + 收起按钮 / 中部导航 / 底部 摸鱼进度卡 + 用户区 + 打卡按钮。
 */
import { computed, onMounted, ref } from 'vue'
import { state, doCheckIn, win, openChatWindow } from '../stores/app.js'
import { formatDuration, formatMoney, REST_PATTERNS } from '@shared/moyu.js'
import { AFFINITY_GAIN, CHAT_AFFINITY_DAILY_CAP, affinityLevel } from '@shared/interactions.js'

const props = defineProps({
  nav: { type: Array, required: true },
  active: { type: String, required: true },
  collapsed: { type: Boolean, default: false },
  brand: { type: String, default: '摸鱼桌宠' },
  tagline: { type: String, default: '' },
})
const emit = defineEmits(['navigate', 'toggle-collapse'])

const checking = ref(false)
const popped = ref(false)
const levelOpen = ref(false)
const progressOpen = ref(false)
/* 桌宠当前是否可见 —— 按钮文案要如实反映，否则用户点了没反应会以为坏了 */
const petVisible = ref(true)

async function togglePetVisible() {
  const visible = await win.togglePet()
  petVisible.value = Boolean(visible)
}

onMounted(async () => {
  const visible = await win.petVisible?.()
  if (typeof visible === 'boolean') petVisible.value = visible
})

const snapshot = computed(() => state.snapshot)
const progressPercent = computed(() => snapshot.value.progressPercent ?? 0)

/** 节假日标签文案：调休与法定假日分别提示 */
const holidayBadge = computed(() => {
  const h = state.holiday
  if (!h?.name) return ''
  if (h.isMakeup) return `🔁 ${h.name}调休上班`
  if (h.isStatutory) return `🎉 ${h.name}`
  return ''
})
const statusText = computed(() => {
  if (!state.settings.enabled) return '摸鱼进度未开启'
  switch (snapshot.value.statusKind) {
    case 'rest-day':
      return '今日休息'
    case 'before-work':
      return '尚未开工'
    case 'completed':
      return '今日已赚满'
    default:
      return '摸鱼进行中'
  }
})

const restLabel = computed(() => {
  const s = state.settings
  const preset = REST_PATTERNS.find((p) => p.id === s.restPattern)
  if (s.restPattern === 'irregular') return `${preset?.label ?? '不定休'}（月休 ${s.customRestDays} 天）`
  return preset?.label ?? '-'
})

const detailRows = computed(() => [
  { label: '发薪日', value: `每月 ${state.settings.payDay} 日` },
  { label: state.payday.today ? '今天' : '距发薪', value: state.payday.today ? '今日发薪' : `${state.payday.days} 天`, highlight: state.payday.today },
  { label: '月薪', value: state.settings.studyDisguise ? '***' : state.salaryText },
  { label: '日薪', value: state.settings.studyDisguise ? '***' : state.dailySalaryText },
  { label: '工作时间', value: `${state.settings.workStart} – ${state.settings.workEnd}` },
  { label: '每日休息', value: formatDuration(state.settings.dailyRestHours * 60) },
  { label: '月休方式', value: restLabel.value },
  { label: '本月工作日', value: `${snapshot.value.workDaysInMonth} 天` },
  { label: '已摸鱼时长', value: formatDuration(snapshot.value.workedPaidMinutes) },
  /* 「剩余」统一用墙上时钟口径（还有多久下班），与气泡一致 */
  { label: '剩余', value: formatDuration(snapshot.value.remainingWorkMinutes) },
])

/** 亲密度：等级进度 + 得分规则文案，展示在等级面板里 */
const affinity = computed(() => affinityLevel(state.affinity?.points ?? 0))
const affinityGain = computed(() => ({ ...AFFINITY_GAIN, chatDailyCap: CHAT_AFFINITY_DAILY_CAP }))

const checkinLabel = computed(() => {
  if (checking.value) return '打卡中...'
  return state.checkedInToday ? '今日已打卡' : '今日打卡'
})

async function onCheckIn() {
  if (checking.value) return
  if (state.checkedInToday) {
    emit('navigate', 'records')
    return
  }
  checking.value = true
  try {
    const result = await doCheckIn()
    if (result?.created) {
      popped.value = true
      window.setTimeout(() => (popped.value = false), 400)
    }
  } finally {
    checking.value = false
  }
}

function goto(key) {
  emit('navigate', key)
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="brand">
      <h1 class="brand-title">{{ brand }}</h1>
      <p class="brand-tag">{{ tagline }}</p>
      <button class="toggle" :title="collapsed ? '展开侧栏' : '收起侧栏'" @click="emit('toggle-collapse')">
        {{ collapsed ? '»' : '«' }}
      </button>
    </div>

    <nav class="nav">
      <button
        v-for="item in nav"
        :key="item.key"
        class="nav-item"
        :class="{ active: active === item.key, iconOnly: collapsed }"
        :title="item.name"
        @click="goto(item.key)"
      >
        <span class="nav-icon">{{ item.icon }}</span>
        <span v-show="!collapsed" class="nav-text">{{ item.name }}</span>
      </button>
    </nav>

    <div class="footer">
      <!-- 摸鱼进度卡 -->
      <div v-show="!collapsed" class="widget-wrap">
        <button class="widget" @click="progressOpen = !progressOpen">
          <div class="widget-head">
            <span class="widget-title">{{ state.settings.studyDisguise ? '今日学习进度' : '今日摸鱼收入' }}</span>
            <span class="widget-cog">⚙</span>
          </div>
          <p class="widget-amount tabular">{{ state.todayEarnedText }}</p>
          <p class="widget-countdown tabular" :class="{ highlight: state.payday.today }">
            {{ state.payday.text }}
          </p>

          <!-- 节假日 / 调休标签：调休是「该休息却要上班」，值得单独提示 -->
          <p v-if="holidayBadge" class="widget-holiday" :class="{ makeup: state.holiday?.isMakeup }">
            {{ holidayBadge }}
          </p>
          <div class="bar">
            <div class="bar-fill" :class="{ pulsing: snapshot.isWorkingNow }" :style="{ width: progressPercent + '%' }" />
          </div>
          <div class="widget-foot">
            <span class="status">
              <i class="dot" :class="[snapshot.statusKind, { pulse: snapshot.isWorkingNow }]" />
              {{ statusText }}
            </span>
            <span class="tabular">{{ progressPercent }}%</span>
          </div>
        </button>

        <transition name="detail">
          <div v-if="progressOpen" class="detail card">
            <p class="detail-title">摸鱼收入详情</p>
            <ul>
              <li v-for="row in detailRows" :key="row.label">
                <span class="d-label">{{ row.label }}</span>
                <span class="d-value tabular" :class="{ hl: row.highlight }">{{ row.value }}</span>
              </li>
            </ul>
            <p class="detail-hint">点击卡片可前往设置</p>
          </div>
        </transition>
      </div>

      <!-- 托底：用户区 + 打卡 -->
      <div class="footer-actions">
        <div class="level-wrap">
          <button class="profile" :class="{ iconOnly: collapsed }" @click="goto('settings')">
            <span class="avatar">🐟</span>
            <div v-show="!collapsed" class="profile-text">
              <p class="profile-name">摸鱼打工人</p>
              <button class="level-badge" :style="{ color: state.level.level.color }" @click.stop="levelOpen = !levelOpen">
                {{ state.level.level.name }}
              </button>
            </div>
          </button>

          <transition name="detail">
            <div v-if="levelOpen && !collapsed" class="level-panel card">
              <p class="detail-title">摸鱼等级规则</p>
              <ul class="level-list">
                <li
                  v-for="lv in state.meta.levels"
                  :key="lv.minDays"
                  :class="{ reached: state.days >= lv.minDays }"
                  :style="state.days >= lv.minDays ? { color: lv.color } : null"
                >
                  <i class="lv-dot" :style="{ background: lv.color }" />
                  摸鱼天数 ≥ {{ lv.minDays }}：{{ lv.name }}
                </li>
              </ul>
              <div class="level-foot">
                <span>当前 {{ state.days }} 天 · 连续 {{ state.streak }} 天</span>
                <span class="tabular" :style="{ color: state.level.level.color }">{{ state.level.level.name }}</span>
              </div>
              <div v-if="!state.level.isMaxLevel" class="bar">
                <div class="bar-fill" :style="{ width: state.level.progress + '%', background: state.level.level.color }" />
              </div>
              <p class="detail-hint">
                {{
                  state.level.isMaxLevel
                    ? '已满级，继续保持摸鱼节奏'
                    : `升级进度 ${Math.round(state.level.progress)}%，距 ${state.level.nextLevel.name} 还需 ${state.level.daysToNext} 天`
                }}
              </p>

              <!-- 亲密度：和摸鱼天数分开算，但一起展示，省得再开一个面板 -->
              <p class="detail-title" style="margin-top: 12px">亲密度</p>
              <div class="bar">
                <div class="bar-fill" :style="{ width: affinity.progress + '%' }" />
              </div>
              <div class="level-foot">
                <span>Yuki · {{ affinity.level.name }}</span>
                <span class="tabular">{{ state.affinity?.points ?? 0 }}/{{ state.affinity?.max ?? 300 }}</span>
              </div>
              <p class="detail-hint">
                {{
                  affinity.isMax
                    ? '关系最好的一档，她说话也最黏人'
                    : `再互动 ${affinity.toNext} 次升到「${affinity.level.next.name}」；聊天一条 +${affinityGain.chatMessage}，每日上限 ${affinityGain.chatDailyCap} 点`
                }}
                <template v-if="state.affinity?.streakDays > 1"> · 连续 {{ state.affinity.streakDays }} 天</template>
              </p>
            </div>
          </transition>
        </div>

        <button
          class="checkin"
          :class="{ done: state.checkedInToday, iconOnly: collapsed }"
          :disabled="checking"
          :title="checkinLabel"
          @click="onCheckIn"
        >
          <span class="checkin-icon" :class="{ pop: popped }">{{ state.checkedInToday ? '✓' : '🎉' }}</span>
          <span v-show="!collapsed">{{ checkinLabel }}</span>
        </button>

        <button
          class="pet-btn"
          :class="{ iconOnly: collapsed, off: !petVisible }"
          :title="petVisible ? '隐藏桌宠（可从托盘找回）' : '显示桌宠'"
          @click="togglePetVisible"
        >
          <span class="nav-icon">{{ petVisible ? '🐱' : '🐾' }}</span>
          <span v-show="!collapsed">{{ petVisible ? '隐藏桌宠' : '显示桌宠' }}</span>
        </button>

        <button class="pet-btn" :class="{ iconOnly: collapsed }" title="和 Yuki 聊天" @click="openChatWindow()">
          <span class="nav-icon">💭</span>
          <span v-show="!collapsed">和 Yuki 聊天</span>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 256px;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border-right: 1px solid var(--border);
  transition: width 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  position: relative;
}
.sidebar.collapsed {
  width: 76px;
}

.brand {
  position: relative;
  padding: 22px 20px 14px;
}
.brand-title {
  margin: 0;
  font-size: 21px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: rgb(var(--theme-accent));
  white-space: nowrap;
}
.sidebar.collapsed .brand-title,
.sidebar.collapsed .brand-tag {
  display: none;
}
.brand-tag {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toggle {
  position: absolute;
  right: -13px;
  top: 26px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-2);
  box-shadow: var(--shadow-card);
  line-height: 1;
  z-index: 5;
}
.toggle:hover {
  color: rgb(var(--theme-accent));
  border-color: rgb(var(--theme-accent));
}

.nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  border: none;
  border-radius: 11px;
  background: transparent;
  color: var(--text-2);
  font-size: 13.5px;
  font-weight: 500;
  text-align: left;
  transition: all 0.15s ease;
}
.nav-item:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.nav-item.active {
  background: var(--theme-accent-soft);
  color: rgb(var(--theme-accent));
  font-weight: 700;
}
html.dark .nav-item.active {
  background: rgb(var(--theme-accent) / 0.16);
}
.nav-item.iconOnly {
  justify-content: center;
  padding: 10px 0;
}
.nav-icon {
  font-size: 16px;
  flex: 0 0 auto;
  width: 20px;
  text-align: center;
}
.nav-text {
  white-space: nowrap;
}

.footer {
  margin-top: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 摸鱼进度卡 */
.widget {
  width: 100%;
  text-align: left;
  padding: 11px 12px;
  border-radius: 13px;
  border: 1px solid rgb(var(--theme-accent) / 0.35);
  background: var(--theme-accent-soft);
  transition: all 0.16s ease;
}
html.dark .widget {
  background: rgb(var(--theme-accent) / 0.12);
}
.widget:hover {
  box-shadow: var(--shadow-card);
}
.widget-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.widget-title {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-2);
}
.widget-cog {
  font-size: 11px;
  color: var(--text-3);
}
.widget-amount {
  margin: 5px 0 1px;
  font-size: 21px;
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: rgb(var(--theme-accent));
}
.widget-countdown {
  margin: 0 0 8px;
  font-size: 10.5px;
  color: var(--text-3);
}
.widget-countdown.highlight {
  color: rgb(var(--theme-accent));
  font-weight: 600;
}
.widget-holiday {
  display: inline-block;
  margin: 0 0 7px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  background: rgb(var(--theme-accent) / 0.14);
  color: rgb(var(--theme-accent));
}
/* 调休用暖色区分：这是「本该休息却要上班」，和放假的情绪正相反 */
.widget-holiday.makeup {
  background: rgba(251, 146, 60, 0.18);
  color: #c2410c;
}
.bar {
  height: 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.08);
  overflow: hidden;
}
html.dark .bar {
  background: rgba(255, 255, 255, 0.1);
}
.bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, rgb(var(--theme-accent)), rgb(var(--theme-accent-light)));
  transition: width 0.6s ease;
}
.bar-fill.pulsing {
  animation: shimmer 1.8s ease-in-out infinite;
}
@keyframes shimmer {
  0%,
  100% {
    filter: brightness(1);
  }
  50% {
    filter: brightness(1.28);
  }
}
.widget-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 7px;
  font-size: 10.5px;
  color: var(--text-3);
}
.status {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #d1d5db;
  flex: 0 0 auto;
}
.dot.working {
  background: #fbbf24;
}
.dot.completed,
.dot.rest-day {
  background: rgb(var(--theme-accent));
}
.dot.pulse {
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

/* 详情面板 */
.widget-wrap {
  position: relative;
}
.detail {
  margin-top: 8px;
  padding: 11px 12px;
}
.detail-title {
  margin: 0 0 8px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-1);
}
.detail ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.detail li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
}
.d-label {
  color: var(--text-3);
  flex: 0 0 auto;
}
.d-value {
  color: var(--text-1);
  font-weight: 600;
  text-align: right;
}
.d-value.hl {
  color: rgb(var(--theme-accent));
}
.detail-hint {
  margin: 8px 0 0;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  font-size: 10px;
  color: var(--text-3);
}

/* 等级面板 */
.level-wrap {
  position: relative;
}
.level-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  padding: 11px 12px;
  z-index: 6;
}
.level-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.level-list li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
}
.level-list li.reached {
  font-weight: 700;
}
.lv-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.level-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 9px 0 6px;
  font-size: 10.5px;
  color: var(--text-2);
}

/* 用户区 */
.footer-actions {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.profile {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border: none;
  background: transparent;
  border-radius: 11px;
  text-align: left;
}
.profile:hover {
  background: var(--bg-subtle);
}
.profile.iconOnly {
  justify-content: center;
}
.avatar {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--theme-accent-soft);
  display: grid;
  place-items: center;
  font-size: 16px;
}
html.dark .avatar {
  background: rgb(var(--theme-accent) / 0.16);
}
.profile-text {
  min-width: 0;
}
.profile-name {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.level-badge {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 10.5px;
  font-weight: 700;
  text-decoration: underline dotted;
}

/* 打卡按钮 */
.checkin {
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: none;
  border-radius: 12px;
  font-size: 13.5px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, rgb(var(--theme-accent)), rgb(var(--theme-accent-light)));
  box-shadow: 0 4px 14px rgb(var(--theme-accent) / 0.35);
  transition: all 0.16s ease;
}
.checkin:hover:not(:disabled) {
  filter: brightness(1.06);
}
.checkin.done {
  background: var(--theme-accent-soft);
  color: rgb(var(--theme-accent));
  box-shadow: none;
}
html.dark .checkin.done {
  background: rgb(var(--theme-accent) / 0.16);
}
.checkin.iconOnly {
  padding: 0;
}
.checkin:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.checkin-icon.pop {
  animation: pop 0.4s ease;
}
@keyframes pop {
  0% {
    transform: scale(1);
  }
  45% {
    transform: scale(1.5) rotate(-8deg);
  }
  100% {
    transform: scale(1);
  }
}

.pet-btn {
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
}
.pet-btn:hover {
  color: rgb(var(--theme-accent));
  border-color: rgb(var(--theme-accent));
}
/* 桌宠已隐藏时给个明显的视觉提示，避免用户以为按钮坏了 */
.pet-btn.off {
  border-style: dashed;
  color: var(--text-3);
}
.pet-btn.off:hover {
  color: rgb(var(--theme-accent));
  border-color: rgb(var(--theme-accent));
}

.sidebar.collapsed .widget-wrap,
.sidebar.collapsed .brand-tag {
  display: none;
}

.detail-enter-active,
.detail-leave-active {
  transition: all 0.18s ease;
}
.detail-enter-from,
.detail-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
