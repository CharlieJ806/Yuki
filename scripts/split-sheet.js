/**
 * 把一张「多格拼图」切成独立 PNG。
 *
 * 用途：AI 出图按 3x4 方格一次给 12 个姿态，用这个脚本切成
 * resources/pet/yuki-<slug>.png，直接喂给现有渲染层。
 *
 * 用法：
 *   node scripts/split-sheet.js <图片> --grid 3x4 --out .tmp-split [--trim] [--names a,b,c]
 *
 * ## 两套素材共用这个脚本
 *
 *   - **立绘**（透明全身）：`--grid 4x3 --trim --auto --isolate`，输出 `resources/raw-cut/yuki-*.png`
 *   - **自拍照片**（实景半身）：`--grid 4x3 --trim --auto`，输出 `resources/raw-cut/yuki-photo-*.png`
 *
 * 照片**不要加 `--isolate`** —— 那一套是给透明立绘准备的
 * （按主体连通块扩展 + 清掉贴边异物）。照片是实景、有连续背景，
 * 整格都是内容，「主体连通块」的概念不适用，加 --isolate 反而
 * 会因为找不到主体而做多余的扩张。
 *
 * 为什么不用 ImageMagick：切完还要 trim 透明边、校验是否有串格，
 * 一次做完比串几条命令稳；而且要在 Windows 上跑，避免 shell 引号地狱。
 *
 * 依赖：项目已用 ImageMagick，但这里为了能精确读
 * alpha 通道做「串格检测」，改用 PNG 手工解析 + zlib（Node 内置，零依赖）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { inflateSync, deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'

/* ---------- PNG 读写（只处理 8bit RGBA / RGB，够用） ---------- */

