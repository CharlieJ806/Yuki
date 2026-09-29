<script setup>
/** 主页 —— 今日概览 + 实时进账/学习进度 + 语录 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { state, doCheckIn } from '../stores/app.js'
import { formatDuration } from '@shared/moyu.js'
import { surfaceText } from '@shared/disguise.js'

const emit = defineEmits(['navigate'])
const clock = ref(new Date())
let timer = null

/* 可见文案走伪装词汇表（shared/disguise.js），组件不再就地三元判断 */
const txt = computed(() => surfaceText(Boolean(state.settings.studyDisguise)))

const quote = computed(() => {
  const quotes = txt.value.heroQuotes
  const idx = (clock.value.getDate() + clock.value.getMonth()) % quotes.length
  return quotes[idx]
})

const weekday = computed(() => '日一二三四五六'[clock.value.getDay()])
const dateText = computed(
  () => `${clock.value.getFullYear()}年${clock.value.getMonth() + 1}月${clock.value.getDate()}日 星期${weekday.value}`,
)

const stats = computed(() => [
  { label: txt.value.earnedLabel, value: state.todayEarnedText, accent: true },
  { label: txt.value.dailySalaryLabel, value: state.dailySalaryText },
  { label: txt.value.workedLabel, value: formatDuration(state.snapshot.workedPaidMinutes) },
  /* 统一墙上时钟口径：这里回答的是「还有多久下班」 */
  { label: '剩余工时', value: formatDuration(state.snapshot.remainingWorkMinutes) },
  { label: txt.value.totalLabel, value: `${state.days} 天` },
  { label: '连续打卡', value: `${state.streak} 天` },
  { label: '本月工作日', value: `${state.workDaysThisMonth} 天` },
  /* 等级名含「摸鱼」字样：转换在词汇表（txt.levelName），组件不判开关 */
  { label: '当前等级', value: txt.value.levelName(state.level.level.name) },
])

/** 实时逐秒计息：按秒把当前进度折算成钱（伪装下为学习词数），视觉上更有"进账感" */
const flowing = ref(0)
function tickFlow() {
  const s = state.snapshot
  const perMinute = s.paidSpanMinutes > 0 ? s.dailySalary / s.paidSpanMinutes : 0
  flowing.value = s.todayEarned + (perMinute * (Date.now() % 60000)) / 60000
}
const flowingText = computed(() => {
  const v = state.snapshot.isWorkingNow ? flowing.value : state.snapshot.todayEarned
  /*
   * v 是渲染层自己逐秒算出来的活值 —— 出口的 state.todayEarnedText 只是
   * getState 那一刻的快照，没法覆盖它。所以这里仍然要格式化，但「金额还是
   * 学习词数」由词汇表（txt.amountText）决定：组件只按开关取表，不判开关。
   */
  return txt.value.amountText(v, state.settings.salaryCurrency, state.snapshot.dailySalary)
})

const statusLabel = computed(() => {
  switch (state.snapshot.statusKind) {
    case 'rest-day':
      return txt.value.restDay
    case 'before-work':
      return txt.value.beforeWork
    case 'completed':
      return txt.value.doneShort
    default:
      return txt.value.working
  }
})

onMounted(() => {
  timer = window.setInterval(() => {
    clock.value = new Date()
    tickFlow()
  }, 1000)
  tickFlow()
})
onUnmounted(() => timer && window.clearInterval(timer))
</script>

