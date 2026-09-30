<script setup>
/** 设置 —— 工作时间 / 薪酬 / 月休 / 桌宠外观 / 偷偷摸摸模式 / 数据同步 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  state,
  saveSettings,
  resetSettings,
  getFullSettings,
  /* 删人设后要重拉一次全局状态：删除会顺手把「正在用这份人设」的会话
     回落成默认人设，不刷新的话设置页还拿着那个已删的 id —— 下拉框空白、
     复制按钮提示「找不到源人设」（见 removePersona） */
  refresh,
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
  wipeAllData,
} from '../stores/app.js'
import { DEFAULT_SETTINGS, formatDuration, formatHours } from '@shared/moyu.js'
import {
  affinityView,
  AFFINITY_GAIN,
  AFFINITY_DECAY,
  AFFINITY_MAX_POINTS,
  PET_AFFINITY_DAILY_CAP,
  OUTFITS,
  rotationCandidatesFor,
  resolveRotationPool,
  outfitUnlockTierName,
  ROTATE_MIN_MIN,
  ROTATE_MIN_MAX,
} from '@shared/interactions.js'

/*
 * 「主动找话题」的开关与间隔共用一个字段（petTopicMin）。
 * 关掉 = 0，打开 = 恢复默认 60 分钟 —— 单独存一个布尔量的话，
 * 用户关掉再打开会丢掉他调过的间隔。
 */
const topicDefault = DEFAULT_SETTINGS.petTopicMin ?? 60

