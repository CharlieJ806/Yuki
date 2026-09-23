<script setup>
/** 打卡记录 —— 月历视图 + 月度统计，对齐 momoyu 的打卡记录页 */
import { computed, onMounted, ref, watch } from 'vue'
import { state, refreshCheckins, doCheckIn, previewBackfill, applyBackfill } from '../stores/app.js'
import { toDateKey, parseDateKey } from '@shared/moyu.js'

const now = new Date()
const year = ref(now.getFullYear())
const month = ref(now.getMonth() + 1)
const loading = ref(false)

/* ---------- 补卡 ---------- */

/** 默认起始日：本月 1 号 —— 大多数人补的是「这个月忘打的那几天」 */
function firstOfMonth() {
  const d = new Date()
  return toDateKey(new Date(d.getFullYear(), d.getMonth(), 1))
}

const backfillOpen = ref(false)
const backfillFrom = ref(firstOfMonth())
const backfillBusy = ref(false)
const backfillMsg = ref('')
const backfillResult = ref(null)
const preview = computed(() => state.backfill)

/** 按周分组，预览列表才不会拉成一条长串 */
const previewByWeek = computed(() => {
  const days = preview.value?.days ?? []
  const groups = []
  for (const d of days) {
    const last = groups[groups.length - 1]
    if (last && last.days.length < 7) last.days.push(d)
    else groups.push({ key: d.dateKey, days: [d] })
  }
  return groups
})

function toggleBackfill() {
  backfillOpen.value = !backfillOpen.value
  backfillMsg.value = ''
  backfillResult.value = null
  if (backfillOpen.value) runPreview()
}

/** 只预览、不写库：写历史之前必须让用户看清会补哪几天 */
async function runPreview() {
  if (!backfillFrom.value) return
  backfillBusy.value = true
  backfillMsg.value = ''
  backfillResult.value = null
  try {
    const result = await previewBackfill(backfillFrom.value)
    if (!result) backfillMsg.value = state.lastError ?? '预览失败'
  } finally {
    backfillBusy.value = false
  }
}

async function runBackfill() {
  const p = preview.value
  if (!p?.count) return
  if (!confirm(`将补写 ${p.from} 至 ${p.to} 之间 ${p.count} 天的工作日打卡，确认吗？`)) return
  backfillBusy.value = true
  try {
    const result = await applyBackfill(backfillFrom.value)
    backfillResult.value = result
    backfillMsg.value = result?.created?.length
      ? `已补 ${result.created.length} 天`
      : '没有需要补的日期'
    /* 补完把日历切到起始月，用户能直接看到结果 */
    const start = parseDateKey(backfillFrom.value)
    if (start) {
      year.value = start.getFullYear()
      month.value = start.getMonth() + 1
    }
  } finally {
    backfillBusy.value = false
  }
}
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

const checkedSet = computed(() => new Set(state.checkins.map((c) => c.dateKey)))

const monthDays = computed(() => {
  const first = new Date(year.value, month.value - 1, 1)
  const total = new Date(year.value, month.value, 0).getDate()
  /* 周一为一周首日 */
  const lead = (first.getDay() + 6) % 7
  const cells = []
  for (let i = 0; i < lead; i++) cells.push({ key: `pad-${i}`, empty: true })
  for (let d = 1; d <= total; d++) {
    const date = new Date(year.value, month.value - 1, d)
    const dateKey = toDateKey(date)
    cells.push({
      key: dateKey,
      day: d,
      dateKey,
      checked: checkedSet.value.has(dateKey),
      today: dateKey === toDateKey(new Date()),
      weekend: date.getDay() === 0 || date.getDay() === 6,
    })
  }
  return cells
})

const monthChecked = computed(() => monthDays.value.filter((c) => c.checked).length)
const totalDays = computed(() => state.days)

function shift(delta) {
  let m = month.value + delta
  let y = year.value
  if (m < 1) {
    m = 12
    y--
  } else if (m > 12) {
    m = 1
    y++
  }
  month.value = m
  year.value = y
}

async function load() {
  loading.value = true
  try {
    await refreshCheckins({ year: year.value, month: month.value })
  } finally {
    loading.value = false
  }
}

