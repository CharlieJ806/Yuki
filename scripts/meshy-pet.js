/**
 * Meshy 桌宠模型生成管线。
 *
 * 把 resources/yuki/*.png 的立绘，走 Meshy API 生成「带骨骼、带动画、低面数」的 GLB，
 * 直接产出 resources/pet3d/yuki.glb 供桌宠窗加载。
 *
 * 三步流程（Meshy 把这三件事拆成独立计费的 API）：
 *   1. image-to-3d   立绘 → 网格（这里选 smart-topology，面数可控）
 *   2. rigging       网格 → 人形骨骼（Meshy 只支持人形，且要求 A/T 姿）
 *   3. animations    骨骼 → 挂动画（action_id 见 ANIMATIONS）
 *
 * 用法：
 *   set MESHY_API_KEY=msy_xxx          # Windows
 *   export MESHY_API_KEY=msy_xxx       # bash
 *
 *   node scripts/meshy-pet.js --dry-run         # 只打印将要消耗的额度与参数，不调 API
 *   node scripts/meshy-pet.js                   # 跑完整流程
 *   node scripts/meshy-pet.js --image resources/pet/yuki-pose1.png
 *   node scripts/meshy-pet.js --no-rig          # 只要静态模型，跳过绑骨与动画
 *   node scripts/meshy-pet.js --no-anim         # 绑骨但不单独挂动画（省 6 信用）
 *
 * 额度（官方定价页，2026-09 抓取；接口是 /openapi/v1/*）：
 *   smart-topology 图生3D  5 信用（无贴图）/ 15 信用（有贴图）
 *   自动绑骨               5 信用，**附赠 walking + running 两段动画**
 *   单独挂动画             3 信用 / 个动作（最多 10 个）
 *
 *   所以默认配置（贴图 + 绑骨 + idle/walk）= 15 + 5 + 6 = 26 信用；
 *   加 --no-anim 则只要 20 信用，且仍有 walking/running 可用（少了 idle）。
 *
 * 网络：本机需走系统代理（Windows 设置里配的 127.0.0.1:4780）。
 * 脚本自动读 HTTPS_PROXY / HTTP_PROXY，没有就不走代理。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 产物落两个地方：
 *   resources/pet3d/        源素材（和 resources/pet/ 一个层级，便于重新生成）
 *   src/renderer/public/pet3d/  渲染层要加载的副本（vite 会拷进 dist）
 *
 * 和 prepare-yuki.js 的做法一致 —— 它也是同时写 resources/pet/ 与
 * src/renderer/public/。副本不是冗余：dist 是自包含的，asar 里没有 resources/。
 */
const SRC_DIR = join(ROOT, 'resources', 'pet3d')
const OUT_DIR = join(ROOT, 'src', 'renderer', 'public', 'pet3d')

const API = 'https://api.meshy.ai/openapi/v1'

/* ---------- 参数 ---------- */

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

const DRY_RUN = hasFlag('--dry-run')
const SKIP_RIG = hasFlag('--no-rig')
/*
 * 跳过单独的动画任务。
 * 绑骨响应里已经白送 basic_animations（walking + running），
 * 桌宠只想省额度时用这个：20 信用拿到「绑骨 + 两段动画」，
 * 而不是 26 信用。代价是没有 idle。
 */
const SKIP_ANIM = hasFlag('--no-anim')
const IMAGE = getOpt('--image', join(ROOT, 'resources', 'yuki', '站姿.png'))
const OUT = getOpt('--out', join(SRC_DIR, 'yuki.glb'))

/**
 * 桌面宠物的目标面数。
 * smart-topology 档位范围 100–15,000，取 8000：
 * 实测 17k 面在这台核显上跑 34fps，8k 留足余量且细节够看。
 */
const TARGET_POLYCOUNT = Number(getOpt('--polycount', '8000'))

/**
 * 要挂的动画。
 * action_id 来自 Meshy 动画库（自报家门：10=idle, 25=walk）。
 * 桌宠只需要「待机 + 少量动作」，挂多了既费额度又占内存。
 */
const ANIMATIONS = [
  { id: 10, name: 'idle', note: '待机呼吸' },
  { id: 25, name: 'walk', note: '行走' },
]

/* ---------- 计费预估 ---------- */

const CREDITS = { mesh: 15, rig: 5, anim: 3 }

function estimateCredits() {
  let n = CREDITS.mesh
  if (!SKIP_RIG) {
    n += CREDITS.rig
    if (!SKIP_ANIM) n += CREDITS.anim * ANIMATIONS.length
  }
  return n
}

/* ---------- HTTP ---------- */

