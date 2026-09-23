/**
 * 把 resources/video/*.mp4 处理成手机端可用的视频资源。
 *
 * ## 为什么要处理，不能直接用原片
 *
 * 1. **moov 必须在文件开头**（faststart）。原片的 moov 在 mdat 之后，
 *    浏览器要把整个文件下完才能开始播 —— 手机上就是转圈半天。
 *    加 `-movflags +faststart` 把索引前置，才能边下边播。
 *
 * 2. **首帧封面**。视频没加载前是一块空白，聊天流里很难看。
 *    抽第一帧存 jpg 当 poster，秒出图。
 *
 * 3. **体积**。原片 0.7~2.0MB，7 段合计约 7.3MB。PWA 要预缓存就必须压。
 *    720x960 / 5s 的竖屏小视频压到 CRF 28 + 音频 96k 足够看，
 *    体积能降一半左右。
 *
 * ## 命名
 *
 * 源文件名是中文（`摸头.mp4`、`旗袍高跟鞋 (1).mp4`），直接进 URL 要
 * 百分号编码、还可能在不同平台上出问题。这里统一换成 slug 文件名
 * （`headpat.mp4`），映射写在 videoStories.js 的 `file` 字段。
 *
 * 用法: node scripts/prepare-video.js
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'resources', 'video')
const OUT = join(ROOT, 'src', 'renderer', 'public', 'videos')

/* 压缩参数：竖屏小视频，CRF 28 是「看不出糊但明显小」的平衡点 */
const CRF = '28'
const AUDIO_BITRATE = '96k'
/* 最长边限制，防止横屏那条（960x720）在手机上占太多带宽 */
const MAX_EDGE = '960'

function has(bin) {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!has('ffmpeg') || !has('ffprobe')) {
  console.error('✗ 需要 ffmpeg / ffprobe，但没找到。')
  console.error('  Windows: winget install --id Gyan.FFmpeg -e')
  console.error('  macOS:   brew install ffmpeg')
  process.exit(1)
}

function probe(file, args) {
  return execFileSync('ffprobe', ['-v', 'error', ...args, '-of', 'default=noprint_wrappers=1:nokey=1', file], {
    encoding: 'utf8',
  }).trim()
}

if (!existsSync(SRC)) {
  console.error(`✗ 找不到源目录: ${SRC}`)
  process.exit(1)
}

const sources = readdirSync(SRC).filter((f) => /\.(mp4|mov|webm)$/i.test(f)).sort()
if (!sources.length) {
  console.error(`✗ ${SRC} 里没有视频文件`)
  process.exit(1)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

/*
 * 中文文件名 -> slug。与 videoStories.js 里的 `file` 字段一一对应。
 * 这里显式列出而不是自动音译：自动生成的 slug 不稳定，
 * 改个文件名就会让已解锁用户的记忆对不上。
 */
const SLUG_BY_FILE = {
  /* 第一批 */
  '摸头': 'headpat',
  '修女栏杆': 'nun-railing',
  '旗袍高跟鞋 (1)': 'qipao-heels-1',
  '旗袍高跟鞋 (2)': 'qipao-heels-2',
  '海边防晒霜': 'beach-sunscreen',
  '睡裙晚安': 'pajamas-goodnight',
  '睡裙转转': 'pajamas-tease',
  /* 第二批 */
  '参加漫展': 'comic-con',
  '女仆咖啡': 'maid-cafe',
  '学校楼梯': 'school-stairs',
  '宿舍自拍': 'dorm-selfie',
  '宿舍自拍2': 'dorm-selfie-2',
  '时候清晨': 'morning-awake',
  /*
   * 源文件原本叫另一个名字，与实际画面（坐吧台椅的坐姿展示）不符，
   * 那个词配角色设定也容易被误读、可能让判断用的模型请求被拦。
   * 已改名为「吧台椅」，与画面一致。
   */
  '吧台椅': 'bar-stool',
  '舞台演出': 'stage-show',
}

let done = 0
let missing = []

for (const f of sources) {
  const base = f.replace(/\.(mp4|mov|webm)$/i, '')
  const slug = SLUG_BY_FILE[base]
  if (!slug) {
    missing.push(f)
    continue
  }
  const src = join(SRC, f)
  const mp4 = join(OUT, `${slug}.mp4`)
  const jpg = join(OUT, `${slug}.jpg`)

  const inSize = statSync(src).size
  const w = probe(src, ['-select_streams', 'v:0', '-show_entries', 'stream=width'])
  const h = probe(src, ['-select_streams', 'v:0', '-show_entries', 'stream=height'])
  const dur = probe(src, ['-select_streams', 'v:0', '-show_entries', 'stream=duration'])
  const hasAudio = probe(src, ['-select_streams', 'a:0', '-show_entries', 'stream=codec_name'])

  /*
   * 转码：
   *   scale      长边限制到 960，短边按比例（保持偶数，H.264 要求）
   *   faststart  moov 前置，移动端才能边下边播
   *   yuv420p    兼容性最好的像素格式，iOS 只认这个
   *   CRF 28     「看不出糊但明显小」
   */
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', src,
    '-vf', `scale='min(${MAX_EDGE},iw)':-2:flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF,
    '-profile:v', 'high', '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ac', '2'] : ['-an']),
    mp4,
  ], { stdio: 'inherit' })

  /* 首帧封面：0.1s 处取，避开有些片头的纯黑帧 */
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-ss', '0.1', '-i', mp4, '-frames:v', '1',
    '-vf', `scale='min(720,iw)':-2`,
    '-q:v', '4',
    jpg,
  ], { stdio: 'inherit' })

  const outSize = statSync(mp4).size + statSync(jpg).size
  console.log(
    `  ✓ ${slug.padEnd(18)} ${w}x${h} ${Number(dur).toFixed(1)}s ` +
      `${hasAudio ? '有声' : '无声'}  ${(inSize / 1024 / 1024).toFixed(2)}MB → ${(outSize / 1024 / 1024).toFixed(2)}MB`,
  )
  done++
}

if (missing.length) {
  console.error('\n✗ 以下源文件没有登记 slug，无法确定输出名：')
  for (const m of missing) console.error(`  · ${m}`)
  console.error('\n请在 scripts/prepare-video.js 的 SLUG_BY_FILE 里补上映射。')
  process.exit(1)
}

console.log(`\n完成，共 ${done} 段视频 → ${OUT}`)
