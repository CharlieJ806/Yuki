<script setup>
/** 设置 —— 工作时间 / 薪酬 / 月休 / 桌宠外观 / 偷偷摸摸模式 / 数据同步 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  state,
  saveSettings,
  resetSettings,
  logMoyu,
  win,
  openChatWindow,
  diagnoseChat,
  listPersonas,
  createPersona,
  duplicatePersona as duplicatePersonaAction,
  updatePersona,
  deletePersona,
  testChat as testChatConnection,
  resetAffinity as resetAffinityAction,
} from '../stores/app.js'
import { DEFAULT_SETTINGS, formatDuration, formatHours } from '@shared/moyu.js'
import { affinityLevel, AFFINITY_GAIN, CHAT_AFFINITY_DAILY_CAP, OUTFITS, outfitsFor } from '@shared/interactions.js'

const TABS = [
  { id: 'work', label: '工作与薪酬' },
  { id: 'pet', label: '桌宠外观' },
  { id: 'chat', label: 'AI 对话' },
  { id: 'data', label: '数据与同步' },
]
const tab = ref('work')

/**
 * 角色设定图：高中 / 大学两个阶段。
 *
 * 图片在 `src/renderer/public/character/`（由 `resources/yuki-new/设定图*.png`
 * 压到 700px、200 色而来）。摆在这里是为了让人设「长什么样」有个参照。
 */
const PROFILE_SHOTS = [
  {
    src: 'character/yuki-profile-1-highschool.png',
    title: '高中时期',
    caption: '安静害羞，穿白衬衫配黑背心裙的校服，个子约 150',
  },
  {
    src: 'character/yuki-profile-2-university.png',
    title: '大学时期（现在）',
    caption: '深大金融系大二，深蓝开衫配格子裙，个子约 160',
  },
]

const form = reactive({ ...DEFAULT_SETTINGS })
const saving = ref(false)
const savedAt = ref(null)

/* AI 对话设置 */
const chatTesting = ref(false)
const chatTestResult = ref(null)
const providers = computed(() => state.meta.chatProviders ?? [])
const currentProvider = computed(() => providers.value.find((p) => p.id === form.chatProvider) ?? null)
const chatNeedsKey = computed(() => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(String(form.chatBaseUrl || '')))

/*
 * 按**实际地址**判断是不是 OpenRouter，而不是按 chatProvider：
 * 用户可能选了「自定义」却填的 OpenRouter 地址，反过来也可能。
 * 以地址为准，界面提示才和真实行为一致。
 */
const isOpenRouter = computed(() => /openrouter\.ai/i.test(String(form.chatBaseUrl || '')))

/** 模型提示：不同服务商的写法/建议不一样，别写死 DeepSeek 那套 */
const modelHint = computed(() => {
  const id = form.chatProvider
  if (id === 'openrouter' || isOpenRouter.value) {
    return '格式为 组织/模型（如 deepseek/deepseek-chat）。想让她看图选带 vl 的，例如 qwen/qwen3-vl-8b-instruct。'
  }
  if (id === 'ollama') {
    return '填 ollama 里的模型名，如 qwen2.5:7b。看图需要拉多模态模型（如 qwen3-vl:8b）。'
  }
  if (id === 'deepseek') {
    return '想让她看图就填 deepseek-flash（原生多模态）；deepseek-chat 是纯文本模型，发图会报错。'
  }
  return '填目标服务商支持的模型名'
})

/** Key 提示同理 */
const keyHint = computed(() => {
  if (!chatNeedsKey.value) return '本地地址（127.0.0.1）不校验 Key'
  if (form.chatProvider === 'openrouter' || isOpenRouter.value) {
    return '在 openrouter.ai/keys 创建，形如 sk-or-v1-xxx'
  }
  if (form.chatProvider === 'deepseek') return '在 DeepSeek 开放平台创建，形如 sk-xxx'
  return '填该服务商的 API Key'
})

/* ---------- 亲密度 ---------- */

const affinityName = computed(() => affinityLevel(state.affinity?.points ?? 0).level.name)
const affinityBusy = ref(false)
const affinityMsg = ref('')