/**
 * 代理处理。
 *
 * 两个坑，都实测踩过：
 *
 * 1. `NODE_USE_ENV_PROXY=1` 只在**进程启动时**被读，脚本运行中再设无效。
 *    所以不能「先设环境变量再 fetch」，必须自己把 dispatcher 挂到 fetch 上。
 *
 * 2. 不能把 undici 的 ProxyAgent 挂到**全局 fetch** 上。
 *    全局 fetch 用的是 Node 内置那份 undici，而 npm 装的 undici 是另一份；
 *    两者 Dispatcher 接口版本不同，混用会报 `invalid onRequestStart method`。
 *    必须全程用 undici 自己的 fetch。
 *
 * 本机出网必须走代理（Windows 设置里配的 127.0.0.1:4780）。
 */
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ''

let doFetch = fetch

async function setupFetch() {
  if (!PROXY) return
  const undici = await import('undici')
  const agent = new undici.ProxyAgent(PROXY)
  /* 连带 fetch 一起用 undici 的，避免上面第 2 条 */
  doFetch = (url, init = {}) => undici.fetch(url, { ...init, dispatcher: agent })
}

const API_KEY = process.env.MESHY_API_KEY || ''

async function api(path, { method = 'GET', body } = {}) {
  const res = await doFetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${method} ${path} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }

  if (!res.ok) {
    const msg = json?.message || json?.error || text.slice(0, 200)
    throw new Error(`${method} ${path} 失败（HTTP ${res.status}）：${msg}`)
  }
  return json
}

/**
 * 轮询任务直到终态。
 * Meshy 是异步任务制：创建返回 id，之后 GET /<id> 查 status。
 */