const TABS = [  { id: 'work', label: '工作与薪酬' },
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
/*
 * chatApiKey 不在 state 快照里（广播面脱敏），表单另存「已保存的 Key」：
 * dirty 判定和 revert 都以它为基准，全量值进设置页时经 getFullSettings 拉取。
 *
 * keyLoaded 门控：全量值取回之前 chatApiKey 还是初始空串，此时把表单整体
 * 保存会把已存的 Key 覆盖成空串 —— 取回前发出去的补丁必须摘掉这个键。
 */
const savedApiKey = ref('')
const keyLoaded = ref(false)

function formPatch() {
  const patch = { ...form }
  if (!keyLoaded.value) delete patch.chatApiKey
  return patch
}

const isDev = import.meta.env.DEV

/* 开机自启：立即写系统 + 立即落库，不走「保存」——只改系统不落库的话，
   下次启动对账会按旧意图把它关掉。成功反馈复用「设置已保存」闪现。 */
async function onAutoStartChange(on) {
  form.autoStart = on
  try {
    await win.autostartSet(on)
    await saveSettings({ autoStart: on })
    savedAt.value = new Date()
    window.setTimeout(() => (savedAt.value = null), 2200)
  } catch {
    form.autoStart = await win.autostartGet().catch(() => false)
  }
}

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

const affinityName = computed(() => affinityView(state.affinity?.points ?? 0, state.settings?.godMode).level.name)
const affinityBusy = ref(false)
const affinityMsg = ref('')

/**
 * 得分规则在设置页摊开写清楚 —— 之前只说「互动会累积亲密度」，
 * 用户根本不知道聊天也算、也不知道哪些来源有每日额度。
 *
 * 现在额度**只挂在桌宠交互上**（`petDailyCap`），所以文案里
 * 不能再出现「每日上限 N 点」这种不指明来源的说法。
 */
const affinityGain = computed(() => ({ ...AFFINITY_GAIN, petDailyCap: PET_AFFINITY_DAILY_CAP }))

/** 每日流失 / 空白天惩罚 —— 文案要能说清「为什么掉了」 */
const affinityDecay = AFFINITY_DECAY

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

/**
 * **实际已解锁**的服饰（图鉴清单）—— 全端唯一的「能穿什么」真相源。
 *
 * 之前这里用的是 `outfitsFor(voice)`：一个按关系档位手写的近似表，
 * 跟图鉴里真实解锁了哪些无关。后果是「清单里能选，但照片根本没发过」，
 * 甚至选了也穿不上（桌宠的守卫查的是图鉴）。
 */
const unlockedOutfitSlugs = computed(() => {
  const list = state.gallery?.outfit?.unlocked
  return Array.isArray(list) ? list : []
})
const unlockedOutfitSet = computed(() => new Set(unlockedOutfitSlugs.value))
const isOutfitUnlocked = (slug) => unlockedOutfitSet.value.has(slug)

/** 当前档位（含上帝模式覆盖）—— 所有解锁门控都看 voice */
const voice = computed(() => affinityView(state.affinity?.points ?? 0, state.settings?.godMode).voice)

/** 勾选框是「是否自动」，表单存的是 'auto' | 'fixed'，这里做一层转换 */
const autoOutfit = computed({
  get: () => form.outfitMode !== 'fixed',
  set: (on) => {
    form.outfitMode = on ? 'auto' : 'fixed'
  },
})

/** 点了具体某套 → 关掉自动并记下这一套。未解锁的直接拒绝 */
function pickOutfit(slug) {
  if (!isOutfitUnlocked(slug)) return
  form.outfitMode = 'fixed'
  form.outfitSlug = slug
}

/** 提示文案里显示已解锁多少套 */
const unlockedOutfitCount = computed(() => unlockedOutfitSlugs.value.length)

/* ---------- 轮换池自选 ---------- */

/**
 * 可勾选项 = **已解锁范围内**的全部候选。
 *
 * 刻意不列未解锁的（哪怕灰显）：用户能勾的都必须是真正会轮到的，
 * 列一堆勾了也不生效的项只会让人困惑、还会去问「为什么没反应」。
 * 解锁一套就多一项。
 */
const rotationCandidates = computed(() => rotationCandidatesFor(voice.value, unlockedOutfitSlugs.value))

/** 空数组 = 全部已解锁（与 resolveRotationPool 的语义必须一致） */
const rotatePoolSelected = computed(() => (Array.isArray(form.petRotatePool) ? form.petRotatePool : []))

const isInRotatePool = (key) => rotatePoolSelected.value.includes(key)

function toggleRotatePool(key) {
  const cur = rotatePoolSelected.value
  form.petRotatePool = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
}
/**
 * 全选：存**此刻**的全量列表。
 *
 * 注意这是**快照**，不等于「不限制」—— 之后新解锁的服饰不会自动进池，
 * 用户得再点一次全选。要「跟着解锁走」请用「恢复默认（全部）」，那个存空数组。
 */
function selectAllRotatePool() {
  form.petRotatePool = rotationCandidates.value.map((c) => c.key)
}
/**
 * 全不选 → 存空数组，**不是空池**。
 *
 * 空数组在 resolveRotationPool 里表示「全部已解锁」，
 * 所以「全不选」这个按钮会让人意外 —— 它其实是恢复默认。
 * 按钮文案因此叫「恢复默认」而不是「全不选」。
 */
function resetRotatePool() {
  form.petRotatePool = []
}

const rotatePoolActions = computed(() => rotationCandidates.value.filter((c) => c.kind === 'action'))
const rotatePoolOutfits = computed(() => rotationCandidates.value.filter((c) => c.kind === 'outfit'))

/**
 * 实际生效的池子大小 —— 直接取自解析函数，所见即所得。
 *
 * 第三个参数**必须**带上已解锁池，否则解析函数只算动作，
 * 和上方 `rotationCandidates`（带服饰）同屏两个数字口径不一致。
 */
const rotatePoolEffective = computed(
  () => resolveRotationPool(voice.value, form.petRotatePool, unlockedOutfitSlugs.value).length,
)


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
    await saveSettings(formPatch())
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
const personaErr = ref(false)

async function loadPersonas() {
  personaList.value = await listPersonas()
  await ensurePersonaSelection()
  return personaList.value
}

/**
 * 把 form.chatPersona 修回一个**列表里真实存在**的 id。
 *
 * 为什么非修不可：复制是拿「当前选中的人设」当源的
 * （`duplicatePersonaAction(form.chatPersona)`），选中值一旦指向一条已删的
 * 记录，服务层 `all.find(...)` 找不到源就返回 null，按钮表现成「点了没反应」。
 * 删掉自己正在用的那份人设之后，界面正是这个状态（下拉框还会显示空白）。
 */
async function ensurePersonaSelection() {
  const list = personaList.value
  if (!list.length) return
  if (list.some((p) => p.id === form.chatPersona)) return
  /* 全量设置还没取回来时 form.chatPersona 只是占位值，别急着反写库 */
  if (!keyLoaded.value) return
  form.chatPersona = list[0].id
  await saveSettings({ chatPersona: list[0].id })
}

function currentPersona() {
  return personaList.value.find((p) => p.id === form.chatPersona) ?? null
}

/**
 * 人设操作失败时的**可见**反馈。
 *
 * 以前这些分支要么没有 else（`if (created)` 不成立就静默什么都不做），
 * 要么异常直接冒出去 —— 用户看到的只有「点了没反应」，这正是这个 bug
 * 最难查的地方。失败一律落一句人话到 personaMsg，并渲染在按钮旁边。
 *
 * 优先用 state.lastError（IPC 真报错时它最准确），没有才用 hint 兜底 ——
 * 「服务层返回 null」这类静默失败不会写 lastError。
 */
function personaFail(action, hint) {
  personaErr.value = true
  personaMsg.value = `${action}失败：${state.lastError ?? hint ?? '未知原因'}`
}

function startEditPersona(p) {
  editingPersona.value = { id: p.id, label: p.label, prompt: p.prompt, custom: Boolean(p.custom) }
  personaMsg.value = ''
  personaErr.value = false
}

/** 成功提示闪现一下就走；失败提示走 personaFail，不自动清除 */
function flashPersonaMsg(msg) {
  personaErr.value = false
  personaMsg.value = msg
  /* 只在文案没被下一条消息替换掉时才清 —— 否则失败提示会被定时器误清 */
  window.setTimeout(() => {
    if (personaMsg.value === msg) personaMsg.value = ''
  }, 2200)
}

async function duplicatePersona(srcId) {
  personaBusy.value = true
  personaErr.value = false
  try {
    /* 选中的可能是已删的人设：先校正，再退回列表首项兜底 */
    await ensurePersonaSelection()
    const source = personaList.value.some((p) => p.id === form.chatPersona)
      ? form.chatPersona
      : (personaList.value[0]?.id ?? srcId)
    const created = await duplicatePersonaAction(source)
    if (!created) {
      /* 服务层查不到源人设（多半是刚在别处被删掉）：重拉列表把选中项修回来，
         再明确告诉用户发生了什么 */
      await loadPersonas()
      return personaFail('复制', '选中的那份人设已不存在，已切回列表第一份，请再点一次')
    }
    await loadPersonas()
    /* 复制完直接切到副本并打开编辑器，否则用户还得手动在下拉里找 */
    form.chatPersona = created.id
    await saveSettings({ chatPersona: created.id })
    startEditPersona({ ...created, custom: true })
    personaMsg.value = '已复制一份，可自由修改'
  } catch (err) {
    personaFail('复制', err?.message ?? err)
  } finally {
    personaBusy.value = false
  }
}

async function newPersona() {
  personaBusy.value = true
  personaErr.value = false
  try {
    const created = await createPersona({ label: '新人设', prompt: '' })
    if (!created) return personaFail('新建', '没能创建新人设，请重试')
    await loadPersonas()
    form.chatPersona = created.id
    await saveSettings({ chatPersona: created.id })
    startEditPersona({ ...created, custom: true })
    personaMsg.value = '已新建，改完记得点保存'
  } catch (err) {
    personaFail('新建', err?.message ?? err)
  } finally {
    personaBusy.value = false
  }
}

async function savePersona() {
  const p = editingPersona.value
  if (!p) return
  personaBusy.value = true
  personaErr.value = false
  try {
    const updated = await updatePersona(p.id, { label: p.label, prompt: p.prompt })
    if (!updated) return personaFail('保存', '人设没能存进库，请重试')
    await loadPersonas()
    flashPersonaMsg('已保存')
  } catch (err) {
    personaFail('保存', err?.message ?? err)
  } finally {
    personaBusy.value = false
  }
}

async function removePersona(p) {
  if (!confirm(`删除人设「${p.label}」？`)) return
  personaBusy.value = true
  personaErr.value = false
  try {
    const ok = await deletePersona(p.id)
    if (!ok) return personaFail('删除', '没能删掉这份人设，请重试')
    if (editingPersona.value?.id === p.id) editingPersona.value = null
    await loadPersonas()
    await refresh()
    flashPersonaMsg('已删除')
  } catch (err) {
    personaFail('删除', err?.message ?? err)
  } finally {
    personaBusy.value = false
  }
}

async function runDiagnose() {
  diagnosing.value = true
  diagResult.value = null
  try {
    await saveSettings(formPatch())
    diagResult.value = await diagnoseChat()
  } finally {
    diagnosing.value = false
  }
}
/*
 * dirty 判定：除 chatApiKey 外逐键与 state.settings 比（不依赖键序，也
 * 不会因后端多返回字段产生「假 dirty」）；chatApiKey 与已保存值比。
 */
const dirty = computed(() => {
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (k === 'chatApiKey') continue
    if (JSON.stringify(form[k]) !== JSON.stringify(state.settings[k])) return true
  }
  return String(form.chatApiKey ?? '') !== savedApiKey.value
})