/**
 * 得分规则在设置页摊开写清楚 —— 之前只说「互动会累积亲密度」，
 * 用户根本不知道聊天也算、也不知道每天有限额。
 */
const affinityGain = computed(() => ({ ...AFFINITY_GAIN, chatDailyCap: CHAT_AFFINITY_DAILY_CAP }))

async function onResetAffinity() {
  if (!confirm('重置亲密度？累计点数与连续天数都会清零，互动记录不影响其他数据。')) return
  affinityBusy.value = true
  affinityMsg.value = ''
  try {
    await resetAffinityAction()
    affinityMsg.value = '已重置'
  } finally {
    affinityBusy.value = false
  }
}

/* ---------- 换装 ---------- */

const outfits = OUTFITS

/** 勾选框是「是否自动」，表单存的是 'auto' | 'fixed'，这里做一层转换 */
const autoOutfit = computed({
  get: () => form.outfitMode !== 'fixed',
  set: (on) => {
    form.outfitMode = on ? 'auto' : 'fixed'
  },
})

/** 点了具体某套 → 关掉自动并记下这一套 */
function pickOutfit(slug) {
  form.outfitMode = 'fixed'
  form.outfitSlug = slug
}

/** 提示文案里显示当前亲密度档位解锁了多少套（挂机轮换用的那部分） */
const unlockedOutfitCount = computed(() => outfitsFor(affinityLevel(state.affinity?.points ?? 0).voice).length)

/** 切换预设时带上默认 BaseURL 与首个模型 */
function onProviderChange(id) {
  form.chatProvider = id
  const p = providers.value.find((x) => x.id === id)
  if (!p) return
  if (p.baseUrl) form.chatBaseUrl = p.baseUrl
  if (p.models?.length && !p.models.includes(form.chatModel)) form.chatModel = p.models[0]
}

async function testChat() {
  chatTesting.value = true
  chatTestResult.value = null
  try {
    /* 先把当前表单存下去，测试读的是库里的配置 */
    await saveSettings({ ...form })
    chatTestResult.value = await testChatConnection()
  } finally {
    chatTesting.value = false
  }
}

/* 全链路自检：逐项摊开，定位「测试连接成功但对话失败」 */
const diagnosing = ref(false)
const diagResult = ref(null)

/* ---------- 人设编辑 ---------- */

const personaList = ref([])
const personaBusy = ref(false)
const editingPersona = ref(null) // { id, label, prompt, custom }
const personaMsg = ref('')

async function loadPersonas() {
  personaList.value = await listPersonas()
  return personaList.value
}

function currentPersona() {
  return personaList.value.find((p) => p.id === form.chatPersona) ?? null
}

function startEditPersona(p) {
  editingPersona.value = { id: p.id, label: p.label, prompt: p.prompt, custom: Boolean(p.custom) }
  personaMsg.value = ''
}

async function duplicatePersona(srcId) {
  personaBusy.value = true
  try {
    const created = await duplicatePersonaAction(srcId)
    if (created) {
      await loadPersonas()
      /* 复制完直接切到副本并打开编辑器，否则用户还得手动在下拉里找 */
      form.chatPersona = created.id
      await saveSettings({ chatPersona: created.id })
      startEditPersona({ ...created, custom: true })
      personaMsg.value = '已复制一份，可自由修改'
    }
  } finally {
    personaBusy.value = false
  }
}

async function newPersona() {
  personaBusy.value = true
  try {
    const created = await createPersona({ label: '新人设', prompt: '' })
    if (created) {
      await loadPersonas()
      form.chatPersona = created.id
      await saveSettings({ chatPersona: created.id })
      startEditPersona({ ...created, custom: true })
      personaMsg.value = '已新建，改完记得点保存'
    }
  } finally {
    personaBusy.value = false
  }
}

async function savePersona() {
  const p = editingPersona.value
  if (!p) return
  personaBusy.value = true
  try {
    await updatePersona(p.id, { label: p.label, prompt: p.prompt })
    await loadPersonas()
    personaMsg.value = '已保存'
    window.setTimeout(() => (personaMsg.value = ''), 2000)
  } finally {
    personaBusy.value = false
  }
}