watch([year, month], load)
onMounted(async () => {
  await load()
  if (state.checkins.length === 0 && totalDays.value === 0) await load()
})
</script>

<template>
  <div class="records">
    <section class="calendar card">
      <header class="cal-head">
        <button class="nav-btn" @click="shift(-1)">‹</button>
        <div class="cal-title">
          <h3>{{ year }} 年 {{ month }} 月</h3>
          <p>本月打卡 {{ monthChecked }} 天 · 累计 {{ totalDays }} 天</p>
        </div>
        <button class="nav-btn" @click="shift(1)">›</button>
      </header>

      <div class="week-row">
        <span v-for="w in WEEK_LABELS" :key="w">{{ w }}</span>
      </div>

      <div class="days" :class="{ loading }">
        <template v-for="cell in monthDays" :key="cell.key">
          <span v-if="cell.empty" class="day empty" />
          <span
            v-else
            class="day"
            :class="{ checked: cell.checked, today: cell.today, weekend: cell.weekend }"
            :title="cell.dateKey"
          >
            {{ cell.day }}
            <i v-if="cell.checked" class="tick">🐟</i>
          </span>
        </template>
      </div>
    </section>

    <section class="side">
      <div class="card summary">
        <p class="summary-title">统计</p>
        <ul>
          <li><span>累计打卡</span><b class="tabular">{{ totalDays }} 天</b></li>
          <li><span>连续打卡</span><b class="tabular">{{ state.streak }} 天</b></li>
          <li><span>当前等级</span><b :style="{ color: state.level.level.color }">{{ state.level.level.name }}</b></li>
          <li v-if="!state.level.isMaxLevel">
            <span>距下一级</span><b class="tabular">{{ state.level.daysToNext }} 天</b>
          </li>
        </ul>
        <p class="hint">摸鱼天数按累计打卡天数计算，每天仅可打卡一次</p>
      </div>

      <div class="card today-card" :class="{ done: state.checkedInToday }">
        <p class="today-label">今日</p>
        <p class="today-date tabular">{{ state.snapshot.dateKey }}</p>
        <button class="btn btn-primary full" :disabled="state.checkedInToday" @click="doCheckIn().then(load)">
          {{ state.checkedInToday ? '✓ 已完成打卡' : '立即打卡' }}
        </button>
      </div>

      <!-- 补卡：入职日之前的漏打一次性补齐 -->
      <div class="card backfill-card">
        <button class="backfill-head" @click="toggleBackfill">
          <span>
            <b>漏打补卡</b>
            <i>从入职日起，把工作日一次补齐</i>
          </span>
          <span class="backfill-caret">{{ backfillOpen ? '▾' : '▸' }}</span>
        </button>

        <div v-if="backfillOpen" class="backfill-body">
          <label class="backfill-field">
            <span>开始日期</span>
            <input v-model="backfillFrom" type="date" :max="state.snapshot.dateKey" @change="runPreview" />
          </label>
          <p class="backfill-hint">
            只补工作日；周末与法定假日跳过，调休补班日会照常补上。
            {{ preview?.hasHolidayTable ? '' : '（还没取到节假日表，暂时只按周末判断）' }}
          </p>

          <p v-if="backfillBusy" class="backfill-hint">正在核对…</p>

          <template v-else-if="preview">
            <p v-if="preview.count === 0" class="backfill-empty">
              {{ preview.from }} 至 {{ preview.to }} 之间没有需要补的工作日
            </p>
            <template v-else>
              <p class="backfill-count">
                待补 <b class="tabular">{{ preview.count }}</b> 天
                <span class="backfill-range tabular">{{ preview.from }} → {{ preview.to }}</span>
              </p>
              <div class="preview-list">
                <div v-for="g in previewByWeek" :key="g.key" class="preview-week">
                  <span
                    v-for="d in g.days"
                    :key="d.dateKey"
                    class="preview-day tabular"
                    :class="{ makeup: d.isMakeup }"
                    :title="d.holidayName ? `${d.dateKey} ${d.holidayName}${d.isMakeup ? '（补班）' : ''}` : d.dateKey"
                  >
                    {{ d.dateKey.slice(5) }}
                  </span>
                </div>
              </div>
              <button class="btn btn-primary full" :disabled="backfillBusy" @click="runBackfill">
                确认补 {{ preview.count }} 天
              </button>
            </template>
          </template>

          <p v-if="backfillMsg" class="backfill-msg">{{ backfillMsg }}</p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.records {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 268px;
  gap: 16px;
  align-items: start;
}