/* 进入设置页就把人设列表拉全；同时拉全量设置 —— state 快照不含 API Key
   原文（广播面脱敏），表单需要真实值 */
onMounted(() => {
  loadPersonas().catch(() => {})
  getFullSettings()
    .then((full) => {
      if (full) {
        Object.assign(form, full)
        savedApiKey.value = String(full.chatApiKey ?? '')
      }
    })
    .catch(() => {})
    .finally(() => {
      /* 失败也放行：mock/异常场景下表单值即当前值，继续拦只会让 Key 永远存不上 */
      keyLoaded.value = true
    })
})

watch(
  () => state.settings,
  (next) => Object.assign(form, next),
  { immediate: true, deep: true },
)

async function save() {
  saving.value = true
  try {
    const ok = await saveSettings(formPatch())
    if (ok) {
      if (keyLoaded.value) savedApiKey.value = String(form.chatApiKey ?? '')
      savedAt.value = new Date()
      window.setTimeout(() => (savedAt.value = null), 2200)
    }
  } finally {
    saving.value = false
  }
}

async function revert() {
  Object.assign(form, state.settings)
  form.chatApiKey = savedApiKey.value
}

async function reset() {
  const ok = await resetSettings()
  if (ok) {
    Object.assign(form, state.settings)
    savedApiKey.value = ''
    form.chatApiKey = ''
  }
}