async function removePersona(p) {
  if (!confirm(`删除人设「${p.label}」？`)) return
  personaBusy.value = true
  try {
    await deletePersona(p.id)
    if (editingPersona.value?.id === p.id) editingPersona.value = null
    await loadPersonas()
    await refresh()
  } finally {
    personaBusy.value = false
  }
}

async function runDiagnose() {
  diagnosing.value = true
  diagResult.value = null
  try {
    await saveSettings({ ...form })
    diagResult.value = await diagnoseChat()
  } finally {
    diagnosing.value = false
  }
}
const dirty = computed(() => JSON.stringify(form) !== JSON.stringify(state.settings))

/* 进入设置页就把人设列表拉全，下拉框与实际保持一致 */
onMounted(() => {
  loadPersonas().catch(() => {})
})

watch(
  () => state.settings,
  (next) => Object.assign(form, next),
  { immediate: true, deep: true },
)

async function save() {
  saving.value = true
  try {
    const ok = await saveSettings({ ...form })
    if (ok) {
      savedAt.value = new Date()
      window.setTimeout(() => (savedAt.value = null), 2200)
    }
  } finally {
    saving.value = false
  }
}

async function revert() {
  Object.assign(form, state.settings)
}

async function reset() {
  const ok = await resetSettings()
  if (ok) Object.assign(form, state.settings)
}

/* 摸鱼时长快捷记账 */
const quickMinutes = ref(15)
async function addMoyu() {
  await logMoyu(quickMinutes.value)
}

const previewText = computed(() => {
  const [sh, sm] = form.workStart.split(':').map(Number)
  const [eh, em] = form.workEnd.split(':').map(Number)
  const span = Math.max(0, eh * 60 + em - (sh * 60 + sm))
  const paid = Math.max(0, span - form.dailyRestHours * 60)
  return `在岗 ${formatDuration(span)} · 计薪 ${formatDuration(paid)} · 每日休息 ${formatHours(form.dailyRestHours)}`
})

const REST_PATTERN_LABELS = { double: '双休', single: '单休', alternate: '大小周', irregular: '不定休' }
const syncStatus = computed(() => ({
  pendingCheckins: state.snapshot ? undefined : undefined,
  backend: state.backend,
  dbHint: '本地 SQLite（userData/desk-pet.db）',
}))
</script>

