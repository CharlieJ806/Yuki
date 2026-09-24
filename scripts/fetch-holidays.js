/**
 * 拉取某年的法定节假日，追加/更新到 `src/shared/holidays.js` 的常量表。
 *
 * ## 为什么需要它
 *
 * 手机端内置了节假日常量表（零网络依赖），代价是**每年要更新一次**。
 * 手动抄 40 条数据很容易抄错，所以做成脚本。
 *
 * ## 用法
 *
 *   node scripts/fetch-holidays.js 2027          # 追加 2027
 *   node scripts/fetch-holidays.js 2027 2028     # 一次追加多年
 *   node scripts/fetch-holidays.js 2026 --force  # 覆盖已有的 2026
 *
 * 数据源与桌面端一致（timor.tech），保证两端判断不会出现分歧。
 *
 * ## 注意
 *
 * 次年安排通常在**当年 11 月前后**由国务院公布。太早跑会拿不到数据
 * （接口返回空表），脚本会明确报出来而不是写入一张空表 ——
 * 空表比没有更糟：它会让 `holidayOf()` 返回 null，
 * 表现成「明明有节日却不显示」，很难联想到是数据没拉到的原因。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'src', 'shared', 'holidays.js')

const args = process.argv.slice(2)
const force = args.includes('--force')
const years = args.filter((a) => /^\d{4}$/.test(a)).map(Number)

if (!years.length) {
  console.error('用法: node scripts/fetch-holidays.js <年份> [年份...] [--force]')
  console.error('例:   node scripts/fetch-holidays.js 2027')
  process.exit(1)
}

/* timor.tech 挡无 UA 的请求，必须带 User-Agent */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) desk-pet'

async function fetchYear(year) {
  const res = await fetch(`https://timor.tech/api/holiday/year/${year}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (json?.code !== 0 || !json.holiday) throw new Error('返回结构异常')

  const out = {}
  for (const [md, raw] of Object.entries(json.holiday)) {
    if (!raw || typeof raw !== 'object') continue
    /* 只留两个字段：是否放假、节日名。补班日是 holiday:false */
    out[md] = [raw.holiday === true, String(raw.name ?? '').trim()]
  }
  return out
}

/* ---------- 读出现有表 ---------- */

const src = readFileSync(TARGET, 'utf8')

/**
 * 从源码里抠出 `HOLIDAY_TABLE = { ... }` 的内容。
 *
 * 用括号计数而不是正则 —— 表里有多层嵌套，正则匹配不了
 * （`{` 和 `}` 的数量不等，非贪婪会提前截断）。
 */
function extractTable(text) {
  const start = text.indexOf('export const HOLIDAY_TABLE = {')
  if (start < 0) throw new Error('找不到 HOLIDAY_TABLE')
  const braceStart = text.indexOf('{', start)
  let depth = 0
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return { from: braceStart, to: i + 1, body: text.slice(braceStart, i + 1) }
    }
  }
  throw new Error('括号不配对')
}

const { from, to, body } = extractTable(src)

/* 现有年份（用于判断哪些要覆盖 / 跳过） */
const existingYears = new Set([...body.matchAll(/^\s{2}(\d{4}): \{/gm)].map((m) => m[1]))

/* ---------- 逐年前处理 ---------- */

const updates = {}
for (const year of years) {
  const key = String(year)
  if (existingYears.has(key) && !force) {
    console.log(`${key}: 已存在，跳过（要覆盖加 --force）`)
    continue
  }
  try {
    const days = await fetchYear(year)
    const n = Object.keys(days).length
    if (!n) {
      /*
       * 空表**必须拒绝**：比没有更糟。
       * 空表会让 holidayOf() 返回 null，表现成「有节日却不显示」，
       * 很难联想到是数据没拉到。
       */
      console.error(`${key}: 接口返回空表 —— 该年安排可能还没公布，未写入`)
      continue
    }
    updates[key] = days
    console.log(`${key}: 拉到 ${n} 条`)
  } catch (e) {
    console.error(`${key}: 拉取失败（${e.message}）`)
  }
}

if (!Object.keys(updates).length) {
  console.log('\n没有要写入的年份，源码未改动。')
  process.exit(0)
}

/* ---------- 合并并重写 ---------- */

/*
 * 把「表体」按年重建成文本。
 *
 * 不保留原有格式是有意的：手写时缩进/引号风格难免漂移，
 * 整体重生成能保证每次跑完格式一致，diff 里只有真实的数据变化。
 */
const merged = {}
for (const [y, days] of [
  /* 原有的：从源码里按年抠出来（保留，因为可能含有脚本没拉的年份） */
  ...[...body.matchAll(/^\s{2}(\d{4}): \{([\s\S]*?)^\s{2}\},/gm)].map((m) => [
    m[1],
    Object.fromEntries(
      [...m[2].matchAll(/'(\d{2}-\d{2})': \[(true|false), '([^']*)'\]/g)].map((r) => [
        r[1],
        [r[2] === 'true', r[3]],
      ]),
    ),
  ]),
  /* 新拉的（会覆盖同名的旧年份） */
  ...Object.entries(updates),
]) {
  merged[y] = days
}

const sortedYears = Object.keys(merged).sort()
let out = '{\n'
for (const y of sortedYears) {
  out += `  ${y}: {\n`
  for (const md of Object.keys(merged[y]).sort()) {
    const [isHoliday, name] = merged[y][md]
    out += `    '${md}': [${isHoliday}, '${name}'],\n`
  }
  out += '  },\n'
}
out += '}'

writeFileSync(TARGET, src.slice(0, from) + out + src.slice(to), 'utf8')

console.log(`\n已写入 ${TARGET}`)
console.log(`年份：${sortedYears.join(', ')}`)
console.log('跑 `node scripts/smoke.js` 确认没问题。')