/* ---------- 聊天背景 ---------- */

/** 已解锁照片的**全部**路径（图鉴快照里有实际存在的那些） */
const allPhotoPaths = computed(() => {
  const g = state.gallery
  const out = new Set()
  for (const kind of ['outfit', 'photo']) {
    for (const it of g?.[kind]?.items ?? []) for (const p of it.photos ?? []) out.add(p)
  }
  return [...out]
})

/** 轮换池里那些**仍然存在**的图 —— 池子可能存着已删/未生成的路径 */
const bgPool = computed(() => (form.chatBgPool ?? []).filter((p) => allPhotoPaths.value.includes(p)))

/**
 * 「不设背景」是个复选框，而设置里存的是三态字符串。
 * 这样映射而不是直接暴露 select：三态里的 fixed/rotate 是由
 * 「在哪儿设的」决定的（图鉴里点「设为背景」→ fixed，勾「加入轮换」→ rotate），
 * 让用户在一个下拉里再选一遍是重复且容易矛盾的。
 */
const bgOffMode = computed({
  get: () => form.chatBgMode === 'off',
  set: (off) => {
    /* 关闭时保留 chatBackground / chatBgPool，用户再打开不用重选 */
    form.chatBgMode = off ? 'off' : (form.chatBgPool ?? []).length ? 'rotate' : 'fixed'
  },
})

