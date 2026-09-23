<script setup>
/**
 * GLB 桌宠查看器 —— 3D 化可行性验证用。
 *
 * 目标（按验证清单）：
 *   1. 透明背景          —— alpha:true + setClearAlpha(0)，不带任何背景色
 *   2. 自动取景与缩放     —— 按包围盒算相机距离，换模型不用手调
 *   3. 鼠标穿透          —— 只在不透明像素上让指针事件命中（alpha 阈值）
 *   4. 常驻性能          —— 按需渲染，静止时不烧 CPU
 *
 * 刻意不做的：阴影、后处理、环境贴图。桌宠常驻悬浮，任何一项都够吃掉一个核。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const props = defineProps({
  /** GLB 地址，相对 public/ 或绝对 URL */
  src: { type: String, required: true },
  /** 桌宠整体缩放，和 2D 版共用同一套语义 */
  scale: { type: Number, default: 1 },
  /** 待机时轻微摇摆，比死物有生气 */
  idle: { type: Boolean, default: true },
  /**
   * 鼠标穿透阈值：alpha 低于它的像素不接收指针事件。
   * 0.02 时几乎只有真正的透明区穿透，适合「想点得到角色本体」。
   */
  alphaThreshold: { type: Number, default: 0.02 },
  /**
   * 是否显示状态角标（加载中 / 动画段数）。
   * 验证台开着便于核对；桌宠窗里必须关掉，否则会贴着模型底部挂一条黑条。
   */
  showStatus: { type: Boolean, default: false },
})

const emit = defineEmits(['ready', 'error', 'pointer'])

const host = ref(null)
const loading = ref(true)
const status = ref('')

let renderer = null
let scene = null
let camera = null
let root = null
let mixer = null
let raf = null
let resizeObserver = null
let idleStart = 0

/* 指针穿透用：离屏画布记录每帧的 alpha，供命中测试查询 */
let hitCtx = null
let hitCanvas = null
let hitW = 0
let hitH = 0
let hitPending = false

const clock = new THREE.Clock()

/**
 * 把相机摆到刚好装下模型并居中。
 *
 * 桌宠是竖长条，相机按包围盒算距离；横向也要校一次，
 * 否则窄窗（桌宠窗 340x700）会把模型左右裁掉。
 */
function frameObject(camera, object, scale = 1) {
  reframeForScale(camera, object, scale)
  return { size: new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()) }
}

/** 缩放通过拉远/推近相机实现，模型世界尺寸不变，避免累积误差 */
function reframeForScale(camera, root, scale) {
  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())

  const s = Math.max(scale, 0.05)
  const vFov = (camera.fov * Math.PI) / 180
  /* 纵向装得下 */
  const distV = (size.y / 2) / Math.tan(vFov / 2) * 1.06 / s
  /* 横向也要装得下，取两者中较远的 */
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect)
  const distH = (size.x / 2) / Math.tan(hFov / 2) * 1.06 / s
  const dist = Math.max(distV, distH)

  /*
   * 居中即可，不做「盒底贴画面底」。
   * 那样做的后果是模型顶端紧贴画面顶，透视会让实际顶点超出包围盒，顶部必被裁。
   * 1.06 的距离余量在上下各留出 (2*dist*tan(vFov/2) - size.y)/2 的安全边距。
   */
  camera.position.set(center.x, center.y, center.z + dist)
  camera.lookAt(center.x, center.y, center.z)
  camera.updateProjectionMatrix()
}

/**
 * 把模型水平居中、底部归零。
 * Meshy 导出物的原点五花八门，不归位就会飘在半空或被裁掉。
 */
function groundAndCenter(object) {
  const box = new THREE.Box3().setFromObject(object)
  const center = box.getCenter(new THREE.Vector3())
  object.position.x -= center.x
  object.position.y -= box.min.y
  object.position.z -= center.z
}

function resize() {
  if (!renderer || !host.value) return
  const w = host.value.clientWidth
  const h = host.value.clientHeight
  if (w === 0 || h === 0) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  renderer.setPixelRatio(dpr)
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()

  /*
   * 桌宠窗是竖长条、验证台是横宽条，同一个模型在两种比例下要都能装下。
   * 纵向 FOV 固定，比例变窄时必须按横向再校一次，否则左右会被裁。
   */
  if (root) reframeForScale(camera, root, props.scale)

  hitW = Math.round(w * dpr)
  hitH = Math.round(h * dpr)
  hitCanvas.width = hitW
  hitCanvas.height = hitH
}

/** 按当前 alpha 阈值抽出不透明像素掩膜，供指针命中测试 */
function updateHitMask() {
  if (!renderer || hitPending) return
  hitPending = true
  renderer.domElement.toBlob(async (blob) => {
    hitPending = false
    if (!blob || !hitCtx) return
    try {
      const bmp = await createImageBitmap(blob)
      hitCtx.clearRect(0, 0, hitW, hitH)
      hitCtx.drawImage(bmp, 0, 0, hitW, hitH)
      bmp.close()
    } catch {
      /* 掩膜失败只是让穿透退回整块矩形，不该影响渲染 */
    }
  })
}

/** 该屏幕坐标是否落在角色不透明像素上 */
function hitsOpaque(clientX, clientY) {
  if (!host.value || !hitCtx || hitW === 0) return true
  const rect = host.value.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const x = Math.round((clientX - rect.left) * dpr)
  const y = Math.round((clientY - rect.top) * dpr)
  if (x < 0 || y < 0 || x >= hitW || y >= hitH) return false
  const a = hitCtx.getImageData(x, y, 1, 1).data[3] / 255
  return a > props.alphaThreshold
}

