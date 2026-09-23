<script setup>
/**
 * 摸鱼研究院 —— 两个子模块：
 * 1) 工作性价比计算器：把薪酬/工时/生活成本折算成一个"值不值得苟"的分数
 * 2) 生命电量：按上班时间占比，算出一天/一周/一年里属于你自己的时间还剩多少
 */
import { computed, ref } from 'vue'
import { formatMoney, formatDuration } from '@shared/moyu.js'
import { state } from '../stores/app.js'

const tab = ref('calculator')
const prefilled = ref(false)

/* ---------- 计算器输入 ---------- */
const input = ref({
  monthlySalary: 10000,
  workStart: '09:00',
  workEnd: '18:00',
  dailyRestHours: 2,
  workDaysPerMonth: 21.75,
  commuteHours: 1,
  overtimeHoursPerWeek: 0,
  housingCost: 2000,
  livingCost: 2500,
  education: 'bachelor',
  cityTier: 'tier1',
  remote: 'onsite',
  stressLevel: 3,
  growthLevel: 3,
})

const EDUCATION = [
  { id: 'highschool', label: '高中及以下', weight: 0.8 },
  { id: 'college', label: '大专', weight: 0.9 },
  { id: 'bachelor', label: '本科', weight: 1 },
  { id: 'master', label: '硕士', weight: 1.08 },
  { id: 'phd', label: '博士', weight: 1.15 },
]
const CITY = [
  { id: 'tier1', label: '一线城市', costIndex: 1.35, ppp: 0.62 },
  { id: 'tier2', label: '二线城市', costIndex: 1.1, ppp: 0.78 },
  { id: 'tier3', label: '三线城市', costIndex: 1, ppp: 0.9 },
  { id: 'town', label: '乡镇/县城', costIndex: 0.85, ppp: 1 },
]
const REMOTE = [
  { id: 'onsite', label: '全坐班', penalty: 0 },
  { id: 'hybrid', label: '混合办公', penalty: 0.04 },
  { id: 'remote', label: '全远程居家', penalty: 0.08 },
]

function prefillFromSettings() {
  const s = state.settings
  input.value.monthlySalary = Number(s.salary) || input.value.monthlySalary
  input.value.workStart = s.workStart
  input.value.workEnd = s.workEnd
  input.value.dailyRestHours = Number(s.dailyRestHours) || 0
  input.value.workDaysPerMonth = state.snapshot.workDaysInMonth || input.value.workDaysPerMonth
  prefilled.value = true
}