async function removeFromBgPool(path) {
  const next = (form.chatBgPool ?? []).filter((p) => p !== path)
  form.chatBgPool = next
  /* 池子空了且正在轮换 → 一起退回关闭，别留个永不生效的「轮换中」 */
  if (!next.length && form.chatBgMode === 'rotate') form.chatBgMode = 'off'
}

/* ---------- 清空全部本地数据 ---------- */

const wipeConfirm = ref(false)
const wipeBusy = ref(false)
const wipeMsg = ref('')

/**
 * 两步确认，不做「输入文字确认」。
 *
 * 权衡：输入确认能挡住手抖，但这是**本地数据**、不可恢复，
 * 而按钮藏在设置页的「数据与同步」最下面 —— 两步已经足够，
 * 再加一道输入门槛反而让人以为这事比实际更危险。
 * 真要更强的保护，应该问的是「要不要做备份」，不是「要不要多按几次」。
 */
async function wipeAll() {
  wipeBusy.value = true
  wipeMsg.value = ''
  try {
    const ok = await wipeAllData()
    /* 表单必须回到默认 —— 界面上还留着清空前那份的话，
       用户会以为没清掉（尤其换装列表和轮换池都跟着回不去了）。 */
    if (ok) Object.assign(form, { ...DEFAULT_SETTINGS, ...state.settings })
    wipeMsg.value = ok ? '已清空全部本地数据，正在刷新界面…' : (state.lastError ?? '清空失败')
    wipeConfirm.value = false
  } finally {
    /* 无论如何都要解锁按钮：卡在「清空中…」会让人以为程序死了 */
    wipeBusy.value = false
  }
}

/* 摸鱼时长快捷记账 */
const quickMinutes = ref(15)
async function addMoyu() {
  await logMoyu(quickMinutes.value)
}