function readPng(file) {
  const buf = readFileSync(file)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件')

  let pos = 8
  let w = 0
  let h = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }

  if (bitDepth !== 8) throw new Error(`只支持 8bit PNG，当前 ${bitDepth}bit`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels) throw new Error(`只支持 RGB/RGBA，当前 colorType=${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const pixels = Buffer.alloc(h * stride)

  /* 反滤波：PNG 逐行有 filter byte，必须还原否则像素全错 */
  let rp = 0
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[x] = v & 255
    }
  }

  return { width: w, height: h, channels, pixels }
}

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function writePng(file, w, h, rgba) {
  const stride = w * 4
  /* 每行前置 filter byte 0（不过滤），最简单且无损 */
  const raw = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 /* bit depth */
  ihdr[9] = 6 /* RGBA */
  const out = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  writeFileSync(file, out)
  return out.length
}

/* ---------- 切图 ---------- */

/**
 * 从大图裁一块并转成 RGBA。
 * @returns {{w:number,h:number,rgba:Buffer}}
 */
function crop(src, x0, y0, cw, ch) {
  const out = Buffer.alloc(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((y0 + y) * src.width + (x0 + x)) * src.channels
      const di = (y * cw + x) * 4
      out[di] = src.pixels[si]
      out[di + 1] = src.pixels[si + 1]
      out[di + 2] = src.pixels[si + 2]
      out[di + 3] = src.channels === 4 ? src.pixels[si + 3] : 255
    }
  }
  return { w: cw, h: ch, rgba: out }
}

/** 找 alpha>阈值的紧致包围盒；全透明返回 null */
function alphaBounds(img, threshold = 8) {
  let minX = img.w
  let minY = img.h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.rgba[(y * img.w + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** 裁到内容边界（透明边去掉），保留少量 padding */
function trimToContent(img, pad = 2) {
  const b = alphaBounds(img)
  if (!b) return img
  const x0 = Math.max(0, b.x - pad)
  const y0 = Math.max(0, b.y - pad)
  const x1 = Math.min(img.w, b.x + b.w + pad)
  const y1 = Math.min(img.h, b.y + b.h + pad)
  const out = Buffer.alloc((x1 - x0) * (y1 - y0) * 4)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const si = (y * img.w + x) * 4
      const di = ((y - y0) * (x1 - x0) + (x - x0)) * 4
      img.rgba.copy(out, di, si, si + 4)
    }
  }
  return { w: x1 - x0, h: y1 - y0, rgba: out }
}

/**
 * 去掉「邻格侵入」的碎片。
 *
 * 为什么需要：AI 出图里相邻两列角色常挨得很近，格线切下去会把
 * 邻居的一缕头发/一片衣角带进来。实测这些碎片有个共同特征
 * —— **贴在本格边缘，且面积远小于角色主体**（主体 5万+ 像素，
 * 碎片通常 < 200 像素）。
 *
 * 为什么不能无脑删：角色自己的头发丝、鞋带、蕾丝边也是独立小块，
 * 但它们**不与邻格共享边缘**（在角色内部）。所以判据是
 * 「贴边 + 小 + 非主体」，三个条件同时满足才删。
 *
 * @param keepRatio 面积小于主体的这个比例才考虑删（默认 0.5%）
 */
function despeckle(img, keepRatio = 0.005, threshold = 32) {
  const { w, h, rgba } = img
  const at = (x, y) => rgba[(y * w + x) * 4 + 3] > threshold

  /* 标记连通块 */
  const label = new Int32Array(w * h).fill(-1)
  const comps = []
  let next = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (label[p] >= 0 || !at(x, y)) continue
      const id = next++
      const comp = { n: 0, touchesEdge: false }
      const st = [p]
      label[p] = id
      while (st.length) {
        const q = st.pop()
        const qx = q % w
        const qy = (q - qx) / w
        comp.n++
        if (qx === 0 || qy === 0 || qx === w - 1 || qy === h - 1) comp.touchesEdge = true
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = qx + dx
          const ny = qy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const np = ny * w + nx
          if (label[np] >= 0 || !at(nx, ny)) continue
          label[np] = id
          st.push(np)
        }
      }
      comps.push(comp)
    }
  }

  if (comps.length <= 1) return { img, removed: 0 }

  const biggest = Math.max(...comps.map((c) => c.n))
  const cut = biggest * keepRatio
  const dead = new Set()
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i]
    if (c.n <= cut && c.touchesEdge && c.n < biggest) dead.add(i)
  }
  if (!dead.size) return { img, removed: 0 }

  const out = Buffer.from(rgba)
  let removed = 0
  for (let i = 0; i < w * h; i++) {
    if (dead.has(label[i])) {
      out[i * 4 + 3] = 0
      removed++
    }
  }
  return { img: { w, h, rgba: out }, removed }
}

/**
 * 清除 cell 内不属于本格角色的连通块。
 *
 * 判据：面积最大的连通块 = 角色主体；其余块若面积 < 主体 5% 则清掉。
 *
 * 为什么 5% 是安全的：角色的头发丝、鞋带、蕾丝边都是独立小块，
 * 但它们**都在主体内部或紧贴主体**，面积远小于主体（实测最大附属块
 * 也就几百像素，而主体普遍 5 万以上）。而邻格侵入的肢体（如
 * pajamas-shorts 左下那块 745px 的膝盖）同样远小于主体。
 * 两者体量相当，所以用「面积 + 连通性」无法区分 —— 但它们有本质差别：
 * **附属块与主体形态无关，而侵入块一定贴在 cell 边缘**。
 *
 * 因此判据收紧为：**贴在 cell 边缘 且 面积 < 主体 5%** 才清。
 * 角色自身的头发丝在主体内部，不贴边缘，不会被误删。
 *
 * @returns 清除的像素数
 */
function clearForeignBlobs(img, threshold = 32, ratio = 0.05) {
  const { w, h, rgba } = img
  const at = (x, y) => rgba[(y * w + x) * 4 + 3] > threshold

  const label = new Int32Array(w * h).fill(-1)
  const comps = []
  let next = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (label[p] >= 0 || !at(x, y)) continue
      const id = next++
      const comp = { n: 0, edge: false }
      const st = [p]
      label[p] = id
      while (st.length) {
        const q = st.pop()
        const qx = q % w
        const qy = (q - qx) / w
        comp.n++
        /* 贴边判定放宽到 2px：抗锯齿会让真正贴边的块边缘半透明 */
        if (qx <= 1 || qy <= 1 || qx >= w - 2 || qy >= h - 2) comp.edge = true
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = qx + dx
          const ny = qy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const np = ny * w + nx
          if (label[np] >= 0 || !at(nx, ny)) continue
          label[np] = id
          st.push(np)
        }
      }
      comps.push(comp)
    }
  }

  if (comps.length <= 1) return 0

  const biggest = Math.max(...comps.map((c) => c.n))
  const cut = biggest * ratio
  const dead = new Set()
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i]
    if (c.edge && c.n <= cut && c.n < biggest) dead.add(i)
  }
  if (!dead.size) return 0

  let removed = 0
  for (let i = 0; i < w * h; i++) {
    if (dead.has(label[i])) {
      rgba[i * 4 + 3] = 0
      removed++
    }
  }
  return removed
}

/**
 * 串格检测：判断这一格的内容是否**真的越过了格线**。
 *
 * 为什么不能只查「边缘有没有像素」：
 * AI 出图经常不遵守「留 50px 隔离带」的要求，头发、脚会紧贴格边。
 * 但「紧贴边界」和「跨越边界」是两回事 —— 前者切出来完全正常，
 * 后者才会让相邻格互相污染（实测：紧贴抱怨 12/12，真实跨越 0）。
 *
 * 判据：
 *   - **外侧 2px** 有不透明像素 → 内容确实溢出到了格线以外（真串格）
 *   - 只在内侧边缘有像素 → 只是画得满，切图安全，不报
 *
 * @returns {{overflow:number, tight:number}} overflow>0 才是真问题
 */
function checkBleed(cell, threshold = 32) {
  const { w, h, rgba } = cell
  const at = (x, y) => rgba[(y * w + x) * 4 + 3] > threshold

  /* 外圈 2px：真溢出 */
  let overflow = 0
  for (let x = 0; x < w; x++) {
    if (at(x, 0)) overflow++
    if (at(x, h - 1)) overflow++
  }
  for (let y = 0; y < h; y++) {
    if (at(0, y)) overflow++
    if (at(w - 1, y)) overflow++
  }

  /* 内圈 3~6px：只是画得满，不算问题，但值得提示 */
  let tight = 0
  for (let x = 0; x < w; x++) {
    for (let d = 3; d < 7; d++) {
      if (at(x, d)) tight++
      if (at(x, h - 1 - d)) tight++
    }
  }

  return { overflow, tight }
}

/**
 * 照片格子的接缝检查 —— 只看**格线那一条线**本身。
 *
 * ## 试错记录（重要，别再走一遍）
 *
 * 1. 先试「边缘像素数 = 串格」→ 照片必然满格，全报假阳性。
 * 2. 再试「边缘平均色 vs 整格平均色 > 绝对阈值」→
 *    对合成图全报、对真实照片全不报。照片的明暗跨度
 *    （逆光、暗角、大片天空）本来就让这个差值波动很大，
 *    不存在通用阈值。
 * 3. 再试「同批中位数 × 3」的相对判据 → 也不可靠：
 *    实测同一张图内不同行的偏离度可以有 281/246/186 的差异
 *    （那只是行的明暗不同），异常信号被正常差异淹没。
 *
 * ## 现在的做法
 *
 * 放弃自动判定「串格」。照片的构图本来就没有客观的「正确」边界，
 * 硬判只会制造噪声，让真正的错误淹没在假报警里。
 *
 * 改为**只报事实**：给出每格四边与相邻格相接处的**色差**，
 * 供人配合拼版图目视判断。`--photo` 模式下**不会因此报错或中止**。
 *
 * 真正可靠的检查是「看拼版图」—— 脚本已经把每格切出来了，
 * 拼回去一眼就能看出哪格串了。
 */
function photoSeamStats(cell) {
  const { w, h, rgba } = cell
  const px = (x, y) => {
    const i = (y * w + x) * 4
    return [rgba[i], rgba[i + 1], rgba[i + 2]]
  }

  /*
   * 一条边的平均色。**长度必须跟着边的方向走** ——
   * 上下边沿宽度采样（w 个点），左右边沿高度采样（h 个点）。
   *
   * 踩过：统一用 w 当长度，横构图时（w=512 > h=384）左右边会越过
   * 底边读到 undefined，除出 NaN。竖构图恰好 w<h 才没暴露。
   */
  const line = (sample, len) => {
    let r = 0, g = 0, b = 0, n = 0
    for (let i = 0; i < len; i++) {
      const c = sample(i)
      if (!c) continue
      const [pr, pg, pb] = c
      if (pr === undefined) continue
      r += pr; g += pg; b += pb; n++
    }
    if (!n) return [0, 0, 0]
    return [r / n, g / n, b / n]
  }
  const l2 = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])

  const top = line((i) => px(i, 0), w)
  const bottom = line((i) => px(i, h - 1), w)
  const left = line((i) => px(0, i), h)
  const right = line((i) => px(w - 1, i), h)

  return {
    /* 四条边自身的平均色，供人工比对相邻格 */
    colors: { top: top.slice(0, 3).map(Math.round), bottom: bottom.slice(0, 3).map(Math.round), left: left.slice(0, 3).map(Math.round), right: right.slice(0, 3).map(Math.round) },
    /* 相对边之间的色差：正常照片内部（如同一片背景）应该不大 */
    spread: Math.round(Math.max(l2(top, bottom), l2(left, right))),
  }
}

/**
 * 找「白缝」格线（照片专用）。
 *
 * ## 为什么照片不能死等分
 *
 * 照片是让模型按网格画的，但它**每行的行高并不精确**
 * （实测同一张图三道行缝的中心在 381 / 765 / 1133，
 * 而等分线是 384 / 768 / 1152 —— 第三道偏了 19px）。
 * 死等分切下去，下面那格会带进上一行的内容。
 *
 * ## 做法
 *
 * 沿轴向算每一行/列的平均亮度，找出**接近纯白（> 阈值）的连续段**，
 * 取段中心作为格线。照片的格间是留白的，所以白缝 = 真实格线。
 *
 * 找不到足够数量的白缝时**退回等分**，不硬来 ——
 * 有些图模型没留白（贴合紧密），那种只能按等分切。
 *
 * @param axis 'y' 找行线；'x' 找列线
 * @param want 期望切成几段
 * @returns {edges: Array<[number,number]>|null, gaps: number[]}
 */
function findWhiteGaps(src, axis, want) {
  const { width: w, height: h, channels: ch, pixels } = src
  const n = axis === 'y' ? h : w
  const across = axis === 'y' ? w : h

  /* 每个位置的平均亮度 */
  const luma = new Array(n).fill(0)
  const step = Math.max(1, Math.floor(across / 128))
  for (let i = 0; i < n; i++) {
    let sum = 0
    let cnt = 0
    for (let j = 0; j < across; j += step) {
      const x = axis === 'y' ? j : i
      const y = axis === 'y' ? i : j
      const p = (y * w + x) * ch
      sum += (pixels[p] + pixels[p + 1] + pixels[p + 2]) / 3
      cnt++
    }
    luma[i] = sum / cnt
  }

  /* 找亮度 > 阈值的连续段（阈值取全图亮度的 90 分位附近，自适应） */
  const sorted = [...luma].sort((a, b) => a - b)
  const p90 = sorted[Math.floor(sorted.length * 0.9)]
  const white = Math.max(235, p90)

  const segs = []
  let s = -1
  for (let i = 0; i < n; i++) {
    if (luma[i] >= white) {
      if (s < 0) s = i
    } else if (s >= 0) {
      /* 太窄的段不算（噪点级别的亮线） */
      if (i - s >= 6) segs.push([s, i - 1])
      s = -1
    }
  }
  if (s >= 0 && n - s >= 6) segs.push([s, n - 1])

  /* 去掉贴边的段，剩下的中心就是内部格线 */
  const inner = segs.filter(([a, b]) => a > n * 0.02 && b < n * 0.98)
  if (inner.length < want - 1) {
    return { edges: null, gaps: [], white: Math.round(white), found: inner.length }
  }

  /* 按位置挑最接近等分点的 want-1 条（多余的白缝可能是画面里的亮区） */
  const cuts = []
  for (let k = 1; k < want; k++) {
    const ideal = (k * n) / want
    let best = null
    let bestD = Infinity
    for (const [a, b] of inner) {
      const mid = (a + b) / 2
      const d = Math.abs(mid - ideal)
      if (d < bestD) {
        bestD = d
        best = Math.round(mid)
      }
    }
    cuts.push(best)
  }

  const edges = []
  let prev = 0
  for (const c of cuts) {
    if (c > prev) {
      edges.push([prev, c])
      prev = c
    }
  }
  edges.push([prev, n])
  return { edges, gaps: cuts, white: Math.round(white), found: inner.length }
}

/* ---------- 自动找格线 ---------- */

/**
 * 用「密度谷值」找行/列分界。
 *
 * 为什么不能靠「全透明带」：AI 出图里相邻两行角色的发梢和鞋尖常常接触，
 * 投影没有一整条空行，找不到间隔。但**密度**仍然有明显的谷
 * —— 角色躯干处每行上千像素，脚与下排头发之间只有几十像素。
 *
 * 实测 G1：谷值在 y=496（47 像素）、y=992（65 像素），
 * 而躯干峰值 3000+。所以谷值比「空白」稳健得多。
 *
 * @param axis  'y' 找行分界；'x' 找列分界
 * @param want  期望切成几段
 * @returns 分界位置数组，长度 want+1
 */
/**
 * 找某一行的列分界：**按「整列空」判据**，而不是「密度最低」。
 *
 * 为什么不能用密度最低：角色与邻格重叠时（G3 第3行 bodysuit 的下方头发
 * 与右上角邻格内容在 x≈520~545 交错），总密度在该处仍有 53px，
 * 局部最低点落在「假空隙」上 —— 实测切掉 24px 头发。
 *
 * 正确判据：一列要当分界，必须**整列没有任何内容**（密度为 0），
 * 或在搜索窗内取「靠近理想位置且密度为极小」的列并按下面的
 * 「扩展 + 连通块清理」兜底。
 *
 * 策略：
 *   1. 先在理想位置附近找密度为 0 的列（真空隙），取最近的
 *   2. 找不到真空隙时，取密度最低列作为**初始**分界，
 *      后续由 extendAndClean 向外扩展到完整内容
 */
function findColCutsInBand(src, y0, y1, want) {
  const { width: w, channels: ch, pixels } = src
  const dens = new Array(w).fill(0)
  for (let x = 0; x < w; x++) {
    let c = 0
    for (let y = y0; y <= y1; y++) if (pixels[(y * w + x) * ch + (ch - 1)] > 32) c++
    dens[x] = c
  }

  const segLen = w / want
  const cuts = [0]
  for (let k = 1; k < want; k++) {
    const ideal = (k * w) / want
    const lo = Math.max(1, Math.round(ideal - segLen * 0.4))
    const hi = Math.min(w - 1, Math.round(ideal + segLen * 0.4))

    /* 1) 优先真空隙（整列无内容） */
    let best = -1
    let bestD = Infinity
    for (let i = lo; i <= hi; i++) {
      if (dens[i] === 0) {
        const d = Math.abs(i - ideal)
        if (d < bestD) { bestD = d; best = i }
      }
    }
    /* 2) 没有真空隙：退化为密度最低 */
    if (best < 0) {
      let bv = Infinity
      best = Math.round(ideal)
      for (let i = lo; i <= hi; i++) if (dens[i] < bv) { bv = dens[i]; best = i }
    }
    cuts.push(best)
  }
  cuts.push(w)
  return cuts
}

/**
 * 向外扩展到内容完整，并擦掉扩展时带进来的邻格像素。
 *
 * 用法：格子按初始分界裁好后，若内容贴到左右边界，说明被切了。
 * 做法是**在更大范围内取该格的连通块**（以格子中心所在的块为主体），
 * 把主体完整取出来，其余块（邻格侵入）丢弃。
 *
 * @param src     原图（整图）
 * @param x0,x1   初始格子的 x 范围（用于定位主体）
 * @param y0,y1   行范围（纵向不扩展）
 * @param margin  向左右各扩展多少像素来寻找接续的主体
 * @returns {{x0:number,x1:number,cleaned:number}} 扩展后的真实 x 范围
 */
function findSubjectExtent(src, x0, x1, y0, y1, margin = 120) {
  const { width: w, height: h, channels: ch, pixels } = src
  const at = (x, y) => pixels[(y * w + x) * ch + (ch - 1)] > 32

  const sx0 = Math.max(0, x0 - margin)
  const sx1 = Math.min(w - 1, x1 + margin)

  /*
   * 以「格子中心点所在的连通块」为主体。
   * 中心点取格子内首个不透明像素，避免中心恰好落在两腿之间的空隙上。
   */
  let seedX = -1
  let seedY = -1
  const midX = Math.round((x0 + x1) / 2)
  outer: for (let y = y0; y <= y1; y++) {
    for (let d = 0; d <= (x1 - x0); d++) {
      const xa = midX - d
      const xb = midX + d
      if (xa >= x0 && at(xa, y)) { seedX = xa; seedY = y; break outer }
      if (xb <= x1 && at(xb, y)) { seedX = xb; seedY = y; break outer }
    }
  }
  if (seedX < 0) return { x0, x1, cleaned: 0, ok: false }

  /* BFS 标记主体连通块（在扩展后的窗口内） */
  const winW = sx1 - sx0 + 1
  const winH = y1 - y0 + 1
  const seen = new Uint8Array(winW * winH)
  const idx = (x, y) => (y - y0) * winW + (x - sx0)

  let minX = seedX
  let maxX = seedX
  const stack = [[seedX, seedY]]
  seen[idx(seedX, seedY)] = 1
  while (stack.length) {
    const [cx, cy] = stack.pop()
    if (cx < minX) minX = cx
    if (cx > maxX) maxX = cx
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < sx0 || nx > sx1 || ny < y0 || ny > y1) continue
      const i = idx(nx, ny)
      if (seen[i] || !at(nx, ny)) continue
      seen[i] = 1
      stack.push([nx, ny])
    }
  }

  return { x0: minX, x1: maxX, cleaned: 0, ok: true, seen, sx0, winW }
}

/**
 * 找行分界：纵向**密度谷值**。
 *
 * 为什么行不用「躯干峰中点」：角色纵向是「头细-躯干粗-腿细」，
 * 密度曲线没有单一尖峰，峰位会被头发/裙摆带偏（实测偏 36~60px）。
 * 而行之间通常真有横向空白带（G1: y=493 密度仅个位数），
 * 谷值判据在纵向是可靠的。
 *
 * 做法：在均分位置附近 ±25% 段宽内找密度最低点。
 */
function findRowCuts(src, want) {
  const { width: w, height: h, channels: ch, pixels } = src

  const dens = new Array(h).fill(0)
  for (let y = 0; y < h; y++) {
    let c = 0
    for (let x = 0; x < w; x++) if (pixels[(y * w + x) * ch + (ch - 1)] > 32) c++
    dens[y] = c
  }

  const cuts = [0]
  const segLen = h / want
  for (let k = 1; k < want; k++) {
    const ideal = Math.round(k * segLen)
    const lo = Math.max(cuts[cuts.length - 1] + 20, Math.round(ideal - segLen * 0.25))
    const hi = Math.min(h - 20, Math.round(ideal + segLen * 0.25))
    let best = ideal
    let bestVal = Infinity
    for (let i = lo; i <= hi; i++) {
      if (dens[i] < bestVal) { bestVal = dens[i]; best = i }
    }
    cuts.push(best)
  }
  cuts.push(h)
  return cuts
}

/* ---------- CLI ---------- *//* ---------- CLI ---------- *//* ---------- CLI ---------- *//* ---------- CLI ---------- *//* ---------- CLI ---------- *//* ---------- CLI ---------- *//* ---------- CLI ---------- *//* ---------- CLI ---------- */

const argv = process.argv.slice(2)
if (!argv.length) {
  console.error('用法: node scripts/split-sheet.js <图片> --grid 3x4 --out <目录> [--trim] [--inset N] [--names a,b,c]')
  process.exit(1)
}

const file = argv[0]
const getOpt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const [cols, rows] = getOpt('--grid', '3x4').split('x').map(Number)
const outDir = getOpt('--out', '.tmp-split')
const doTrim = argv.includes('--trim')
/*
 * --despeckle：删掉「贴边 + 远小于主体」的连通块（邻格侵入的碎片）。
 * 角色自身的头发丝/鞋带不贴本格边缘，所以不会被误删。
 */
const doDespeckle = argv.includes('--despeckle')
let speckles = 0
/*
 * --isolate：优先保证角色完整。
 * 按主体连通块向外扩展取全，并清掉扩展带进来的邻格像素。
 */
const doIsolate = argv.includes('--isolate')
let isolatedCleaned = 0
/*
 * --photo：这组是**实景自拍照片**，不是透明立绘。
 *
 * 两个差别：
 *   1. 照片每格都是满的（连续背景），没有透明隔离带 ——
 *      所以**不能用 `--auto`** 找格线（它会退化成在内容里找「密度谷」，
 *      切出大小不一的格子）。照片一律用等分。
 *   2. `checkBleed` 的「贴边 = 串格」判据对照片**永远为真**
 *      （背景铺满整格），报出来全是噪声。所以照片模式下改成
 *      检查「格内是否有明显不连续的接缝」，这才是真问题。
 */
const isPhoto = argv.includes('--photo')
/*
 * --skip <名字列表>：跳过这些格，不产出文件。
 *
 * 用途：某格生成废了（比如脖子扭成 180°、多画了一只手），
 * 又不想为了一格重跑整张 sheet。把名字列在这里，
 * 之后每次切图都会跳过它 —— 比手工删文件可靠：
 * 手工删的会被下一次切图重新生成出来（实测踩过）。
 */
const skipNames = new Set(
  (getOpt('--skip', '') || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
)
/*
 * 格线内缩像素数。
 * 用途：AI 出图的分格与「画布/列数」不一定整除（比如 1024/3=341.33），
 * 累积偏移会让切口擦到邻格角色的发梢/鞋尖。内缩几像素即可干净，
 * 代价是每格损失一点边缘空白 —— 角色本来就不贴边，无影响。
 */
const inset = Number(getOpt('--inset', '0')) || 0

/*
 * --auto：按内容自动找格线，而不是等分。
 *
 * 为什么需要：AI 生成的多格图**不是**按等分排的。
 * 实测 1024 宽的图，三列实际落在 x=20~265 / 270~506 / 519~771，
 * 而等分切法是 0~340 / 341~681 / 682~1022 —— 每一刀都切在角色身上，
 * 切出来的图左右各半、惨不忍睹。
 *
 * 做法：投影找「整行/整列都透明」的空白带，用它们当格线。
 */
const useAuto = argv.includes('--auto')
const names = (getOpt('--names', '') || '').split(',').map((s) => s.trim()).filter(Boolean)

if (!existsSync(file)) {
  console.error(`找不到文件：${file}`)
  process.exit(1)
}

const src = readPng(file)
console.log(`源图 ${src.width}x${src.height}  通道 ${src.channels}`)
console.log(`切分 ${cols}列 x ${rows}行，每格 ${Math.floor(src.width / cols)}x${Math.floor(src.height / rows)}`)

mkdirSync(outDir, { recursive: true })
const cellW = Math.floor(src.width / cols)
const cellH = Math.floor(src.height / rows)

/*
 * 格线：默认等分；--auto 时按内容自动找。
 * colEdges / rowEdges 是 [start, end) 半开区间。
 */
let colEdges
let rowEdges
/* 逐行独立的列分界：colEdgesPerRow[r] = 该行的列分界数组 */
let colEdgesPerRow = null
if (useAuto) {
  console.log()
  console.log('自动找格线（行=密度谷值，列=逐行独立空隙）…')
  const yc = findRowCuts(src, rows)
  rowEdges = yc.slice(0, -1).map((a, i) => [a, yc[i + 1]])
  colEdgesPerRow = rowEdges.map(([y0, y1]) => {
    const xc = findColCutsInBand(src, y0, y1 - 1, cols)
    return xc.slice(0, -1).map((a, i) => [a, xc[i + 1]])
  })
  colEdges = colEdgesPerRow[0]
  console.log()
  rowEdges.forEach(([a, b], i) => {
    const rowCols = colEdgesPerRow[i].map(([x0, x1]) => `${x0}~${x1 - 1}`).join('  ')
    console.log(`  第${i + 1}行  y=${a}~${b - 1}  高${b - a}`)
    console.log(`         列: ${rowCols}`)
  })
} else {
  /*
   * 照片模式：优先按**真实白缝**切，找不到才退回等分。
   * 详见 findWhiteGaps 的注释 —— 模型的每行行高并不精确，
   * 死等分会让下面那格吃进上一行的内容。
   */
  if (isPhoto) {
    /* src 已在上面读好，这里直接用 */
    const rowsGap = findWhiteGaps(src, 'y', rows)
    const colsGap = findWhiteGaps(src, 'x', cols)
    if (rowsGap.edges) {
      rowEdges = rowsGap.edges
      console.log()
      console.log(`照片行线（白缝，阈值 ${rowsGap.white}）：${rowsGap.gaps.join(', ')}`)
    } else {
      console.warn(`照片未找到足够行白缝（只找到 ${rowsGap.found} 条），退回等分`)
    }
    if (colsGap.edges) {
      colEdges = colsGap.edges
      console.log(`照片列线（白缝）：${colsGap.gaps.join(', ')}`)
    } else {
      console.warn(`照片未找到足够列白缝（只找到 ${colsGap.found} 条），退回等分`)
    }
    if (!rowEdges) rowEdges = Array.from({ length: rows }, (_, i) => [i * cellH, (i + 1) * cellH])
    if (!colEdges) colEdges = Array.from({ length: cols }, (_, i) => [i * cellW, (i + 1) * cellW])
  } else {
    colEdges = Array.from({ length: cols }, (_, i) => [i * cellW, (i + 1) * cellW])
    rowEdges = Array.from({ length: rows }, (_, i) => [i * cellH, (i + 1) * cellH])
  }
}

let n = 0
const report = []

for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const name = names[n] || `cell${String(n + 1).padStart(2, '0')}`
    /* --skip 列到的格子直接跳过，不产出文件（见 skipNames 的注释） */
    if (skipNames.has(name)) {
      report.push({ name, row: r, col: c, status: '已跳过（--skip）' })
      n++
      continue
    }
    const [cx0, cx1] = (colEdgesPerRow ? colEdgesPerRow[r] : colEdges)[c]
    const [cy0, cy1] = rowEdges[r]

    /*
     * 优先保证完整（--isolate）：
     * 按初始分界裁出的 content 若贴到左右格线，说明角色被切。
     * 此时以格子内的主体连通块为准，向左右扩展取其完整范围。
     */
    let realX0 = cx0 + inset
    let realX1 = cx1 - inset
    if (doIsolate) {
      const r0 = cy0 + inset
      const r1 = cy1 - inset
      const ext = findSubjectExtent(src, realX0, realX1 - 1, r0, r1 - 1, 140)
      if (ext.ok && (ext.x0 < realX0 || ext.x1 > realX1 - 1)) {
        realX0 = ext.x0
        realX1 = ext.x1 + 1
      }
    }

    let cell = crop(
      src,
      realX0,
      cy0 + inset,
      realX1 - realX0,
      cy1 - cy0 - inset * 2,
    )

    /*
     * 清掉不属于本格角色的像素。
     *
     * 为什么必须在**整个 cell** 范围内做，而不是只清「扩展带进来的」：
     * 邻格角色的肢体可能落在本格**内部**（实测 pajamas-shorts 左边缘
     * x=0~18 处有邻格 bodysuit 的膝盖，745px），它不是扩展带进来的，
     * 只清扩展区就会漏掉。
     *
     * 判据：以面积最大的连通块为主体；面积不到主体 5% 的块视为异物清除。
     * 角色自身的头发丝、鞋带虽然是独立小块，但都远小于主体的 5%
     * （实测最大的附属块也就几百像素，而主体普遍 5 万+），
     * 所以这个阈值既清得干净，又不会误伤。
     */
    if (doIsolate) {
      isolatedCleaned += clearForeignBlobs(cell)
    }

    /*
     * 照片模式：边缘偏离度必须在 **trim 之前**算 ——
     * trim 会把内容裁到紧致边界，此时「边缘」已经不是格线位置了，
     * 算出来的是角色轮廓而不是接缝，完全失去意义。
     */
    const photoSeam = isPhoto ? photoSeamStats(cell) : null

    const bleed = isPhoto ? { overflow: 0, tight: 0 } : checkBleed(cell)
    const bounds = alphaBounds(cell)
    const empty = !bounds

    if (empty) {
      report.push({ name, row: r, col: c, status: '空格（全透明）' })
      n++
      continue
    }

    if (doDespeckle) {
      const d = despeckle(cell)
      cell = d.img
      speckles += d.removed
    }

    if (doTrim) cell = trimToContent(cell)

    const out = join(outDir, `${name}.png`)
    const bytes = writePng(out, cell.w, cell.h, cell.rgba)

    report.push({
      name,
      row: r,
      col: c,
      size: `${cell.w}x${cell.h}`,
      kb: Math.round(bytes / 1024),
      bleed: bleed.overflow,
      tight: bleed.tight,
      photoSeam,
      status: isPhoto
        ? 'OK'
        : bleed.overflow > 0
          ? `❌ 越过格线（${bleed.overflow}px）真串格`
          : bleed.tight > 400
            ? '画得满（未越线，安全）'
            : 'OK',
    })
    n++
  }
}

/*
 * 照片模式：不自动判「串格」，只打印四边色差供人工对照拼版确认。
 * 理由见 photoSeamStats 的注释 —— 照片没有客观的「正确边界」，
 * 自动判定只会制造假警报。
 */
if (isPhoto) {
  console.log()
  console.log('接缝色差（配合拼版图目视判断，差得大说明那条边可能混进邻格）：')
  for (const x of report) {
    if (!x.photoSeam) continue
    const loc = `r${x.row + 1}c${x.col + 1}`
    console.log(
      `  ${loc}  ${x.name.padEnd(20)} 上下 ${String(x.photoSeam.spread).padStart(4)}  ` +
        `边缘色 上${JSON.stringify(x.photoSeam.colors.top)} 右${JSON.stringify(x.photoSeam.colors.right)}`,
    )
  }
}

console.log()
for (const x of report) {
  const loc = `r${x.row + 1}c${x.col + 1}`
  const detail = x.size ? `${x.size} ${x.kb}KB`.padEnd(14) : ''.padEnd(14)
  console.log(`  ${loc}  ${x.name.padEnd(20)} ${detail} ${x.status}`)
}

const bleedCount = report.filter((x) => x.bleed > 0).length
const tightCount = report.filter((x) => x.tight > 400 && !x.bleed).length
const emptyCount = report.filter((x) => x.status.startsWith('空格')).length
console.log()
if (isPhoto) {
  console.log(`共 ${report.length} 格：${emptyCount} 个空格，${bleedCount} 个边缘异常`)
} else {
  console.log(
    `共 ${report.length} 格：${emptyCount} 个空格，` +
      `${bleedCount} 个真串格，${tightCount} 个画得满（不影响使用）`,
  )
}
if (speckles) {
  console.log(`已清除 ${speckles} 个邻格侵入像素（--despeckle）`)
}
if (isolatedCleaned) {
  console.log(`--isolate：为保完整向外扩展后，清除 ${isolatedCleaned} 个邻格像素`)
}
if (isPhoto) {
  console.log()
  console.log('照片模式：不自动判定串格（照片没有客观的正确边界）。')
  console.log('  请加 `--contact <文件>` 生成拼版图目视确认，或切完后自己拼一遍。')
} else if (bleedCount) {
  console.log()
  console.log('❌ 真串格 = 内容越过了格线，切出来会带上相邻格的碎片。')
  console.log('   处理：重新生成这一组，或在提示词里加大「50px 隔离带」的权重。')
} else if (tightCount) {
  console.log()
  console.log('提示：这些格的角色贴到了格子边缘（AI 没遵守隔离带要求），')
  console.log('      但没有越过格线，切出来是完整的，可以直接用。')
}
console.log(`\n输出目录：${outDir}`)

/*
 * --contact：把切出来的格拼成一张总览图，方便一眼看出串格。
 *
 * 为什么做成参数而不是事后另跑脚本：切图和「看得对不对」
 * 是同一件事的两半 —— 出完图立刻能看，才不用记住文件名再去找。
 * 立绘那边靠 --isolate + 连通块清理能自动保证质量，
 * 照片没有这类确定性判据，只能靠看。
 */
const contactPath = getOpt('--contact', '')
if (contactPath) {
  const files = report.filter((x) => x.size).map((x) => join(outDir, `${x.name}.png`))
  if (files.length) {
    const tmp = join(outDir, '.contact-list.txt')
    writeFileSync(tmp, files.join('\n'), 'utf8')
    /*
     * 用 montage 而不是自己拼：命令行一行搞定，且自动处理
     * 不同尺寸的格子（照片都是等大的，但立绘不是）。
     */
    try {
      execFileSync('magick', ['montage', '@' + tmp, '-tile', `${cols}x`, '-geometry', '+6+6', '-background', '#d8d8d8', contactPath], {
        stdio: 'ignore',
      })
      rmSync(tmp, { force: true })
      console.log(`拼版图：${contactPath}`)
    } catch (e) {
      console.warn(`拼版失败：${e.message}`)
    }
  }
}