const computedResult = computed(() => {
  const i = input.value
  const toMin = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const spanHours = Math.max(0, (toMin(i.workEnd) - toMin(i.workStart)) / 60)
  const paidHoursPerDay = Math.max(0, spanHours - Number(i.dailyRestHours || 0))
  const dailyTotalHours = spanHours + Number(i.commuteHours || 0)

  const monthlyOvertime = (Number(i.overtimeHoursPerWeek || 0) * 52) / 12
  const monthlyHours = paidHoursPerDay * Number(i.workDaysPerMonth || 0) + monthlyOvertime
  const hourlyRate = monthlyHours > 0 ? Number(i.monthlySalary || 0) / monthlyHours : 0

  /* 真实可支配：扣掉住宿+生活成本 */
  const disposable = Math.max(0, Number(i.monthlySalary || 0) - Number(i.housingCost || 0) - Number(i.livingCost || 0))
  const city = CITY.find((c) => c.id === i.cityTier) ?? CITY[1]
  const edu = EDUCATION.find((e) => e.id === i.education) ?? EDUCATION[2]
  const remote = REMOTE.find((r) => r.id === i.remote) ?? REMOTE[0]

  /* 生活时间占比：一天里不属于工作(含通勤)的比例 */
  const lifeRatio = dailyTotalHours > 0 ? Math.max(0, (24 - dailyTotalHours) / 24) : 1

  /* 综合分：时薪(PPP折算) × 生活时间 × 成长 × 学历 × 远程 × 压力修正 */
  const pppHourly = hourlyRate * city.ppp
  const stressFactor = 1 - (Number(i.stressLevel || 3) - 3) * 0.08
  const growthFactor = 0.85 + (Number(i.growthLevel || 3) - 1) * 0.075
  const raw = (pppHourly / 50) * (0.55 + lifeRatio * 0.9) * stressFactor * growthFactor * edu.weight * (1 + remote.penalty)
  const score = Math.max(0, Math.min(100, Math.round(raw * 100)))

  const grade =
    score >= 85
      ? { label: '梦中情职，别乱动', color: '#16a34a' }
      : score >= 70
        ? { label: '相当能苟，稳住', color: '#22c55e' }
        : score >= 55
          ? { label: '中规中矩，可苟可看', color: '#eab308' }
          : score >= 40
            ? { label: '性价比偏低，留意机会', color: '#f97316' }
            : { label: '严重冲突，建议尽快调整', color: '#dc2626' }

  const percentile = Math.max(1, Math.min(99, Math.round(score * 0.92)))

  const breakdown = [
    { label: '有效时薪（PPP 折算）', value: formatMoney(pppHourly) + '/小时' },
    { label: '名义时薪', value: formatMoney(hourlyRate) + '/小时' },
    { label: '月均工时（含加班）', value: `${monthlyHours.toFixed(1)} 小时` },
    { label: '月可支配结余', value: formatMoney(disposable) },
    { label: '每日自由时间占比', value: `${Math.round(lifeRatio * 100)}%` },
    { label: '日均在岗时长', value: formatDuration(dailyTotalHours * 60) },
    { label: '压力修正系数', value: stressFactor.toFixed(2) },
    { label: '成长修正系数', value: growthFactor.toFixed(2) },
  ]

  return { score, grade, percentile, hourlyRate, pppHourly, monthlyHours, disposable, lifeRatio, breakdown }
})

/* ---------- 生命电量 ---------- */
const battery = computed(() => {
  const s = state.settings
  const toMin = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const workHours = Math.max(0, (toMin(s.workEnd) - toMin(s.workStart)) / 60)
  const sleep = 8
  const freePerDay = Math.max(0, 24 - workHours - sleep)

  const weekWork = workHours * 5
  const weekFree = freePerDay * 7
  const yearWorkDays = state.workDaysThisMonth * 12
  const yearWork = workHours * yearWorkDays
  const yearFree = 24 * 365 - yearWork - sleep * 365

  /* 职业生涯：按 22 岁入职、60 岁退休计算 */
  const careerYears = 38
  const careerWork = yearWork * careerYears
  const careerTotal = 24 * 365 * careerYears + sleep * 365 * careerYears
  const workPercentOfLife = (yearWork / (24 * 365)) * 100

  return {
    freePerDay,
    weekWork,
    weekFree,
    yearWork,
    yearFree,
    careerWork,
    careerYears,
    workPercentOfLife,
    daily: { work: workHours, free: freePerDay, sleep },
    lifeRemainingPercent: 100 - workPercentOfLife,
  }
})

const batteryPercent = computed(() => Math.max(0, Math.min(100, Math.round(battery.value.lifeRemainingPercent))))

function copyReport() {
  const r = computedResult.value
  const text = [
    `【我的工作性价比报告】${r.score} 分 · ${r.grade.label}`,
    `超越全国约 ${r.percentile}% 的打工人`,
    ...r.breakdown.map((b) => `${b.label}：${b.value}`),
  ].join('\n')
  navigator.clipboard?.writeText(text)
  copied.value = true
  window.setTimeout(() => (copied.value = false), 1600)
}
const copied = ref(false)
</script>