<template>
  <div class="home">
    <section class="hero card">
      <div class="hero-left">
        <p class="hero-date">{{ dateText }}</p>
        <h1 class="hero-amount tabular">{{ flowingText }}</h1>
        <p class="hero-sub">
          {{ txt.earnedTitle }} ·
          <span :class="{ hl: state.snapshot.isWorkingNow }">{{ state.snapshot.isWorkingNow ? txt.liveWorking : statusLabel }}</span>
        </p>
        <div class="hero-bar">
          <div class="hero-fill" :style="{ width: (state.snapshot.progressPercent ?? 0) + '%' }" />
        </div>
        <p class="hero-meta tabular">
          进度 {{ state.snapshot.progressPercent }}% · {{ state.payday.text }} · 距离今日下班还需
          {{ formatDuration(state.snapshot.remainingWorkMinutes) }}
        </p>
      </div>
      <div class="hero-right">
        <div class="level-ring" :style="{ '--lv-color': state.level.level.color }">
          <span class="ring-value">{{ state.days }}</span>
          <span class="ring-label">{{ txt.daysLabel }}</span>
        </div>
        <p class="level-name" :style="{ color: state.level.level.color }">{{ txt.levelName(state.level.level.name) }}</p>
        <p class="level-progress tabular">
          {{ state.level.isMaxLevel ? '已满级' : `距 ${txt.levelName(state.level.nextLevel.name)} 还需 ${state.level.daysToNext} 天` }}
        </p>
      </div>
    </section>

    <section class="quote card">
      <span class="quote-mark">「</span>
      <p>{{ quote }}</p>
    </section>

    <section class="grid">
      <div v-for="s in stats" :key="s.label" class="stat card" :class="{ accent: s.accent }">
        <p class="stat-label">{{ s.label }}</p>
        <p class="stat-value tabular">{{ s.value }}</p>
      </div>
    </section>

    <section class="actions card">
      <div>
        <p class="actions-title">快捷操作</p>
        <p class="actions-sub">{{ txt.actionsSub }}</p>
      </div>
      <div class="actions-btns">
        <button class="btn btn-primary" :disabled="state.checkedInToday" @click="doCheckIn()">
          {{ state.checkedInToday ? '今日已打卡' : '立即打卡' }}
        </button>
        <button class="btn" @click="emit('navigate', 'records')">查看打卡记录</button>
        <button class="btn" @click="emit('navigate', 'settings')">调整薪酬设置</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 22px 24px;
}
.hero-left {
  min-width: 0;
  flex: 1;
}
.hero-date {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.hero-amount {
  margin: 6px 0 2px;
  font-size: 40px;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: rgb(var(--theme-accent));
  line-height: 1.05;
}
.hero-sub {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--text-2);
}
.hero-sub .hl {
  color: rgb(var(--theme-accent));
  font-weight: 700;
}
.hero-bar {
  height: 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.07);
  overflow: hidden;
  max-width: 460px;
}
html.dark .hero-bar {
  background: rgba(255, 255, 255, 0.09);
}
.hero-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, rgb(var(--theme-accent)), rgb(var(--theme-accent-light)));
  transition: width 0.6s ease;
}
.hero-meta {
  margin: 9px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
}

.hero-right {
  flex: 0 0 auto;
  text-align: center;
}
.level-ring {
  width: 104px;
  height: 104px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  align-content: center;
  border: 3px solid var(--lv-color, #9ca3af);
  background: color-mix(in srgb, var(--lv-color, #9ca3af) 10%, transparent);
}
.ring-value {
  font-size: 26px;
  font-weight: 800;
  line-height: 1;
  color: var(--text-1);
}
.ring-label {
  font-size: 10px;
  color: var(--text-3);
  margin-top: 3px;
}
.level-name {
  margin: 8px 0 2px;
  font-size: 13px;
  font-weight: 700;
}
.level-progress {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
}

.quote {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 18px;
}
.quote-mark {
  font-size: 22px;
  line-height: 1;
  color: rgb(var(--theme-accent));
  font-weight: 800;
}
.quote p {
  margin: 0;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 12px;
}
.stat {
  padding: 14px 16px;
}
.stat.accent {
  border-color: rgb(var(--theme-accent) / 0.4);
  background: var(--theme-accent-soft);
}
html.dark .stat.accent {
  background: rgb(var(--theme-accent) / 0.12);
}
.stat-label {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
}
.stat-value {
  margin: 6px 0 0;
  font-size: 19px;
  font-weight: 700;
  color: var(--text-1);
}
.stat.accent .stat-value {
  color: rgb(var(--theme-accent));
}

.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 20px;
  flex-wrap: wrap;
}
.actions-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 700;
}
.actions-sub {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.actions-btns {
  display: flex;
  gap: 9px;
  flex-wrap: wrap;
}
</style>