.calendar {
  padding: 18px 20px 20px;
}
.cal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.cal-title {
  text-align: center;
}
.cal-title h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}
.cal-title p {
  margin: 3px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.nav-btn {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text-2);
  font-size: 16px;
  line-height: 1;
}
.nav-btn:hover {
  color: rgb(var(--theme-accent));
  border-color: rgb(var(--theme-accent));
}

.week-row {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
  margin-bottom: 6px;
}
.week-row span {
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
}

.days {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
  transition: opacity 0.2s ease;
}
.days.loading {
  opacity: 0.5;
}
.day {
  position: relative;
  aspect-ratio: 1 / 1;
  display: grid;
  place-items: center;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  font-size: 12.5px;
  color: var(--text-2);
  transition: all 0.15s ease;
}
.day.empty {
  border: none;
  background: transparent;
}
.day.weekend {
  color: var(--text-3);
}
.day.today {
  outline: 2px solid rgb(var(--theme-accent) / 0.55);
  outline-offset: -1px;
}
.day.checked {
  background: var(--theme-accent-soft);
  border-color: rgb(var(--theme-accent) / 0.45);
  color: rgb(var(--theme-accent));
  font-weight: 700;
}
html.dark .day.checked {
  background: rgb(var(--theme-accent) / 0.16);
}
.tick {
  position: absolute;
  right: 4px;
  bottom: 2px;
  font-size: 9px;
}

.side {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.summary {
  padding: 16px 18px;
}
.summary-title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 700;
}
.summary ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.summary li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
}
.summary li span {
  color: var(--text-3);
}
.summary li b {
  font-weight: 700;
}
.hint {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-size: 10.5px;
  color: var(--text-3);
  line-height: 1.55;
}

.today-card {
  padding: 16px 18px;
  text-align: center;
}
.today-card.done {
  border-color: rgb(var(--theme-accent) / 0.45);
}
.today-label {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
}
.today-date {
  margin: 4px 0 12px;
  font-size: 17px;
  font-weight: 700;
}
.full {
  width: 100%;
}

/* ---------- 补卡 ---------- */
.backfill-card {
  padding: 0;
  overflow: hidden;
}
.backfill-head {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 16px;
  background: var(--bg-surface);
  border: none;
  text-align: left;
}
.backfill-head b {
  display: block;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-1);
}
.backfill-head i {
  display: block;
  margin-top: 3px;
  font-size: 10.5px;
  font-style: normal;
  color: var(--text-3);
}
.backfill-caret {
  font-size: 12px;
  color: var(--text-3);
}
.backfill-body {
  padding: 0 16px 16px;
  border-top: 1px solid var(--border);
}
.backfill-field {
  display: block;
  margin-top: 12px;
}
.backfill-field span {
  display: block;
  margin-bottom: 5px;
  font-size: 11px;
  color: var(--text-3);
}
.backfill-field input {
  width: 100%;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text-1);
  font-size: 12px;
}
.backfill-hint,
.backfill-msg {
  margin: 9px 0 0;
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--text-3);
}
.backfill-msg {
  color: rgb(var(--theme-accent));
  font-weight: 600;
}
.backfill-empty {
  margin: 10px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.backfill-count {
  margin: 11px 0 7px;
  font-size: 12.5px;
  color: var(--text-2);
}
.backfill-count b {
  font-size: 15px;
  color: rgb(var(--theme-accent));
}
.backfill-range {
  display: block;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-3);
}
/* 预览清单：一天一格，两行以上就换行，避免撑破 268px 的侧栏 */
.preview-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
  max-height: 168px;
  overflow-y: auto;
}
.preview-week {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.preview-day {
  padding: 2px 5px;
  border-radius: 6px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  font-size: 10px;
  color: var(--text-2);
}
.preview-day.makeup {
  border-color: rgb(var(--theme-accent) / 0.5);
  color: rgb(var(--theme-accent));
}

@media (max-width: 900px) {
  .records {
    grid-template-columns: 1fr;
  }
}
</style>