async function poll(path, { label, timeoutMs = 15 * 60 * 1000 } = {}) {
  const start = Date.now()
  let last = ''
  for (;;) {
    const t = await api(path)
    const status = t.status

    if (status !== last) {
      process.stdout.write(`\r  ${label}: ${status}${' '.repeat(20)}`)
      last = status
    }

    if (status === 'SUCCEEDED') {
      process.stdout.write('\n')
      return t
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      process.stdout.write('\n')
      const why = t.task_error?.message || JSON.stringify(t.task_error ?? {})
      throw new Error(`${label} ${status}：${why}`)
    }

    const pct = Number(t.progress)
    if (Number.isFinite(pct) && pct > 0) {
      process.stdout.write(`\r  ${label}: ${status} ${pct}%${' '.repeat(20)}`)
    }

    if (Date.now() - start > timeoutMs) throw new Error(`${label} 超时（${timeoutMs / 60000} 分钟）`)

    /* 10 秒一次：Meshy 任务动辄几分钟，频了纯属浪费配额 */
    await sleep(10_000)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 立绘 → data URI ---------- */

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

/**
 * 把本地立绘转成 data URI。
 * Meshy 的 image_url 支持 base64 data URI，所以不用先把图传到任何图床 ——
 * 这点很关键：桌宠立绘是本地素材，为跑一次管线去开个公网地址不值得。
 */
function imageToDataUri(path) {
  if (!existsSync(path)) throw new Error(`找不到立绘：${path}`)
  const ext = extname(path).toLowerCase()
  const mime = MIME[ext]
  if (!mime) throw new Error(`不支持的图片格式 ${ext}，只支持 png/jpg/jpeg`)

  const buf = readFileSync(path)
  const mb = buf.length / 1024 / 1024
  if (mb > 8) {
    throw new Error(
      `立绘 ${mb.toFixed(1)}MB 偏大。Meshy 走 base64 内联，太大容易被拒或超时；` +
        `先用 scripts/prepare-yuki.js 产出的透明立绘（几十 KB）更合适。`,
    )
  }
  return `data:${mime};base64,${buf.toString('base64')}`
}

/* ---------- 下载 ---------- */

async function download(url, dest) {
  const res = await doFetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf)
  return buf.length
}

/* ---------- 主流程 ---------- */

async function main() {
  console.log('Meshy 桌宠模型生成')
  console.log('─'.repeat(52))
  console.log(`  立绘      ${IMAGE}`)
  console.log(`  输出      ${OUT}`)
  console.log(`  面数目标  ${TARGET_POLYCOUNT}（smart-topology，范围 100–15000）`)
  console.log(`  绑骨      ${SKIP_RIG ? '跳过' : '是'}`)
  console.log(
    `  动画      ${
      SKIP_RIG ? '跳过（无骨骼）'
        : SKIP_ANIM ? '用绑骨附赠的 walking/running（省 6 信用，但没有 idle）'
        : ANIMATIONS.map((a) => `${a.name}(${a.id})`).join(', ')
    }`,
  )
  console.log(`  预估额度  ${estimateCredits()} 信用`)
  console.log(`  代理      ${PROXY || '(未配置，将直连)'}`)
  console.log('─'.repeat(52))

  if (TARGET_POLYCOUNT < 100 || TARGET_POLYCOUNT > 15000) {
    throw new Error(`面数 ${TARGET_POLYCOUNT} 超出 smart-topology 范围（100–15000）`)
  }

  if (DRY_RUN) {
    console.log('\n--dry-run：只做了以上校验，未调用 API。')
    if (!API_KEY) console.log('（也没检测到 MESHY_API_KEY，正式跑之前记得配。）')
    return
  }

  if (!API_KEY) {
    throw new Error(
      '缺少 MESHY_API_KEY。\n' +
        '  1. 打开 https://www.meshy.ai/api 创建 API Key\n' +
        '  2. 设置环境变量后重跑：\n' +
        '     Windows:  $env:MESHY_API_KEY="msy_xxx"   （当前会话）\n' +
        '     bash:     export MESHY_API_KEY=msy_xxx',
    )
  }

  /* 首次请求前挂上代理 dispatcher */
  await setupFetch()

  console.log('\n[1/3] 立绘 → 网格')
  const imageUrl = imageToDataUri(IMAGE)
  console.log(`  data URI ${(imageUrl.length / 1024).toFixed(0)} KB`)

  const meshTask = await api('/image-to-3d', {
    method: 'POST',
    body: {
      image_url: imageUrl,
      /*
       * smart-topology（meshy-t2）而非 standard：
       * 它是唯一能直接按面数生成、且不用 remesh 的档，也是计费最低的（5 信用）。
       * standard 档默认 3 万面，对常驻桌宠太重。
       */
      model_type: 'smart-topology',
      ai_model: 'meshy-t2',
      target_polycount: TARGET_POLYCOUNT,
      should_texture: true,
      enable_pbr: false,
      /*
       * 正姿（A/T pose）—— 绑骨的必要条件。
       * 官方原文：「Models facing other axes will fail pose estimation」，
       * 且非正姿的人形绑骨会失败。立绘本身是站姿，这里显式要求 A-pose。
       */
      pose_mode: 'a-pose',
      /* 只要 GLB；不限定的话它会把 OBJ/FBX 一起生成，白等 */
      target_formats: ['glb'],
      remove_lighting: true,
    },
  })

  const meshId = meshTask.result
  if (!meshId) throw new Error(`创建网格任务没有返回 id：${JSON.stringify(meshTask).slice(0, 200)}`)
  console.log(`  任务 ${meshId}`)

  const mesh = await poll(`/image-to-3d/${meshId}`, { label: '网格生成' })
  const glbUrl = mesh.model_urls?.glb
  if (!glbUrl) {
    throw new Error(`任务成功但没有 glb 产物，可用字段：${Object.keys(mesh.model_urls ?? {}).join(', ') || '(空)'}`)
  }
  console.log(`  面数 ${mesh.polycount ?? '?'} · ${glbUrl.slice(0, 70)}…`)

  /* ---- 2. 绑骨 ---- */

  let finalGlb = glbUrl
  let anims = []

  if (!SKIP_RIG) {
    console.log('\n[2/3] 网格 → 骨骼')
    const rigTask = await api('/rigging', {
      method: 'POST',
      body: {
        input_task_id: meshId,
        /* 桌宠是少女体型，按 1.6m 估；这个值只影响缩放的合理性 */
        height_meters: 1.6,
      },
    })
    const rigId = rigTask.result
    console.log(`  任务 ${rigId}`)

    const rig = await poll(`/rigging/${rigId}`, { label: '绑骨' })
    const riggedUrl = rig.result?.rigged_character_glb_url || rig.model_urls?.glb
    if (!riggedUrl) {
      throw new Error(`绑骨完成但没拿到 GLB：${JSON.stringify(rig).slice(0, 300)}`)
    }
    console.log(`  已绑骨`)

    /*
     * 绑骨响应里白送两段动画（walking / running），不额外计费。
     * 先记下来 —— 即使后面单独挂 idle，这两段也是零成本的。
     */
    const basic = rig.result?.basic_animations ?? {}
    const freeAnims = Object.entries(basic)
      .filter(([k]) => k.endsWith('_glb_url') && !k.includes('armature'))
      .map(([k, url]) => ({ name: k.replace('_glb_url', ''), url }))
    if (freeAnims.length) {
      console.log(`  附赠动画 ${freeAnims.map((a) => a.name).join(', ')}（不额外计费）`)
    }

    /* ---- 3. 动画（可选） ---- */

    if (SKIP_ANIM) {
      console.log('\n[3/3] 跳过单独动画任务（--no-anim）')
      const extra = []
      for (const a of freeAnims) {
        const dest = OUT.replace(/\.glb$/i, `-${a.name}.glb`)
        const size = await download(a.url, dest)
        console.log(`  ${a.name.padEnd(10)} ${(size / 1024 / 1024).toFixed(2)} MB → ${basename(dest)}`)
        extra.push({ file: basename(dest), actions: [{ name: a.name }] })
      }
      anims = extra
      finalGlb = riggedUrl
    } else {
      console.log('\n[3/3] 挂动画')
      const animTask = await api('/animations', {
        method: 'POST',
        body: {
          rig_task_id: rigId,
          /*
           * 用 action_ids（复数，数组）而不是 action_id（单数，整数）：
           * 官方明确「with action_ids, the task returns one merged file rather than
           * one file per action」—— 一个 GLB 里包含每个动作各一条 clip。
           * 桌宠正好需要一个文件按状态切动画，这样最省事也省一次下载。
           */
          action_ids: ANIMATIONS.map((a) => a.id),
          /* 后处理重采样关键帧；桌宠不需要电影级精度，30fps 更省内存。
             fps 只支持 24/25/30/60。 */
          post_process: { operation_type: 'change_fps', fps: 30 },
        },
      })
      const animId = animTask.result
      console.log(`  任务 ${animId}`)

      const anim = await poll(`/animations/${animId}`, { label: '动画' })

      /*
       * 响应字段是 **单数** animation_glb_url。
       * 一开始按 animation_glb_urls 写，拿不到值 —— 官方文档只列单数这一项。
       */
      const animGlb = anim.result?.animation_glb_url
      if (!animGlb) {
        throw new Error(`动画成功但没拿到 GLB：${JSON.stringify(anim.result ?? {}).slice(0, 300)}`)
      }

      const animDest = OUT.replace(/\.glb$/i, '-anims.glb')
      const animSize = await download(animGlb, animDest)
      console.log(`  动画已写入 ${animDest}（${(animSize / 1024 / 1024).toFixed(2)} MB）`)

      /*
       * 顺手把免费的 walking/running 也存下来 —— 已经拿到了 URL，
       * 不存就等于白送的东西不要。主模型自带的那份由 three 直接读。
       */
      anims = [{ file: basename(animDest), actions: ANIMATIONS.map((a) => ({ name: a.name, actionId: a.id })) }]
      for (const a of freeAnims) {
        const dest = OUT.replace(/\.glb$/i, `-${a.name}.glb`)
        const size = await download(a.url, dest)
        console.log(`  ${a.name.padEnd(10)} ${(size / 1024 / 1024).toFixed(2)} MB → ${basename(dest)}（附赠）`)
        anims.push({ file: basename(dest), actions: [{ name: a.name }] })
      }

      finalGlb = riggedUrl
    }
  }

  /* ---- 落地 ---- */

  const size = await download(finalGlb, OUT)
  console.log(`\n主体模型已写入 ${OUT}（${(size / 1024 / 1024).toFixed(2)} MB）`)

  /*
   * 再往渲染层能加载的位置放一份。
   * dist 是自包含的，打包后 asar 里没有 resources/ 这一份，
   * 所以 renderer/public 下必须有副本，否则装到别人机器上就是「开了 3D 没模型」。
   */
  mkdirSync(OUT_DIR, { recursive: true })
  const mirrored = []
  for (const file of [basename(OUT), ...anims.map((a) => a.file)]) {
    const from = join(SRC_DIR, file)
    if (!existsSync(from)) continue
    writeFileSync(join(OUT_DIR, file), readFileSync(from))
    mirrored.push(file)
  }
  console.log(`已复制 ${mirrored.length} 个文件到 ${OUT_DIR}`)

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: basename(IMAGE),
    modelType: 'smart-topology',
    aiModel: 'meshy-t2',
    targetPolycount: TARGET_POLYCOUNT,
    polycount: mesh.polycount ?? null,
    rigged: !SKIP_RIG,
    main: basename(OUT),
    animations: anims,
    credits: estimateCredits(),
  }
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  const manifestPath = join(OUT_DIR, 'manifest.json')

  console.log(`清单已写入 ${manifestPath}`)
  console.log(`\n下一步：npm run dev:3d，把生成的 GLB 拖进验证台核对取景与穿透。`)
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`)
  process.exit(1)
})
