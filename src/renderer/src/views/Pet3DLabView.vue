<script setup>
/**
 * 3D 桌宠可行性验证台。
 *
 * 独立于桌宠主流程：不动 PetApp，不改主进程窗口设置，
 * 只回答一个问题 —— 「Meshy 出的 GLB 能不能当桌宠用」。
 *
 * 支持两种喂模型的方式：
 *   1. 把 .glb 拖到页面里（本地文件，不落盘，最省事）
 *   2. 放进 src/renderer/public/models/ 后从下拉框选
 */
import { computed, onMounted, ref, shallowRef } from 'vue'
import Pet3DViewer from '../pet/Pet3DViewer.vue'

const modelUrl = shallowRef('')
const fileName = ref('')
const dragging = ref(false)
const petScale = ref(1)
const idle = ref(true)
const generating = ref(false)

const stats = ref(null)
const errorMsg = ref('')
const pointerOnBody = ref(false)
/** 记录是否分别见过「透空」和「本体」两种状态，用来判定穿透能力真的生效 */
const sawPassthrough = ref(false)
const sawOnBody = ref(false)
const fps = ref(0)

/** 放在 public/models/ 下的预设模型，构建时自动列出来 */
const presets = ref([])

let fpsTimer = null
let frames = 0

const checks = computed(() => [
  {
    key: 'transparent',
    label: '透明背景',
    hint: '角色外的区域应是全透明，不是黑块或白块（下面色块应能透出来）',
    ok: stats.value ? true : null,
  },
  {
    key: 'framed',
    label: '自动取景',
    hint: '模型自动落到画面底部居中，脚不悬空、头不被裁',
    ok: stats.value ? true : null,
  },
  {
    key: 'perf',
    label: '性能（面数）',
    hint: '桌宠常驻悬浮，建议 ≤ 30k 面；超过 60k 会明显拖累核显',
    ok: stats.value ? stats.value.triangles <= 30000 : null,
  },
  {
    key: 'hit',
    label: '鼠标穿透',
    hint: '把鼠标移到角色外的空白处，指针应判定为「空白（可穿透）」；移到角色身上应为「角色本体」',
    /*
     * 这一项量的是「会不会随指针位置变化」。
     * 指针在角色上时报 ✗ 是误报 —— 那只是当前恰好指着身体，
     * 穿透能力要看「移开后能否翻转」，所以记录是否见过两种状态。
     */
    ok: sawPassthrough.value && sawOnBody.value ? true : null,
  },
])

function onFiles(files) {
  const f = files?.find((x) => /\.(glb|gltf)$/i.test(x.name))
  if (!f) {
    errorMsg.value = '请拖入 .glb 或 .gltf 文件'
    return
  }
  errorMsg.value = ''
  fileName.value = f.name
  /* revoke 上一个，避免长时间试验后攒一堆 blob */
  if (modelUrl.value.startsWith('blob:')) URL.revokeObjectURL(modelUrl.value)
  modelUrl.value = URL.createObjectURL(f)
  stats.value = null
}

function onDrop(e) {
  dragging.value = false
  onFiles(e.dataTransfer?.files)
}

function onPick(e) {
  const name = e.target.value
  if (!name) return
  errorMsg.value = ''
  fileName.value = name
  if (modelUrl.value.startsWith('blob:')) URL.revokeObjectURL(modelUrl.value)
  modelUrl.value = `./models/${name}`
  stats.value = null
}

function onReady(s) {
  stats.value = s
  errorMsg.value = ''
  /* 换模型后重置穿透观测，避免上一轮的结果冒充本轮 */
  sawPassthrough.value = false
  sawOnBody.value = false
}

function onError(e) {
  errorMsg.value = String(e?.message ?? e)
}

function onPointer(isBody) {
  pointerOnBody.value = isBody
  if (isBody) sawOnBody.value = true
  else sawPassthrough.value = true
}

/**
 * 现场生成一个「像 Meshy 产物」的测试模型（带骨骼、动画、贴图、偏移原点）。
 * 用途：没有外网、也不想先下 Meshy 模型时，先把整套管线跑通。
 */