<template>
  <div class="settings">
    <div class="tabs">
      <button v-for="t in TABS" :key="t.id" class="tab" :class="{ active: tab === t.id }" @click="tab = t.id">
        {{ t.label }}
      </button>
    </div>

    <!-- 工作与薪酬 -->
    <section v-if="tab === 'work'" class="card pane">
      <div class="pane-head">
        <p class="pane-title">工作与薪酬</p>
        <p class="pane-sub">这些参数决定「今日摸鱼收入」的换算口径</p>
      </div>

      <div class="grid">
        <div class="field">
          <label>月薪（税前）</label>
          <input v-model.number="form.salary" type="number" min="0" step="500" />
        </div>
        <div class="field">
          <label>货币</label>
          <select v-model="form.salaryCurrency">
            <option value="CNY">人民币 ¥</option>
            <option value="USD">美元 $</option>
            <option value="EUR">欧元 €</option>
            <option value="HKD">港币 HK$</option>
            <option value="JPY">日元 ¥</option>
          </select>
        </div>
        <div class="field">
          <label>上班时间</label>
          <input v-model="form.workStart" type="time" />
        </div>
        <div class="field">
          <label>下班时间</label>
          <input v-model="form.workEnd" type="time" />
        </div>
        <div class="field">
          <label>每日休息时长</label>
          <input v-model.number="form.dailyRestHours" type="range" min="0" max="4" step="0.5" />
          <span class="hint">当前：{{ formatHours(form.dailyRestHours) }}（半小时间隔）</span>
        </div>
        <div class="field">
          <label>发薪日</label>
          <select v-model.number="form.payDay">
            <option v-for="d in 28" :key="d" :value="d">每月 {{ d }} 日</option>
          </select>
        </div>
        <div class="field">
          <label>月休方式</label>
          <select v-model="form.restPattern">
            <option v-for="(label, id) in REST_PATTERN_LABELS" :key="id" :value="id">{{ label }}</option>
          </select>
        </div>
        <div v-if="form.restPattern === 'irregular'" class="field">
          <label>每月休息天数</label>
          <input v-model.number="form.customRestDays" type="number" min="0" max="15" step="1" />
        </div>
        <div class="field">
          <label>摸鱼进度开关</label>
          <label class="switch">
            <input v-model="form.enabled" type="checkbox" />
            <span>在侧边栏展示今日摸鱼收入</span>
          </label>
        </div>
      </div>

      <p class="preview">{{ previewText }}</p>
    </section>

    <!-- 桌宠外观 -->
    <section v-else-if="tab === 'pet'" class="card pane">
      <div class="pane-head">
        <p class="pane-title">桌宠外观</p>
        <p class="pane-sub">调整悬浮小挂件的显示方式</p>
      </div>

      <div class="grid">
        <div class="field">
          <label>桌宠缩放</label>
          <input v-model.number="form.petScale" type="range" min="0.6" max="2" step="0.1" @change="win.setPetScale(form.petScale)" />
          <span class="hint">当前：{{ Number(form.petScale).toFixed(1) }}×</span>
        </div>
        <div class="field">
          <label>窗口置顶</label>
          <label class="switch">
            <input
              :checked="form.petAlwaysOnTop"
              type="checkbox"
              @change="form.petAlwaysOnTop = $event.target.checked; win.setPetAlwaysOnTop(form.petAlwaysOnTop)"
            />
            <span>始终显示在其他窗口之上</span>
          </label>
        </div>
        <div class="field">
          <label>偷偷摸摸模式</label>
          <label class="switch">
            <input v-model="form.studyDisguise" type="checkbox" />
            <span>开启后界面文案切换为学习风格，降低划水观感</span>
          </label>
        </div>
        <div class="field">
          <label>桌宠显隐</label>
          <button class="btn" @click="win.togglePet()">显示 / 隐藏桌宠</button>
        </div>
      </div>

      <div class="pane-head" style="margin-top: 22px">
        <p class="pane-title">互动</p>
        <p class="pane-sub">桌宠会主动说话、回应你的操作；不需要可以逐项关掉</p>
      </div>

      <div class="grid">
        <div class="field">
          <label>鼠标互动</label>
          <label class="switch">
            <input v-model="form.petInteractions" type="checkbox" />
            <span>悬停搭话、单击、双击、长按贴贴</span>
          </label>
        </div>
        <div class="field">
          <label>挂机主动说话</label>
          <label class="switch">
            <input v-model="form.petIdleChatter" type="checkbox" />
            <span>隔一段时间自己冒一句话</span>
          </label>
        </div>
        <div class="field">
          <label>主动说话间隔（分钟）</label>
          <input v-model.number="form.petChatterInterval" type="number" min="2" max="120" step="1" />
          <span class="hint">实际间隔会在此基础上随机浮动，免得像定时机器人</span>
        </div>
        <div class="field">
          <label>情境台词</label>
          <label class="switch">
            <input v-model="form.petContextLines" type="checkbox" />
            <span>早上、上班、临近下班、休息日各有不同的话</span>
          </label>
        </div>
        <div class="field">
          <label>久坐提醒</label>
          <label class="switch">
            <input v-model="form.petSedentary" type="checkbox" />
            <span>工作中每 50 分钟提醒你起来动一动</span>
          </label>
        </div>
        <div class="field">
          <label>亲密度</label>
          <label class="switch">
            <input v-model="form.petAffinity" type="checkbox" />
            <span>互动会累积亲密度，右键菜单可查看</span>
          </label>
          <span class="hint">
            当前 {{ state.affinity?.points ?? 0 }} / {{ state.affinity?.max ?? 300 }} 点 ·
            {{ affinityName }} · 连续 {{ state.affinity?.streakDays ?? 0 }} 天
          </span>
          <span class="hint">
            聊天一条 +{{ affinityGain.chatMessage }}、聊完一轮 +{{ affinityGain.chatRound }}（每日上限
            {{ affinityGain.chatDailyCap }} 点）；摸头 +{{ affinityGain.pet }}、双击 +{{ affinityGain.double }}、
            每天见面 +{{ affinityGain.daily }}。
            关系越近，Yuki 说话越黏、主动搭话越频繁，聊天窗标题栏会实时显示进度。
          </span>
          <button class="btn" :disabled="affinityBusy" @click="onResetAffinity">
            {{ affinityBusy ? '重置中…' : '重置亲密度' }}
          </button>
          <span v-if="affinityMsg" class="hint">{{ affinityMsg }}</span>
        </div>

        <!-- 换装：和对话窗、右键菜单读写同一份设置 -->
        <div class="field">
          <label>换装</label>
          <label class="switch">
            <input v-model="autoOutfit" type="checkbox" />
            <span>按时间自动换（深夜睡衣 / 早晚居家 / 白天便服）</span>
          </label>
          <div class="outfit-row">
            <button
              v-for="o in outfits"
              :key="o.slug"
              class="outfit-chip"
              :class="{ active: !autoOutfit && form.outfitSlug === o.slug }"
              :title="o.hint"
              @click="pickOutfit(o.slug)"
            >
              {{ o.emoji }} {{ o.label }}
            </button>
          </div>
          <span class="hint">
            选一套即固定不再自动切换；勾上「按时间自动换」恢复自动。
            挂机时她还会自己轮换衣服，那部分随亲密度解锁（当前 {{ unlockedOutfitCount }} 套）。
          </span>
        </div>
      </div>
    </section>

    <!-- AI 对话 -->
    <section v-else-if="tab === 'chat'" class="card pane">
      <div class="pane-head">
        <p class="pane-title">AI 对话</p>
        <p class="pane-sub">
          填自己的 API Key 直连官方接口。Key 只存在本机数据库里，不会上传到任何第三方。
        </p>
      </div>

      <div class="grid">
        <div class="field">
          <label>服务商</label>
          <select :value="form.chatProvider" @change="onProviderChange($event.target.value)">
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.label }}</option>
          </select>
          <span class="hint">切换会自动带出默认接口地址</span>
        </div>

        <div class="field">
          <label>接口地址（BaseURL）</label>
          <input v-model.trim="form.chatBaseUrl" type="text" placeholder="https://api.deepseek.com" />
          <span class="hint">OpenAI 兼容格式，会自动拼 /chat/completions</span>
        </div>

        <div class="field">
          <label>模型</label>
          <input v-model.trim="form.chatModel" type="text" list="chat-model-list" placeholder="deepseek-chat" />
          <datalist id="chat-model-list">
            <option v-for="m in currentProvider?.models ?? []" :key="m" :value="m" />
          </datalist>
          <span class="hint">{{ modelHint }}</span>
        </div>

        <div class="field">
          <label>API Key</label>
          <input
            v-model.trim="form.chatApiKey"
            type="password"
            autocomplete="off"
            :placeholder="chatNeedsKey ? 'sk-...' : '本地服务通常不需要填'"
          />
          <span class="hint">{{ keyHint }}</span>
        </div>

        <!-- OpenRouter 专属：路由偏好。别的服务商不认这些字段，就不显示 -->
        <template v-if="isOpenRouter">
          <div class="field">
            <label>仅用零保留端点</label>
            <label class="switch-inline">
              <input v-model="form.chatZdr" type="checkbox" />
              <span>开启后只路由到「不保留请求」的 provider</span>
            </label>
            <span class="hint">
              隐私控制，不是「免审核」—— 有没有内容策略由上游模型和 provider 决定。
            </span>
          </div>

          <div class="field">
            <label>路由偏好</label>
            <select v-model="form.chatRouteSort">
              <option value="">默认（按价格加权）</option>
              <option value="price">最省</option>
              <option value="throughput">最快</option>
              <option value="latency">延迟最低</option>
            </select>
            <span class="hint">同一模型多家 provider 时怎么挑</span>
          </div>
        </template>

        <div class="field span-2">
          <label>角色设定</label>
          <div class="persona-row">
            <select v-model="form.chatPersona">
              <option v-for="p in state.meta.chatPersonas ?? []" :key="p.id" :value="p.id">
                {{ p.label }}{{ p.custom ? '（自定义）' : '' }}
              </option>
            </select>
            <button class="btn small" :disabled="personaBusy" title="复制当前人设另存为自定义" @click="duplicatePersona(form.chatPersona)">
              复制
            </button>
            <button class="btn small" :disabled="personaBusy" title="新建空白人设" @click="newPersona">新建</button>
            <button
              v-if="currentPersona()?.custom"
              class="btn small"
              :disabled="personaBusy"
              @click="startEditPersona(currentPersona())"
            >
              编辑
            </button>
            <button
              v-if="currentPersona()?.custom"
              class="btn small danger"
              :disabled="personaBusy"
              @click="removePersona(currentPersona())"
            >
              删除
            </button>
          </div>
          <span class="hint">
            内置人设不可改；点「复制」会另存一份可编辑的副本，随便改里面的提示词
          </span>
        </div>

        <!--
          角色设定图：两张分别对应高中 / 大学两个阶段。
          放在这里是因为它解释「人设长什么样」—— 换人设、改外观时有个直观参照，
          也方便用户自己比对模型认不认得出这是 Yuki。
        -->
        <div class="field span-2">
          <label>角色设定图</label>
          <div class="profile-shots">
            <figure v-for="p in PROFILE_SHOTS" :key="p.src" class="profile-shot">
              <img :src="p.src" :alt="p.title" loading="lazy" />
              <figcaption>
                <strong>{{ p.title }}</strong>
                <span>{{ p.caption }}</span>
              </figcaption>
            </figure>
          </div>
          <span class="hint">
            高中时期安静害羞，大学时期变得爱笑爱闹 —— 两段都写在人设里了
          </span>
        </div>

        <!-- 人设编辑器 -->
        <div v-if="editingPersona" class="field span-2 persona-editor">
          <div class="pe-head">
            <input v-model.trim="editingPersona.label" class="pe-label" maxlength="40" placeholder="人设名称" />
            <button class="btn small" :disabled="personaBusy" @click="editingPersona = null">取消</button>
            <button class="btn small btn-primary" :disabled="personaBusy" @click="savePersona">保存</button>
          </div>
          <textarea
            v-model="editingPersona.prompt"
            class="pe-prompt"
            rows="12"
            placeholder="在这里写人设提示词，例如：&#10;你叫 XX，是一个……&#10;&#10;【性格】&#10;【说话方式】&#10;【绝对不要】"
          />
          <span class="hint">
            提示词越长越具体，模型越不容易跑偏。建议写清：身份、性格、说话方式、不要做什么。
            当前 {{ editingPersona.prompt.length }} 字
            <b v-if="personaMsg">· {{ personaMsg }}</b>
          </span>
        </div>

        <div class="field">
          <label>回复温度</label>
          <input v-model.number="form.chatTemperature" type="range" min="0" max="2" step="0.1" />
          <span class="hint">当前 {{ Number(form.chatTemperature).toFixed(1) }}，越高越随机</span>
        </div>

        <div class="field">
          <label>上下文条数</label>
          <input v-model.number="form.chatMaxHistory" type="number" min="2" max="400" step="10" />
          <span class="hint">每次带给模型的最近消息条数（最多 400），越大越记得住前文</span>
        </div>

        <div class="field">
          <label>上下文长度上限（字符）</label>
          <input v-model.number="form.chatMaxChars" type="number" min="2000" max="400000" step="2000" />
          <span class="hint">
            约 {{ Math.round(form.chatMaxChars / 1.6) }} 个汉字；超出后从最早的对话开始丢弃。
            DeepSeek 上限约 64K token，别设太满
          </span>
        </div>
      </div>

      <div class="chat-test">
        <button class="btn" :disabled="chatTesting" @click="testChat">
          {{ chatTesting ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn" :disabled="diagnosing" @click="runDiagnose">
          {{ diagnosing ? '自检中…' : '全链路自检' }}
        </button>
        <span v-if="chatTestResult" class="test-result" :class="{ ok: chatTestResult.ok }">
          {{
            chatTestResult.ok
              ? `连接正常 · ${chatTestResult.model}${chatTestResult.reply ? ` · 回复「${chatTestResult.reply}」` : ''}`
              : `失败：${chatTestResult.reason}`
          }}
        </span>
        <span v-else-if="!diagResult" class="hint">测试连接只发一次极短请求；自检会把流式、落库逐项跑一遍</span>
      </div>

      <div v-if="diagResult" class="diag">
        <p class="diag-head">
          自检结果：<b :class="diagResult.ok ? 'ok' : 'bad'">{{ diagResult.ok ? '全部通过' : '有步骤失败' }}</b>
        </p>
        <ul class="diag-list">
          <li v-for="(s, i) in diagResult.steps" :key="i" :class="s.ok ? 'ok' : 'bad'">
            <span class="diag-icon">{{ s.ok ? '✓' : '✕' }}</span>
            <span class="diag-name">{{ s.name }}</span>
            <span class="diag-detail">{{ s.detail }}</span>
          </li>
        </ul>
        <p v-if="diagResult.reply" class="diag-reply">模型回复：{{ diagResult.reply }}</p>
        <p class="diag-hint">
          把这一整块截图发出来即可定位问题。若「流式请求」失败但「非流式请求」成功，
          通常是网络中间设备拦截了 SSE 长连接。
        </p>
      </div>

      <div class="chat-actions">
        <button class="btn btn-primary" @click="openChatWindow()">打开对话窗</button>
      </div>

      <p class="chat-note">
        对话记录保存在本机 <code>chat_sessions</code> / <code>chat_messages</code> 表，
        与打卡数据同一套同步字段，接入云端后可按增量推拉。
      </p>
    </section>

    <!-- 数据与同步 -->
    <section v-else class="card pane">
      <div class="pane-head">
        <p class="pane-title">数据与同步</p>
        <p class="pane-sub">本地优先存储，云端同步按「增量推拉」设计，接入时无需改表结构</p>
      </div>

      <div class="grid">
        <div class="field">
          <label>存储位置</label>
          <span class="value">{{ syncStatus.dbHint }}</span>
          <span class="hint">运行环境：{{ syncStatus.backend === 'electron' ? 'Electron 桌面版' : '浏览器预览模式（数据不落盘）' }}</span>
        </div>
        <div class="field">
          <label>累计数据</label>
          <span class="value tabular">打卡 {{ state.days }} 天 · 连续 {{ state.streak }} 天</span>
        </div>
        <div class="field">
          <label>快捷补记摸鱼</label>
          <div class="inline">
            <input v-model.number="quickMinutes" type="number" min="1" max="480" step="5" />
            <button class="btn" @click="addMoyu">记 {{ quickMinutes }} 分钟</button>
          </div>
          <span class="hint">今日已补记：{{ formatDuration(state.loggedMinutesToday) }}</span>
        </div>
        <div class="field">
          <label>恢复默认</label>
          <button class="btn" @click="reset">重置全部设置</button>
          <span class="hint">不会删除打卡记录</span>
        </div>
      </div>
    </section>

    <div class="bar">
      <span v-if="state.lastError" class="err">{{ state.lastError }}</span>
      <span v-else-if="savedAt" class="ok">设置已保存</span>
      <span v-else-if="dirty" class="hint">有未保存的修改</span>
      <div class="bar-actions">
        <button class="btn" :disabled="!dirty" @click="revert">放弃修改</button>
        <button class="btn btn-primary" :disabled="!dirty || saving" @click="save">
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
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

.pane {
  padding: 18px 20px 20px;
}
.pane-head {
  margin-bottom: 16px;
}
.pane-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 700;
}
.pane-sub {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}
.switch {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
}
.value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.inline {
  display: flex;
  gap: 8px;
}
.inline input {
  width: 96px;
}
.preview {
  margin: 16px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-3);
}

