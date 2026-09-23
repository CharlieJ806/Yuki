/**
 * 生成一个「像 Meshy 产物」的测试 GLB，用来在没网的环境下验证 3D 查看器。
 *
 * 刻意复刻 Meshy 导出物的特征：
 *   - 单个 skin + 骨骼动画（Meshy 人形会带 walk/idle 之类的 clip）
 *   - 带贴图的 PBR 材质（金属度非 0，查看器要能压掉）
 *   - 非零原点、脚底不在 y=0（查看器必须自己归位）
 *   - 面数在几万级（低模档的真实量级）
 *
 * 用法：验证台（?route=pet3d）上的「生成测试模型」按钮。
 *
 * 为什么不做成 Node CLI：GLTFExporter 编码贴图时必须走 canvas，
 * Node 里没有，要跑得装 node-canvas 这个重依赖。而验证台本来就在
 * 浏览器里，原生 canvas 现成，没必要为省一次点击引入原生编译依赖。
 */
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

/* ---------- 1. 骨骼：脊椎 + 双臂 + 双腿，够验证 skinned 路径 ---------- */

const bones = []
function bone(name, x, y, z) {
  const b = new THREE.Bone()
  b.name = name
  b.position.set(x, y, z)
  bones.push(b)
  return b
}

const hips = bone('Hips', 0, 0.75, 0)
const spine = bone('Spine', 0, 0.4, 0)
const chest = bone('Chest', 0, 0.3, 0)
const neck = bone('Neck', 0, 0.17, 0)
const head = bone('Head', 0, 0.13, 0)
hips.add(spine)
spine.add(chest)
chest.add(neck)
neck.add(head)

const armL = bone('ArmL', 0.26, 0.24, 0)
const armR = bone('ArmR', -0.26, 0.24, 0)
chest.add(armL, armR)

const legL = bone('LegL', 0.13, 0, 0)
const legR = bone('LegR', -0.13, 0, 0)
hips.add(legL, legR)

const skeleton = new THREE.Skeleton(bones)

/* ---------- 2. 蒙皮网格：一个塔形身材，几万面 ---------- */

const RADIAL = 32
const HSEG = 240
/* 躯干：上窄下略宽，近似人形；半径比头部大才不会把头吞掉 */
const body = new THREE.CylinderGeometry(0.26, 0.34, 1.62, RADIAL, HSEG, false)
body.translate(0, 0.81, 0)

/* 头：抬到躯干之上，半径 0.24，明显粗于颈部 */
const headGeo = new THREE.SphereGeometry(0.24, 32, 24)
headGeo.scale(1, 1.15, 1)
headGeo.translate(0, 1.78, 0)

/* 双臂：从肩部斜下，验证骨骼蒙皮的形变 */
const armGeo = new THREE.CapsuleGeometry(0.085, 0.62, 8, 16)
armGeo.translate(0.36, 1.28, 0)

const merged = mergeBuffers([body, headGeo, armGeo])
const triCount = merged.index ? merged.index.count / 3 : merged.attributes.position.count / 3

/*
 * 蒙皮权重：按顶点高度在两段之间线性混合，够驱动动画即可。
 * 骨骼下标 0=Hips 1=Spine 2=Chest 3=Neck 4=Head。
 * 分段按新比例走：躯干 [0,1.62]，头 [1.62,2.10]。
 */
const pos = merged.attributes.position
const skinIndices = new Float32Array(pos.count * 4)
const skinWeights = new Float32Array(pos.count * 4)
for (let i = 0; i < pos.count; i++) {
  const y = pos.getY(i)
  let a = 0
  let b = 0
  let t = 0

  if (y < 0.75) {
    a = 0; b = 0; t = 0
  } else if (y < 1.15) {
    a = 0; b = 1; t = (y - 0.75) / 0.4
  } else if (y < 1.45) {
    a = 1; b = 2; t = (y - 1.15) / 0.3
  } else if (y < 1.62) {
    a = 2; b = 3; t = (y - 1.45) / 0.17
  } else if (y < 1.75) {
    a = 3; b = 4; t = (y - 1.62) / 0.13
  } else {
    a = 4; b = 4; t = 0
  }

  skinIndices[i * 4] = a
  skinIndices[i * 4 + 1] = b
  skinWeights[i * 4] = 1 - t
  skinWeights[i * 4 + 1] = t
}
merged.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4))
merged.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4))