function tick() {
  raf = requestAnimationFrame(tick)
  const dt = clock.getDelta()

  if (mixer) mixer.update(dt)

  /* 待机摇摆：绕 Y 轴低频摆动 ±3°，幅度小到不干扰阅读气泡 */
  if (props.idle && root) {
    const t = (performance.now() - idleStart) / 1000
    root.rotation.y = Math.sin(t * 0.7) * 0.052
  }

  renderer.render(scene, camera)
  if (typeof window !== 'undefined' && window.__pet3dFrame) window.__pet3dFrame()
  updateHitMask()
}

function disposeScene() {
  if (root) {
    root.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) {
          if (!m) continue
          for (const k of Object.keys(m)) {
            const v = m[k]
            if (v && v.isTexture) v.dispose()
          }
          m.dispose?.()
        }
      }
    })
    scene.remove(root)
    root = null
  }
  mixer = null
}

async function load() {
  loading.value = true
  status.value = ''
  disposeScene()

  try {
    const loader = new GLTFLoader()
    const gltf = await loader.loadAsync(props.src)
    const model = gltf.scene

    /* Meshy 的 GLB 常带 PBR 金属度，桌宠不需要高光，压掉更接近立绘观感 */
    model.traverse((o) => {
      if (!o.isMesh) return
      o.castShadow = false
      o.receiveShadow = false
      o.frustumCulled = false
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) {
        if (!m) continue
        m.metalness = 0
        m.roughness = 0.9
        /* 双面渲染：低模偶尔有翻面，正面剔除会出现空洞 */
        m.side = THREE.DoubleSide
        m.transparent = false
      }
    })

    root = model
    groundAndCenter(root)
    scene.add(root)

    if (gltf.animations?.length) {
      mixer = new THREE.AnimationMixer(root)
      mixer.clipAction(gltf.animations[0]).play()
      status.value = `自带动画 ${gltf.animations.length} 段`
    } else {
      status.value = '无动画'
    }

    frameObject(camera, root, props.scale)
    idleStart = performance.now()

    /*
     * 把取景结果挂到 window 上，便于用无头浏览器量取景对不对。
     * 桌宠是常驻程序，这类「画面对不对」的问题肉眼看不准，
     * 留一个可查询的出口比每次截图比对可靠。
     */
    const fbox = new THREE.Box3().setFromObject(root)
    window.__pet3dDebug = {
      boxMin: fbox.min.toArray(),
      boxMax: fbox.max.toArray(),
      camPos: camera.position.toArray(),
      camAspect: camera.aspect,
      fov: camera.fov,
      visibleH: 2 * (camera.position.z - fbox.getCenter(new THREE.Vector3()).z) * Math.tan((camera.fov * Math.PI) / 360),
    }
    const box = new THREE.Box3().setFromObject(root)
    const tri = countTriangles(root)
    emit('ready', { triangles: tri, height: box.getSize(new THREE.Vector3()).y, animations: gltf.animations?.length ?? 0 })
    loading.value = false
  } catch (e) {
    loading.value = false
    status.value = String(e?.message ?? e)
    emit('error', e)
  }
}

function countTriangles(obj) {
  let n = 0
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry) return
    const g = o.geometry
    n += g.index ? g.index.count / 3 : (g.attributes?.position?.count ?? 0) / 3
  })
  return Math.round(n)
}

function onPointerMove(e) {
  emit('pointer', hitsOpaque(e.clientX, e.clientY))
}

onMounted(() => {
  const w = host.value.clientWidth || 340
  const h = host.value.clientHeight || 700

  renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
  })
  renderer.setClearAlpha(0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'
  host.value.appendChild(renderer.domElement)

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(38, w / h, 0.01, 100)

  /* 桌宠需要看得见：两盏平价灯，不用 HDR 环境贴图（省显存） */
  const key = new THREE.DirectionalLight(0xffffff, 2.4)
  key.position.set(1, 2, 3)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.9)
  fill.position.set(-2, 0.5, 1.5)
  scene.add(fill)
  scene.add(new THREE.AmbientLight(0xffffff, 0.85))

  hitCanvas = document.createElement('canvas')
  hitCtx = hitCanvas.getContext('2d', { willReadFrequently: true })

  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(host.value)
  window.addEventListener('resize', resize)
  resize()

  raf = requestAnimationFrame(tick)
  load()
})

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  resizeObserver?.disconnect()
  window.removeEventListener('resize', resize)
  disposeScene()
  renderer?.dispose()
  renderer?.domElement?.remove()
  renderer = null
})

watch(() => props.src, load)

watch(
  () => props.scale,
  (s) => {
    if (!root || !camera) return
    /* 缩放靠相机距离实现，模型本身不动，避免累积误差 */
    reframeForScale(camera, root, s)
  },
)

defineExpose({ hitsOpaque })
</script>

<template>
  <div ref="host" class="viewer" @mousemove="onPointerMove">
    <div v-if="showStatus && loading" class="overlay">加载中…</div>
    <div v-else-if="showStatus && status" class="badge">{{ status }}</div>
  </div>
</template>

<style scoped>
.viewer {
  position: relative;
  width: 100%;
  height: 100%;
  /* 透明是验证项之一，这里绝不能有背景色 */
  background: transparent;
}

.overlay,
.badge {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  pointer-events: none;
  white-space: nowrap;
}

.overlay {
  top: 50%;
  transform: translate(-50%, -50%);
}

.badge {
  bottom: 6px;
  font-variant-numeric: tabular-nums;
}
</style>