/* 备份数据：打开数据所在目录（浏览器预览无此能力，静默失败） */
async function onOpenDataDir() {
  await win.openDataDir()
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
          <label>开机自启</label>
          <label class="switch">
            <input
              :checked="form.autoStart"
              type="checkbox"
              @change="onAutoStartChange($event.target.checked)"
            />
            <span>登录 Windows 后自动运行；便携目录挪动后下次启动自动修正</span>
          </label>
          <p v-if="isDev" class="hint">开发模式下注册的是调试版 exe，正式使用请在打包版里开启</p>
        </div>
        <div class="field">
          <label>偷偷摸摸模式</label>
          <label class="switch">
            <input v-model="form.studyDisguise" type="checkbox" />
            <span>开启后金额显示为学习进度（如「已背 432 词」）、文案切换为学习风格，降低划水观感</span>
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
          <span class="hint">
            只在她旁边的<b>气泡</b>里冒一句，说完就没 —— 不进聊天记录、不产生未读。
            实际间隔会在此基础上随机浮动，免得像定时机器人。
          </span>
        </div>

        <!--
          「主动找话题」是**独立**于上面那个的功能：它会落成真消息。
          两者各有各的定时器与间隔，互不影响。
        -->
        <div class="field">
          <label>主动找话题</label>
          <label class="switch">
            <input v-model.number="form.petTopicMin" type="checkbox" :true-value="topicDefault" :false-value="0" />
            <span>她会主动给你发消息（有未读红点）</span>
          </label>
        </div>
        <div v-if="form.petTopicMin" class="field">
          <label>找话题间隔（分钟）</label>
          <input v-model.number="form.petTopicMin" type="number" min="5" max="720" step="5" />
          <span class="hint">
            这条<b>会进聊天记录</b>、会亮未读红点 —— 和「主动说话」是两回事。
            正在聊天时她不会另外发，只在你们安静下来之后才找话头。
          </span>
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
            当前 {{ state.affinity?.points ?? 0 }} / {{ state.affinity?.max ?? AFFINITY_MAX_POINTS }} 点 ·
            {{ affinityName }} · 连续 {{ state.affinity?.streakDays ?? 0 }} 天
          </span>
          <span class="hint">
            聊天一条 +{{ affinityGain.chatMessage }}、聊完一轮 +{{ affinityGain.chatRound }}，
            聊得让她开心再 +1~3（<strong>聊天不限量</strong>）；
            摸头 +{{ affinityGain.pet }}、双击 +{{ affinityGain.double }}（桌宠互动合计每日
            {{ affinityGain.petDailyCap }} 点封顶）、每天见面 +{{ affinityGain.daily }}、
            解锁新照片 +{{ affinityGain.photoUnlock }}。
            关系越近，Yuki 说话越黏、主动搭话越频繁，聊天窗标题栏会实时显示进度。
          </span>
          <span class="hint">
            每天自然流失 {{ affinityDecay.DAILY_DRAIN }} 点（跟聊没聊无关）；
            一整天完全没互动再额外扣 {{ affinityDecay.IDLE_PENALTY }} 点；
            说重话惹她生气当轮扣 {{ affinityDecay.UPSET }} 点且不加分。
            掉档只会让说话变冷，<strong>已经解锁的照片和衣服不会收回</strong>。
          </span>
          <button class="btn" :disabled="affinityBusy" @click="onResetAffinity">
            {{ affinityBusy ? '重置中…' : '重置亲密度' }}
          </button>
          <span v-if="affinityMsg" class="hint">{{ affinityMsg }}</span>
        </div>

        <!-- 上帝模式：只影响「能看到什么」，不动真实进度 -->
        <div class="field">
          <label>上帝模式</label>
          <label class="switch">
            <input v-model="form.godMode" type="checkbox" />
            <span>解锁全部服饰与图鉴，轮换池直接给到满级</span>
          </label>
          <span class="hint">
            只是「显示层」打开：亲密度点数和图鉴进度<strong>一点没动</strong>，
            关掉开关立刻回到真实档位。真实进度当前 {{ state.affinity?.points ?? 0 }} 点。
          </span>
        </div>

        <!-- 换装：和对话窗、右键菜单读写同一份设置 -->
        <div class="field">
          <label>换装</label>
          <label class="switch">
            <input v-model="autoOutfit" type="checkbox" />
            <span>自动轮换（每隔一段时间换一套）</span>
          </label>
          <div class="field">
            <label>轮换间隔（分钟）</label>
            <input
              v-model.number="form.petRotateMin"
              type="number"
              :min="ROTATE_MIN_MIN"
              :max="ROTATE_MIN_MAX"
              step="1"
            />
            <span class="hint">
              实际等待会在此基础上随机浮动 ±25%，免得像定时机器人。
            </span>
          </div>

          <!-- 轮换池自选：只在已解锁范围内勾 -->
          <div class="field">
            <label>轮换内容</label>
            <div class="pool-toolbar">
              <button class="btn" @click="selectAllRotatePool">全选</button>
              <button class="btn" @click="resetRotatePool">恢复默认（全部）</button>
              <span class="hint">实际轮换 {{ rotatePoolEffective }} 项</span>
            </div>
            <div class="pool-group">
              <span class="pool-group-title">动作</span>
              <button
                v-for="c in rotatePoolActions"
                :key="c.key"
                class="pool-chip"
                :class="{ active: isInRotatePool(c.key) }"
                @click="toggleRotatePool(c.key)"
              >
                {{ c.label }}
              </button>
            </div>
            <div class="pool-group">
              <span class="pool-group-title">服饰</span>
              <button
                v-for="c in rotatePoolOutfits"
                :key="c.key"
                class="pool-chip"
                :class="{ active: isInRotatePool(c.key) }"
                @click="toggleRotatePool(c.key)"
              >
                {{ c.emoji }} {{ c.label }}
              </button>
            </div>
            <span class="hint">
              只列已解锁的（随亲密度解锁，上帝模式下是全部）。一个都没勾 = 全部都轮换。
              想完全停掉轮换，用上面的「固定穿某一套」。
            </span>
          </div>

          <div class="outfit-row">
            <button
              v-for="o in outfits"
              :key="o.slug"
              class="outfit-chip"
              :class="{ active: !autoOutfit && form.outfitSlug === o.slug, locked: !isOutfitUnlocked(o.slug) }"
              :disabled="!isOutfitUnlocked(o.slug)"
              :title="isOutfitUnlocked(o.slug) ? o.hint : `${o.hint}（未解锁：亲密度到「${outfitUnlockTierName(o.slug)}」、且聊到相关话题后她会发照片给你）`"
              @click="pickOutfit(o.slug)"
            >
              {{ isOutfitUnlocked(o.slug) ? '' : '🔒 ' }}{{ o.emoji }} {{ o.label }}
            </button>
          </div>
          <span class="hint">
            选一套即固定不再自动切换（轮换会停）；勾上「自动轮换」恢复。
            清单列出全部 {{ outfits.length }} 套，但<strong>带锁的选不了</strong> ——
            只有她发过照片的那 {{ unlockedOutfitCount }} 套能穿。去图鉴看还差哪些。
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
            <!-- 编辑器关着的时候（复制/新建/删除 失败就是这种情形），提示必须
                 落在按钮旁边 —— 只在编辑器里显示的话，失败就是「点了没反应」 -->
            <b v-if="personaMsg && !editingPersona" class="persona-msg" :class="{ err: personaErr }">
              · {{ personaMsg }}
            </b>
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

      <!-- 聊天背景：与手机端共用 chatBackground.js 的选图逻辑 -->
      <div class="field bg-field">
        <label>聊天背景</label>
        <div class="bg-modes">
          <label class="switch">
            <input v-model="bgOffMode" type="checkbox" />
            <span>不设背景（关闭）</span>
          </label>
          <p class="hint">
            背景只能从<strong>图鉴里已解锁的照片</strong>里选 —— 去图鉴点开一张照片，
            用「设为背景」或「加入轮换」。
          </p>
        </div>

        <template v-if="form.chatBgMode !== 'off'">
          <div class="field">
            <label>背景浓度 {{ Math.round((Number(form.chatBgOpacity) || 0.25) * 100) }}%</label>
            <input
              v-model.number="form.chatBgOpacity"
              type="range"
              min="0.05"
              max="0.85"
              step="0.05"
            />
            <span class="hint">数值越大照片越清楚、气泡文字越吃力。默认 25%。</span>
          </div>

          <div v-if="form.chatBgMode === 'rotate'" class="field">
            <label>轮换间隔（分钟）</label>
            <input v-model.number="form.chatBgRotateMin" type="number" min="5" max="1440" step="5" />
            <span class="hint">
              轮换池 {{ bgPool.length }} 张。<strong>按时间片取模</strong>算，不存「轮到第几张」——
              所以手机端和桌面端同一时刻显示的永远是同一张，刷新也不会跳回第一张。
            </span>
          </div>

          <div v-if="bgPool.length" class="field">
            <label>轮换池</label>
            <div class="bg-pool">
              <div v-for="p in bgPool" :key="p" class="bg-pool-item">
                <img :src="p" alt="" />
                <button class="bg-pool-del" title="移出轮换池" @click="removeFromBgPool(p)">✕</button>
              </div>
            </div>
            <span class="hint">在轮换池里的照片，图鉴里会带角标。</span>
          </div>
          <p v-else-if="form.chatBgMode === 'rotate'" class="hint warn">
            轮换池是空的 —— 轮换不会生效（等同关闭）。去图鉴点开一张照片选「加入轮换」。
          </p>
        </template>
      </div>
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
          <span class="hint">运行环境：{{ syncStatus.backend === 'native' ? '桌面版（数据在本机 SQLite）' : '浏览器预览模式（数据不落盘）' }}</span>
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
        <div class="field">
          <label>备份数据</label>
          <button class="btn" @click="onOpenDataDir">打开数据目录</button>
          <span class="hint">数据库与设置都在这个目录，拷走即备份</span>
        </div>

        <!-- 破坏性操作：两步确认，且与「重置全部设置」明确分开 -->
        <div class="field danger">
          <label>清空全部本地数据</label>
          <template v-if="!wipeConfirm">
            <button class="btn danger" @click="wipeConfirm = true">清空全部数据…</button>
          </template>
          <template v-else>
            <div class="danger-warn">
              将删除：聊天记录、打卡与摸鱼时长、图鉴与亲密度进度、自定义人设、全部设置。
              <strong>无法恢复</strong>，也没有回收站。确定继续？
            </div>
            <div class="inline">
              <button class="btn danger" :disabled="wipeBusy" @click="wipeAll">
                {{ wipeBusy ? '清空中…' : '确认清空（不可恢复）' }}
              </button>
              <button class="btn" :disabled="wipeBusy" @click="wipeConfirm = false">取消</button>
            </div>
          </template>
          <span v-if="wipeMsg" class="hint">{{ wipeMsg }}</span>
          <span class="hint">
            只想改设置请用上面的「重置全部设置」—— 那个不会碰数据。
          </span>
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

/*
 * 未解锁的服饰：必须一眼看出「点了没用」。
 *
 * 之前锁着的和解锁的长得一模一样，而 `currentOutfitSlug` 是**静默回落**的 ——
 * 用户点一下发现衣服没变，只能靠猜。列表又必须列全（否则新解锁的那套
 * 永远没机会被发现），所以「区分」这件事只能靠视觉。
 */
.outfit-chip.locked {
  border-style: dashed;
  background: transparent;
  color: var(--text-3);
  opacity: 0.55;
  cursor: not-allowed;
}
.outfit-chip.locked:hover {
  border-color: var(--border);
  color: var(--text-3);
}
.outfit-chip.locked.active {
  border-color: var(--border);
  background: transparent;
  color: var(--text-3);
}

/* ---------- 轮换池选择器 ---------- */

/*
 * 用比 outfit-chip 更弱的默认态：这一屏可能有 30+ 个格子（满级 10 动作 + 24 服饰），
 * 全用和「换装」一样的强强调会让人以为这里也是「点一下就穿上」。
 * 池子的语义是「参与轮换」，弱化是对的。
 */
.pool-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0;
}
.pool-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 8px;
}
.pool-group-title {
  width: 34px;
  flex: none;
  font-size: 11.5px;
  color: var(--text-3);
}
.pool-chip {
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-3);
  font-size: 11.5px;
  line-height: 1.6;
}
.pool-chip:hover {
  border-color: rgb(var(--theme-accent) / 0.5);
  color: var(--text-2);
}
.pool-chip.active {
  border-color: rgb(var(--theme-accent) / 0.65);
  background: var(--theme-accent-soft);
  color: rgb(var(--theme-accent));
}