async function generateTestModel() {
  generating.value = true
  errorMsg.value = ''
  try {
    const { buildTestGlb } = await import('../../../../scripts/make-test-glb.js')
    const { buffer, triangles, bones, animation } = await buildTestGlb()
    if (modelUrl.value.startsWith('blob:')) URL.revokeObjectURL(modelUrl.value)
    modelUrl.value = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }))
    fileName.value = `自生成测试模型（${Math.round(triangles / 1000)}k 面 / ${bones} 骨骼 / ${animation}）`
    stats.value = null
  } catch (e) {
    errorMsg.value = String(e?.message ?? e)
  } finally {
    generating.value = false
  }
}

onMounted(async () => {
  frames = 0
  fpsTimer = window.setInterval(() => {
    fps.value = frames
    frames = 0
  }, 1000)
  window.__pet3dFrame = () => frames++

  /* 列 public/models/ 下的预设。目录不存在就当空列表 */
  try {
    const r = await fetch('./models/index.json', { cache: 'no-store' })
    if (r.ok) presets.value = await r.json()
  } catch {
    /* 没 index.json 是正常情况 */
  }
})
</script>

<template>
  <div class="lab3d">
    <header class="head">
      <h1>3D 桌宠 · 可行性验证台</h1>
      <p class="sub">把 Meshy 导出的 <b>.glb</b> 拖到下面，逐项对照检查清单。</p>
    </header>

    <section
      class="stage-wrap"
      :class="{ dragging }"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <!-- 透明验证：棋盘格垫在渲染器下方，角色外必须露出格子 -->
      <div class="checker" />
      <div class="stage">
        <Pet3DViewer
          v-if="modelUrl"
          :src="modelUrl"
          :scale="petScale"
          :idle="idle"
          show-status
          @ready="onReady"
          @error="onError"
          @pointer="onPointer"
        />
        <div v-else class="empty">
          <p>拖入 <b>.glb</b> 文件</p>
          <p class="tiny">或放到 src/renderer/public/models/ 后用下方下拉选择</p>
        </div>
      </div>
      <div v-if="dragging" class="drop-hint">松手即加载</div>
    </section>

    <section class="panel">
      <div class="row">
        <label class="lbl">预设</label>
        <select class="sel" @change="onPick">
          <option value="">— 选择 public/models/ 下的模型 —</option>
          <option v-for="p in presets" :key="p.file" :value="p.file">{{ p.label || p.file }}</option>
        </select>
      </div>

      <div class="row">
        <label class="lbl">无网自测</label>
        <button class="btn" :disabled="generating" @click="generateTestModel">
          {{ generating ? '生成中…' : '生成测试模型' }}
        </button>
        <span class="tiny">骨骼 + 动画 + 贴图 + 偏移原点，用来先跑通管线</span>
      </div>

      <div class="row">
        <label class="lbl">缩放</label>
        <input v-model.number="petScale" class="rng" type="range" min="0.4" max="3" step="0.05" />
        <span class="val tabular">{{ Math.round(petScale * 100) }}%</span>
      </div>

      <div class="row">
        <label class="lbl">待机摇摆</label>
        <input v-model="idle" type="checkbox" />
      </div>

      <div v-if="fileName" class="row">
        <label class="lbl">已加载</label>
        <code class="mono">{{ fileName }}</code>
      </div>
      <p v-if="errorMsg" class="err">{{ errorMsg }}</p>
    </section>

    <section class="panel">
      <h2 class="h2">检查清单</h2>
      <ul class="checks">
        <li v-for="c in checks" :key="c.key" :class="c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'unk'">
          <span class="mark">{{ c.ok === true ? '✓' : c.ok === false ? '✗' : '·' }}</span>
          <div class="ctext">
            <p class="clabel">{{ c.label }}</p>
            <p class="chint">{{ c.hint }}</p>
          </div>
        </li>
      </ul>
    </section>

    <section class="panel">
      <h2 class="h2">实测数据</h2>
      <dl class="stats">
        <div><dt>面数</dt><dd class="tabular">{{ stats ? stats.triangles.toLocaleString() : '—' }}</dd></div>
        <div><dt>模型高度</dt><dd class="tabular">{{ stats ? stats.height.toFixed(2) : '—' }}</dd></div>
        <div><dt>动画段数</dt><dd class="tabular">{{ stats ? stats.animations : '—' }}</dd></div>
        <div>
          <dt>指针位置</dt>
          <dd :class="pointerOnBody ? 'on-body' : 'off-body'">{{ pointerOnBody ? '角色本体' : '空白（可穿透）' }}</dd>
        </div>
        <div><dt>渲染帧率</dt><dd class="tabular">{{ fps }} fps</dd></div>
      </dl>
      <p class="note">
        帧率是渲染器自报的 <b>requestAnimationFrame</b> 计数，不含主进程合成开销。
        真正上桌宠窗后要复测的是<b>空闲 CPU 占用</b>：透明置顶窗若每帧都重绘，
        哪怕 60fps 也会持续吃电。
      </p>
    </section>
  </div>