/* ---------- 3. 贴图：程序化格子，验证纹理能否嵌入 GLB ---------- */

const tex = makeTexture()
const material = new THREE.MeshStandardMaterial({
  map: tex,
  /* Meshy 默认输出带金属度，故意设高，看查看器是否压掉高光 */
  metalness: 0.6,
  roughness: 0.35,
})

const mesh = new THREE.SkinnedMesh(merged, material)
mesh.name = 'YukiBody'
mesh.add(hips)
mesh.bind(skeleton)

/* 故意偏移原点、让脚底离开 y=0 —— 查看器必须自己归位 */
mesh.position.set(3.5, -1.2, -7.4)

/* ---------- 4. 动画：一段待机摆动 ---------- */

const times = [0, 0.5, 1, 1.5, 2]
const armLTrack = new THREE.QuaternionKeyframeTrack(
  'ArmL.quaternion',
  times,
  times.map((t) => new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(t * Math.PI) * 0.6, 0, 0)).toArray()).flat(),
)
const armRTrack = new THREE.QuaternionKeyframeTrack(
  'ArmR.quaternion',
  times,
  times.map((t) => new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.sin(t * Math.PI) * 0.6, 0, 0)).toArray()).flat(),
)
const hipsTrack = new THREE.VectorKeyframeTrack(
  'Hips.position',
  times,
  times.map((t) => [0, 0.75 + Math.sin(t * Math.PI * 2) * 0.02, 0]).flat(),
)
const clip = new THREE.AnimationClip('Idle', 2, [armLTrack, armRTrack, hipsTrack])

/* ---------- 5. 导出 ---------- */

const scene = new THREE.Scene()
scene.add(mesh)

/**
 * 生成测试 GLB。
 * @returns {Promise<{buffer: ArrayBuffer, triangles: number, bones: number, animation: string}>}
 */
export async function buildTestGlb() {
  const exporter = new GLTFExporter()
  const glb = await new Promise((res, rej) => {
    exporter.parse(scene, res, rej, { binary: true, animations: [clip], onlyVisible: false })
  })
  return {
    buffer: glb,
    triangles: Math.round(triCount),
    bones: bones.length,
    animation: clip.name,
  }
}

/* ---------- 工具函数 ---------- */

/** 把多个非索引几何体合成一个带索引的几何体（只保留 position/uv/normal） */
function mergeBuffers(geos) {
  const positions = []
  const uvs = []
  const normals = []
  const indices = []
  let offset = 0

  for (const g of geos) {
    const p = g.attributes.position
    const n = g.attributes.normal
    const u = g.attributes.uv
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i))
      if (n) normals.push(n.getX(i), n.getY(i), n.getZ(i))
      if (u) uvs.push(u.getX(i), u.getY(i))
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) indices.push(g.index.getX(i) + offset)
    } else {
      for (let i = 0; i < p.count; i++) indices.push(i + offset)
    }
    offset += p.count
  }

  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  out.setIndex(indices)
  return out
}

/** 程序化棋盘贴图，避免依赖外部图片 */
function makeTexture() {
  const S = 256
  const canvas = makeCanvas(S, S)
  const g = canvas.getContext('2d')
  if (canvas.__flat) {
    const px = new Uint8Array(S * S * 4)
    for (let i = 0; i < S * S; i++) {
      px[i * 4] = 0xe8
      px[i * 4 + 1] = 0xb9
      px[i * 4 + 2] = 0xc9
      px[i * 4 + 3] = 0xff
    }
    const t = new THREE.DataTexture(px, S, S)
    t.colorSpace = THREE.SRGBColorSpace
    t.needsUpdate = true
    return t
  }
  g.fillStyle = '#e8b9c9'
  g.fillRect(0, 0, S, S)
  g.fillStyle = '#c98ba4'
  for (let y = 0; y < S; y += 32) {
    for (let x = 0; x < S; x += 32) {
      if (((x / 32) + (y / 32)) % 2 === 0) g.fillRect(x, y, 32, 32)
    }
  }
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Node 没有 document；返回带 __flat 标记的占位对象，走 DataTexture 分支 */
function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  return { width: w, height: h, __flat: true, getContext: () => ({ fillStyle: '', fillRect() {} }) }
}
