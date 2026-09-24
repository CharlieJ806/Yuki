/**
 * 冒烟测试 —— 直接在 Node 里跑主进程服务层，不依赖 Electron。
 * 验证：摸鱼收入换算、打卡幂等、等级推进、设置持久化。
 * 用法: node scripts/smoke.js
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createService } from '../src/main/service.js'
import { openStore } from '../src/main/store.js'
import { toDateKey, isRestDay, levelOf, todaySnapshot, workDaysInMonth, timeContextFor, dayPartOf } from '../src/shared/moyu.js'
import { isCacheFresh } from '../src/main/holiday.js'
import { VIDEO_STORIES } from '../src/shared/videoStories.js'
import { OUTFIT_STORIES } from '../src/shared/outfitStories.js'
import { resolveChatConfig } from '../src/main/chat.js'
import { CHAT_PERSONAS, DEFAULT_SETTINGS } from '../src/shared/moyu.js'
import {
  LINES,
  pickLine,
  affinityLevel,
  affinityGain,
  AFFINITY_GAIN,
  AFFINITY_MAX_POINTS,
  CHAT_AFFINITY_DAILY_CAP,
  linesFor,
  hoverLinesFor,
  idleIntervalScale,
  idlePosesFor,
  idleCandidatesFor,
  outfitsFor,
  IDLE_POSES_BY_VOICE,
  OUTFITS,
  OUTFITS_BY_VOICE,
  OUTFIT_SLUGS,
  DEFAULT_OUTFIT,
  outfitFile,
  outfitForTime,
  outfitInfo,
  poseImageFile,
  weightedPool,
  TIRED_POSE_WEIGHT,
  TIRED_POSES,
  contextualScene,
  expressionFile,
  MOOD_KEYS,
  EMOTE_KEYS,
  EMOTE_FOR,
  PET_EXPRESSIONS,
  IDLE_POSES,
  sanitizeChatter,
  recentDialogueMessages,
} from '../src/shared/interactions.js'

const ROOT_PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'public')

let failures = 0
let checks = 0

function check(label, actual, expected) {
  checks++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures++
    console.error(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`)
  } else {
    console.log(`✓ ${label}`)
  }
}

function approx(label, actual, expected, tolerance = 0.01) {
  checks++
  const ok = Math.abs(actual - expected) <= tolerance
  if (!ok) {
    failures++
    console.error(`✗ ${label}\n    expected: ${expected} ±${tolerance}\n    actual:   ${actual}`)
  } else {
    console.log(`✓ ${label} (${actual})`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'desk-smoke-'))
const dbPath = join(dir, 'test.db')
let service = createService(openStore(dbPath))

try {
  /* ---------- 1. 默认设置 ---------- */
  const settings = await service.getSettings()
  check('默认工作时间', [settings.workStart, settings.workEnd], ['08:30', '17:30'])
  check('默认月薪', settings.salary, 10000)
  check('默认月休方式', settings.restPattern, 'double')

  /* ---------- 2. 摸鱼收入换算 ---------- */
  await service.updateSettings({ salary: 21750, workStart: '09:00', workEnd: '18:00', dailyRestHours: 2, restPattern: 'double' })
  /* 2025-06-04 是周三，6 月双休 => 21 个工作日 */
  const afternoon = new Date(2025, 5, 4, 14, 0, 0)
  const snap = todaySnapshot(await service.getSettings(), afternoon)
  check('本月工作日（2025-06 双休）', snap.workDaysInMonth, 21)
  approx('日薪 = 21750/21', snap.dailySalary, 21750 / 21)
  /* 09:00-18:00 在岗 540 分钟，扣 120 分钟休息 => 计薪 420 分钟 */
  check('计薪时长（分钟）', snap.paidSpanMinutes, 420)
  /* 14:00 时已过 300 分钟在岗，按 420/540 折算 => 233.33 分钟计薪 */
  approx('已计薪时长', snap.workedPaidMinutes, 300 * (420 / 540))
  approx('今日摸鱼收入', snap.todayEarned, (21750 / 21) * (233.333 / 420))
  check('状态：摸鱼进行中', snap.statusKind, 'working')

  /* 尚未开工 / 已赚满 的边界 */
  check('08:00 尚未开工', todaySnapshot(await service.getSettings(), new Date(2025, 5, 4, 8, 0)).statusKind, 'before-work')
  check('19:00 今日已赚满', todaySnapshot(await service.getSettings(), new Date(2025, 5, 4, 19, 0)).statusKind, 'completed')
  check('19:00 进度 100%', todaySnapshot(await service.getSettings(), new Date(2025, 5, 4, 19, 0)).progressPercent, 100)

  /*
   * 「还有多久下班」必须走墙上时钟口径，不能用计薪剩余。
   * 09:00-18:00 / 午休 2h，17:00 时：
   *   计薪剩余 = 420 - 480*(420/540) = 420 - 373.33 = 46.67 → 47 分钟
   *   墙上剩余 = 18:00 - 17:00 = 60 分钟
   * 两者差 13 分钟，用户会以为算错了。
   */
  const at17 = todaySnapshot(await service.getSettings(), new Date(2025, 5, 4, 17, 0))
  approx('17:00 计薪剩余', at17.remainingPaidMinutes, 420 - 480 * (420 / 540))
  check('17:00 墙上剩余 60 分钟', Math.round(at17.remainingWorkMinutes), 60)
  /* 未上班时，剩余应为整天在岗时长 */
  check('08:00 剩余整天在岗', Math.round(todaySnapshot(await service.getSettings(), new Date(2025, 5, 4, 8, 0)).remainingWorkMinutes), 540)
  /* 下班后归零，不出现负数 */
  check('19:00 剩余归零', Math.round(todaySnapshot(await service.getSettings(), new Date(2025, 5, 4, 19, 0)).remainingWorkMinutes), 0)
  /* 正好到点下班也归零 */
  check('18:00 整点归零', Math.round(todaySnapshot(await service.getSettings(), new Date(2025, 5, 4, 18, 0)).remainingWorkMinutes), 0)

  /* 休息日：2025-06-07 是周六 */
  const weekend = todaySnapshot(await service.getSettings(), new Date(2025, 5, 7, 14, 0))
  check('周六状态', weekend.statusKind, 'rest-day')
  check('周六收入为 0', weekend.todayEarned, 0)

  /* ---------- 3. 单休 / 大小周 / 不定休 工作日数（2025-06：30 天，9 个周末日） ---------- */
  await service.updateSettings({ restPattern: 'single' })
  check('单休本月工作日（2025-06）', todaySnapshot(await service.getSettings(), afternoon).workDaysInMonth, 25)
  await service.updateSettings({ restPattern: 'alternate' })
  check('大小周本月工作日（2025-06）', todaySnapshot(await service.getSettings(), afternoon).workDaysInMonth, 23)
  await service.updateSettings({ restPattern: 'irregular', customRestDays: 4 })
  check('不定休本月工作日（月休 4 天）', todaySnapshot(await service.getSettings(), afternoon).workDaysInMonth, 26)
  await service.updateSettings({ restPattern: 'double' })

  /* 跨月稳定性：日薪必须随当月真实工作日数变化 */
  check('2025-01 双休工作日', workDaysInMonth({ restPattern: 'double' }, 2025, 1), 23)
  check('2025-02 双休工作日', workDaysInMonth({ restPattern: 'double' }, 2025, 2), 20)

  /* ---------- 4. 打卡 ---------- */
  const before = await service.getState(afternoon)
  check('初始累计天数', before.days, 0)
  check('初始未打卡', before.checkedInToday, false)

  const first = await service.checkIn(afternoon)
  check('首次打卡 created', first.created, true)
  check('打卡后累计天数', first.state.days, 1)
  check('打卡后已打卡', first.state.checkedInToday, true)

  const second = await service.checkIn(afternoon)
  check('同日重复打卡幂等', second.created, false)
  check('重复打卡不增天数', second.state.days, 1)

  /* 昨天补一条，验证连续天数 */
  await service.checkIn(new Date(2025, 5, 3, 10, 0))
  check('连续打卡天数', (await await service.getState(afternoon)).streak, 2)

  /* ---------- 5. 等级 ---------- */
  check('0 天等级', levelOf(0).level.name, '职场萌新')
  check('7 天等级', levelOf(7).level.name, '摸鱼学徒')
  check('7 天距下一级', levelOf(7).daysToNext, 23)
  check('满级', levelOf(9999).isMaxLevel, true)

  /* ---------- 6. 补记摸鱼时长 ---------- */
  await service.logMoyu(45, afternoon)
  check('补记时长累计', (await await service.getState(afternoon)).loggedMinutesToday, 45)
  await service.logMoyu(15, afternoon)
  check('补记时长累加', (await await service.getState(afternoon)).loggedMinutesToday, 60)

  /* ---------- 7. 持久化（重开数据库） ---------- */
  const dateKey = toDateKey(afternoon)
  await service.close()
  service = createService(openStore(dbPath))
  const reopened = await service.getState(afternoon)
  check('重启后设置仍在', reopened.settings.salary, 21750)
  check('重启后打卡仍在', reopened.checkedInToday, true)
  check('重启后累计天数', reopened.days, 2)
  check('重启后补记仍在', reopened.loggedMinutesToday, 60)

  /* ---------- 8. 同步记账 ---------- */
  const pending = await service.pendingChanges()
  check('存在待同步记录', pending.checkins.length > 0 && pending.settings.length > 0, true)
  await service.markSynced({ checkins: pending.checkins.map((c) => c.id) })
  check('标记后打卡无待同步', (await await service.pendingChanges()).checkins.length, 0)

  /* ---------- 10. 未知设置键被忽略 ---------- */
  await service.updateSettings({ hackerKey: 'boom' })
  check('未知键不写入', (await await service.getSettings()).hackerKey, undefined)

  /* ---------- 11. 对话：会话与消息 ---------- */
  const session = await service.ensureChatSession()
  check('自动建会话', typeof session?.id === 'string' && session.id.length > 0, true)
  check('ensure 幂等（仍只有一个）', (await await service.listChatSessions()).length, 1)

  const empty = await service.loadChatSession(session.id)
  check('新会话无消息', empty.messages.length, 0)

  await service.addChatMessage(session.id, 'user', '你好')
  await service.addChatMessage(session.id, 'assistant', '摸鱼快乐')
  const loaded = await service.loadChatSession(session.id)
  check('消息按时间正序', loaded.messages.map((m) => m.role), ['user', 'assistant'])
  check('消息内容正确', loaded.messages[0].content, '你好')

  /* 出错的消息不应进入上下文 */
  const errMsg = await service.addChatMessage(session.id, 'assistant', 'API Key 无效', { error: true })
  check('错误消息标记 error', errMsg.error, true)
  check('错误消息被排除出上下文', (await await service.recentChatMessages(session.id, 10)).length, 2)

  /* 上下文窗口截断：只取最近 N 条且保持时间正序 */
  for (let i = 0; i < 6; i++) await service.addChatMessage(session.id, 'user', `第${i}条`)
  const recent = await service.recentChatMessages(session.id, 3)
  check('上下文按 limit 截断', recent.length, 3)
  check('截断后仍为正序（最后一条最新）', recent[2].content, '第5条')

  /* 会话管理 */
  const s2 = await service.createChatSession('第二个会话')
  check('新建会话数', (await await service.listChatSessions()).length, 2)
  check('新会话标题', (await await service.renameChatSession(s2.id, '改过的标题')).title, '改过的标题')
  check('重命名截断到 60 字', (await await service.renameChatSession(s2.id, 'x'.repeat(100))).title.length, 60)
  check('空标题回退', (await await service.renameChatSession(s2.id, '   ')).title, '新的对话')

  await service.deleteChatSession(s2.id)
  check('删除后会话数', (await await service.listChatSessions()).length, 1)
  check('删除后消息一并软删', (await await service.listChatMessages(s2.id)).length, 0)

  /* 持久化 */
  await service.close()
  service = createService(openStore(dbPath))
  check('重启后会话还在', (await await service.listChatSessions()).length >= 1, true)
  const after = await service.loadChatSession(session.id)
  check('重启后消息还在', after.messages.length >= 8, true)

  /* ---------- 12. 对话配置校验 ---------- */
  await service.updateSettings({ chatBaseUrl: '', chatApiKey: '' })
  check('空 BaseURL 不可用', (await await service.chatStatus()).ready, false)
  await service.updateSettings({ chatBaseUrl: 'https://api.deepseek.com', chatApiKey: '' })
  check('缺 Key 不可用', (await await service.chatStatus()).ready, false)
  check('缺 Key 提示准确', (await await service.chatStatus()).reason.includes('API Key'), true)
  await service.updateSettings({ chatBaseUrl: 'https://api.deepseek.com', chatApiKey: 'sk-test' })
  check('配置完整可用', (await await service.chatStatus()).ready, true)
  await service.updateSettings({ chatBaseUrl: 'http://127.0.0.1:11434/v1', chatApiKey: '' })
  check('本地地址免 Key', (await await service.chatStatus()).ready, true)
  check('本地不需 Key 标记', (await await service.chatStatus()).needsApiKey, false)

  /* ---------- 13. 全链路自检 ---------- */
  /* 指向一个必然连不上的地址：应逐项失败且不抛异常 */
  await service.updateSettings({ chatBaseUrl: 'http://127.0.0.1:9/v1', chatApiKey: '' })
  const diag = await await service.chatDiagnose()
  check('自检返回 ok=false', diag.ok, false)
  check('自检有步骤明细', Array.isArray(diag.steps) && diag.steps.length >= 4, true)
  check('前两步（本地校验）通过', diag.steps.slice(0, 3).every((s) => s.ok), true)
  check('网络步骤失败', diag.steps.some((s) => !s.ok), true)
  check('失败步骤带原因', diag.steps.find((s) => !s.ok).detail.length > 0, true)

  /* ---------- 14. 节假日 / 调休 ---------- */
  await service.updateSettings({ restPattern: 'double', salary: 21750 })
  {
    /* 手造一张表，避免测试依赖外网 */
    const table = {
      '01-01': { isHoliday: true, isMakeup: false, name: '元旦' },
      '01-04': { isHoliday: false, isMakeup: true, name: '元旦后补班' },
      '09-20': { isHoliday: false, isMakeup: true, name: '中秋节前补班' },
      '10-01': { isHoliday: true, isMakeup: false, name: '国庆节' },
    }
    const S = async (y, m, d) => todaySnapshot(await service.getSettings(), new Date(y, m - 1, d, 14, 0), table)

    /* 补班日：周日也要上班（这是修复前的 bug，会误判成休息） */
    const makeup = await S(2026, 9, 20)
    check('补班日不算休息', makeup.restDay, false)
    check('补班日状态为工作中', makeup.statusKind, 'working')
    check('补班日有收入', makeup.todayEarned > 0, true)
    check('补班日标记 isMakeupDay', makeup.isMakeupDay, true)

    /* 法定假日：工作日也要休息 */
    const holiday = await S(2026, 10, 1)
    check('法定假日算休息', holiday.restDay, true)
    check('法定假日状态为休息', holiday.statusKind, 'rest-day')
    check('法定假日收入为 0', holiday.todayEarned, 0)
    check('法定假日带节日名', holiday.holidayName, '国庆节')

    /* 普通周末不受影响 */
    check('普通周六仍休息', (await S(2026, 9, 26)).restDay, true)
    /* 普通工作日不受影响 */
    check('普通工作日仍上班', (await S(2026, 9, 22)).restDay, false)

    /* 没有表时退回纯周末规则 */
    const noTable = todaySnapshot(await service.getSettings(), new Date(2026, 8, 20, 14, 0), null)
    check('无表时退回周末规则', noTable.restDay, true)
    check('无表时不带补班标记', noTable.isMakeupDay, false)

    /* 月度统计要跟着变：有表的 9 月多一个工作日 */
    const withTable = workDaysInMonth(await service.getSettings(), 2026, 9, table)
    const without = workDaysInMonth(await service.getSettings(), 2026, 9)
    check('补班使本月工作日 +1', withTable - without, 1)
  }

  /* 缓存新鲜度判断 */
  check('新缓存判定为新鲜', isCacheFresh({ fetchedAt: Date.now(), table: {} }), true)
  check('过期缓存判定为不新鲜', isCacheFresh({ fetchedAt: Date.now() - 8 * 24 * 3600 * 1000, table: {} }), false)
  check('空缓存不新鲜', isCacheFresh(null), false)
  check('结构异常不新鲜', isCacheFresh({ table: {} }), false)

  /* ---------- 16. 互动逻辑 ---------- */
  {
    /* 台词选择：必须避开上一句，否则连着两次一样会很呆 */
    const pool = ['A', 'B', 'C']
    let allDifferent = true
    for (let i = 0; i < 40; i++) {
      if (pickLine(pool, 'A', Math.random) === 'A') allDifferent = false
    }
    check('台词不会重复上一句', allDifferent, true)
    check('单元素池仍返回该句', pickLine(['only'], 'only'), 'only')
    check('空池返回空串', pickLine([], null), '')
    check('非数组安全', pickLine(null, null), '')

    /* 亲密度等级 */
    check('0 点等级', affinityLevel(0).level.name, '有点眼熟')
    check('10 点升级', affinityLevel(10).level.name, '熟络起来了')
    check('满级判定', affinityLevel(99999).isMax, true)
    check('距下一级计算', affinityLevel(0).toNext, 10)
    check('负值归零', affinityLevel(-5).points ?? affinityLevel(-5).level.min, 0)

    /* 情境台词优先级 */
    const snap = { restDay: false, workStart: '09:00', workEnd: '18:00' }
    check('休息日优先', contextualScene({ ...snap, restDay: true }, new Date(2026, 8, 20, 14, 0)).key, 'restDay')
    check('下班后', contextualScene(snap, new Date(2026, 8, 20, 19, 0)).key, 'offWork')
    check('临近下班', contextualScene(snap, new Date(2026, 8, 20, 17, 45)).key, 'nearOffWork')
    check('刚上班', contextualScene(snap, new Date(2026, 8, 20, 9, 5)).key, 'workStart')
    check('早上', contextualScene(snap, new Date(2026, 8, 20, 8, 0)).key, 'morning')
    check('普通工作时间无情境', contextualScene(snap, new Date(2026, 8, 20, 14, 0)), null)

    /* ---------- 挂机台词：模型输出清理 ---------- */
    /* 模型经常无视「只输出一句话」，这里必须兜住，否则气泡会串行 */
    check('清理 ASCII 双引号', sanitizeChatter('"今天天气不错"'), '今天天气不错')
    check('清理中文弯引号', sanitizeChatter('\u201c弯引号\u201d'), '弯引号')
    check('清理直角引号', sanitizeChatter('\u300c直角引号\u300d'), '直角引号')
    check('清理 「Yuki：」前缀', sanitizeChatter('Yuki：刚看到个好玩的'), '刚看到个好玩的')
    check('清理 「台词：」前缀', sanitizeChatter('台词：想吃那家店'), '想吃那家店')
    check('多行只保留第一行', sanitizeChatter('第一句\n第二句'), '第一句')
    check('去掉列表符', sanitizeChatter('- 列表项'), '列表项')
    check('前缀+引号组合', sanitizeChatter('Yuki：\u300c想吃那家店\u300d'), '想吃那家店')
    check('不闭合引号原样保留', sanitizeChatter('\u300c没闭合'), '\u300c没闭合')
    check('空输入返回空', sanitizeChatter(''), '')
    check('undefined 返回空', sanitizeChatter(undefined), '')
    check('超长截断带省略号', sanitizeChatter('啊'.repeat(60)).endsWith('…'), true)
    check('截断后长度受控', sanitizeChatter('啊'.repeat(60), 10).length, 11)

    /* ---------- 挂机姿态：随亲密度解锁，且每张图都要有文件 ---------- */
    {
      const voices = ['stranger', 'familiar', 'friend', 'close', 'intimate']
      /* 越熟动作越多，必须单调不减 —— 这是「关系变近」的可见表现 */
      const counts = voices.map((v) => idlePosesFor(v).length)
      check('姿态数量随亲密度递增', counts.every((n, i) => i === 0 || n >= counts[i - 1]), true)
      check('最低档最少', counts[0], IDLE_POSES.length)
      check('最高档最多', counts[counts.length - 1] > counts[0], true)

      /* 每个档位的池子都必须有对应图片，否则挂机时 404 */
      let poolFilesOk = true
      for (const v of voices) {
        for (const k of idlePosesFor(v)) {
          if (!existsSync(join(ROOT_PUBLIC, expressionFile(k)))) poolFilesOk = false
        }
      }
      check('所有档位姿态都有图', poolFilesOk, true)

      /* 高分档必须包含低分档的全部动作（只解锁、不替换） */
      let monotoneSets = true
      for (let i = 1; i < voices.length; i++) {
        const prev = new Set(idlePosesFor(voices[i - 1]))
        for (const k of prev) if (!idlePosesFor(voices[i]).includes(k)) monotoneSets = false
      }
      check('高档次集合包含低档', monotoneSets, true)

      check('未知档位回落最低档', idlePosesFor('nope').length, IDLE_POSES.length)

      /* 深夜/早八只显示这几个，不能出现精神头很足的动作 */
      check('深夜池是挂机池子集', TIRED_POSES.every((k) => idlePosesFor('intimate').includes(k)), true)
      check('深夜不含吃零食', TIRED_POSES.includes('snack'), false)
      check('深夜含打哈欠', TIRED_POSES.includes('yawn'), true)
    }

    /* ---------- 服饰：独立命名空间 + 随亲密度解锁 + 时间换装 ---------- */
    {
      /* 每套服饰都必须有图，否则挂机轮换到就 404 */
      const missing = OUTFITS.filter((o) => !existsSync(join(ROOT_PUBLIC, outfitFile(o.slug))))
      check('所有服饰都有图片', missing.map((o) => o.slug), [])

      /* 服饰必须走独立命名空间：混进动作会覆盖立绘（实测过睡衣→pose1 撞握拳） */
      check('服饰文件名带 outfit 前缀', outfitFile('casual').startsWith('yuki-outfit-'), true)
      check('服饰与动作命名空间不重叠', OUTFIT_SLUGS.some((s) => PET_EXPRESSIONS[s]) , false)

      /* 解锁只增不减 */
      const voices = ['stranger', 'familiar', 'friend', 'close', 'intimate']
      const counts = voices.map((v) => outfitsFor(v).length)
      check('服饰数量随亲密度递增', counts.every((n, i) => i === 0 || n >= counts[i - 1]), true)
      check('刚认识不换装', counts[0], 0)
      check('最熟悉解锁全部', counts[counts.length - 1], OUTFITS.length)

      /* 高分档包含低分档全部服饰 */
      let superset = true
      for (let i = 1; i < voices.length; i++) {
        const prev = outfitsFor(voices[i - 1])
        for (const s of prev) if (!outfitsFor(voices[i]).includes(s)) superset = false
      }
      check('高档次集合包含低档（服饰）', superset, true)

      check('未知档位服饰回落最低', outfitsFor('nope').length, 0)

      /* 挂机候选 = 动作 + 服饰，且服饰带可辨识前缀 */
      const intimate = idleCandidatesFor('intimate')
      check('候选含动作', intimate.includes('snack'), true)
      check('候选含服饰且带前缀', intimate.includes('outfit:casual'), true)
      check('候选总数 = 动作 + 服饰', intimate.length, idlePosesFor('intimate').length + outfitsFor('intimate').length)

      /* 候选 -> 文件名：前缀决定取图逻辑 */
      check('动作候选解析', poseImageFile('snack'), 'yuki-snack.png')
      check('服饰候选解析', poseImageFile('outfit:casual'), 'yuki-outfit-casual.png')
      /* 未知输入必须安全回落，不能拼出不存在的路径 */
      check('未知候选回落默认', poseImageFile('nope'), expressionFile('idle'))
      check('空候选回落默认', poseImageFile(''), expressionFile('idle'))
      check('未知名服饰回落默认', outfitFile('nope'), outfitFile(DEFAULT_OUTFIT))

      /* 时间换装：深夜睡衣、早晚居家、白天便服 */
      const at = (h) => outfitForTime(new Date(2026, 8, 21, h, 0))
      check('03:00 睡衣', at(3), 'pajamas')
      check('23:30 睡衣', at(23), 'pajamas')
      check('08:00 居家', at(8), 'homewear')
      check('21:00 居家', at(21), 'homewear')
      check('12:00 便服', at(12), 'casual')
      check('15:00 便服', at(15), 'casual')
      /* 任何时刻都必须返回合法 slug，否则界面会拿到 404 图 */
      let allValid = true
      for (let h = 0; h < 24; h++) if (!OUTFIT_SLUGS.includes(at(h))) allValid = false
      check('24 小时都能返回合法服饰', allValid, true)

      check('服饰信息可查', outfitInfo('qipao').label, '旗袍')
      check('未知服饰信息回落默认', outfitInfo('nope').slug, DEFAULT_OUTFIT)
      /* 默认设置在服饰上必须合法，否则重置设置后会 404 */
      check('默认服饰合法', OUTFIT_SLUGS.includes(DEFAULT_SETTINGS.outfitSlug), true)
      check('默认换装模式合法', ['auto', 'fixed'].includes(DEFAULT_SETTINGS.outfitMode), true)

      /*
       * 换装入口必须处处都在。
       *
       * 这条来自真实回归：把立绘移到独立小窗时，对话框里那个 👗
       * 被我顺手改成了「显隐立绘窗」，换装入口就这么无声无息丢了 ——
       * 用户只剩「点小窗里的立绘」一条路，很难发现。
       *
       * 断言各处的换装写入路径存在（而不是断言 UI 文案，
       * 文案改了不算 bug，但入口没了是）。
       */
      const root = join(dirname(fileURLToPath(import.meta.url)), '..')
      const entries = {
        '对话窗': 'src/renderer/src/chat/ChatApp.vue',
        '对话旁立绘窗': 'src/renderer/src/chat/ChatPetApp.vue',
        '桌宠右键菜单窗': 'src/renderer/src/pet/MenuApp.vue',
        '设置页': 'src/renderer/src/views/SettingsView.vue',
      }
      const entriesMissing = []
      for (const [label, rel] of Object.entries(entries)) {
        const src = readFileSync(join(root, rel), 'utf8')
        /*
         * 匹配两种写法：对象字面量（saveSettings({ outfitMode: 'fixed' })）
         * 与赋值（form.outfitMode = 'fixed'）——
         * 设置页走表单，用的是后者，只认前者会误报。
         */
        if (!/outfitMode\s*[:=]\s*'fixed'/.test(src)) entriesMissing.push(label)
      }
      check('换装入口都在（防再次丢失）', entriesMissing, [])
    }

    /* ---------- 入口必须真的能用：不能引用未导入的标识符 ---------- */
    {
      /*
       * 真实 bug：ChatApp 里 `saveSettings` 被调用但**没有 import**，
       * 点击换装时抛 ReferenceError —— 表面看是「点了没反应」
       * （面板在函数第一行就关了，所以连报错都看不到）。
       *
       * 这类错 Vite 打包不报（自由变量可能是全局），测试也不报（没执行到），
       * 所以只能静态检查：**用到的每个跨模块标识符都必须 import 进来**。
       */
      const root = join(dirname(fileURLToPath(import.meta.url)), '..')
      const files = [
        'src/renderer/src/chat/ChatApp.vue',
        'src/renderer/src/chat/ChatPetApp.vue',
        'src/renderer/src/pet/PetApp.vue',
        'src/renderer/src/pet/MenuApp.vue',
        'src/renderer/src/views/SettingsView.vue',
        'src/renderer/src/views/RecordsView.vue',
      ]
      /* 这些函数都从 stores/app.js 导出，组件里用就必须导入 */
      const mustImport = ['saveSettings', 'resetSettings', 'doCheckIn', 'addAffinity', 'openChatWindow', 'sendPetUi']

      const badRefs = []
      for (const rel of files) {
        const src = readFileSync(join(root, rel), 'utf8')
        /* 只看 <script setup> 部分 */
        const m = /<script setup>([\s\S]*?)<\/script>/.exec(src)
        const script = m ? m[1] : src
        /* 收集 import 进来的名字（覆盖单行与多行两种写法） */
        const imported = new Set()
        for (const im of script.matchAll(/import\s*\{([^}]+)\}/g)) {
          for (const raw of im[1].split(',')) {
            const name = raw.trim().split(/\s+as\s+/).pop().trim()
            if (name) imported.add(name)
          }
        }
        for (const fn of mustImport) {
          /* 调用形式才需要导入；仅出现在注释里不算 */
          const called = new RegExp(`(^|[^.\\w])${fn}\\s*\\(`, 'm').test(
            script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
          )
          if (called && !imported.has(fn)) badRefs.push(`${rel}: ${fn}`)
        }
      }
      check('跨模块函数都已导入（防 ReferenceError）', badRefs, [])
    }

    /* ---------- 广播不能漏窗口 ---------- */
    {
      /*
       * 真实 bug：`broadcast()` 的窗口列表里漏了 `chatPetWindow`，
       * 于是「对话框里换装后，旁边的立绘不变」—— 小窗收不到 state 广播，
       * 只能等自己的时间 tick（那只更新时间、不刷设置）。
       *
       * 这类漏窗口很难在单测里发现（渲染层逻辑是对的，是发送端漏了），
       * 所以直接对源码断言：所有窗口变量都必须出现在 broadcast 的列表里。
       */
      const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'index.js'), 'utf8')

      /* 所有窗口变量（声明处形如 let xWindow = null） */
      const declared = [...src.matchAll(/^let\s+(\w*[Ww]indow)\s*=\s*null$/gm)].map((m) => m[1])
      check('窗口变量已识别', declared.length >= 4, true)

      /* broadcast 里的目标列表 */
      const bm = /function broadcast\([\s\S]*?for \(const win of \[([^\]]+)\]/.exec(src)
      const targets = bm ? bm[1].split(',').map((s) => s.trim()) : []
      check('broadcast 有窗口列表', targets.length > 0, true)

      const missed = declared.filter((w) => !targets.includes(w))
      check('broadcast 覆盖所有窗口（防漏广播）', missed, [])
    }

    /* ---------- 轮换覆盖：每一项都必须会被用到 ---------- */
    {
      /*
       * 用户要求「确保每一个都会轮换用到」。
       *
       * 之前深夜用的是**硬过滤**（只留 TIRED_POSES），代价是 23:00–09:00
       * 这近 10 小时里 snack/music/shrug/heart… 全被排除 ——
       * 满级池从 19 项掉到 12 项，最低档只剩 2 项，
       * 「每个都会用到」直接不成立。现在改成加权，不再排除。
       */
      const voices = ['stranger', 'familiar', 'friend', 'close', 'intimate']

      /* 加权池必须包含原池的每一项（不丢项） */
      let noLoss = true
      for (const v of voices) {
        const base = idleCandidatesFor(v)
        const weighted = weightedPool(base, (k) => !k.startsWith('outfit:') && TIRED_POSES.includes(k))
        for (const k of base) if (!weighted.includes(k)) noLoss = false
      }
      check('加权不丢项（每个都还在）', noLoss, true)

      /* 模拟真实轮换：白天与深夜都必须覆盖到每一项 */
      const simulate = (voice, rounds, night) => {
        const base = idleCandidatesFor(voice)
        const pool = night
          ? weightedPool(base, (k) => !k.startsWith('outfit:') && TIRED_POSES.includes(k))
          : base
        const uniq = [...new Set(pool)]
        const counts = new Map(uniq.map((k) => [k, 0]))
        let last = null
        for (let i = 0; i < rounds; i++) {
          const n = pickLine(pool, last, Math.random)
          counts.set(n, counts.get(n) + 1)
          last = n
        }
        return uniq.filter((k) => counts.get(k) === 0)
      }

      let dayMissing = []
      let nightMissing = []
      for (const v of voices) {
        dayMissing = dayMissing.concat(simulate(v, 2000, false))
        nightMissing = nightMissing.concat(simulate(v, 2000, true))
      }
      check('白天轮换覆盖全部项', dayMissing, [])
      check('深夜轮换也覆盖全部项', nightMissing, [])

      /* 深夜加权：困倦项应明显更频繁，但仍非独占 */
      const base = idleCandidatesFor('intimate')
      const pool = weightedPool(base, (k) => !k.startsWith('outfit:') && TIRED_POSES.includes(k))
      const yawnCount = pool.filter((k) => k === 'yawn').length
      const casualCount = pool.filter((k) => k === 'outfit:casual').length
      check('困倦项被加权', yawnCount > casualCount, true)
      check('非困倦项仍在池里', pool.includes('snack'), true)
      check('服饰不被加权', casualCount, 1)

      /* 权重为 1 / 非法时应当是原池（不能改变调用方语义） */
      check('weight=1 不复制', weightedPool(['a', 'b'], () => true, 1), ['a', 'b'])
      check('非数组安全', weightedPool(null, () => true), [])

      /*
       * 满级候选池规模。
       *
       * 断言的是**关系**而不是具体数字 —— 写死数字的话每次加素材
       * 这条都会红，改的人还分不清「是真错了还是数字过时了」。
       *
       * 注意池子用的是 idlePosesFor（挂机动作池），不是全部动作：
       * heart/jump/angry 那些是**互动触发**的，不参与挂机轮换。
       * 早先这里误写成「全部动作 + 全部服饰」，把 18 当成动作数，
       * 结果加完素材后这条一直红 —— 是断言错了，不是代码错了。
       */
      check(
        '满级候选池 = 挂机动作 + 全部服饰',
        idleCandidatesFor('intimate').length,
        idlePosesFor('intimate').length + outfitsFor('intimate').length,
      )
      check('满级服饰池 = 全部服饰', outfitsFor('intimate').length, OUTFITS.length)
      check('服饰表非空', OUTFITS.length > 0, true)
      check('服饰 slug 唯一', new Set(OUTFIT_SLUGS).size, OUTFITS.length)
    }

    /* ---------- 源素材零遗漏：每张 yuki 源图都必须被用上 ---------- */
    {
      /*
       * 这条是为了防止重演「同款去重误删 9 张素材」那类问题。
       *
       * 当时的根因是「靠命名习惯猜内容」：以为 `便服 (2)` 是 `便服` 的同款，
       * 于是静默丢弃。实际它们是完全不同的衣服（实测 RMSE 6000~14000、
       * 缩略指纹全不同）。所以这里用 manifest 对账：
       * **源目录里每张 png 都必须出现在产物清单里**，一张都不能少。
       */
      const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'yuki')
      const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'pet', 'manifest.json')

      if (!existsSync(manifestPath)) {
        check('manifest 已生成', false, true)
      } else {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        const sourcesUsed = new Set(Object.values(manifest).map((v) => v.source))
        const allSources = readdirSync(SRC_DIR).filter((f) => /\.png$/i.test(f))

        const dropped = allSources.filter((f) => !sourcesUsed.has(f))
        check('源素材零遗漏（每张都被用上）', dropped, [])
        check('manifest 条目数 = 源图数', Object.keys(manifest).length, allSources.length)

        /* 服饰类的每一项都必须产出独立图片文件 */
        /*
         * 服饰条目数从 manifest 自身推导比较，而不是写死 17：
         * 断言的是「服饰表里的每一套都产出了图」这一层对应关系。
         */
        const outfitEntries = Object.entries(manifest).filter(
          ([, v]) => v.kind === 'outfit' || v.kind === 'outfit-scene',
        )
        check('服饰条目数 = 服饰表条目数', outfitEntries.length, OUTFITS.length)
        const missingFiles = outfitEntries
          .filter(([slug]) => !existsSync(join(ROOT_PUBLIC, `yuki-${slug}.png`)))
          .map(([slug]) => slug)
        check('服饰图文件零缺失', missingFiles, [])
      }
    }

    /* ---------- 桌宠立绘解析：换装必须真的改变显示 ---------- */
    {
      /*
       * 用户实测反馈「右键换装没反应」。
       *
       * 根因：桌宠立绘原来只看 emote/idlePose/mood（都是动作），
       * 完全不读 outfitMode —— 换装设置写进去了，但桌宠不显示它。
       * 这里锁住解析规则，避免再退化。
       */
      const resolve = (settings, { emote = '', idlePose = '', mood = 'work' } = {}) => {
        const currentExpression = emote || idlePose || mood
        const showingOutfit = settings.outfitMode === 'fixed' && !emote
        if (!showingOutfit) return poseImageFile(currentExpression)
        const s = settings.outfitSlug
        const slug = OUTFIT_SLUGS.includes(s) ? s : DEFAULT_OUTFIT
        return outfitFile(slug)
      }

      /* 固定模式：立绘必须是那套衣服 */
      check('固定旗袍显示旗袍', resolve({ outfitMode: 'fixed', outfitSlug: 'qipao' }), 'yuki-outfit-qipao.png')
      check('固定修女显示修女', resolve({ outfitMode: 'fixed', outfitSlug: 'nun' }), 'yuki-outfit-nun.png')
      /* 换一套必须换一张图 —— 这正是「没反应」的反面 */
      check(
        '换装会改变立绘',
        resolve({ outfitMode: 'fixed', outfitSlug: 'qipao' }) !== resolve({ outfitMode: 'fixed', outfitSlug: 'nun' }),
        true,
      )

      /* 互动表情优先，否则点了没反馈 */
      check('互动表情盖过服饰', resolve({ outfitMode: 'fixed', outfitSlug: 'qipao' }, { emote: 'shy' }), 'yuki-shy.png')
      check('表情结束后回到服饰', resolve({ outfitMode: 'fixed', outfitSlug: 'qipao' }), 'yuki-outfit-qipao.png')

      /* 自动模式仍走动作，不锁死在服饰上 */
      const autoImg = resolve({ outfitMode: 'auto', outfitSlug: 'qipao' })
      check('自动模式走动作', autoImg, poseImageFile('work'))
      check('自动模式不被 outfitSlug 影响', autoImg.includes('outfit'), false)

      /* 非法 slug 必须回落，不能拼出不存在的文件 */
      check('非法 slug 回落默认', resolve({ outfitMode: 'fixed', outfitSlug: 'nope' }), outfitFile(DEFAULT_OUTFIT))
      check('缺失 slug 回落默认', resolve({ outfitMode: 'fixed' }), outfitFile(DEFAULT_OUTFIT))
    }

    /* ---------- 挂机台词：只看最近两天的对话 ---------- */
    {
      const store2 = openStore(':memory:')
      const sid = store2.createSession().id
      const DAY = 24 * 3600 * 1000
      const now = Date.now()
      const rows = [
        ['user', '【五天前】爬山'],
        ['assistant', '【五天前】看日出'],
        ['user', '【三天前】作业'],
        ['assistant', '【三天前】还差一点'],
        ['user', '【昨天】芒果冰'],
        ['assistant', '【昨天】我也想吃'],
      ]
      const ids = rows.map(([role, c]) => store2.addMessage(sid, role, c).id)
      const ages = [5 * DAY, 5 * DAY, 3 * DAY, 3 * DAY, 1 * DAY, 1 * DAY]
      ids.forEach((id, i) => {
        store2.db.prepare('UPDATE chat_messages SET createdAt = ? WHERE id = ?').run(now - ages[i], id)
      })

      const windowed = store2.messagesSince(sid, now - 2 * DAY, 200)
      check('窗口内只剩昨天的两条', windowed.length, 2)
      check('五天前被排除', windowed.some((m) => m.content.includes('五天前')), false)
      check('三天前被排除', windowed.some((m) => m.content.includes('三天前')), false)
      check('昨天保留', windowed.filter((m) => m.content.includes('昨天')).length, 2)

      /* 对照：旧的按条数取法会把老内容一起捞出来 */
      check('按条数取会捞到全部（旧行为）', store2.recentMessages(sid, 24).length, 6)

      /* 全是很久以前 → 窗口为空，调用方应回落到台词库 */
      store2.db.prepare('UPDATE chat_messages SET createdAt = ?').run(now - 30 * DAY)
      check('全超窗口时为空', store2.messagesSince(sid, now - 2 * DAY, 200).length, 0)

      store2.close()
    }

    /* ---------- 挂机台词：上下文按真实角色重建 ---------- */
    /*
     * 用户反馈的实际问题：她会对着自己说过的话发问。
     * 原因是把整段记录塞进一条 user 消息，模型分不清谁说的。
     * 这里锁住「role 必须如实传递」这条契约。
     */
    check('空数组返回空数组', recentDialogueMessages([]), [])
    check('null 返回空数组', recentDialogueMessages(null), [])
    check(
      '只保留 user/assistant 且 role 如实',
      recentDialogueMessages([
        { role: 'system', content: '不该出现' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '嗨' },
        { role: 'tool', content: '不该出现' },
      ], 10, 500),
      [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '嗨' },
      ],
    )
    /* 关键回归：她自己的话必须以 assistant 身份送达，不能混成 user */
    {
      const rebuilt = recentDialogueMessages([
        { role: 'user', content: '今天好累' },
        { role: 'assistant', content: '我今天好累，改了一下午图' },
      ])
      const assistantLines = rebuilt.filter((m) => m.role === 'assistant').map((m) => m.content)
      check('她的话标为 assistant', assistantLines, ['我今天好累，改了一下午图'])
      check('没有把自己的话混成 user', rebuilt.filter((m) => m.role === 'user').length, 1)
      /* 绝不能出现「Yuki：」这种文本前缀 —— 那正是分不清的根源 */
      check('不带角色文字前缀', rebuilt.some((m) => m.content.includes('Yuki：')), false)
    }

    const trimmed = recentDialogueMessages(
      Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `内容${i}`.repeat(20) })),
      20,
      200,
    )
    check('超长时保留最近几条', trimmed.some((m) => m.content.includes('内容19')), true)
    check('超长时丢掉最早的', trimmed.some((m) => m.content.includes('内容0')), false)
    check('裁剪后至少留一条', trimmed.length >= 1, true)
    check('正序保留（最后一条最新）', trimmed[trimmed.length - 1].content.includes('内容19'), true)

    /* 表情注册表：每个 key 都要能映射到实际存在的文件 */
    const allKeys = [...MOOD_KEYS, ...EMOTE_KEYS]
    check('表情 key 数量', allKeys.length, 18)
    check('状态类 4 个', MOOD_KEYS.length, 4)
    check('表情类 14 个', EMOTE_KEYS.length, 14)
    /* 生活化姿态也要有图，否则挂机轮换会 404 */
    check('挂机姿态都有图', IDLE_POSES.every((k) => allKeys.includes(k)), true)

    let allFilesExist = true
    const missing = []
    for (const k of allKeys) {
      const f = expressionFile(k)
      if (!existsSync(join(ROOT_PUBLIC, f))) {
        allFilesExist = false
        missing.push(f)
      }
    }
    check('所有表情都有对应图片', allFilesExist, true)
    if (!allFilesExist) console.error('    缺失:', missing.join(', '))

    check('未知 key 回落默认', expressionFile('nope'), expressionFile('idle'))
    check('心情类映射正确', expressionFile('rest'), 'yuki-pose3.png')

    /* 每种互动都要配到表情，否则表情不切换 */
    const scenes = Object.keys(EMOTE_FOR)
    let allMapped = true
    for (const s of scenes) {
      const e = EMOTE_FOR[s]
      if (!e || !allKeys.includes(e)) {
        allMapped = false
        console.error(`    ${s} -> ${e} 无效`)
      }
    }
    check('所有互动都配了有效表情', allMapped, true)

    /* ---------- 亲密度：关系档位影响说话方式 ---------- */
    check('等级带关系档位', affinityLevel(0).voice, 'stranger')
    check('高档位 voice 正确', affinityLevel(300).voice, 'intimate')
    check('满级 upper bound', affinityLevel(AFFINITY_MAX_POINTS).isMax, true)

    /*
     * 台词要随亲密度变化 —— 这是「提升亲密度」的实际效果，
     * 只涨数字不改说法的话用户感觉不到。
     */
    const strangerPoke = linesFor('poke', 'stranger')
    const familiarPoke = linesFor('poke', 'familiar')
    check('生疏档取到通用池', strangerPoke, LINES.poke)
    /* 熟络档在句首挂前缀，但语气词开头的句子要跳过（「诶，嗯？」很怪） */
    check('熟络档加前缀', familiarPoke[0], `诶，${LINES.poke[0]}`)
    check('熟络档多数句子带前缀', familiarPoke.filter((l) => l.startsWith('诶，')).length, 4)
    check('语气词句跳过前缀', familiarPoke.includes('嗯？'), true)
    check('数量不变（只加前缀）', familiarPoke.length, strangerPoke.length)
    const familiarPet = linesFor('pet', 'familiar')
    check('语气词句跳过前缀（pet）', familiarPet.includes('诶嘿…'), true)
    check('最熟档切专属池', linesFor('pet', 'intimate'), ['嗯…随便你摸', '诶嘿，今天心情好？', '再摸一下也不是不行'])
    check('最熟档挂机台词变多', linesFor('idle', 'intimate').length > linesFor('idle', 'stranger').length, true)
    check('未知档位回落通用池', linesFor('poke', 'nope').length, strangerPoke.length)
    check('未知 key 返回空', linesFor('nope', 'intimate'), [])
    check('悬停台词随档位切换', hoverLinesFor('intimate')[0], '忙完啦？')
    check('悬停台词默认用通用池', hoverLinesFor('stranger').length > 0, true)
    /* 越熟越黏人：倍率必须单调下降 */
    const scales = ['stranger', 'familiar', 'friend', 'close', 'intimate'].map(idleIntervalScale)
    check('主动说话频率随亲密度递增', scales.every((s, i) => i === 0 || s < scales[i - 1]), true)
    check('未知档位倍率为 1', idleIntervalScale('nope'), 1)

    /* ---------- 亲密度：得分规则（上限 + 聊天日配额） ---------- */
    check('满级后不再涨点', affinityGain({ points: AFFINITY_MAX_POINTS }, 5, '2026-09-21'), 0)
    check('接近上限时被截断', affinityGain({ points: AFFINITY_MAX_POINTS - 2 }, 5, '2026-09-21'), 2)
    check('正常加点', affinityGain({ points: 0 }, AFFINITY_GAIN.pet, '2026-09-21'), AFFINITY_GAIN.pet)
    check('零和负数不加点', affinityGain({ points: 0 }, 0, '2026-09-21'), 0)
    /* 聊天配额：不设的话一口气聊几十条就能从 0 冲到满级 */
    const capUsed = { points: 10, chatDay: '2026-09-21', chatToday: CHAT_AFFINITY_DAILY_CAP }
    check('聊到日上限后不再加分', affinityGain(capUsed, 3, '2026-09-21', { chat: true, chatCap: CHAT_AFFINITY_DAILY_CAP }), 0)
    check('跨天后配额重置', affinityGain(capUsed, 3, '2026-09-22', { chat: true, chatCap: CHAT_AFFINITY_DAILY_CAP }), 3)
    check('配额快满时按剩余给', affinityGain({ points: 10, chatDay: '2026-09-21', chatToday: 59 }, 3, '2026-09-21', { chat: true, chatCap: 60 }), 1)
    /* 手动互动不受聊天配额约束 */
    check('摸头不受聊天配额影响', affinityGain(capUsed, 2, '2026-09-21', { chatCap: CHAT_AFFINITY_DAILY_CAP }), 2)

    const before = (await await service.affinity()).points
    await service.addAffinity(7)
    check('亲密度累加', (await await service.affinity()).points, before + 7)
    check('连续天数为 1', (await await service.affinity()).streakDays, 1)
    check('getState 带亲密度', (await await service.getState()).affinity.points, before + 7)
    /* 上限：到顶后继续互动不再涨，避免等级卡在最后一档还以为在涨 */
    for (let i = 0; i < 400; i++) await service.addAffinity(10)
    check('亲密度封顶', (await await service.affinity()).points, AFFINITY_MAX_POINTS)
    check('封顶后 isMax', (await await service.affinity()).isMax, true)
    await service.resetAffinity()
    check('重置归零', (await await service.affinity()).points, 0)
    check('重置清空聊天配额', (await await service.affinity()).chatToday, 0)
  }

  /* ---------- 16b. 聊天记亲密度 ---------- */
  {
    await service.resetAffinity()
    /*
     * 对话是提升亲密度最主要的途径，必须真的落库。
     * 用假接口时会失败，所以只验证「记账」这一步本身。
     */
    const before = (await await service.affinity()).points
    const chatSession = await service.ensureChatSession()
    await service.addChatMessage(chatSession.id, 'user', '在吗')
    await service.addAffinity(AFFINITY_GAIN.chatMessage, { kind: 'chat' })
    check('聊天加分生效', (await await service.affinity()).points, before + AFFINITY_GAIN.chatMessage)
    check('聊天计入当日配额', (await await service.affinity()).chatToday, AFFINITY_GAIN.chatMessage)

    /* 配额用完后再聊不加分，但其他互动照常 */
    await service.addAffinity(CHAT_AFFINITY_DAILY_CAP * 10, { kind: 'chat' })
    const capped = (await await service.affinity()).points
    check('聊天配额封顶', (await await service.affinity()).chatToday, CHAT_AFFINITY_DAILY_CAP)
    await service.addAffinity(AFFINITY_GAIN.chatMessage, { kind: 'chat' })
    check('配额用尽后聊天不加分', (await await service.affinity()).points, capped)
    await service.addAffinity(AFFINITY_GAIN.pet)
    check('配额用尽后摸头仍加分', (await await service.affinity()).points, capped + AFFINITY_GAIN.pet)

    /* meta 要下发规则，否则设置页只能写死文案 */
    const meta = await service.meta()
    check('meta 带亲密度等级表', meta.affinity.levels.length, affinityLevel(0).level ? 5 : 0)
    check('meta 带聊天日上限', meta.affinity.chatDailyCap, CHAT_AFFINITY_DAILY_CAP)
    check('meta 带得分规则', meta.affinity.gain.chatRound, AFFINITY_GAIN.chatRound)
    await service.resetAffinity()
  }

  /* ---------- 16c. 补卡 ---------- */
  {
    await service.resetAffinity()
    const today = new Date(2026, 8, 21, 14, 0) // 2026-09-21 周一
    await service.updateSettings({ restPattern: 'double' })

    /*
     * 没有表时只能按周末判工作日 —— 这是补卡口径的下限，
     * 有节假日表（下面第二个 case）时补班日/法定假日要正确区分。
     */
    const noTable = await service.previewBackfill('2026-09-14', new Date(2026, 8, 21, 14, 0))
    check('预览区间端点', [noTable.from, noTable.to], ['2026-09-14', '2026-09-21'])
    /* 9/14 周一 ~ 9/21 周一：去掉 9/19、9/20 周末 => 6 天 */
    check('按周末算出 6 天', noTable.count, 6)
    check('预览不含周末', noTable.days.some((d) => ['2026-09-19', '2026-09-20'].includes(d.dateKey)), false)

    const applied = await service.applyBackfill('2026-09-14', new Date(2026, 8, 21, 14, 0))
    check('补卡写入天数', applied.created.length, 6)
    check('补卡后累计天数', (await await service.getState(new Date(2026, 8, 21, 14, 0))).days >= 6, true)
    check('补卡记录带补卡备注', (await await service.listCheckins({ year: 2026, month: 9 })).find((c) => c.dateKey === '2026-09-14').note, '补卡')

    /* 幂等：已经补过的日期第二次预览必须为空，不能重复计数 */
    const again = await service.previewBackfill('2026-09-14', new Date(2026, 8, 21, 14, 0))
    check('补卡幂等（二次预览为空）', again.count, 0)
    check('二次执行不写入', (await await service.applyBackfill('2026-09-14', new Date(2026, 8, 21, 14, 0))).created.length, 0)

    /* 补卡后连续天数要连起来，否则「连续打卡」会显示成 1 */
    check('补卡后连续天数连贯', (await await service.getState(new Date(2026, 8, 21, 14, 0))).streak >= 6, true)

    /*
     * 周末不断档：这是补卡带来的真实场景 —— 只有工作日有记录，
     * 按日历天数连推会在周六停下，用户周五+周一都打了卡却看到「连续 1 天」。
     * 用独立的库文件，避免和上面的打卡记录串在一起。
     */
    await service.close()
    service = createService(openStore(join(mkdtempSync(join(tmpdir(), 'desk-streak-')), 'a.db')))
    await service.updateSettings({ restPattern: 'double' })
    const fri = new Date(2026, 8, 18, 14, 0)
    const mon = new Date(2026, 8, 21, 14, 0)
    await service.applyBackfill('2026-09-14', mon)
    /* 区间含今天，周一自己也有记录 → 从今天起回看到 9/14 共 6 个工作日 */
    check('跨周末连续 = 补卡天数', (await await service.getState(mon)).streak, 6)
    /* 周五视角只回看到 9/14，是 5 天 */
    check('周五当天为 5 天', (await await service.getState(fri)).streak, 5)
    /* 中间缺一天工作日就必须断档 */
    await service.close()
    service = createService(openStore(join(mkdtempSync(join(tmpdir(), 'desk-streak2-')), 'b.db')))
    await service.updateSettings({ restPattern: 'double' })
    await service.checkIn(new Date(2026, 8, 14, 10, 0)) // 周一
    await service.checkIn(new Date(2026, 8, 16, 10, 0)) // 周三，跳过周二
    check('缺工作日则断档', (await await service.getState(new Date(2026, 8, 16, 14, 0))).streak, 1)

    /*
     * 法定假日/补班日：9/20 是周日但补班（要补），10/1 是周四但放假（不补）。
     * 这是补卡最容易出错的地方，也是跟 isRestDay 共用口径的意义。
     *
     * 注意 service 内部有节假日内存缓存，直接写 meta 不会被读到，
     * 所以这里换一个干净的库并重建 service，让它按新表重新读。
     */
    await service.close()
    const holidayDb = join(mkdtempSync(join(tmpdir(), 'desk-holiday-')), 'h.db')
    service = createService(openStore(holidayDb))
    await service.updateSettings({ restPattern: 'double' })
    await service.setMeta('holiday-2026', {
      fetchedAt: Date.now(),
      table: {
        '09-20': { isHoliday: false, isMakeup: true, name: '中秋前补班' },
        '10-01': { isHoliday: true, isMakeup: false, name: '国庆节' },
      },
    })
    await service.close()
    service = createService(openStore(holidayDb))
    const withTable = await service.previewBackfill('2026-09-19', new Date(2026, 9, 2, 14, 0))
    check('补班日算工作日', withTable.days.some((d) => d.dateKey === '2026-09-20'), true)
    check('补班日带标记', withTable.days.find((d) => d.dateKey === '2026-09-20')?.isMakeup, true)
    check('法定假日跳过', withTable.days.some((d) => d.dateKey === '2026-10-01'), false)

    /* 边界：起止同一天、开始日晚于今天都要能正确处理 */
    check('单日区间', (await await service.previewBackfill('2026-09-21', new Date(2026, 8, 21, 14, 0))).count <= 1, true)
    let threw = false
    try {
      await service.previewBackfill('2026-09-22', new Date(2026, 8, 21, 14, 0))
    } catch {
      threw = true
    }
    check('开始日晚于今天报错', threw, true)
    threw = false
    try {
      await service.previewBackfill('2026/09/01', new Date(2026, 8, 21, 14, 0))
    } catch {
      threw = true
    }
    check('非法日期格式报错', threw, true)
  }

  /* ---------- 17. 自定义人设 ---------- */
  {
    check('内置人设已就绪', (await await service.listPersonas()).length, 3)
    check('内置人设为非自定义', (await await service.listPersonas()).every((p) => !p.custom), true)

    const created = await service.createPersona({ label: '测试人设', prompt: '测试提示词' })
    check('新建人设', created.label, '测试人设')
    check('新建后总数 +1', (await await service.listPersonas()).length, 4)

    const dup = await service.duplicatePersona('yuki')
    check('复制内置人设', dup.prompt.length > 400, true)
    check('副本名称带后缀', dup.label.endsWith('副本'), true)

    await service.updatePersona(created.id, { prompt: '改过的提示词' })
    check('更新人设提示词', (await await service.listPersonas()).find((p) => p.id === created.id).prompt, '改过的提示词')
    await service.updatePersona(created.id, { label: '' })
    check('空名称不覆盖原名', (await await service.listPersonas()).find((p) => p.id === created.id).label, '测试人设')

    /* 关键：自定义人设必须能被对话层解析到，否则会静默回落成 Yuki */
    await service.updateSettings({ chatPersona: created.id })
    const custom = (await await service.listPersonas()).filter((p) => p.custom)
    const cfg = resolveChatConfig(await service.getSettings(), custom)
    check('自定义人设被解析', cfg.personaId, created.id)
    /* system 现在是「时间块 + 人设」，人设本身要原样保留在末尾 */
    /*
     * 顺序现在是「人设在前、时间块在后」——为了前缀缓存命中
     * （时间块每分钟变，放末尾才不会击穿人设的缓存）。
     */
    check('自定义提示词生效', cfg.systemPrompt.startsWith('改过的提示词'), true)
    check('自定义人设也注入时间块', cfg.systemPrompt.includes('当前时间'), true)

    /* 删掉正在用的人设要回落到默认，不能让人设变成空白 */
    await service.deletePersona(created.id)
    check('删除后回落到默认人设', (await await service.getSettings()).chatPersona, 'yuki')

    /* 复制品也删掉，保持测试隔离 */
    await service.deletePersona(dup.id)
    check('自定义人设已清空', (await await service.listPersonas()).filter((p) => p.custom).length, 0)
  }

  /* ---------- 18. 退出收尾：关库之后不能再被回调碰到 ---------- */
  {
    /*
     * 真实崩溃：点「退出」时 before-quit 先关掉了数据库，紧接着桌宠窗口
     * 触发 closed → rebuildTrayMenu() → await service.getState() → 在已关闭的库上
     * getSettings()，弹出一个原生「database is not open」错误框。
     * 这里固定住两条契约：关库后读状态必须抛（说明竞态真实存在），
     * 且 close 必须能重复调用（退出流程里有多个入口都会关）。
     */
    const shutdown = createService(openStore(join(mkdtempSync(join(tmpdir(), 'desk-quit-')), 'q.db')))
    shutdown.close()

    let threw = null
    try {
      await shutdown.getState()
    } catch (err) {
      threw = err
    }
    check('关库后读状态确实会抛（竞态成立）', threw !== null, true)
    check('抛的就是 database is not open', String(threw?.message ?? '').includes('database is not open'), true)

    /* 幂等：before-quit 与窗口 closed 都会走 close，重复调用不能炸 */
    let repeatOk = true
    try {
      shutdown.close()
      shutdown.close()
    } catch {
      repeatOk = false
    }
    check('close 可重复调用', repeatOk, true)
  }

  /* ---------- 19. 对话的时间感：不能 9 点说吃午饭 ---------- */
  {
    const opts = { workStart: '09:00', workEnd: '18:00', isRestDay: false }
    const at = (h, m = 0) => timeContextFor(new Date(2026, 8, 21, h, m), opts)

    /* 用户实测的问题：早上九点多她说要去吃午饭 */
    const nine = at(9, 10)
    check('9 点识别为上午', dayPartOf(new Date(2026, 8, 21, 9, 10)).label, '上午')
    check('9 点禁止提午饭', nine.includes('不要提吃午饭'), true)
    check('9 点带上具体时刻', nine.includes('09:10'), true)
    check('带星期', nine.includes('周一'), true)

    /*
     * 另一类实测问题：「她搞不清现在是几点/周几」。
     *
     * 根因不是没注入时间（注入一直是对的），而是**提示词只讲「不要说什么」，
     * 从没让她意识到「我确实知道时间」**。结果被问「现在几点」时，
     * 她把时间块当成背景设定而含糊其辞。
     * 所以这里锁住「主动认知」的措辞，而不只是禁止项。
     */
    check('明确告知她这是真实此刻', nine.includes('这是真实的此刻'), true)
    check('明确她知道自己知道时间', nine.includes('你确实知道现在的时间'), true)
    check('要求被问就直接回答', nine.includes('照上面直接回答'), true)
    check('禁止含糊/反问', nine.includes('不要含糊或反问'), true)
    /* 日期三要素要齐全，否则「周几」还是会答不出 */
    check('秒级格式：年', nine.includes('2026 年'), true)
    check('秒级格式：月日', nine.includes('9 月 21 日'), true)
    /* 人设里也要有对应的「她知道时间」条目 */
    const prompt = CHAT_PERSONAS.find((p) => p.id === 'yuki').prompt
    check('人设要求她知道时间', prompt.includes('你确实知道现在是几点'), true)
    check('人设禁止含糊回答', prompt.includes('不要含糊、不要反问'), true)
    /* 不能反过来变成「动不动就报时」 */
    check('人设限制主动报时', prompt.includes('不用主动报时'), true)

    /*
     * 顺序必须「稳定内容在前、易变内容在后」—— 为了命中前缀缓存。
     *
     * 实测证据（同一段人设 + 极短变化量对比）：
     *   前缀不同 → cached=0,    miss=1003
     *   前缀相同 → cached=768,  miss=234
     * 官方价：命中 $0.003/M vs 未命中 $0.15/M，差 50 倍。
     * 一旦有人把时间块挪回前面，人设就会每轮按全价重算。
     */
    {
      /* 用 service 的设置即可；这条只关心顺序，不关心具体人设内容 */
      const cfgOrder = resolveChatConfig(await service.getSettings(), [], { now: new Date(2026, 8, 21, 14, 15), ...opts })
      const iPersona = cfgOrder.systemPrompt.indexOf('你叫 Yuki')
      const iClock = cfgOrder.systemPrompt.indexOf('当前时间')
      check('人设在时间块之前（缓存友好）', iPersona >= 0 && iPersona < iClock, true)
      check('时间块在末尾附近', iClock > cfgOrder.systemPrompt.length * 0.5, true)
    }

    /* 12 小时制歧义：23:40 不能说成「11:40」而不带深夜语境 */
    {
      const t2340 = timeContextFor(new Date(2026, 8, 21, 23, 40), opts)
      check('深夜给出 24 小时制', t2340.includes('23:40'), true)
      check('深夜带时段词消歧', t2340.includes('深夜'), true)
      check('显式标注 24 小时制', t2340.includes('24 小时制'), true)
      const t1205 = timeContextFor(new Date(2026, 8, 21, 0, 5), opts)
      check('凌晨 00:05 正确', t1205.includes('00:05'), true)
      const t1200 = timeContextFor(new Date(2026, 8, 21, 12, 0), opts)
      check('正午 12:00 不说成 0:00', t1200.includes('中午12:00') || t1200.includes('中午 12:00'), true)
    }

    /* 中午以后反过来不能再提早饭 */
    check('12 点可以提午饭', at(12, 30).includes('是午饭时间'), true)
    check('12 点禁止提早午饭', at(12, 30).includes('不要提吃早饭'), true)
    check('14 点禁止提午饭（刚吃过）', at(14, 0).includes('不要提吃午饭'), true)

    /* 各时段都要有明确的禁止项，否则模型会自由发挥 */
    let allForbidden = true
    for (const h of [3, 7, 9, 12, 14, 16, 18, 20, 23]) {
      if (!timeContextFor(new Date(2026, 8, 21, h), opts).includes('不要提')) allForbidden = false
    }
    check('各时段都有禁止项', allForbidden, true)

    /* 深夜/凌晨要提醒她可能在睡觉或打游戏，避免表现得精力充沛 */
    check('凌晨提示已睡', at(3).includes('早就睡了'), true)
    check('深夜像是在打游戏', at(23).includes('打游戏'), true)

    /*
     * 用户作息：淡化异地（用户明确要求别反复强调地理距离），
     * 所以措辞是「他在忙、回消息慢」而不是「他在上班、别拉他出去玩」。
     */
    check('工作日不提异地/不拦着她找他', at(10).includes('多半在忙'), true)
    check('工作日不出现「别拉他出去玩」', at(10).includes('别拉他出去玩'), false)
    const rest = timeContextFor(new Date(2026, 8, 21, 10), { ...opts, isRestDay: true })
    check('休息日语气更松', rest.includes('休息日') && rest.includes('心情比较松'), true)
    /* 任何时段都不该出现城市名（淡化异地） */
    let noCity = true
    for (const h of [3, 9, 14, 23]) if (timeContextFor(new Date(2026, 8, 21, h), opts).includes('香港')) noCity = false
    check('时间块不提城市', noCity, true)

    /* 休闲活动要具体（用户反馈：原来整天上课太苦） */
    const leisure = ['看剧', '游戏', '咖啡', '桌球', '电影']
    const afternoon = at(15)
    check('午后列出具体休闲活动', leisure.filter((k) => afternoon.includes(k)).length >= 3, true)
    check('不再满口作业', afternoon.includes('做作业'), false)

    /* 不传作息时也要能生成（相关设置可能为空） */
    const bare = timeContextFor(new Date(2026, 8, 21, 10))
    check('无作息也能生成', bare.includes('当前时间') && !bare.includes('他在上班'), true)

    /* 接进 system 提示词：必须在人设之前，且人设完整保留 */
    const chatSettings = { ...DEFAULT_SETTINGS, chatPersona: 'yuki' }
    const cfg = resolveChatConfig(chatSettings, [], { now: new Date(2026, 8, 21, 9, 10), ...opts })
    check('时间块在 system 里', cfg.systemPrompt.includes('当前时间'), true)
    /*
     * 顺序：人设在前、时间块在后。这是刻意的（前缀缓存），不是笔误 ——
     * 见 chat.js 的 composeSystemPrompt。
     */
    check('人设在时间块之前（缓存友好）', cfg.systemPrompt.indexOf('你叫 Yuki') < cfg.systemPrompt.indexOf('当前时间'), true)
    check('人设未被破坏', cfg.systemPrompt.includes('不黏人'), true)
    check('9 点的 system 禁午饭', cfg.systemPrompt.includes('不要提吃午饭'), true)

    /* withClock:false 用于自检等场景，必须能关掉 */
    const noClock = resolveChatConfig(chatSettings, [], { withClock: false })
    /*
     * 注意不能断言「不含『当前时间』」：人设正文里就写着
     * 「系统会在对话开头给你『当前时间』」这句说明，会误命中。
     * 用严格相等比对才是准确的口径。
     */
    check('可关闭时间块', noClock.systemPrompt, CHAT_PERSONAS[0].prompt)
    check('关掉后不带时间块标题', noClock.systemPrompt.startsWith('【当前时间'), false)

    /* 自定义人设也要带时间上下文（chatPersona 必须指向它才会被选中） */
    const custom = resolveChatConfig({ ...chatSettings, chatPersona: 'c1' }, [{ id: 'c1', prompt: '我是自定义人设' }], {
      now: new Date(2026, 8, 21, 9, 10),
      ...opts,
    })
    check('自定义人设被选中', custom.personaId, 'c1')
    check('自定义人设也带时间', custom.systemPrompt.includes('当前时间'), true)
    check('自定义人设保留', custom.systemPrompt.includes('我是自定义人设'), true)
  }
  /* ---------- 20. 解锁条件不能被随口一句触发 ---------- */
  {
    /*
     * 两条实测报过的问题：
     *   ① 只叫了一下她的名字（如「yuki 好乖」）就解锁了视频 ——
     *      根因是视频关键词里残留单字（"乖"）与泛词（"可爱"），
     *      而发型那次只收紧了装扮、漏了视频。
     *   ② 「清晨刚醒」那段 anytime 都解锁 —— 根因是数据里写了
     *      `hoursBefore`，判定里却没实现，条件形同虚设。
     *
     * 这里按「会被误触发」和「条件必须真的生效」两个角度守住。
     */
    const { videoKeywordCandidates, videoConditionUnlocks } = await import('../src/shared/videoStories.js')

    /* ① 单字/泛词不能再当关键词 */
    const tooShort = []
    for (const [slug, d] of Object.entries(VIDEO_STORIES)) {
      for (const k of d.keywords ?? []) {
        if (k.length <= 1) tooShort.push(slug + ':' + k)
      }
    }
    check('视频关键词无单字（易误命中）', tooShort, [])

    /* ② 叫名字 + 泛泛的情绪词不该命中 */
    for (const t of ['yuki', 'yuki 好乖', 'yuki 你好可爱', '在吗 yuki']) {
      check(`「${t}」不该触发视频`, videoKeywordCandidates(t, []), [])
    }

    /* ③ 具体的请求必须能命中（别收得太死导致永不触发） */
    check('「摸摸头」能命中', videoKeywordCandidates('摸摸头', []).length > 0, true)
    check('「穿旗袍给我看」能命中', videoKeywordCandidates('穿旗袍给我看', []).length > 0, true)

    /* ④ 时段条件必须真的生效 —— hoursBefore 曾漏实现 */
    check('凌晨 2 点不触发「睡裙晚安」(23点后)', videoConditionUnlocks({ hour: 2, points: 0 }, []).includes('pajamas-goodnight'), false)
    check('中午 12 点不触发「清晨刚醒」(11点前)', videoConditionUnlocks({ hour: 12, points: 0 }, []).includes('morning-awake'), false)
    check('早上 8 点触发「清晨刚醒」', videoConditionUnlocks({ hour: 8, points: 0 }, []).includes('morning-awake'), true)
    check('晚上 23 点触发「睡裙晚安」', videoConditionUnlocks({ hour: 23, points: 0 }, []).includes('pajamas-goodnight'), true)

    /* ⑤ 已解锁的不再重复给 */
    check('已解锁的不重复', videoConditionUnlocks({ hour: 8, points: 0 }, ['morning-awake']).includes('morning-awake'), false)

    /*
     * ⑥ story 必须进判断提示词。
     *
     * 它一度只用于图鉴展示，模型看不到 —— 于是「演到哪一幕」全靠 hint 猜，
     * 用户精心写的剧情完全没起作用。装扮和视频两份提示词都曾漏掉。
     */
    const { buildVideoJudgePrompt } = await import('../src/shared/videoStories.js')
    const { buildStoryJudgePrompt } = await import('../src/shared/outfitStories.js')

    const vp = buildVideoJudgePrompt([{ role: 'user', content: 'hi' }], ['headpat'], 'casual')
    check('视频提示词含剧情', vp.includes(VIDEO_STORIES.headpat.story), true)

    const op = buildStoryJudgePrompt([{ role: 'user', content: 'hi' }], ['jk'], 'jk')
    check('装扮提示词含剧情', op.includes(OUTFIT_STORIES.jk.story), true)
    /* 当前穿着仍要标注（别在加剧情时把这行弄丢） */
    check('装扮提示词仍标注当前穿着', op.includes('她此刻正穿着这套'), true)
  }
} catch (err) {
  failures++
  console.error('✗ 运行异常:', err)
} finally {
  try {
    await service.close()
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} 通过`)
process.exit(failures > 0 ? 1 : 0)