<template>
  <div class="lab">
    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'calculator' }" @click="tab = 'calculator'">工作性价比计算器</button>
      <button class="tab" :class="{ active: tab === 'battery' }" @click="tab = 'battery'">生命电量</button>
    </div>

    <!-- 计算器 -->
    <div v-if="tab === 'calculator'" class="calc">
      <section class="card form">
        <div class="form-head">
          <div>
            <p class="form-title">薪酬与时间</p>
            <p class="form-sub">检测到已配置摸鱼进度，可一键回填</p>
          </div>
          <button class="btn" @click="prefillFromSettings">{{ prefilled ? '已回填' : '从摸鱼进度回填' }}</button>
        </div>

        <div class="fields">
          <div class="field">
            <label>月薪（税前）</label>
            <input v-model.number="input.monthlySalary" type="number" min="0" step="500" />
          </div>
          <div class="field">
            <label>上班时间</label>
            <input v-model="input.workStart" type="time" />
          </div>
          <div class="field">
            <label>下班时间</label>
            <input v-model="input.workEnd" type="time" />
          </div>
          <div class="field">
            <label>日均休息 &amp; 摸鱼（小时）</label>
            <input v-model.number="input.dailyRestHours" type="number" min="0" max="8" step="0.5" />
          </div>
          <div class="field">
            <label>每月工作日</label>
            <input v-model.number="input.workDaysPerMonth" type="number" min="1" max="31" step="0.25" />
          </div>
          <div class="field">
            <label>每日通勤（小时）</label>
            <input v-model.number="input.commuteHours" type="number" min="0" max="6" step="0.5" />
          </div>
          <div class="field">
            <label>每周加班（小时）</label>
            <input v-model.number="input.overtimeHoursPerWeek" type="number" min="0" max="40" step="1" />
          </div>
          <div class="field">
            <label>住房支出（月）</label>
            <input v-model.number="input.housingCost" type="number" min="0" step="100" />
          </div>
          <div class="field">
            <label>生活支出（月）</label>
            <input v-model.number="input.livingCost" type="number" min="0" step="100" />
          </div>
          <div class="field">
            <label>学历</label>
            <select v-model="input.education">
              <option v-for="e in EDUCATION" :key="e.id" :value="e.id">{{ e.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>城市</label>
            <select v-model="input.cityTier">
              <option v-for="c in CITY" :key="c.id" :value="c.id">{{ c.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>办公形态</label>
            <select v-model="input.remote">
              <option v-for="r in REMOTE" :key="r.id" :value="r.id">{{ r.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>压力水平（1 低 – 5 高）</label>
            <input v-model.number="input.stressLevel" type="range" min="1" max="5" step="1" />
          </div>
          <div class="field">
            <label>成长空间（1 低 – 5 高）</label>
            <input v-model.number="input.growthLevel" type="range" min="1" max="5" step="1" />
          </div>
        </div>
      </section>

      <section class="card result">
        <p class="result-label">你的工作性价比</p>
        <p class="result-score tabular" :style="{ color: computedResult.grade.color }">{{ computedResult.score }}</p>
        <p class="result-grade" :style="{ color: computedResult.grade.color }">{{ computedResult.grade.label }}</p>
        <p class="result-sub">分，已超越全国约 {{ computedResult.percentile }}% 的打工人</p>

        <ul class="result-list">
          <li v-for="row in computedResult.breakdown" :key="row.label">
            <span>{{ row.label }}</span>
            <b class="tabular">{{ row.value }}</b>
          </li>
        </ul>

        <button class="btn full" @click="copyReport">{{ copied ? '已复制分享文案' : '复制分享文案' }}</button>
      </section>
    </div>

    <!-- 生命电量 -->
    <div v-else class="battery">
      <section class="card battery-main">
        <p class="battery-title">一天里属于你自己的时间</p>
        <div class="battery-outer">
          <div class="battery-fill" :style="{ height: batteryPercent + '%' }" />
          <span class="battery-num tabular">{{ batteryPercent }}%</span>
        </div>
        <p class="battery-hint">
          按每天 8 小时睡眠、{{ battery.daily.work }} 小时在岗计算，剩余
          <b>{{ battery.daily.free }} 小时</b> 是你真正可以支配的。
        </p>
      </section>

      <section class="card rows">
        <p class="rows-title">时间账本</p>
        <ul>
          <li>
            <span>每天自由时间</span>
            <b class="tabular">{{ battery.daily.free.toFixed(1) }} 小时</b>
          </li>
          <li>
            <span>每周在岗</span>
            <b class="tabular">{{ battery.weekWork.toFixed(1) }} 小时</b>
          </li>
          <li>
            <span>每周自由时间</span>
            <b class="tabular">{{ battery.weekFree.toFixed(1) }} 小时</b>
          </li>
          <li>
            <span>每年在岗</span>
            <b class="tabular">{{ Math.round(battery.yearWork) }} 小时</b>
          </li>
          <li>
            <span>每年自由时间</span>
            <b class="tabular">{{ Math.round(battery.yearFree) }} 小时</b>
          </li>
          <li>
            <span>38 年职业生涯在岗</span>
            <b class="tabular">{{ Math.round(battery.careerWork / 24 / 365) }} 年</b>
          </li>
        </ul>
        <p class="rows-hint">上班占掉的可支配人生：{{ battery.workPercentOfLife.toFixed(1) }}%。剩下的，都还是你的。</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.lab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border-radius: 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  align-self: flex-start;
}
.tab {
  border: none;
  background: transparent;
  padding: 8px 16px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.tab.active {
  background: var(--theme-accent-soft);
  color: rgb(var(--theme-accent));
}
html.dark .tab.active {
  background: rgb(var(--theme-accent) / 0.16);
}

.calc {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 16px;
  align-items: start;
}

.form {
  padding: 18px 20px 20px;
}
.form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 16px;
}
.form-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 700;
}
.form-sub {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 14px;
}

.result {
  padding: 20px;
  text-align: center;
  position: sticky;
  top: 0;
}
.result-label {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.result-score {
  margin: 6px 0 0;
  font-size: 52px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.03em;
}
.result-grade {
  margin: 6px 0 3px;
  font-size: 15px;
  font-weight: 700;
}
.result-sub {
  margin: 0 0 16px;
  font-size: 11.5px;
  color: var(--text-3);
}
.result-list {
  list-style: none;
  margin: 0 0 16px;
  padding: 14px 0 0;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}
.result-list li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
}
.result-list li span {
  color: var(--text-3);
}
.full {
  width: 100%;
}

/* 生命电量 */
.battery {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.battery-main {
  padding: 22px;
  text-align: center;
}
.battery-title {
  margin: 0 0 16px;
  font-size: 13px;
  font-weight: 700;
}
.battery-outer {
  position: relative;
  width: 120px;
  height: 230px;
  margin: 0 auto 16px;
  border-radius: 18px;
  border: 3px solid var(--border-strong);
  padding: 5px;
  display: flex;
  align-items: flex-end;
  overflow: hidden;
}
.battery-outer::after {
  content: '';
  position: absolute;
  top: -10px;
  left: 50%;
  transform: translateX(-50%);
  width: 34px;
  height: 7px;
  border-radius: 4px 4px 0 0;
  background: var(--border-strong);
}
.battery-fill {
  width: 100%;
  border-radius: 12px;
  background: linear-gradient(180deg, rgb(var(--theme-accent-light)), rgb(var(--theme-accent)));
  transition: height 0.8s cubic-bezier(0.16, 1, 0.3, 1);
}
.battery-num {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 27px;
  font-weight: 800;
  color: var(--text-1);
  text-shadow: 0 1px 8px rgba(255, 255, 255, 0.65);
}
html.dark .battery-num {
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.65);
}
.battery-hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.7;
}
.battery-hint b {
  color: rgb(var(--theme-accent));
}

.rows {
  padding: 18px 20px;
}
.rows-title {
  margin: 0 0 12px;
  font-size: 13.5px;
  font-weight: 700;
}
.rows ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 10px;
}
.rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 13px;
  border-radius: 11px;
  background: var(--bg-subtle);
  font-size: 12.5px;
}
.rows li span {
  color: var(--text-3);
}
.rows-hint {
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-3);
}

@media (max-width: 980px) {
  .calc,
  .battery {
    grid-template-columns: 1fr;
  }
  .result {
    position: static;
  }
}
</style>