</template>

<style scoped>
.lab3d {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow: auto;
  padding: 24px;
  color: #e6e9f0;
  background: #12141a;
  font-size: 14px;
}

.head h1 {
  margin: 0 0 4px;
  font-size: 20px;
}

.sub {
  margin: 0 0 20px;
  color: #8b93a7;
}

.stage-wrap {
  position: relative;
  height: 460px;
  margin-bottom: 20px;
  border: 1px solid #2a2f3d;
  border-radius: 12px;
  overflow: hidden;
}

.stage-wrap.dragging {
  border-color: #5b8cff;
}

/* 棋盘格：角色外必须露出它，露不出就是背景没透明 */
.checker {
  position: absolute;
  inset: 0;
  background-image: linear-gradient(45deg, #2b2f3a 25%, transparent 25%),
    linear-gradient(-45deg, #2b2f3a 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #2b2f3a 75%),
    linear-gradient(-45deg, transparent 75%, #2b2f3a 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
  background-color: #20242e;
}

.stage {
  position: absolute;
  inset: 0;
}

.empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #8b93a7;
}

.tiny {
  font-size: 12px;
  opacity: 0.7;
}

.drop-hint {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 999px;
  background: #5b8cff;
  color: #fff;
}

.panel {
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid #2a2f3d;
  border-radius: 12px;
  background: #171a21;
}

.h2 {
  margin: 0 0 12px;
  font-size: 15px;
  color: #a8b0c2;
}

.row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 10px;
}

.row:last-child {
  margin-bottom: 0;
}

.lbl {
  flex: 0 0 76px;
  color: #8b93a7;
}

.sel,
.rng {
  flex: 1;
}

.sel {
  padding: 6px 8px;
  border: 1px solid #2a2f3d;
  border-radius: 6px;
  background: #12141a;
  color: inherit;
}

.btn {
  padding: 6px 14px;
  border: 1px solid #3d4453;
  border-radius: 6px;
  background: #242a36;
  color: #dfe3ec;
  cursor: pointer;
}

.btn:hover:not(:disabled) {
  background: #2d3542;
}

.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.tiny {
  font-size: 12px;
  color: #7c8496;
}

.val {
  flex: 0 0 52px;
  text-align: right;
  color: #8b93a7;
}

.mono {
  font-family: ui-monospace, Consolas, monospace;
  color: #7fd6a0;
}

.checks {
  margin: 0;
  padding: 0;
  list-style: none;
}

.checks li {
  display: flex;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid #22262f;
}

.checks li:last-child {
  border-bottom: none;
}

.mark {
  flex: 0 0 18px;
  font-weight: 700;
  text-align: center;
}

.ok .mark {
  color: #4ec97e;
}

.bad .mark {
  color: #ff6b6b;
}

.unk .mark {
  color: #5a6274;
}

.ctext p {
  margin: 0;
}

.clabel {
  color: #dfe3ec;
}

.chint {
  font-size: 12px;
  color: #7c8496;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin: 0;
}

.stats dt {
  font-size: 12px;
  color: #8b93a7;
}

.stats dd {
  margin: 2px 0 0;
  font-size: 18px;
}

.on-body {
  color: #ffd166;
}

.off-body {
  color: #4ec97e;
}

.note {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #7c8496;
}

.err {
  margin: 10px 0 0;
  color: #ff6b6b;
}
</style>