.chat-test {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.test-result {
  font-size: 12px;
  color: #dc2626;
  word-break: break-all;
}
.test-result.ok {
  color: rgb(var(--theme-accent));
}

.diag {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 11px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
}
.diag-head {
  margin: 0 0 10px;
  font-size: 12.5px;
  color: var(--text-2);
}
.diag-head b.ok {
  color: rgb(var(--theme-accent));
}
.diag-head b.bad {
  color: #dc2626;
}
.diag-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.diag-list li {
  display: grid;
  grid-template-columns: 16px 110px 1fr;
  gap: 8px;
  align-items: baseline;
  font-size: 11.5px;
  font-family: ui-monospace, Consolas, monospace;
}
.diag-icon {
  font-weight: 700;
}
.diag-list li.ok .diag-icon {
  color: rgb(var(--theme-accent));
}
.diag-list li.bad .diag-icon {
  color: #dc2626;
}
.diag-name {
  color: var(--text-2);
}
.diag-detail {
  color: var(--text-3);
  word-break: break-all;
}
.diag-list li.bad .diag-detail {
  color: #dc2626;
}
.diag-reply {
  margin: 10px 0 0;
  padding-top: 9px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-2);
}
.diag-hint {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
}
.chat-actions {
  margin-top: 14px;
}