/* ---------- 聊天背景 ---------- */

/* 与上面的对话配置隔开：它是外观项，不是「能不能聊」的配置 */
/*
 * 同样不加 border-top —— 理由与上面的 `.field.danger` 一致：
 * grid 是**多列**的，网格项上的边框只跨自己那一列，会变成半截横线。
 * 靠间距和内容本身的视觉重量分区就够了。
 */
.bg-field {
  padding-top: 4px;
}
.bg-modes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hint.warn {
  color: #d97706;
}

.bg-pool {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.bg-pool-item {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.bg-pool-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.bg-pool-del {
  position: absolute;
  right: 3px;
  top: 3px;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.bg-pool-del:hover {
  background: rgba(220, 38, 38, 0.85);
}

/* ---------- 危险操作 ---------- */

/*
 * 刻意**不加 border-top**。
 *
 * 这里原来有一条 `border-top: 1px solid`，想跟上面的「恢复默认」隔开。
 * 但 `.grid` 是 `repeat(auto-fill, minmax(240px, 1fr))` 的**多列**网格，
 * 这个 field 只是其中一个网格项 —— 边框只跨自己那一列，
 * 渲染出来是「半截横线」，看着像渲染故障而不是分隔线。
 *
 * 分隔由两件事提供了：网格自带的 16px 间距，以及红色按钮 + 红框警告块。
 * 要真做分隔线，得让元素跨满整行（grid-column: 1 / -1），
 * 但那样得为此单独加一个空元素，不值得。
 */
.field.danger {
  padding-top: 4px;
}
.danger-warn {
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgb(220 38 38 / 0.4);
  background: rgb(220 38 38 / 0.08);
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
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
.persona-msg {
  font-weight: 600;
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