/* ---------- 换装 ---------- */
.outfit-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.outfit-chip {
  padding: 4px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text-2);
  font-size: 11.5px;
  line-height: 1.5;
}
.outfit-chip:hover {
  border-color: rgb(var(--theme-accent) / 0.5);
  color: rgb(var(--theme-accent));
}
.outfit-chip.active {
  border-color: rgb(var(--theme-accent));
  background: var(--theme-accent-soft);
  color: rgb(var(--theme-accent));
  font-weight: 700;
}

/* ---------- 人设编辑 ---------- */
.field.span-2 {
  grid-column: 1 / -1;
}

/* 角色设定图：两张并排，窄屏自动换行 */
.profile-shots {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.profile-shot {
  flex: 1 1 200px;
  min-width: 0;
  margin: 0;
  border-radius: 11px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
}
.profile-shot img {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  /* 设定图是完整排版图（含服装展示、表情差集、三视图），
     用 contain 保留全貌；用 cover 会把两侧内容裁掉 */
  object-fit: contain;
  background: #fff;
}
.profile-shot figcaption {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.4;
}
.profile-shot figcaption strong {
  font-size: 12.5px;
}
.profile-shot figcaption span {
  color: var(--text-3);
}
.persona-row {
  display: flex;
  gap: 7px;
  align-items: center;
  flex-wrap: wrap;
}
.persona-row select {
  flex: 1;
  min-width: 150px;
}
.btn.small {
  height: 30px;
  padding: 0 11px;
  font-size: 12px;
  border-radius: 8px;
}
.btn.danger {
  color: #dc2626;
  border-color: rgba(220, 38, 38, 0.35);
}
.btn.danger:hover {
  background: rgba(220, 38, 38, 0.08);
  border-color: #dc2626;
  color: #dc2626;
}

.persona-editor {
  padding: 12px;
  border-radius: 11px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
}
.pe-head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.pe-label {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border-radius: 9px;
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-1);
  font-size: 13px;
  font-weight: 600;
  outline: none;
}
.pe-label:focus {
  border-color: rgb(var(--theme-accent));
}
.pe-prompt {
  width: 100%;
  margin-top: 9px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-1);
  font-size: 12.5px;
  line-height: 1.65;
  resize: vertical;
  outline: none;
  font-family: inherit;
}
.pe-prompt:focus {
  border-color: rgb(var(--theme-accent));
}
.chat-note {
  margin: 16px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.7;
}
.chat-note code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--bg-subtle);
  font-size: 10.5px;
}

.bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 18px;
  border-radius: var(--radius);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
}
.bar-actions {
  display: flex;
  gap: 9px;
}
.ok {
  font-size: 12.5px;
  color: rgb(var(--theme-accent));
  font-weight: 600;
}
.err {
  font-size: 12.5px;
  color: #dc2626;
}
</style>
