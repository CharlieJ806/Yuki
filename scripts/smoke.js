/**
 * 冒烟测试 —— 直接在 Node 里跑主进程服务层，不依赖 Electron。
 * 验证：摸鱼收入换算、打卡幂等、等级推进、设置持久化。
 * 用法: node scripts/smoke.js
 */
import { existsSync, readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createService, REPLY_SEGMENT_GAP_MS } from '../src/main/service.js'
import { openStore } from '../src/main/store.js'
import { toDateKey, isRestDay, levelOf, todaySnapshot, workDaysInMonth, timeContextFor, dayPartOf } from '../src/shared/moyu.js'
import { isCacheFresh } from '../src/main/holiday.js'
import { OUTFIT_STORIES, conditionUnlocks, OUTFIT_MIN_POINTS, outfitMinPoints } from '../src/shared/outfitStories.js'
import { PHOTO_SLUGS, photoFiles } from '../src/shared/photoStories.js'
import { GALLERY_KINDS, GALLERY_KEYS } from '../src/shared/gallery.js'
import { pickChatBackground, rotateIntervalMs } from '../src/shared/chatBackground.js'
import {
  tapLineCount,
  tapTier,
  TAP_LINES,
  pickFromBag,
  resetBags,
} from '../src/shared/tapLines.js'
import { buildChatterRequest, nextChatterDelay, cleanChatter } from '../src/shared/chatter.js'
import { ChatBackgroundMode } from '../src/shared/moyu.js'
import {
  buildPhotoMessages,
  isPhotoMessage,
  photoCandidates,
  photoPathAt,
  photoPathsOf,
  MAX_PHOTOS_PER_OUTFIT,
} from '../src/shared/photoMessage.js'
import { OUTFIT_LOOKS, ORIENTATIONS, PER_SHEET, PHOTO_SHOTS, buildSheetBody, shotsByOrient } from './gen-photos.js'
import { normalizeForRequest, textOfContent, splitReplySegments, livePreviewOf, MSG_SPLIT_TOKEN } from '../src/shared/content.js'
import { SCHEMA, WIPE_TABLES } from '../src/shared/db-schema.js'
import { resolveChatConfig } from '../src/main/chat.js'
import { CHAT_PERSONAS, DEFAULT_SETTINGS } from '../src/shared/moyu.js'
import {
  LINES,
  pickLine,
  affinityLevel,
  affinityGain,
  AFFINITY_GAIN,
  AFFINITY_MAX_POINTS,
  AFFINITY_LEVELS,
  AFFINITY_DAILY_CAP,
  AFFINITY_DECAY,
  affinityDecay,
  settleAffinity,
  isUpsetting,
  linesFor,
  hoverLinesFor,
  idleIntervalScale,
  idlePosesFor,
  idleCandidatesFor,
  IDLE_POSES_BY_VOICE,
  OUTFITS,
  OUTFIT_SLUGS,
  DEFAULT_OUTFIT,
  outfitFile,
  outfitForTime,
  outfitInfo,
  poseImageFile,
  weightedPool,
  pickRotation,
  resolveRotationPool,
  rotationCandidatesFor,
  outfitUnlockTierName,
  affinityView,
  rotateDelayMs,
  clampRotateMin,
  ROTATE_MIN_MIN,
  ROTATE_MIN_MAX,
  DEFAULT_ROTATE_MIN,
  TIRED_POSE_WEIGHT,
  TIRED_POSES,
  contextualScene,
  expressionFile,
  MOOD_KEYS,
  EMOTE_KEYS,
  EMOTE_FOR,
  PET_EXPRESSIONS,
  PET_EXPRESSIONS_KEYS,
  CHAT_ACTION_RULES,
  chatActionFor,
  IDLE_POSES,
  ALL_IDLE_POSES,
  IDLE_POSE_LABELS,
  sanitizeChatter,
  recentDialogueMessages,
} from '../src/shared/interactions.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT_PUBLIC = join(ROOT, 'src', 'renderer', 'public')

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
  check('待同步集含 personas', Array.isArray(pending.personas), true)
  const pendingCheckinBefore = pending.checkins[0]
  await service.markSynced({ checkins: pending.checkins.map((c) => c.id) })
  check('标记后打卡无待同步', (await await service.pendingChanges()).checkins.length, 0)
  const markedRow = (await service.listCheckins()).find((c) => c.id === pendingCheckinBefore.id)
  check('标记同步不改写 updatedAt', markedRow.updatedAt, pendingCheckinBefore.updatedAt)
  let threwOnUnknownTable = false
  try {
    await service.markSynced({ 'settings; DELETE FROM checkins --': ['x'] })
  } catch {
    threwOnUnknownTable = true
  }
  check('markSynced 表名白名单', threwOnUnknownTable, true)

  /* ---------- 9. schema 迁移（user_version / 软删唯一索引） ---------- */
  const legacyPath = join(dir, 'legacy.db')
  {
    /* 手工造一个 v1 形态的旧库：列级 UNIQUE + 一条已软删的打卡 */
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec(`CREATE TABLE checkins (
      id        TEXT PRIMARY KEY,
      dateKey   TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL,
      note      TEXT,
      updatedAt INTEGER NOT NULL,
      deletedAt INTEGER,
      syncState TEXT NOT NULL DEFAULT 'local'
    );`)
    const legacyTs = Date.parse('2025-06-03T10:00:00')
    legacy
      .prepare(
        "INSERT INTO checkins (id, dateKey, createdAt, note, updatedAt, syncState) VALUES ('legacy-1', '2025-06-03', ?, NULL, ?, 'synced')",
      )
      .run(legacyTs, legacyTs)
    legacy.prepare("UPDATE checkins SET deletedAt = ? WHERE id = 'legacy-1'").run(legacyTs)
    legacy.close()
  }
  const legacyStore = openStore(legacyPath)
  check('旧库迁移后 user_version=2', legacyStore.db.prepare('PRAGMA user_version').get().user_version, 2)
  check('迁移保留旧数据行', legacyStore.db.prepare('SELECT COUNT(*) AS n FROM checkins').get().n, 1)
  check('软删日期可重新打卡（partial unique）', legacyStore.addCheckin('2025-06-03').created, true)
  let liveDateStillUnique = false
  try {
    legacyStore.db
      .prepare("INSERT INTO checkins (id, dateKey, createdAt, updatedAt, syncState) VALUES ('dup', '2025-06-03', 0, 0, 'pending')")
      .run()
  } catch {
    liveDateStillUnique = true
  }
  check('未删除日期仍唯一', liveDateStillUnique, true)
  legacyStore.close()

  const freshStore = openStore(join(dir, 'fresh.db'))
  check('新库 user_version=2', freshStore.db.prepare('PRAGMA user_version').get().user_version, 2)
  freshStore.close()

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
  /* state 快照广播到全部窗口，必须脱敏；全量读取仅供设置页按需调用 */
  check('state 快照不携带 API Key 原文', (await await service.getState()).settings.chatApiKey, undefined)
  check('getSettings 全量仍含原文', (await service.getSettings()).chatApiKey, 'sk-test')
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

  /* ---------- 15. 偷偷摸摸模式（伪装在数据出口统一生效） ---------- */
  {
    const { formatStudyProgress, surfaceText, STUDY_DAILY_WORDS } = await import('../src/shared/disguise.js')

    /* 纯函数换算 */
    check('学习换算：零收入零词', formatStudyProgress(0, 1000), '0 词')
    check('学习换算：线性对齐进度', formatStudyProgress(518.5, 1037), '500 词')
    check('学习换算：日薪为零保守封顶', formatStudyProgress(500, 0), '500 词')
    check('学习换算：超额封顶', formatStudyProgress(99999, 0), `${STUDY_DAILY_WORDS} 词`)

    /* 词汇表本身不得含敏感字样（含语录与托盘函数产物） */
    const study = surfaceText(true)
    const studyVisible = [
      study.earnedTitle, study.working, study.done, study.doneShort, study.restDay,
      study.beforeWork, study.disabled, study.earnedLabel, study.workedLabel,
      study.totalLabel, study.incomeDetail, study.brand, study.tagline,
      ...study.heroQuotes,
      study.trayEarned('432 词'),
      study.trayTotal(3, '摸鱼学徒'),
    ].join('\n')
    check('伪装词汇表无摸鱼/已赚/货币符号', /摸鱼|已赚|[¥$]/.test(studyVisible), false)
    check('伪装托盘等级名学习化', study.trayTotal(3, '摸鱼学徒').includes('学习学徒'), true)

    /* state 出口：三个文本字段全部转换 */
    await service.updateSettings({ studyDisguise: true })
    const disguised = await await service.getState(afternoon)
    check('伪装下收入文案为学习词数形态', /^\d+ 词$/.test(disguised.todayEarnedText), true)
    check('伪装换算与进度线性对齐', disguised.todayEarnedText, `${Math.round(disguised.snapshot.progress * STUDY_DAILY_WORDS)} 词`)
    check('伪装下日薪转为今日目标', disguised.dailySalaryText, `${STUDY_DAILY_WORDS} 词`)
    check('伪装下月薪打码', disguised.salaryText, '***')

    await service.updateSettings({ studyDisguise: false })
    const normal = await await service.getState(afternoon)
    check('关闭伪装恢复金额显示', /^¥/.test(normal.todayEarnedText), true)
    check('关闭伪装日薪恢复金额', /^¥/.test(normal.dailySalaryText), true)
  }

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

    /* ---------- 挂机姿态：不再分档，一开始就全给 ---------- */
    {
      const voices = ['stranger', 'familiar', 'friend', 'close', 'intimate']
      /*
       * 用户要求「动作初始全都可用」。
       *
       * 早先是按亲密档位阶梯解锁的（最低档只有 4 个动作），
       * 现在每个档位都返回全集、且不再随关系变化。
       * 动作本身没有「私密」语义 —— 打哈欠和比心不该分亲疏；
       * 真正该按解锁走的是**服饰**那一侧。
       */
      const counts = voices.map((v) => idlePosesFor(v).length)
      check('每档动作数一致（不再分档）', new Set(counts).size, 1)
      check('初始就给全部动作', counts[0], ALL_IDLE_POSES.length)
      check('全集含深夜那几张', ALL_IDLE_POSES.includes('yawn') && ALL_IDLE_POSES.includes('sleep'), true)

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

      check('未知档位也返回全集（不分档了）', idlePosesFor('nope').length, ALL_IDLE_POSES.length)

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
      check('服饰文件名带 outfit 前缀', outfitFile(DEFAULT_OUTFIT).startsWith('yuki-outfit-'), true)
      check('服饰与动作命名空间不重叠', OUTFIT_SLUGS.some((s) => PET_EXPRESSIONS[s]) , false)

      /*
       * 服饰**不再按关系档位分层** —— 「能不能穿」由图鉴的已解锁清单决定
       * （照片发过了才算），亲密度只决定「够不够格去触发」。
       * 原来这里有一整组 outfitsFor 的档位断言，随那张手写表一起删了。
       */

      /* 挂机候选 = 动作 + 传入的已解锁服饰，且服饰带可辨识前缀 */
      const intimate = idleCandidatesFor('intimate', OUTFIT_SLUGS)
      check('候选含动作', intimate.includes('snack'), true)
      check('候选含服饰且带前缀', intimate.includes(`outfit:${DEFAULT_OUTFIT}`), true)
      check('候选总数 = 动作 + 服饰', intimate.length, idlePosesFor('intimate').length + OUTFIT_SLUGS.length)
      /* 没给清单就没有服饰可换 —— 不是「回落到档位近似」 */
      check('不给解锁清单就没有服饰', idleCandidatesFor('intimate').some((k) => k.startsWith('outfit:')), false)

      /* 候选 -> 文件名：前缀决定取图逻辑 */
      check('动作候选解析', poseImageFile('snack'), 'yuki-snack.png')
      check('服饰候选解析', poseImageFile(`outfit:${DEFAULT_OUTFIT}`), `yuki-outfit-${DEFAULT_OUTFIT}.png`)
      /* 未知输入必须安全回落，不能拼出不存在的路径 */
      check('未知候选回落默认', poseImageFile('nope'), expressionFile('idle'))
      check('空候选回落默认', poseImageFile(''), expressionFile('idle'))
      check('未知名服饰回落默认', outfitFile('nope'), outfitFile(DEFAULT_OUTFIT))

      /*
       * 自动换装：**从已解锁池里随机，不看时段**。
       *
       * 早先是「时段适配表」（深夜睡衣 / 白天常服），用户明确要求改掉。
       * 所以这里反过来断言：**任何时刻都可能穿到任何一套**，
       * 包括凌晨穿 JK —— 那正是要的行为，不是 bug。
       */
      const at = (h) => outfitForTime(new Date(2026, 8, 21, h, 0))
      check('无解锁清单时回落默认', at(3), DEFAULT_OUTFIT)

      /* 任何时刻都必须返回合法 slug，否则界面会拿到 404 图 */
      let allValid = true
      for (let h = 0; h < 24; h++) if (!OUTFIT_SLUGS.includes(outfitForTime(new Date(2026, 8, 21, h, 0), OUTFIT_SLUGS))) allValid = false
      check('24 小时都能返回合法服饰', allValid, true)

      /*
       * 不能有**时段偏向**：把所有时段扫一遍，应该出现多套而不是恒同一套。
       * 这条是「不再跟随时间」的正面证据 —— 若哪天有人把时段适配加回来，
       * 凌晨那批会退化成睡衣，这里就会红。
       */
      {
        const fresh = OUTFIT_SLUGS.slice()
        const seen = new Set()
        for (let h = 0; h < 24; h++) seen.add(outfitForTime(new Date(2026, 8, 21, h, 0), fresh))
        check('不同时片会换到不同套（真的在轮）', seen.size > 1, true)
      }

      /*
       * 传入解锁清单时同样必须返回合法 slug。
       *
       * 曾经踩过：散列最后一步 `h32 ^ (h32 >>> 16)` 返回**有符号 int32**，
       * 取模得到负索引 -> `pool[-17]` = undefined -> 换装静默失效。
       * 上面那条只覆盖「不给清单」的回落路径，覆盖不到这个分支。
       */
      let poolValid = true
      const badHours = []
      for (let h = 0; h < 24; h++) {
        const got = outfitForTime(new Date(2026, 8, 24, h, 0), OUTFIT_SLUGS)
        if (!OUTFIT_SLUGS.includes(got)) { poolValid = false; badHours.push(h) }
      }
      check('给了清单也必须返回合法服饰', badHours, [])

      /*
       * **同一时间片内必须稳定**（不闪）。
       *
       * 这条最要紧：`outfitForTime` 是在 computed 里调的，每次依赖变化都会重算。
       * 如果实现里用了 `Math.random()`，立绘和标签会在重渲染时乱跳 ——
       * 那种 bug 只在界面上看得见，单测不写这条就防不住。
       */
      const slot = 30 * 60 * 1000
      const t0 = new Date(2026, 8, 24, 14, 0, 0).getTime()
      check('同一时间片内稳定', outfitForTime(new Date(t0), OUTFIT_SLUGS) === outfitForTime(new Date(t0 + slot - 1), OUTFIT_SLUGS), true)
      /* 跨片才换 —— 用固定片长扫一整天，应出现多套 */
      {
        const seen = new Set()
        for (let i = 0; i < 48; i++) seen.add(outfitForTime(new Date(t0 + i * slot), OUTFIT_SLUGS))
        check('跨时间片会变', seen.size > 1, true)
      }
      /*
       * 片长可覆盖（调用方想换更快的节奏时用）。
       *
       * 不能只断言「返回 string」—— 那个恒真，`slotMs` 整份忽略也照样绿
       * （参数删掉、或实现里写死 30 分钟，都测不出来）。
       * t0 = 14:00 起这 20 分钟**全落在同一个 30 分钟片内**：
       * 传了片长则每一分钟都是一片，结果会出现多套；
       * 忽略第三个参数时只会得到 1 个值。
       */
      const shortSlots = new Set()
      for (let i = 0; i < 20; i++) shortSlots.add(outfitForTime(new Date(t0 + i * 60_000), OUTFIT_SLUGS, 60_000))
      check('片长参数生效', shortSlots.size > 1, true)

      /* 返回的必须是**解锁池里的**那几套，不能跑到池外 */
      const small = ['jk', 'pajamas']
      let poolBound = true
      for (let h = 0; h < 24; h++) {
        if (!small.includes(outfitForTime(new Date(2026, 8, 24, h, 0), small))) poolBound = false
      }
      check('换装结果不超出解锁池', poolBound, true)

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
         *
         * 换装写入逻辑收敛进 lib/outfit-state.js（useOutfitState）之后，
         * 对话窗/立绘窗组件里不再直接写 outfitMode：入口存在性的充分证据
         * 是「组件引用了 useOutfitState」（解构出 outfits/chooseOutfit 供
         * 模板使用），所以两种形态任一命中即算入口在。
         */
        const hasWrite = /outfitMode\s*[:=]\s*'fixed'/.test(src)
        const usesShared = /useOutfitState/.test(src)
        if (!hasWrite && !usesShared) entriesMissing.push(label)
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

      /*
       * 同一条纪律，推广到 @shared/interactions.js 的**全部**导出。
       *
       * 为什么必须单独加：上面那条只硬编码了 6 个 store 函数，
       * 于是 `weightedPool` 漏导入活了下来 —— 它在深夜分支里被调用，
       * 但没人跑得到（单测不渲染 .vue），Vite 也不报（自由变量在 ESM 里
       * 只在**执行到**那一行才抛）。
       * 症状是「每天 23:00–09:00 桌宠的挂机轮换整个停住」，
       * 且因为异常抛在重排定时器**之前**，一次就再也接不上，
       * 必须重启进程。靠人眼看 import 列表是防不住的。
       */
      const interactionsExports = Object.keys(await import('../src/shared/interactions.js'))
      /* 渲染层里所有 .vue（不只上面那几个）都要查 */
      const vueFiles = files.concat([
        'src/renderer/src/chat/ChatPetApp.vue',
        'src/renderer/src/components/Sidebar.vue',
        'src/renderer/src/pet/PetMenu.vue',
        'src/renderer/src/panel/PanelApp.vue',
        'src/renderer/src/views/GalleryView.vue',
        'src/renderer/src/views/HomeView.vue',
        'src/renderer/src/views/LabView.vue',
      ]).filter((f, i, a) => a.indexOf(f) === i && existsSync(join(root, f)))

      const missingImports = []
      for (const rel of vueFiles) {
        const src = readFileSync(join(root, rel), 'utf8')
        const m = /<script setup>([\s\S]*?)<\/script>/.exec(src)
        let script = m ? m[1] : src
        /* 去掉注释与字符串字面量，避免注释里的函数名被当成调用 */
        script = script
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/`(?:[^`\\]|\\.)*`/g, '``')
          .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
          .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')

        const imported = new Set()
        for (const im of script.matchAll(/import\s*\{([^}]+)\}/g)) {
          for (const raw of im[1].split(',')) {
            const name = raw.trim().split(/\s+as\s+/).pop().trim()
            if (name) imported.add(name)
          }
        }
        /* 本地声明过的名字（const/let/function）不算缺导入 */
        const local = new Set()
        for (const d of script.matchAll(/(?:const|let|function)\s+([A-Za-z_$][\w$]*)/g)) local.add(d[1])

        for (const name of interactionsExports) {
          const called = new RegExp(`(^|[^.\\w])${name}\\s*\\(?`, 'm').test(script)
          if (called && !imported.has(name) && !local.has(name)) missingImports.push(`${rel}: ${name}`)
        }
      }
      check('interactions 导出用而未导入（防 ReferenceError）', missingImports, [])
    }

    /* ---------- 对话窗必须在配置变化时重拉状态 ---------- */
    {
      /*
       * `chatStatus` 只算一次存在 `store.chat.status` 里，而设置保存广播的
       * `state` **不含** chat.status（getState 没有这个字段）。
       * 窗口又是「只 hide 不销毁」的，重新打开走 `chatWindow.show()`
       * 而**不重新加载页面**，`onMounted` 不会再跑。
       *
       * 于是有条极隐蔽的断链：开着对话窗 → 去设置填 API Key → 回来
       * → 对话窗仍以为没填，`status.ready` 为假 → **输入框整个被禁用**，
       * 表现成「明明填了却说未填写，而且打不了字」。
       *
       * 这条断言把「watch 列表要覆盖 validateConfig 的判定依据」钉住：
       * 将来 validateConfig 新增一个决定 ok 的设置项时，这里会红。
       */
      const chatPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src/renderer/src/chat/ChatApp.vue')
      const chatSrc = readFileSync(chatPath, 'utf8')
      const chatWatch = /watch\(\s*\(\)\s*=>\s*\[([\s\S]*?)\]/.exec(chatSrc)
      const watched = chatWatch ? chatWatch[1] : ''
      /* validateConfig 判 ok/reason 只看这两个；chatModel 决定标题文案 */
      const notWatched = ['chatApiKey', 'chatBaseUrl', 'chatModel'].filter((k) => !watched.includes(k))
      check('对话窗监听了决定可用性的设置', notWatched, [])
      /*
       * 注意要连 `addEventListener('` 一起匹配：ChatApp 的**注释里**就出现过
       * `visibilitychange` 这个词，只测裸词的话监听真被删掉也照样绿。
       */
      check('对话窗在窗口重新可见时也刷新', /addEventListener\('visibilitychange'/.test(chatSrc), true)
      /* 只挂 visibilitychange 不够：Chromium 在 hide/show 路径上不保证派发它，
         而 createChatWindow 对已存在窗口做的是 show()+focus() */
      check('对话窗在窗口重新聚焦时也刷新', /addEventListener\('focus'/.test(chatSrc), true)
      check(
        '设置保存后主动重算对话可用性',
        /refreshChatStatus\(\)\.catch\(\(\) => \{\}\)/.test(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/renderer/src/stores/app.js'), 'utf8')),
        true,
      )
    }

    /* ---------- 流式占位不能早撤 ---------- */
    {
      /*
       * 「回复的瞬间看不见」的根因是一条**时序**约束：
       * 撤掉 liveText 占位和「最终消息 push 进 messages」必须是同一个时刻。
       * 分开做就露出一段两边都没有的空窗。
       *
       * 这条约束没法用普通单测覆盖（在渲染层、依赖事件时序），
       * 所以用源码级断言把结构钉住 —— 这个仓库已有同类先例
       * （导入守卫、广播窗口守卫）。
       */
      const storeSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/renderer/src/stores/app.js'), 'utf8')

      /* 清 streaming 的地方只能有一处（settleStream），否则必然有人抢跑 */
      const clearSites = [...storeSrc.matchAll(/store\.chat\.streaming\s*=\s*false/g)].length
      check('撤流式占位只有一处', clearSites, 1)

      /* 那唯一一处必须在 settleStream 里 */
      const settleFn = /function settleStream\(\)\s*\{([\s\S]*?)\n\}/.exec(storeSrc)
      check('撤占位集中在 settleStream', Boolean(settleFn) && /streaming\s*=\s*false/.test(settleFn[1]), true)

      /* 入队要能带落地回调 */
      check('enqueueMessage 支持落地回调', /function enqueueMessage\(message, onLanded/.test(storeSrc), true)

      /*
       * 回调必须在 push **之后** —— 顺序反了等于没修，
       * 而且是那种「看起来改了、实际没生效」的错。
       */
      const pushIdx = storeSrc.indexOf('store.chat.messages.push(next)')
      const cbIdx = storeSrc.indexOf('entry.onLanded?.()')
      check('落地回调排在 push 之后', pushIdx >= 0 && cbIdx > pushIdx, true)

      /* chat-done 的兜底不能无条件撤 */
      check('chat-done 兜底受队列长度约束', /if \(!pendingQueue\.length\) settleStream\(\)/.test(storeSrc), true)
    }

    /* ---------- 两端图鉴的「看大图」必须都是全屏 ---------- */
    {
      /*
       * 桌面端原来是一张 **380px 窄卡片里最高 300px** 的图，移动端却是全屏 ——
       * 同一个功能两端观感差一大截，用户会问「为什么这边看不清」。
       *
       * 这条断言把「查看大图 = 全屏」钉住：谁把其中一端改回小卡片，这里就红。
       * 只断言**全屏**这个本质，不管具体用 flex 还是 grid、有没有工具条 ——
       * 那些是实现细节，各端本来就该按平台习惯不同。
       */
      const rroot = join(dirname(fileURLToPath(import.meta.url)), '..')
      const desktopGallery = readFileSync(join(rroot, 'src/renderer/src/views/GalleryView.vue'), 'utf8')
      const mobileCss = readFileSync(join(rroot, 'mobile/style.css'), 'utf8')

      /* 抓 `.viewer { ... }` 规则体 */
      const ruleBody = (src, sel) => {
        const m = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(src)
        return m ? m[1] : ''
      }
      const isFullscreen = (body) => /position:\s*fixed/.test(body) && /inset:\s*0/.test(body)

      check('桌面图鉴查看器是全屏', isFullscreen(ruleBody(desktopGallery, '.viewer')), true)
      check('移动图鉴查看器是全屏', isFullscreen(ruleBody(mobileCss, '.viewer')), true)

      /*
       * 图必须能吃到整个图区高度。
       * `max-height: 100%` 而不是写死 px —— 写死就是「小图」的根因。
       */
      check('桌面大图不限死高度', /max-height:\s*100%/.test(ruleBody(desktopGallery, '.viewer-img')), true)
      check('移动大图不限死高度', /max-height:\s*100%/.test(ruleBody(mobileCss, '.viewer-img')), true)

      /* 桌面是键鼠环境，Esc / 方向键该能用 */
      check('桌面查看器支持 Esc 关闭', /key === 'Escape'/.test(desktopGallery), true)
      check('桌面查看器支持方向键翻页', /ArrowLeft/.test(desktopGallery) && /ArrowRight/.test(desktopGallery), true)
      /* 键盘监听必须解绑，否则反复进出图鉴页会累积监听 */
      check('键盘监听有解绑', /removeEventListener\('keydown'/.test(desktopGallery), true)
    }

    /* ---------- 手机端聊天背景不能再用 attachment:local ---------- */
    {
      /*
       * 实测（CDP 在真实页面上量的）：`.msgs` 可见高 604px、可滚动内容 4266px。
       * `background-attachment: local` 会把「背景定位区」变成**可滚动溢出区**，
       * 而 `cover` 按定位区缩放 —— 照片被放大 7 倍，只剩一块无法辨认的色块。
       *
       * 顺带：原来那层 `::before` 遮罩是滚动容器内的绝对定位元素，
       * **会跟着内容一起滚**（实测滚 300px、遮罩位移 300px），
       * 所以聊天一长下半段就没遮罩了。现在遮罩并进背景层解决。
       *
       * 这条断言把两个坑都钉住：不能再出现 `local`，且遮罩必须还在
       * （并进背景层，用 color-mix 生成半透明底色渐变）。
       */
      const mroot = join(dirname(fileURLToPath(import.meta.url)), '..')
      const mcss = readFileSync(join(mroot, 'mobile/style.css'), 'utf8')
      const body = (() => {
        const m = /\.msgs\.has-bg\s*\{([^}]*)\}/.exec(mcss)
        return m ? m[1] : ''
      })()
      check('聊天背景不用 attachment:local', /background-attachment:\s*local/.test(body), false)
      check('聊天背景遮罩并进背景层', /linear-gradient\(var\(--bg-mask\)/.test(body), true)
      check('遮罩色由 color-mix 生成', /color-mix\(/.test(body), true)
      /* 遮罩 alpha 必须跟随 --bg-opacity，否则「背景浓淡」滑杆会失效 */
      check('遮罩 alpha 跟随 --bg-opacity', /--bg-opacity/.test(body), true)
    }

    /* ---------- 多段回复的拆分 ---------- */
    {
      /*
       * 跨模块的两个字面量必须守住不等式。
       *
       * 主进程落库时按 `REPLY_SEGMENT_GAP_MS` 把相邻两条的时间戳错开，
       * 渲染层的错峰队列按 `STAGGER_MAX_MS` 判定「这是她在连发」并递延显示。
       * 间隔一旦不小于窗口，每条都会被当成「普通对话」立即弹出 ——
       * 多段回复的逐条出现彻底失效，而两侧单独看都完全正常、不报任何错。
       * 实测把 1200 改成 5000，原有那批断言依旧全绿，所以必须专门钉住。
       *
       * `stores/app.js` 是 Vue 渲染层模块（`import { reactive } from 'vue'` +
       * `@shared` 别名），smoke 在 Node 里 import 不了，只能读源码抽数字：
       * 常量改名/删掉时正则抽不到 → `NaN` → 下面第一条直接红，不会静默放过。
       */
      {
        const appStoreSrc = readFileSync(join(ROOT, 'src/renderer/src/stores/app.js'), 'utf8')
        const staggerMatch = /export const STAGGER_MAX_MS\s*=\s*(\d+)/.exec(appStoreSrc)
        const staggerMaxMs = staggerMatch ? Number(staggerMatch[1]) : NaN
        check('渲染层错峰窗口可读', Number.isFinite(staggerMaxMs), true)
        check('分段间隔必须落在错峰窗口内', REPLY_SEGMENT_GAP_MS < staggerMaxMs, true)
      }

      /*
       * 她可以一次生成、按多条发出。拆分的**兼容底线**是：
       * 没有标记时必须原样返回一条 —— 模型不听话、或用户用自定义人设
       * 没写这条指令时，行为要和以前一模一样。
       */
      check('无标记时原样一条', splitReplySegments('哈哈哈你好呀'), ['哈哈哈你好呀'])
      check('空输入返回空数组', splitReplySegments(''), [])
      check('纯空白返回空数组', splitReplySegments('   \n  '), [])

      check('两段拆分', splitReplySegments(`甲${MSG_SPLIT_TOKEN}乙`), ['甲', '乙'])
      check('三段拆分', splitReplySegments(`甲${MSG_SPLIT_TOKEN}乙${MSG_SPLIT_TOKEN}丙`), ['甲', '乙', '丙'])
      /* 模型偶尔会连发标记，空段必须丢掉，否则会出现空气泡 */
      check('丢弃空段', splitReplySegments(`甲${MSG_SPLIT_TOKEN}${MSG_SPLIT_TOKEN}乙`), ['甲', '乙'])
      check('首尾标记不产生空段', splitReplySegments(`${MSG_SPLIT_TOKEN}甲${MSG_SPLIT_TOKEN}`), ['甲'])
      check('全是标记则返回空', splitReplySegments(`${MSG_SPLIT_TOKEN}${MSG_SPLIT_TOKEN}`), [])
      /* 每段 trim —— 模型常在标记两侧留换行 */
      check('分段后 trim', splitReplySegments(`甲  \n${MSG_SPLIT_TOKEN}\n  乙`), ['甲', '乙'])
      /* 上限：超过 4 段只取前 4，防止刷屏 */
      const many = ['1', '2', '3', '4', '5', '6'].join(MSG_SPLIT_TOKEN)
      check('超过上限只取前 4 段', splitReplySegments(many).length, 4)
      check('上限可覆盖', splitReplySegments(many, 2).length, 2)

      /*
       * 拆条**落库**：一次生成产出 N 条，且相邻 `createdAt` 差值正好 = 分段间隔。
       *
       * 只有 `splitReplySegments` 的纯函数单测是不够的 —— 拆出来之后
       * service 是否真按 GAP 逐条写库、写库后时间戳有没有保住，
       * 才是「一条条冒出来」能否成立的关键（渲染层就是按这个差值排队的）。
       * `sendChat` 要真实 LLM，跑不了，于是分两段验：
       *   ① 源码级：service 的落库循环确实在用 `baseTs + i * REPLY_SEGMENT_GAP_MS`
       *   ② 数据级：按同一公式写进真库，条数与差值都读得回来
       * ① 挡住「公式被搬出循环」，② 挡住「store 层把时间戳吃掉了」。
       */
      {
        const segSrc = readFileSync(join(ROOT, 'src/main/service.js'), 'utf8')
        /*
         * 变量名**不固定**成 `segments`：那段代码要先做「分段全空回落原文」
         * （`const parts = segments.length ? segments : [result.content]`），
         * 循环体遍历的是 `parts`。断言真正的不变量 —— **时间戳公式** ——
         * 而不是某个局部变量叫什么，否则重构一次就误报一次。
         */
        const segLoop = /for \(const \[i, \w+\] of \w+\.entries\(\)\)\s*\{[^}]*createdAt:\s*baseTs \+ i \* REPLY_SEGMENT_GAP_MS/.exec(segSrc)
        check('service 按分段间隔逐条落库', Boolean(segLoop), true)
        /* 分段全空必须回落原文，否则她的回复会凭空消失（两端都要有） */
        check('service 分段全空回落原文', /segments\.length \? segments : \[result\.content\]/.test(segSrc), true)

        const segDir = mkdtempSync(join(tmpdir(), 'desk-seg-'))
        const segStore = openStore(join(segDir, 'seg.db'))
        const segSvc = createService(segStore)
        const segSid = (await segSvc.ensureChatSession()).id
        const segments = splitReplySegments(`甲${MSG_SPLIT_TOKEN}乙${MSG_SPLIT_TOKEN}丙`)
        const baseTs = Date.now()
        for (const [i, seg] of segments.entries()) {
          await segStore.addMessage(segSid, 'assistant', seg, { createdAt: baseTs + i * REPLY_SEGMENT_GAP_MS })
        }
        const stored = (await segStore.listMessages(segSid)).filter((mm) => mm.role === 'assistant')
        check('三段回复落库成三条', stored.length, segments.length)
        check('相邻时间戳差值 = 分段间隔', stored.slice(1).map((mm, i) => mm.createdAt - stored[i].createdAt), [
          REPLY_SEGMENT_GAP_MS,
          REPLY_SEGMENT_GAP_MS,
        ])
        await segSvc.close()
      }

      /*
       * 流式预览必须**截到第一个标记为止** —— 否则生成过程中
       * 用户会在气泡里看到 `甲<<<MSG>>>乙` 这种原始文本，
       * 标记直接暴露，生成完又重排一次，观感很跳。
       */
      check('预览无标记时是全文', livePreviewOf('哈哈哈你好呀'), '哈哈哈你好呀')
      check('预览截到第一个标记', livePreviewOf(`甲${MSG_SPLIT_TOKEN}乙`), '甲')
      check('预览只有标记时为空', livePreviewOf(`${MSG_SPLIT_TOKEN}乙`), '')
      check('预览空输入为空', livePreviewOf(''), '')

      /* 拆出来的段拼回去应等于去掉标记的原文（不丢字） */
      const original = '第一句。' + MSG_SPLIT_TOKEN + '第二句！'
      check('拆分不丢内容', splitReplySegments(original).join(''), '第一句。第二句！')
    }

    /* ---------- 惹她生气必须是**净负** ---------- */
    {
      /*
       * 一轮对话被拆成两次结算：
       *   chatMessage(+2) —— 带上 upsetting
       *   chatRound(+3)   —— 聊完的额外一笔
       *
       * 踩过的坑：第二轮没带 upsetting，于是「先扣 2 再加 3」净 **+1**，
       * **骂她反而涨亲密度**。`settleAffinity` 里「生气当次加分清零」
       * 本身是对的，但抵消发生在两次调用**之间**，函数内部管不着。
       * 所以两端的调用点都得用同一个 `upsetting` 挡住 chatRound。
       */
      const base = { points: 100, lastActive: '2026-09-24', lastDay: '2026-09-24', gainDay: '2026-09-24', gainToday: 0 }

      const afterMsg = settleAffinity(base, {
        today: '2026-09-24',
        delta: AFFINITY_GAIN.chatMessage,
        upsetting: true,
      })
      check('惹她生气当次是净负', afterMsg.points < base.points, true)
      check('扣的量正好是 UPSET', base.points - afterMsg.points, AFFINITY_DECAY.UPSET)

      /* 同一轮若再补一笔 chatRound，就会把扣的分加回来 —— 这就是那个 bug 的形态 */
      const wrong = settleAffinity(afterMsg, { today: '2026-09-24', delta: AFFINITY_GAIN.chatRound })
      check('补记 chatRound 会抵消掉扣分（所以要挡住）', wrong.points > afterMsg.points, true)

      const normal = settleAffinity(base, { today: '2026-09-24', delta: AFFINITY_GAIN.chatMessage })
      check('正常一轮是净正', normal.points > base.points, true)

      /*
       * 源码级守卫：两端的 chatRound 都必须在 `upsetting` 为假时才记。
       * 纯函数测不到调用点 —— 而 bug 恰恰出在调用点。
       *
       * 必须绑到**块体**上，不能只测「文件里出现过 `!isUpsetting(text)`」：
       * 把那笔 `addAffinity(AFFINITY_GAIN.chatRound, …)` 挪到 if 之外，
       * 字符串照样在、断言照样绿，而毛病（骂她还涨点）就回来了。
       * 所以用 `[^}]*` 卡住「中间不能有关闭括号」，保证它真在同一个块里。
       */
      for (const f of ['../src/main/service.js', '../mobile/chat.js']) {
        const src = readFileSync(new URL(f, import.meta.url), 'utf8')
        const ok = /if \(!isUpsetting\(text\)\)\s*\{[^}]*AFFINITY_GAIN\.chatRound[^}]*\}/
          .test(src) || /if \(!upsetting\)\s*await bumpAffinity\('chatRound'/.test(src)
        check(`${f.split('/').pop()} 的 chatRound 受 upsetting 约束`, ok, true)
      }

      /* 口径：骂她的话要认得出；诉苦的话不能（误扣比漏判更糟） */
      check('骂她会被认出来', isUpsetting('讨厌你'), true)
      check('诉苦不算骂她', isUpsetting('今天好委屈'), false)
      check('自己的情绪不算骂她', isUpsetting('烦死了'), false)
    }

    /* ---------- 解锁门槛只有一个来源 ---------- */
    {
      /*
       * 用户的解锁逻辑：**亲密度达标 + 对话触发场景 → 发照片 → 解锁衣服**。
       * 其中「亲密度达标」对所有解锁类型都必须成立。
       *
       * 踩过的坑：`conditionUnlocks` 原来读的是故事对象自己的
       * `condition.minPoints`，而 `pajamas` 那条写的是 `{hoursAfter:23}`、
       * 压根没有 minPoints 字段 —— 于是**过了 23 点就无条件送睡裙**，
       * 哪怕亲密度是 0，而表里它标的是 300（最私密那一档）。
       *
       * 根因是门槛有两个来源。现在统一到 `OUTFIT_MIN_POINTS`。
       */
      const lowNight = conditionUnlocks({ points: 0, hour: 23, isRestDay: false }, [])
      check('低亲密度深夜不解锁睡裙', lowNight.includes('pajamas'), false)

      const highNight = conditionUnlocks(
        { points: OUTFIT_MIN_POINTS.pajamas, hour: 23, isRestDay: false },
        [],
      )
      check('亲密度够+深夜才给睡裙', highNight.includes('pajamas'), true)

      /* 亲密度够了但时段不对，仍然不给 —— 两个条件必须同时成立 */
      const highDay = conditionUnlocks({ points: OUTFIT_MIN_POINTS.pajamas, hour: 12, isRestDay: false }, [])
      check('亲密度够但非深夜不给睡裙', highDay.includes('pajamas'), false)

      /* jk 是基准装扮：门槛 0，第一轮对话就该给 */
      check('基准装扮无条件给', conditionUnlocks({ points: 0, hour: 12, isRestDay: false }, []).includes('jk'), true)
      check('已解锁的不再给', conditionUnlocks({ points: 0, hour: 12, isRestDay: false }, ['jk']).includes('jk'), false)

      /*
       * 防回流：故事对象里**不许再出现 `condition.minPoints`**。
       * 它已经无人读取，留着就是第二个真相源 —— 下次有人改它，
       * 会以为生效了，实际一点用没有。
       */
      const offenders = Object.entries(OUTFIT_STORIES)
        .filter(([, d]) => d.condition && 'minPoints' in d.condition)
        .map(([slug]) => slug)
      check('故事对象里没有第二个门槛来源', offenders, [])

      /*
       * 每个 condition 类故事都必须真的登记在门槛表里。
       *
       * 不能断言 `Number.isFinite(outfitMinPoints(slug))` —— 它内部是
       * `OUTFIT_MIN_POINTS[slug] ?? 0`，对**任何** slug 都恒 true：
       * 新增一个 condition 类故事却忘了进表，门槛会静默变成 0（等于白送），
       * 而这条旧断言只会继续绿。
       */
      const condMissing = Object.entries(OUTFIT_STORIES)
        .filter(([, d]) => d.unlock === 'condition')
        .map(([slug]) => slug)
        .filter((slug) => !(slug in OUTFIT_MIN_POINTS))
      check('condition 类的门槛都能查到', condMissing, [])
    }

    /* ---------- 未读：她说了但我还没看 ---------- */
    {
      const udir = mkdtempSync(join(tmpdir(), 'desk-unread-'))
      const ustore = openStore(join(udir, 'u.db'))
      const usvc = createService(ustore)

      const sid = (await usvc.ensureChatSession()).id

      check('新会话未读为 0', await usvc.unread(), 0)

      /* 我自己发的不算未读 —— 只数 assistant */
      ustore.addMessage(sid, 'user', '在吗')
      check('用户消息不算未读', await usvc.unread(), 0)

      ustore.addMessage(sid, 'assistant', '在的呀')
      ustore.addMessage(sid, 'assistant', '刚下课')
      check('她说的算未读', await usvc.unread(), 2)

      await usvc.markChatRead(sid)
      check('读过之后未读清零', await usvc.unread(), 0)

      /*
       * 关键回归：多段回复的时间戳是**未来时间**（now + i×间隔）提前写好的。
       * 已读位置若取 `Date.now()`，这些消息会被判成「还没发生」而继续算未读
       * —— 表现是「点开对话窗红点也不消失」。所以必须取**最新消息的时间戳**。
       */
      ustore.addMessage(sid, 'assistant', '未来时间戳', { createdAt: Date.now() + 5000 })
      check('未来时间戳算未读', await usvc.unread(), 1)
      await usvc.markChatRead(sid)
      check('读过未来时间戳也清零', await usvc.unread(), 0)

      /* 反复打点不能把已读位置往回退（多窗口竞争） */
      const before = await usvc.markChatRead(sid)
      const again = await usvc.markChatRead(sid)
      check('重复标已读不回退', again >= before, true)

      ustore.close()
      rmSync(udir, { recursive: true, force: true })
    }

    /* ---------- ref / computed 在 script 里必须带 .value ---------- */
    {
      /*
       * 踩过的坑：`computed(() => { if (!status.ready) ... })`。
       *
       * `status` 是 ComputedRef 对象，`<script setup>` 里**没有**模板那层
       * 自动解包，所以 `status.ready` 恒为 undefined —— `!undefined` 恒真，
       * 那个 computed 永远返回「未配置」分支，用户看到的是
       * 「明明配好了 Key，输入框一直说未配置」。
       *
       * 为什么难发现：**同一个名字在模板里是对的**（模板自动解包），
       * 于是同一个元素上 `:disabled="!status.ready"` 正常、只有 placeholder 坏，
       * 看起来像响应式失效，而不是「少写了 .value」。
       *
       * 这条静态检查：把顶层的 ref/computed 名字收集起来，
       * 在 <script setup> 里凡是 `名字.属性` 且不是 `名字.value` 的都报出来。
       */
      const vueFiles = [
        'src/renderer/src/chat/ChatApp.vue',
        'src/renderer/src/chat/ChatPetApp.vue',
        'src/renderer/src/pet/PetApp.vue',
        'src/renderer/src/pet/PetMenu.vue',
        'src/renderer/src/pet/MenuApp.vue',
        'src/renderer/src/panel/PanelApp.vue',
        'src/renderer/src/components/Sidebar.vue',
        'src/renderer/src/views/SettingsView.vue',
        'src/renderer/src/views/GalleryView.vue',
        'src/renderer/src/views/HomeView.vue',
        'src/renderer/src/views/RecordsView.vue',
        'src/renderer/src/views/LabView.vue',
      ]
      const vroot = join(dirname(fileURLToPath(import.meta.url)), '..')
      const missingValue = []

      for (const rel of vueFiles) {
        const full = join(vroot, rel)
        if (!existsSync(full)) continue
        const src = readFileSync(full, 'utf8')
        const m = /<script setup>([\s\S]*?)<\/script>/.exec(src)
        if (!m) continue
        let js = m[1]
        /* 去注释与字符串，免得注释里的示例被当成代码 */
        js = js
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/`(?:[^`\\]|\\.)*`/g, '``')
          .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
          .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')

        /* 顶层 ref / computed（含 reactive 之外的响应式句柄） */
        const refs = new Set()
        for (const d of js.matchAll(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ref|computed|shallowRef)\s*\(/gm)) {
          refs.add(d[1])
        }
        if (!refs.size) continue

        for (const name of refs) {
          /*
           * 匹配 `name.xxx`，但排除 `name.value`（正确写法）、
           * `name.` 出现在对象属性访问链里的情况（如 `foo.name.bar`）。
           */
          const re = new RegExp(`(^|[^.\\w$])${name}\\.(?!value\\b)([A-Za-z_$][\\w$]*)`, 'gm')
          for (const hit of js.matchAll(re)) {
            missingValue.push(`${rel}: ${name}.${hit[2]}（应为 ${name}.value.${hit[2]}）`)
          }
        }
      }
      check('ref/computed 在 script 里都带了 .value', missingValue, [])
    }

    /* ---------- 产物目录必须排除在 app.asar 之外 ---------- */
    {
      /*
       * 踩过：重构打包脚本时新增了顶级产物目录 `release-mobile/`，
       * 只加进了 .gitignore，漏了 build.js 的 packager ignore 名单。
       * 后果是手机端启动器（200MB）整个进了 app.asar ——
       * asar 44.8MB → 369.8MB，zip 174MB → 305MB，**而且不报错**。
       *
       * 这类漏配的隐蔽点：产物目录平时不存在，连打几次都正常；
       * 只有「先跑 pack:mobile 再跑 pack」才暴露。
       *
       * 这条断言的做法：从 build.js 里把 ignore 的正则字面量抠出来，
       * 拿 .gitignore 里登记的顶层产物目录去试 —— 任何一个没被覆盖就报错。
       * 将来新增产物目录时，只要加了 .gitignore 就会在这里被提醒。
       */
      const groot = join(dirname(fileURLToPath(import.meta.url)), '..')
      const buildSrc = readFileSync(join(groot, 'scripts/build.js'), 'utf8')

      /* 抠出 ignore 数组里的正则字面量 */
      const ignoreBlock = /ignore:\s*\[([\s\S]*?)\]/.exec(buildSrc)
      const patterns = []
      if (ignoreBlock) {
        for (const m of ignoreBlock[1].matchAll(/\/((?:\\.|[^/\\])+)\/([gimsuy]*)/g)) {
          try {
            patterns.push(new RegExp(m[1], m[2]))
          } catch {
            /* 抠错的跳过，不影响其余判断 */
          }
        }
      }
      check('能解析出打包 ignore 规则', patterns.length > 0, true)

      /*
       * 候选 = .gitignore 里那些「看起来是本地产物」的顶层目录。
       * 只取**目录名不含点、且带 build/dist/release 语义**的，
       * 避免把 `docs/` 这类「该不该进包」的判断题也拉进来。
       *
       * `dist/` 要**排除在候选之外**：它虽然叫 dist，却是应用本体 ——
       * 打包后主进程就是靠 `dist/index.html` 起窗口的，必须进包。
       * 这条 allowlist 是「确实要随包分发」的产物目录白名单。
       */
      const REQUIRED_IN_PACKAGE = ['dist']
      const gi = readFileSync(join(groot, '.gitignore'), 'utf8')
      const artifactDirs = gi
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
        .map((l) => l.replace(/^\//, '').replace(/\/$/, ''))
        .filter((l) => /^[A-Za-z][\w.-]*$/.test(l))
        .filter((l) => /(^|-)(release|dist|build|out|target)/i.test(l))
        .filter((l) => !REQUIRED_IN_PACKAGE.includes(l))

      const notIgnored = artifactDirs.filter((d) => !patterns.some((re) => re.test(`/${d}/x`)))
      check('产物目录都已排除出 app.asar', notIgnored, [])
    }

    /* ---------- 聊天背景的 URL 必须是绝对路径 ---------- */
    {
      /*
       * 实测（打包版）：`--bg-image: url("photos/x.png")` 会被解析成
       * `dist/assets/photos/x.png`（404），因为自定义属性里的 url()
       * 相对**消费它的样式表**解析，而桌面端样式被编译进 `dist/assets/`。
       *
       * 只在内联样式的 dev 模式下恰好正确 —— 典型的「开发能跑、打包裂图」。
       * 所以这条断言：设置 `--bg-image` 时必须经过 `new URL(...)`。
       */
      const croot = join(dirname(fileURLToPath(import.meta.url)), '..')
      const chatSrc2 = readFileSync(join(croot, 'src/renderer/src/chat/ChatApp.vue'), 'utf8')
      check('背景 URL 经 new URL 解析成绝对路径', /--bg-image':\s*`url\("\$\{new URL\(/.test(chatSrc2), true)
      /* 不该再有裸的 url("${chatBg...}") 写法 */
      const rawUrl = /--bg-image':\s*`url\("\$\{(?!new URL)/.test(chatSrc2)
      check('背景 URL 没有裸用相对路径', rawUrl, false)
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
        const base = idleCandidatesFor(v, OUTFIT_SLUGS)
        const weighted = weightedPool(base, (k) => !k.startsWith('outfit:') && TIRED_POSES.includes(k))
        for (const k of base) if (!weighted.includes(k)) noLoss = false
      }
      check('加权不丢项（每个都还在）', noLoss, true)

      /* 模拟真实轮换：白天与深夜都必须覆盖到每一项 */
      /*
       * 这里必须用 `pickRotation` 而不是 `pickLine` ——
       * 生产路径已经换成前者（避最近三项），用旧的单项避让去模拟
       * 会让「覆盖全部项」这条断言替一个没人跑的分支背书。
       */
      const simulate = (voice, rounds, night) => {
        const base = idleCandidatesFor(voice, OUTFIT_SLUGS)
        const pool = night
          ? weightedPool(base, (k) => !k.startsWith('outfit:') && TIRED_POSES.includes(k))
          : base
        const uniq = [...new Set(pool)]
        const counts = new Map(uniq.map((k) => [k, 0]))
        let recent = []
        for (let i = 0; i < rounds; i++) {
          const n = pickRotation(pool, recent)
          counts.set(n, (counts.get(n) ?? 0) + 1)
          recent = [n, ...recent].slice(0, 3)
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
      const base = idleCandidatesFor('intimate', OUTFIT_SLUGS)
      const pool = weightedPool(base, (k) => !k.startsWith('outfit:') && TIRED_POSES.includes(k))
      const yawnCount = pool.filter((k) => k === 'yawn').length
      const outfitCount = pool.filter((k) => k === `outfit:${DEFAULT_OUTFIT}`).length
      check('困倦项被加权', yawnCount > outfitCount, true)
      check('非困倦项仍在池里', pool.includes('snack'), true)
      check('服饰不被加权', outfitCount, 1)

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
        '全解锁时候选池 = 挂机动作 + 全部服饰',
        idleCandidatesFor('intimate', OUTFIT_SLUGS).length,
        idlePosesFor('intimate').length + OUTFIT_SLUGS.length,
      )
      check('服饰表非空', OUTFITS.length > 0, true)
      check('服饰 slug 唯一', new Set(OUTFIT_SLUGS).size, OUTFITS.length)

      /* ---------- 轮换节拍 ---------- */

      /*
       * 间隔钳制。
       *
       * 重点是空串：设置页是 number 输入框，用户清空时 v-model 给的是 ''，
       * 而 Number('') === 0 —— 不特判就会被钳到下限 1 分钟，
       * 也就是「一秒钟换一套」，桌宠变成幻灯片且没人知道是为什么。
       */
      check('间隔默认', clampRotateMin(undefined), DEFAULT_ROTATE_MIN)
      check('间隔空串回落默认', clampRotateMin(''), DEFAULT_ROTATE_MIN)
      check('间隔 null 回落默认', clampRotateMin(null), DEFAULT_ROTATE_MIN)
      check('间隔非数字回落默认', clampRotateMin('abc'), DEFAULT_ROTATE_MIN)
      check('间隔 NaN 回落默认', clampRotateMin(NaN), DEFAULT_ROTATE_MIN)
      check('间隔下限', clampRotateMin(0), ROTATE_MIN_MIN)
      check('间隔负数收敛到下限', clampRotateMin(-30), ROTATE_MIN_MIN)
      check('间隔上限', clampRotateMin(9999), ROTATE_MIN_MAX)
      check('间隔向下取整', clampRotateMin(7.9), 7)
      check('间隔字符串可用', clampRotateMin('12'), 12)
      check('区间内原样返回', clampRotateMin(30), 30)

      /* 等待时长：基准 ±25%，且不低于 15 秒 */
      const baseMs = clampRotateMin(10) * 60_000
      check('等待无抖动时等于基准', rotateDelayMs(10, () => 0.5), baseMs)
      check('等待抖动下限', rotateDelayMs(10, () => 0), Math.round(baseMs * 0.75))
      check('等待抖动上限', rotateDelayMs(10, () => 1), Math.round(baseMs * 1.25))
      check('最短间隔也不会低于 15 秒', rotateDelayMs(1, () => 0) >= 15_000, true)
      /* 抖动必须是真抖动：同一间隔连续取值不该全一样 */
      const delays = [0.1, 0.9, 0.3, 0.7].map((r) => rotateDelayMs(10, () => r))
      check('等待确实在抖动', new Set(delays).size > 1, true)

      /*
       * 抽选：动作与服饰同池，且避开最近三项。
       *
       * 避让数不能超过池子大小，否则 usable 会空掉（`pickLine([])` 返回 ''
       * -> 立绘直接不显示）。最低档只有 4 项，必须专门覆盖。
       */
      check('空池返回空串', pickRotation([]), '')
      check('null 池安全', pickRotation(null), '')
      check('单项池返回该项', pickRotation(['a'], ['a', 'b', 'c']), 'a')
      check('两项池不返回空串', pickRotation(['a', 'b'], ['a', 'b']) !== '', true)
      /* 避让不能把池子清空：清空 -> 空串 -> 立绘回落站姿，比重复一次糟得多 */
      check('避让过头仍从原池抽', pickRotation(['a', 'b'], ['a', 'b', 'a']) !== '', true)
      check('四项池避三项仍能选出', ['a', 'b', 'c', 'd'].includes(pickRotation(['a', 'b', 'c', 'd'], ['a', 'b', 'c'])), true)
      /* 最近三项都要避开（池里只剩 w 可选，结果必须不是 x/y/z） */
      check('避开最近三项', ['x', 'y', 'z'].includes(pickRotation(['x', 'y', 'z', 'w'], ['x', 'y', 'z'])), false)
      check('只剩一项时选中它', pickRotation(['x', 'y', 'z', 'w'], ['x', 'y', 'z']), 'w')
      /* 满级池跑一轮，相邻两次必不同 */
      const fullPool = idleCandidatesFor('intimate', OUTFIT_SLUGS)
      let rotationCandidatesOk = true
      let hist = []
      let immediateRepeat = false
      for (let i = 0; i < 300; i++) {
        const n = pickRotation(fullPool, hist)
        if (n === hist[0]) immediateRepeat = true
        hist = [n, ...hist].slice(0, 3)
      }
      check('不会连续重复同一项', immediateRepeat, false)
      /* 服饰项要真的能被轮到（否则「换一套衣服」名不副实） */
      const seenOutfits = new Set()
      hist = []
      for (let i = 0; i < 400; i++) {
        const n = pickRotation(fullPool, hist)
        if (n.startsWith('outfit:')) seenOutfits.add(n)
        hist = [n, ...hist].slice(0, 3)
      }
      check('轮换里能轮到衣服', seenOutfits.size > 0, true)
      check('轮换到的都是池内项', [...seenOutfits].every((k) => fullPool.includes(k)), true)

      /* ---------- 轮换池自选 ---------- */

      /*
       * 三条语义，逐条钉死：
       *   空选 = 全部（不是「什么都不换」）
       *   自选必须被已解锁范围夹住（防穿未解锁的衣服）
       *   过滤后为空要回落全池（老库里存着失效项时不至于变哑巴）
       */
      const allPool = idleCandidatesFor('intimate')
      check('空选 = 全部已解锁', resolveRotationPool('intimate', []).length, allPool.length)
      check('非数组视同空选', resolveRotationPool('intimate', null).length, allPool.length)
      check('空选与不传等价', resolveRotationPool('intimate', undefined).length, allPool.length)

      const sub = ['snack', 'outfit:jk']
      check('自选只保留勾选项', resolveRotationPool('intimate', sub, OUTFIT_SLUGS), sub)
      /* 未解锁的项必须被滤掉：'outfit:qipao' 在 stranger 档不可用 */
      const stranger = resolveRotationPool('stranger', ['snack', 'outfit:qipao', 'outfit:swimsuit'])
      check('未解锁的服饰被滤掉', stranger.filter((k) => k.startsWith('outfit:')).length, 0)
      check('已解锁的动作保留', stranger.includes('snack'), true)
      /* 全是未解锁项 -> 回落全池，而不是空池 */
      const allLocked = resolveRotationPool('stranger', ['outfit:qipao'])
      check('全失效时回落全池', allLocked.length, idleCandidatesFor('stranger').length)
      check('回落结果非空（立绘不能哑）', allLocked.length > 0, true)
      /*
       * 动作不分档了 —— 最低档也拿得到 yawn。
       * 这一条原来断言「低档位滤掉高档动作」，那是阶梯时代的语义。
       */
      const allTiers = resolveRotationPool('stranger', ['yawn', 'snack'])
      check('最低档也能选到全部动作', allTiers.includes('yawn'), true)

      /*
       * 服饰则相反：**必须以实际解锁清单为准**。
       * 传空数组表示「图鉴里一套都没解锁」，此时池子里不该有任何 outfit。
       */
      const noOutfit = idleCandidatesFor('intimate', [])
      check('未传解锁清单时不含任何服饰', noOutfit.some((k) => k.startsWith('outfit:')), false)
      const someOutfit = idleCandidatesFor('intimate', ['jk', 'qipao'])
      check('按解锁清单给服饰', someOutfit.filter((k) => k.startsWith('outfit:')).length, 2)
      /* 清单里没解锁的不能出现在池里 —— 这是「能穿的必须是发过照片的」 */
      check('清单外的服饰不出现', someOutfit.includes('outfit:swimsuit'), false)

      /*
       * 选择器候选必须全在已解锁池内（用户勾的都得真会轮到）。
       *
       * 两边都必须**显式传解锁清单**：不传时 `unlockedOutfits` 默认 `[]`，
       * 服饰那一侧两边都是空集，「候选 ⊆ 池」就退化成「全集 ⊆ 全集」的恒真式，
       * 标题里的「已解锁池／全部服饰」一格都没测到。
       */
      for (const v of ['stranger', 'familiar', 'friend', 'close', 'intimate']) {
        const pool = idleCandidatesFor(v, OUTFIT_SLUGS)
        const cands = rotationCandidatesFor(v, OUTFIT_SLUGS)
        if (cands.some((c) => !pool.includes(c.key))) rotationCandidatesOk = false
        /*
         * 动作项的中文名要看**对照表里有没有登记**，不能看 `c.label` 是否真值 ——
         * 实现用 `IDLE_POSE_LABELS[k] ?? k` 回落，key 本身也是 truthy，
         * 漏登记的格子会显示成 `yawn` 这种英文 key 而测试照样绿。
         */
        if (cands.some((c) => c.kind === 'action' && IDLE_POSE_LABELS[c.key] == null)) rotationCandidatesOk = false
      }
      check('选择器候选都在已解锁池内且有名字', rotationCandidatesOk, true)
      check('满级候选 = 动作 + 全部服饰', rotationCandidatesFor('intimate', OUTFIT_SLUGS).length, ALL_IDLE_POSES.length + OUTFIT_SLUGS.length)
      check('候选数与已解锁池一致', rotationCandidatesFor('intimate', OUTFIT_SLUGS).length, idleCandidatesFor('intimate', OUTFIT_SLUGS).length)
      check('动作与服饰分开统计', rotationCandidatesFor('intimate', OUTFIT_SLUGS).filter((c) => c.kind === 'outfit').length, OUTFITS.length)
      check('未知档位回落最低档候选', rotationCandidatesFor('nope').length, rotationCandidatesFor('stranger').length)

      /* ---------- 上帝模式：读时覆盖 ---------- */

      const plain = affinityView(120, false)
      check('关闭时与 affinityLevel 一致', plain.voice, affinityLevel(120).voice)
      check('关闭时不带 godMode 标记', plain.godMode, false)

      const god = affinityView(0, true)
      check('上帝模式：0 点也到满档', god.voice, 'intimate')
      check('上帝模式：显示为上帝模式', god.level.name, '上帝模式')
      check('上帝模式：进度满', god.progress, 100)
      check('上帝模式：标记为 true', god.godMode, true)
      check('上帝模式：视为已满级', god.isMax, true)
      check('上帝模式：没有下一档', god.next, null)
      /*
       * 上帝模式覆盖 voice —— 但**服饰不再由档位决定**，所以这里只断言
       * 动作那一侧（动作本来就不分档了，这里验证 voice 确实被顶到满档）。
       */
      check('上帝模式：voice 顶到最高档', god.voice, 'intimate')
      check('对照：0 点真实档位是最低档', affinityLevel(0).voice, 'stranger')
      /* 缺省参数不能当成开启 */
      check('缺省 godMode 为关闭', affinityView(300).godMode, false)

      /* ---------- 上帝模式：图鉴也全解锁（读时覆盖，不写库） ---------- */
      {
        /*
         * `affinityView` 那几条只覆盖了 voice/progress，**图鉴那一侧没测**：
         * service 的 `const unlocked = godMode ? Object.keys(table) : real`
         * 一旦写坏（或 godMode 判定改错），表现是「开了上帝模式图鉴还是黑的」，
         * 但没有任何断言会红。
         *
         * 顺带把「读时覆盖」这条纪律也钉住：快照能全解锁，但**不许写库** ——
         * 关掉开关后必须立刻回到真实清单（真的灌过 meta 的话就回不去了，
         * 用户会以为「这些衣服我明明有，怎么变回没解锁」）。
         */
        const gDir = mkdtempSync(join(tmpdir(), 'desk-god-'))
        const gStore = openStore(join(gDir, 'g.db'))
        const gSvc = createService(gStore)
        const gSid = (await gSvc.ensureChatSession()).id

        const snapOff = await gSvc.gallery(gSid)
        check('关闭上帝模式：服饰图鉴只有初始那套', snapOff.outfit.unlocked, [DEFAULT_OUTFIT])
        check('关闭上帝模式：图鉴不带 godMode 标记', snapOff.outfit.godMode, false)

        await gSvc.updateSettings({ godMode: true })
        const snapOn = await gSvc.gallery(gSid)
        check('上帝模式：服饰图鉴全解锁', snapOn.outfit.unlocked.length, OUTFIT_SLUGS.length)
        check('上帝模式：每套都标为已获得', snapOn.outfit.items.every((it) => it.got), true)
        check('上帝模式：生活照图鉴也全解锁', snapOn.photo.unlocked.length, PHOTO_SLUGS.length)
        check('上帝模式：快照带标记', snapOn.outfit.godMode, true)

        await gSvc.updateSettings({ godMode: false })
        const snapBack = await gSvc.gallery(gSid)
        check('关掉后回到真实清单（覆盖不写库）', snapBack.outfit.unlocked, [DEFAULT_OUTFIT])
        await gSvc.close()
      }

      /* ---------- 未解锁的服饰必须能被标出来 ---------- */
      /*
       * 换装列表列的是全量 OUTFITS（不然新解锁的没机会被发现），
       * 所以「锁住的那部分」只能靠 UI 标出来。`outfitUnlockTierName`
       * 就是那个标识的依据 —— 它和 OUTFIT_MIN_POINTS 必须同源，
       * 否则会出现「列表说解锁了、轮换池里却没有」。
       *
       * 旧断言（`name` 非空且不是字符串 'undefined'）恒真：
       * 实现里 `outfitMinPoints` 是 `?? 0`、必然落在最低档，对**任何**
       * 输入都返回一个档位名 —— 它连 `outfitUnlockTierName('nope')`
       * 都算过，等于没有测「同源」这件事。
       * 真正要钉的是：每套服饰都登记在门槛表里，且档位名恰好等于
       * 「第一个 `min >= outfitMinPoints(slug)` 的档位名」。
       */
      const tierMismatch = OUTFIT_SLUGS.filter((slug) => {
        if (!(slug in OUTFIT_MIN_POINTS)) return true
        const lvl = AFFINITY_LEVELS.find((l) => outfitMinPoints(slug) <= l.min)
        const expect = lvl?.name ?? AFFINITY_LEVELS[AFFINITY_LEVELS.length - 1].name
        return outfitUnlockTierName(slug) !== expect
      })
      check('每套服饰的档位名与门槛表同源', tierMismatch, [])
      check('门槛 0 的服饰落在最低档', outfitUnlockTierName(DEFAULT_OUTFIT), AFFINITY_LEVELS[0].name)
      check('未登记的 slug 按门槛 0 落在最低档', outfitUnlockTierName('nope'), AFFINITY_LEVELS[0].name)
      /* 档位名必须真的是某一档 —— 不能返回内部 voice 标识 */
      check('返回的是档位名不是 voice 标识', AFFINITY_LEVELS.some((l) => l.name === outfitUnlockTierName('swimsuit')), true)
    }

    /* ---------- 清空全部数据 ---------- */
    {
      /*
       * SCHEMA 里的表必须都在 WIPE_TABLES 里登记。
       *
       * 漏登记的表现极隐蔽：「清空」跑成功了，但新表的数据还在，
       * 而用户以为已经清干净了 —— 比直接报错糟得多。
       * 所以这里从 SCHEMA 正则抽表名，跟 WIPE_TABLES 对账。
       */
      const schemaTables = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1])
      const notWiped = schemaTables.filter((t) => !WIPE_TABLES.includes(t))
      check('schema 里的表都已登记进清空清单', notWiped, [])
      check('清空清单无多余表', WIPE_TABLES.filter((t) => !schemaTables.includes(t)), [])
      /*
       * 外键子表必须排在父表前面。
       * chat_messages.sessionId 引用 chat_sessions.id ——
       * 顺序反了就算开了 CASCADE 也可能先撞约束。
       */
      check('子表排在父表前', WIPE_TABLES.indexOf('chat_messages') < WIPE_TABLES.indexOf('chat_sessions'), true)

      const wipeDir = mkdtempSync(join(tmpdir(), 'desk-wipe-'))
      const store3 = openStore(join(wipeDir, 'w.db'))
      const svc = createService(store3)

      /* 铺足够杂的数据：每张表都要有行，否则「删干净了」证明不了什么。
         消息直接走 store 写，不走 sendChat —— 那条路要 API Key，
         失败时消息表会是空的，这条断言就白写了。 */
      await svc.checkIn(new Date())
      await svc.logMoyu(45)
      await svc.updateSettings({ salary: 99999, petRotateMin: 3 })
      await svc.createPersona({ label: '测试人设', prompt: 'x' })
      const ss = await svc.ensureChatSession()
      store3.addMessage(ss.id, 'user', '在吗')
      store3.addMessage(ss.id, 'assistant', '在的')
      await svc.addEvent('test', { a: 1 })

      const before = {
        settings: Object.keys(await svc.getSettings()).length,
        checkins: (await store3.listCheckins({})).length,
        worklogs: (await store3.listWorklogs(toDateKey(new Date()))).length,
        events: (await store3.listEvents('test')).length,
        personas: (await store3.listPersonas()).length,
        sessions: (await svc.listChatSessions()).length,
        msgs: (await store3.listMessages(ss.id)).length,
      }
      check('清空前数据齐全', Object.values(before).every((n) => n > 0), true)

      await svc.wipeAllData()

      const after = {
        settings: (await store3.getSettings()).petScale,
        checkins: (await store3.listCheckins({})).length,
        worklogs: (await store3.listWorklogs(toDateKey(new Date()))).length,
        events: (await store3.listEvents('test')).length,
        personas: (await store3.listPersonas()).length,
      }
      check('打卡已清空', after.checkins, 0)
      check('摸鱼时长已清空', after.worklogs, 0)
      check('事件已清空', after.events, 0)
      check('人设已清空', after.personas, 0)
      /* 设置不是「空」而是回落默认值 —— 空设置会让界面全 undefined */
      check('设置回落默认值', after.settings, DEFAULT_SETTINGS.petScale)

      /* 表结构必须还在：库没被删，重开一次即可用 */
      const reopened = openStore(join(wipeDir, 'w.db'))
      check('库文件保留、表结构完好', typeof reopened.getSettings, 'function')
      check('重开后能读设置', reopened.getSettings().workStart, DEFAULT_SETTINGS.workStart)

      /* 会话必须重建：全空时所有读路径会拿到 undefined，界面静默空白 */
      const sessions = await reopened.listSessions()
      check('已重建默认会话', sessions.length, 1)
      check('新会话为空', sessions[0].messageCount, 0)

      /* 关掉所有句柄再删临时目录，否则 node:sqlite 仍持有文件 -> EPERM */
      reopened.close()
      store3.close()
      rmSync(wipeDir, { recursive: true, force: true })
    }

    /* ---------- 素材对账：清单、图片文件、代码表三者一致 ---------- */
    {
      /*
       * 这条是为了防止重演两类事故：
       *   1. 「同款去重误删 9 张素材」—— 靠命名习惯猜内容，静默丢弃
       *   2. 「睡衣(1) 撞 pose1」—— 新旧素材混用同名 slug，静默覆盖立绘
       *
       * 现在素材链路是：`resources/yuki-new/G*.png` --split-sheet.js-->
       * resources/raw-cut --install-pet-assets.js--> public/ + manifest。
       * 所以对账三方：**manifest 条目 = 实际图片文件 = 代码里的 slug 表**。
       */
      /*
       * manifest 仍在 `resources/pet/` —— 它是**素材清单**
       * （`{ spriteHeight, items: { slug: {kind, size} } }`），
       * 而且是「代码里的 slug 表」与「实际文件」之间的对账依据
       * （下面几条断言靠它）。与它同目录的重复 PNG 才是冗余。
       */
      const manifestPath = join(ROOT, 'resources', 'pet', 'manifest.json')

      if (!existsSync(manifestPath)) {
        check('manifest 已生成', false, true)
      } else {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
        const manifest = raw.items ?? {}
        const slugs = Object.keys(manifest)

        /*
         * ⓪ 立绘必须是**真彩无损**，且高度与清单声明一致。
         *
         * 这条守的是一个出过的真实事故：`install-pet-assets.js` 里
         * `-colors 220` 把真彩 RGBA（colortype 6）量化成了 204 色调色板
         * （colortype 3），像素级损失 —— 6.1 万色 → 204 色、
         * 255 级 alpha → 56 级。裁切脚本是无损的，损耗全在这一步，
         * 而且**没有任何断言拦得住**，只能靠肉眼发现。
         *
         * 判据用「颜色类型」而不是「颜色数量」：
         *   colortype 3 = 调色板索引 —— 只要量化就一定变成它，
         *   而正常降采样不会改变颜色类型。极稳，不会误报。
         */
        const IHDR_COLOR_TYPE_OFFSET = 25
        const sampled = slugs.filter((s) => existsSync(join(ROOT_PUBLIC, `yuki-${s}.png`)))
        const paletteQuantized = sampled.filter((s) => {
          const b = readFileSync(join(ROOT_PUBLIC, `yuki-${s}.png`))
          return b[IHDR_COLOR_TYPE_OFFSET] === 3 || b.includes(Buffer.from('PLTE'))
        })
        check('立绘未被量化成调色板（应为真彩无损）', paletteQuantized, [])

        /*
         * 高度对账：素材实高必须 ≥ 清单声明的 spriteHeight。
         *
         * 声明值 = 渲染端最大 CSS 高度 × 2（见 install-pet-assets.js 的
         * SPRITE_HEIGHT）。素材比它小就意味着浏览器要**放大** ——
         * 那正是这次糊掉的直接原因，所以单独守一条。
         */
        const tooShort = sampled.filter((s) => {
          const b = readFileSync(join(ROOT_PUBLIC, `yuki-${s}.png`))
          return b.readUInt32BE(20) !== raw.spriteHeight
        })
        check(`立绘实高 = manifest.spriteHeight(${raw.spriteHeight})`, tooShort, [])

        /*
         * ① manifest 里的每个 slug 都必须有**运行期用的那份图**。
         *
         * 只查 `src/renderer/public/` —— 它才是渲染层真正读的。
         * `resources/pet/` 里那份母版是 `install-pet-assets.js` 的归档产物，
         * 与 public 逐字节相同、**运行期无人读**（曾经两边都查，
         * 于是删掉那份冗余母版会让冒烟挂掉 —— 守错了对象）。
         */
        const missingWeb = slugs.filter((s) => !existsSync(join(ROOT_PUBLIC, `yuki-${s}.png`)))
        check('manifest 每项都有图（public）', missingWeb, [])

        /*
         * ② 反过来：public 里不能有 manifest 之外的孤儿图。
         *
         * 这才是「slug 改名后忘了清理」真正会出问题的地方 ——
         * 多出来的图不会被任何代码引用，白占体积。
         */
        const onDisk = readdirSync(ROOT_PUBLIC)
          .filter((f) => /^yuki-(outfit-)?[a-z0-9-]+\.png$/.test(f))
          .map((f) => f.replace(/^yuki-/, '').replace(/\.png$/, ''))
          .filter((s) => s !== 'avatar')
        const orphans = onDisk.filter((s) => !slugs.includes(s))
        check('public 里没有 manifest 之外的孤儿图', orphans, [])

        /* ③ 代码里的动作表与服饰表必须恰好覆盖 manifest */
        const manifestActions = slugs.filter((s) => manifest[s].kind === 'action')
        const manifestOutfits = slugs.filter((s) => manifest[s].kind === 'outfit')
        const codeActions = Object.values(PET_EXPRESSIONS)
        const missingInCode = manifestActions.filter((s) => !codeActions.includes(s))
        check('每个动作素材都在 PET_EXPRESSIONS 里（无死素材）', missingInCode, [])
        /* manifest 里服饰 slug 带 outfit- 前缀，代码里不带 —— 去掉前缀再比 */
        const outfitsNotInCode = manifestOutfits
          .map((s) => s.replace(/^outfit-/, ''))
          .filter((s) => !OUTFIT_SLUGS.includes(s))
        check('每套服饰素材都在 OUTFITS 里', outfitsNotInCode, [])

        /* ④ 反向：代码里引用的每个 slug 都必须有图，否则轮换到就 404 */
        const codeMissingImage = [
          ...new Set(codeActions).values(),
        ].map((s) => expressionFile(s)).concat(OUTFIT_SLUGS.map((s) => outfitFile(s)))
          .filter((f) => !existsSync(join(ROOT_PUBLIC, f)))
        check('代码引用的 slug 都有图', codeMissingImage, [])

        /*
         * 角色设定图（高中 / 大学）也要在。设置页按固定路径引用，
         * 改名或漏打包会直接空白 —— 这两张不参与素材轮换，容易被忽略。
         */
        const profileMissing = [
          'character/yuki-profile-1-highschool.png',
          'character/yuki-profile-2-university.png',
        ].filter((f) => !existsSync(join(ROOT_PUBLIC, f)))
        check('角色设定图都在', profileMissing, [])

        /*
         * 自拍照片：有则必须能对上 OUTFITS 的 slug。
         *
         * 照片是**分批生成**的，所以允许缺失（解锁时退回立绘）。
         * 但**存在而不能对上 slug 的**必须报出来 ——
         * 那说明生成脚本里的 slug 拼错了，或者 OUTFITS 改了名
         * 而照片没跟着改，表现为解锁弹窗里显示空图。
         */
        const PHOTO_DIR = join(ROOT_PUBLIC, 'photos')
        if (existsSync(PHOTO_DIR)) {
          const all = readdirSync(PHOTO_DIR)
            .filter((f) => /^yuki-photo-[a-z0-9-]+\.png$/.test(f))
            .map((f) => f.replace(/^yuki-photo-/, '').replace(/\.png$/, ''))
          /*
           * 两类：
           *   - 装扮照片：slug 必须对上 `OUTFITS`（对不上 = 拼错名字，解锁时显示空图）
           *   - 额外照片：`scene-N`（旧命名）/ `free-N`（自由穿搭格），不绑装扮
           */
          const EXTRA_RE = /^(scene|free)-\d+$/
          const extra = all.filter((s) => EXTRA_RE.test(s))
          /* 一套装扮可有多张：`<slug>.png` / `<slug>-2.png`… 比较用基础名 */
          const photos = all.filter((s) => !EXTRA_RE.test(s)).map((s) => s.replace(/-\d+$/, ''))
          check('装扮照片 slug 都能对上服饰表', photos.filter((s) => !OUTFIT_SLUGS.includes(s)), [])
          /* 额外照片的命名必须规范，否则装图时会被当成装扮处理 */
          check('额外照片命名规范', extra.filter((s) => !EXTRA_RE.test(s)), [])

          /*
           * 同一个 slug 可以出现多次（多张照片），但**每张的路径必须唯一**——
           * 文件名撞车会互相覆盖，最终只剩一张。
           */
          check('照片文件名唯一（无覆盖）', all.length - new Set(all).size, 0)

          /*
           * 多张照片的序号必须**从 1 连续**：
           * 有 `-2` 却没第 1 张，说明基础名拼错了（比如生成时少了后缀），
           * 前端按 1..N 顺序探测，中间断档会让后面的图永远显示不出来。
           */
          const groups = new Map()
          for (const s of all) {
            if (EXTRA_RE.test(s)) continue
            const idx = Number((/-\d+$/.exec(s) || ['1'])[0].replace('-', '')) || 1
            const base = s.replace(/-\d+$/, '')
            if (!groups.has(base)) groups.set(base, [])
            groups.get(base).push(idx)
          }
          const holes = []
          for (const [base, idxs] of groups) {
            const sorted = [...new Set(idxs)].sort((a, b) => a - b)
            for (let i = 0; i < sorted.length; i++) {
              if (sorted[i] !== i + 1) {
                holes.push(`${base}: 期望第${i + 1}张，实际有 ${sorted[i]}`)
                break
              }
            }
          }
          check('多张照片的序号从 1 连续', holes, [])
          const multi = [...groups.values()].filter((v) => v.length > 1).length
          if (multi) console.log(`  · ${multi} 套装扮有多张照片`)

          if (photos.length) {
            console.log(`  · 装扮照片 ${photos.length}/${OUTFIT_SLUGS.length} 套已生成`)
          }
          if (extra.length) console.log(`  · 额外照片 ${extra.length} 张（自由穿搭）`)
        }

        /*
         * 生活照：每一组都必须至少有第一张图。
         *
         * 第二张是可选的（同场景跑了两版才有），所以要分别断言：
         *   - 第一张：必须有，缺了说明切图或搬运漏了
         *   - 第二张：有则行，但**不能只有第二张没有第一张**
         *     （那说明命名错位，调用方从 1 开始找会找不到）
         */
        const photoMissing = PHOTO_SLUGS.filter((slug) => !existsSync(join(ROOT_PUBLIC, photoFiles(slug)[0])))
        check('生活照每组都有第一张', photoMissing, [])
        const orphanSecond = PHOTO_SLUGS.filter((slug) => {
          const [a, b] = photoFiles(slug)
          return existsSync(join(ROOT_PUBLIC, b)) && !existsSync(join(ROOT_PUBLIC, a))
        })
        check('生活照没有「有第二张却没第一张」的组', orphanSecond, [])
        const lifeCount = PHOTO_SLUGS.filter((slug) => existsSync(join(ROOT_PUBLIC, photoFiles(slug)[0]))).length
        if (lifeCount) console.log(`  · 生活照 ${lifeCount}/${PHOTO_SLUGS.length} 组已就位`)
      }
    }

    /* ---------- 全局扫描：运行期所有 PNG 都不得被调色板量化 ---------- */
    {
      /*
       * 上面那条只盯立绘，但「量化」是**一类**风险，不是立绘独有的。
       * 实测已经出现过四批：立绘（`-colors 220`）、照片（220）、
       * 设定图（200）—— 每次都是同一个模式：导出时为了省体积加
       * `-colors`，代价是几万色塌成两百色，且没有任何断言拦得住。
       *
       * 所以这里做成**递归全扫**：`src/renderer/public/` 下运行期
       * 真正会被加载的每张 PNG 都检查。colortype 3（调色板索引）
       * 或存在 PLTE 块 = 量化，报出来。
       *
       * 为什么判颜色类型而不是颜色数量：
       *   - 降采样/缩放**不会**改变颜色类型，所以不会误报
       *   - 量化**必然**产生 PLTE + colortype 3，所以不会漏报
       * 唯一合法例外是调色板本身就是资产形态的图标类（本项目没有）。
       */
      const walkPng = (dir, out = []) => {
        let entries
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return out
        }
        for (const e of entries) {
          const p = join(dir, e.name)
          if (e.isDirectory()) walkPng(p, out)
          else if (e.name.toLowerCase().endsWith('.png')) out.push(p)
        }
        return out
      }

      const allPng = walkPng(ROOT_PUBLIC)
      const quantized = []
      for (const p of allPng) {
        let b
        try {
          b = readFileSync(p)
        } catch {
          continue
        }
        if (b.length < 26 || b.readUInt32BE(0) !== 0x89504e47) continue
        const colorType = b[25]
        const hasPalette = b.includes(Buffer.from('PLTE'))
        if (colorType === 3 || hasPalette) {
          quantized.push(`${p.slice(ROOT_PUBLIC.length + 1)} (ct${colorType}${hasPalette ? '+PLTE' : ''})`)
        }
      }
      check(`运行期 PNG 全部真彩（共 ${allPng.length} 张，无调色板量化）`, quantized, [])
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

    /* ---------- 照片生成器的提示词覆盖 ---------- */
    {
      /*
       * 照片提示词是**逐格手写**的，最容易出的错是：
       *   1. 某套装扮漏了服装描述 → 生成出一套认不出来的衣服
       *   2. 服装描述与 gen-sheet.js 的立绘描述漂移 →
       *      照片里的人和桌宠立绘不是同一个人
       *   3. 24 套没盖全 / 有重复
       */
      const photoSlugs = PHOTO_SHOTS.map((x) => x.slug).filter(Boolean)
      const lookSlugs = Object.keys(OUTFIT_LOOKS)

      check('每套装扮都有服装描述', OUTFIT_SLUGS.filter((s) => !lookSlugs.includes(s)), [])
      check('服装描述没有多余的 slug', lookSlugs.filter((s) => !OUTFIT_SLUGS.includes(s)), [])
      check('每套装扮都有照片格子', OUTFIT_SLUGS.filter((s) => !photoSlugs.includes(s)), [])
      check('照片格子没有重复 slug', photoSlugs.length - new Set(photoSlugs).size, 0)

      /*
       * 服装描述必须**点到具体单品**，不能只剩一句氛围话。
       *
       * 不卡长度：像「白色比基尼，配浅色外罩衫」只有 12 字但完全够用，
       * 卡长度会误伤。改成要求出现服装名词 —— 被误删成
       * 「穿得很休闲」这类描述会立刻报警。
       */
      const GARMENT = /吊带|裙|衬衫|外套|开衫|旗袍|比基尼|泳装|西装|风衣|睡衣|裤|女仆|修女|制服|礼裙|背心|毛衣|袜|新年装|棉衣|大衣/
      const vague = lookSlugs.filter((s) => !GARMENT.test(OUTFIT_LOOKS[s]?.wear ?? ''))
      check('服装描述点到具体单品', vague, [])

      /*
       * 逐格明细必须**逐格可定位**：每条都带「（第N行第M列）」。
       *
       * 只说「第N格」时模型仍可能自行重排顺序（实测出图出现过
       * 把第 3 格的服装画到第 5 格）。锁定行列之后位置才是死的。
       */
      for (const key of Object.keys(ORIENTATIONS)) {
        const o = ORIENTATIONS[key]
        /*
         * 用 shotsByOrient 而不是直接筛 PHOTO_SHOTS ——
         * `feet` 是独立特辑（清单在 FEET_SHOTS），不在 PHOTO_SHOTS 里，
         * 直接筛会得到 0 格，断言形同虚设。
         */
        const shots = shotsByOrient(key)
        const text = buildSheetBody(o, shots)
        const cells = text.match(/^第\d+格（第\d+行第\d+列）/gm) || []
        check(`${o.label} 逐格明细带行列坐标`, cells.length, shots.length)

        /* 行列不能越界 */
        const badPos = []
        for (const m of text.matchAll(/^第\d+格（第(\d+)行第(\d+)列）/gm)) {
          if (Number(m[1]) > o.rows || Number(m[2]) > o.cols) badPos.push(m[0])
        }
        check(`${o.label} 行列坐标不越界`, badPos, [])

        /* 同一格数不能重复出现（重复说明编号算错） */
        const nums = (text.match(/^第(\d+)格（/gm) || []).length
        check(`${o.label} 逐格明细条数 = ${shots.length}`, nums, shots.length)
      }

      /* 两栏提示词画的必须是同一批画布，否则切图参数会错 */
      for (const key of Object.keys(ORIENTATIONS)) {
        const o = ORIENTATIONS[key]
        const [cw, chh] = o.size.split('x').map(Number)
        const cellW = cw / o.cols
        const cellH = chh / o.rows
        const want = key === 'vert' ? 3 / 4 : 4 / 3
        const got = cellW / cellH
        check(`${o.label} 每格比例正确`, Math.abs(got - want) < 0.02, true)
        check(`${o.label} 格子数 = 4×4`, o.cols * o.rows, PER_SHEET)
      }

      /* 每张 sheet 都要凑满槽位，空镜补足 */
      for (const key of Object.keys(ORIENTATIONS)) {
        const n = shotsByOrient(key).length
        check(`${ORIENTATIONS[key].label} 格子数 = ${PER_SHEET}`, n, PER_SHEET)
      }
    }

    /* ---------- 解锁照片消息（拆成多条） ---------- */
    {
      /*
       * 解锁时照片要作为**真实消息**进聊天记录，而且是
       * 「配文一条、每张照片一条」—— 像她一张张发过来。
       *
       * 最容易错的几点：
       *   1. 多条消息的 `createdAt` 撞在同一毫秒 → 列表排序不稳定，
       *      照片会跑到配文前面。`offsetMs` 必须严格递增。
       *   2. 消息里的图用相对路径，回传给模型会变非法 URL →
       *      规范化必须降级成纯文本。
       *   3. 生活照走的是另一套路径命名（`photos/life/`），
       *      用错规则就是裂图。
       */
      const parts = buildPhotoMessages('早八的课', [photoPathAt('jk', 1), photoPathAt('jk', 2)])
      check('配文单独一条（不带图）', parts[0].content.map((b) => b.type), ['text'])
      check('每条照片各占一条消息', parts.slice(1).map((b) => b.content.map((x) => x.type)), [
        ['image_url'],
        ['image_url'],
      ])
      check('配文在最前', parts[0].content[0].text, '早八的课')
      check('图片路径符合 UI 约定', parts[1].content[0].image_url.url, 'photos/yuki-photo-jk.png')

      /*
       * offsetMs 必须**严格递增** —— 落库时按它算 createdAt，
       * 并列会让排序不稳定。
       */
      const offsets = parts.map((p) => p.offsetMs)
      check('offsetMs 严格递增', offsets.every((v, i) => i === 0 || v > offsets[i - 1]), true)

      /* 空配文不产出配文那条（只有图，不要一句空洞的兜底） */
      const noCap = buildPhotoMessages('', [photoPathAt('jk', 1)])
      check('空配文只出图那一条', noCap.length, 1)
      check('空配文那条是图', noCap[0].content[0].type, 'image_url')

      /* 类目分派：生活照走另一套命名 */
      check('生活照路径在 life/ 下', photoPathsOf('photo', 'g08')[0], 'photos/life/g08-1.png')
      check('服饰照片路径不带 life/', photoPathsOf('outfit', 'jk')[0], 'photos/yuki-photo-jk.png')
      const lifeParts = buildPhotoMessages('刚洗完', photoPathsOf('photo', 'g08'))
      check('生活照也拆成配文+两张', lifeParts.length, 3)

      /* 关键：规范化后不能把相对路径原样发给模型 */
      const norm = normalizeForRequest([
        { role: 'user', content: '在干嘛' },
        { role: 'assistant', content: parts[1].content },
      ])
      const assistantOut = norm.find((m) => m.role === 'assistant')
      check('照片消息发给模型时降级成纯文本', typeof assistantOut.content, 'string')
      check('降级后不含图片路径', assistantOut.content.includes('photos/'), false)

      /* isPhotoMessage 用于渲染层判断 */
      check('能识别照片消息', isPhotoMessage({ role: 'assistant', content: parts[1].content }), true)
      check('纯配文那条不算照片消息', isPhotoMessage({ role: 'assistant', content: parts[0].content }), false)
    }

    /* ---------- 手机端 vendor 模块完整性 ---------- */
    {
      /*
       * 手机端的 shared 模块是**构建时复制**到 `dist-mobile/vendor/` 的
       * （见 mobile/build.js 的 MODULES 列表）。
       *
       * 踩过的坑：新增 `src/shared/weather.js` 却忘了加进 MODULES，
       * 于是构建产物里没有 `vendor/weather.js` → 浏览器 404 →
       * **app.js 整个模块加载失败**（`main()` 根本没跑）→
       * 页面白屏、状态行停在「…」，但控制台没有任何异常，
       * 只有网络面板里一条 404。查了很久。
       *
       * 这条断言把两个列表对上：`mobile/app.js` 里 import 了哪些
       * shared 模块，就必须在 MODULES 里。缺了当场报出来。
       */
      const appSrc = readFileSync(join(ROOT, 'mobile', 'app.js'), 'utf8')
      const buildSrc = readFileSync(join(ROOT, 'mobile', 'build.js'), 'utf8')

      const imported = new Set(
        [...appSrc.matchAll(/from '\.\.\/src\/shared\/([a-zA-Z0-9]+)\.js'/g)].map((m) => `${m[1]}.js`),
      )
      const modListMatch = /const MODULES = \[([\s\S]*?)\]/.exec(buildSrc)
      const bundled = new Set(
        modListMatch ? [...modListMatch[1].matchAll(/'([a-zA-Z0-9]+\.js)'/g)].map((m) => m[1]) : [],
      )

      check('build.js 能解析出 MODULES 列表', bundled.size > 0, true)
      const missing = [...imported].filter((f) => !bundled.has(f)).sort()
      check('app.js 引用的 shared 模块都在 MODULES 里（缺了会白屏）', missing, [])

      /*
       * 反向：MODULES 里列了但没人 import 的 —— 不是错误
       * （可能是别的 mobile 文件要用），但值得知道。
       * 这里不断言，只在有富余时打印，避免噪声。
       */
      const unused = [...bundled].filter((f) => !imported.has(f)).sort()
      if (unused.length) console.log(`  · vendor 里未被 app.js 直接引用：${unused.join(', ')}`)

      /* 每个列出的模块文件都要真实存在，否则复制时静默跳过 */
      const notExist = [...bundled].filter((f) => !existsSync(join(ROOT, 'src', 'shared', f)))
      check('MODULES 里的文件都存在', notExist, [])
    }

    /* ---------- 点击台词与洗牌袋 ---------- */
    {
      /*
       * 用户要求「台词写死但丰富到 100 条」。少了他会立刻察觉在重复。
       * 只数**单击**（最常用的那组）—— 双击/长按是附加的，不该凑数。
       */
      check('单击台词 ≥ 100 条', tapLineCount() >= 100, true)
      const tiers = ['cold', 'warm', 'hot']
      check(
        '三档都有台词',
        tiers.every((t) => (TAP_LINES[t] ?? []).length > 0),
        true,
      )
      /* 同一句不能同时出现在两档里 —— 那说明复制粘贴漏改 */
      const allTap = tiers.flatMap((t) => TAP_LINES[t])
      check('单击台词无重复', allTap.length - new Set(allTap).size, 0)

      /* 档次边界：40 / 120 与 AFFINITY_LEVELS 的「好朋友」「默契搭档」对齐 */
      check('亲密度 0 是冷档', tapTier(0), 'cold')
      check('亲密度 39 还是冷档', tapTier(39), 'cold')
      check('亲密度 40 进熟档', tapTier(40), 'warm')
      check('亲密度 119 还是熟档', tapTier(119), 'warm')
      check('亲密度 120 进热档', tapTier(120), 'hot')

      /*
       * 洗牌袋：**一轮之内绝不重复**。
       *
       * 这条断言是有来历的 —— 初版把「该不该重洗」的判据写成了
       * `bag.length !== pool.length`，而取过一张后袋子自然比池子短，
       * 于是每次都重洗、洗牌袋等于失效（实测取 23 次只覆盖 14 张）。
       * 这种 bug 不报错、只是手感变差，所以必须锁住。
       */
      resetBags()
      const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
      const round = Array.from({ length: pool.length }, () => pickFromBag(pool, 'test'))
      check('洗牌袋一轮内不重复', round.length - new Set(round).size, 0)
      check('洗牌袋一轮覆盖全部', new Set(round).size, pool.length)

      /* 跨轮：继续取不该出错，且仍是池内的元素 */
      const next = pickFromBag(pool, 'test')
      check('洗牌袋跨轮仍取池内元素', pool.includes(next), true)

      /* 池子变了要重洗 —— 否则新池的元素要等旧袋取完才出现 */
      resetBags()
      pickFromBag(['x', 'y'], 'swap')
      const afterSwap = pickFromBag(['p', 'q'], 'swap')
      check('池子变化后重洗', ['p', 'q'].includes(afterSwap), true)

      /* 空池不该崩 */
      check('空池返回空串', pickFromBag([], 'empty'), '')
    }

    /* ---------- 聊天背景的轮换选图 ---------- */
    {
      /*
       * 轮换是**按时间片取模**算的，不存「轮到第几张」。
       * 这条断言守的是「两端算出的一致」—— 逻辑写错会导致
       * 同一时刻 PC 和手机显示不同的背景（它们读同一份 settings）。
       */
      const pool = ['a.png', 'b.png', 'c.png']
      const step = rotateIntervalMs(30)

      check('关模式不选图', pickChatBackground({ mode: ChatBackgroundMode.OFF, fixed: 'x.png' }), '')
      check('固定模式用指定那张', pickChatBackground({ mode: ChatBackgroundMode.FIXED, fixed: 'x.png' }), 'x.png')
      check('轮换模式从池里选', pickChatBackground({ mode: ChatBackgroundMode.ROTATE, pool, now: 0 }), 'a.png')

      /* 时间片推进：每过一个间隔轮一张，转完一圈回到开头 */
      const seq = [0, 1, 2, 3, 4].map((i) =>
        pickChatBackground({ mode: ChatBackgroundMode.ROTATE, pool, now: i * step }),
      )
      check('轮换按时间片依次推进', seq, ['a.png', 'b.png', 'c.png', 'a.png', 'b.png'])

      /* 同一时刻算两次必须一样（无状态） */
      const t = 12345678
      check(
        '同一时刻结果稳定',
        pickChatBackground({ mode: ChatBackgroundMode.ROTATE, pool, now: t }),
        pickChatBackground({ mode: ChatBackgroundMode.ROTATE, pool, now: t }),
      )

      /*
       * 池里剔除不可用的：**先滤再取模**。
       *
       * 反过来（先取模再滤）会在轮到失效那张时空一下 —— 用户没改设置，
       * 背景却闪没了，看起来像 bug。所以关键是「任何时刻都有结果」。
       * 滤掉 b 后池子是 [a, c]，逐个时间片都该有图，且不出现 b。
       */
      const filtered = [0, 1, 2, 3].map((i) =>
        pickChatBackground({ mode: ChatBackgroundMode.ROTATE, pool, available: (p) => p !== 'b.png', now: i * step }),
      )
      check('池里不可用的被滤掉', filtered.includes('b.png'), false)
      check('滤掉之后每个时间片都有图', filtered.every((p) => Boolean(p)), true)
      check('滤掉后按剩下的循环', filtered, ['a.png', 'c.png', 'a.png', 'c.png'])
      check('池子全不可用则不设背景', pickChatBackground({ mode: ChatBackgroundMode.ROTATE, pool, available: () => false }), '')
      check('空池不设背景', pickChatBackground({ mode: ChatBackgroundMode.ROTATE, pool: [] }), '')
      check('固定模式下失效的图被忽略', pickChatBackground({ mode: ChatBackgroundMode.FIXED, fixed: 'x.png', available: () => false }), '')

      /* 时钟回拨（负数时间戳）不能算出负索引 */
      check('时钟回拨不越界', pickChatBackground({ mode: ChatBackgroundMode.ROTATE, pool, now: -1 }), 'c.png')

      /* 间隔钳制：0 / 负数 / 非数字都用默认，超大值封顶 */
      check('间隔 0 用默认', rotateIntervalMs(0), 30 * 60 * 1000)
      check('间隔为负用默认', rotateIntervalMs(-5), 30 * 60 * 1000)
      check('间隔非数字用默认', rotateIntervalMs('x'), 30 * 60 * 1000)
      check('间隔过小被抬到下限', rotateIntervalMs(1), 5 * 60 * 1000)
      check('间隔过大被封顶', rotateIntervalMs(999999), 24 * 60 * 60 * 1000)
    }

    /* ---------- 图鉴类目三方一致 ---------- */
    {
      /*
       * 加「背景图」时踩过：gallery.js 注册了三类，
       * 但 mobile/storage.js 和主进程各维护一张键名表，
       * 只改了一处 -> 手机端直接抛「未知的图鉴类型: background」。
       *
       * 现在键名表已收归 shared/gallery.js 一份。这条断言锁住
       * 「键名表必须覆盖所有类目」，加类目忘了登记键名会当场红。
       */
      const keyed = Object.keys(GALLERY_KEYS)
      const missingKeys = GALLERY_KINDS.filter((k) => !keyed.includes(k))
      check('每个图鉴类目都有存储键名', missingKeys, [])
      const extraKeys = keyed.filter((k) => !GALLERY_KINDS.includes(k))
      check('没有多余/失效的键名条目', extraKeys, [])

      /* 键名不能撞车，否则两类共用一份数据 */
      const all = Object.values(GALLERY_KEYS).flatMap((k) => [k.list, k.mem])
      check('存储键名互不重复', all.length - new Set(all).size, 0)
    }

    /* ---------- 聊天关键词 -> 动作 ---------- */
    {
      /*
       * 手机端会在用户发消息时本地匹配关键词，命中就切立绘演 5 秒。
       * 两条最容易出错的：① 映射到不存在的表情 -> 空白立绘
       *                ② 关键词太宽 -> 随便一句都触发，看着像卡住
       */
      const emoteKeys = new Set(PET_EXPRESSIONS_KEYS)
      const badEmote = CHAT_ACTION_RULES.filter((r) => !emoteKeys.has(r.emote)).map((r) => r.emote)
      check('关键词规则都指向存在的表情', badEmote, [])

      /* 每条规则必须有关键词，且不能有空串（空串 includes 恒真 -> 全触发） */
      const noWords = CHAT_ACTION_RULES.filter((r) => !Array.isArray(r.any) || !r.any.length).map((r) => r.emote)
      check('每条规则都有关键词', noWords, [])
      const emptyWord = []
      for (const r of CHAT_ACTION_RULES) {
        for (const w of r.any) if (!String(w).trim()) emptyWord.push(`${r.emote}:"${w}"`)
      }
      check('没有空关键词（会全命中）', emptyWord, [])

      /* 权重去重：同一 emote 不该出现两条规则（合并成一条更清楚） */
      const dupEmote = []
      const seenEmote = new Set()
      for (const r of CHAT_ACTION_RULES) {
        if (seenEmote.has(r.emote)) dupEmote.push(r.emote)
        seenEmote.add(r.emote)
      }
      check('每种动作只有一条规则', dupEmote, [])

      /*
       * 冷却：同一动作 20 秒内不重复触发。
       * 用固定时间戳避开「跑测试时真的过了 20 秒」这种不稳定。
       */
      const t0 = 1_700_000_000_000
      check('首次命中', chatActionFor('笑死我了哈哈哈', t0), 'laugh')
      check('20 秒内同动作不重复', chatActionFor('哈哈哈好好笑', t0 + 5000), null)
      check('超过 20 秒可再次触发', chatActionFor('哈哈哈哈', t0 + 21_000), 'laugh')
      check('不同动作互不影响', chatActionFor('我好难过想哭', t0 + 1000), 'cry')
      /* 权重：一句话同时像好几条时取权重最高的 */
      check('命中取权重最高的', chatActionFor('哈哈哈笑死 但我好难过想哭', t0 + 60_000), 'laugh')
      /* 无关的话不该触发 */
      check('无关内容不触发', chatActionFor('今天天气还行', t0 + 90_000), null)
      check('空输入不触发', chatActionFor('', t0 + 90_000), null)
    }

    /* 表情注册表：每个 key 都要能映射到实际存在的文件 */
    const allKeys = [...MOOD_KEYS, ...EMOTE_KEYS]
    /* 数量跟着素材走：动作 24 = 状态 4 + 表情 20 */
    check('表情 key 数量', allKeys.length, PET_EXPRESSIONS_KEYS.length)
    check('状态类 4 个', MOOD_KEYS.length, 4)
    check('表情类数量 = 动作总数 - 状态数', EMOTE_KEYS.length, PET_EXPRESSIONS_KEYS.length - MOOD_KEYS.length)
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

    /* ---------- 亲密度：得分规则（上限 + 每日总额度） ---------- */
    check('满级后不再涨点', affinityGain({ points: AFFINITY_MAX_POINTS }, 5, '2026-09-21'), 0)
    check('接近上限时被截断', affinityGain({ points: AFFINITY_MAX_POINTS - 2 }, 5, '2026-09-21'), 2)
    check('正常加点', affinityGain({ points: 0 }, AFFINITY_GAIN.pet, '2026-09-21'), AFFINITY_GAIN.pet)
    check('零和负数不加点', affinityGain({ points: 0 }, 0, '2026-09-21'), 0)

    /*
     * 每日额度：**所有来源合计**封顶（原来是「只封聊天」）。
     *
     * 改的原因：只封聊天时，一直点立绘能无限涨 ——
     * 一天点 300 下就能从「有点眼熟」冲到「默契搭档」，
     * 等级推进完全失去节奏。
     */
    const capUsed = { points: 10, gainDay: '2026-09-21', gainToday: AFFINITY_DAILY_CAP }
    check('额度用尽后聊天不加分', affinityGain(capUsed, 3, '2026-09-21'), 0)
    check('额度用尽后点击也不加分', affinityGain(capUsed, AFFINITY_GAIN.click, '2026-09-21'), 0)
    check('跨天后额度重置', affinityGain(capUsed, 3, '2026-09-22'), 3)
    check('额度快满时按剩余给', affinityGain({ points: 10, gainDay: '2026-09-21', gainToday: 59 }, 3, '2026-09-21'), 1)
    /* 旧字段（chatDay/chatToday）仍要能读到，否则升级当天的额度会凭空多出来 */
    check(
      '旧的聊天计数字段仍被识别',
      affinityGain({ points: 10, chatDay: '2026-09-21', chatToday: AFFINITY_DAILY_CAP }, 3, '2026-09-21'),
      0,
    )

    /* ---------- 亲密度：下降机制 ---------- */
    check('刚互动过不衰减', affinityDecay({ points: 100, lastActive: '2026-09-21' }, '2026-09-21'), 0)
    check('宽限期内不衰减', affinityDecay({ points: 100, lastActive: '2026-09-21' }, '2026-09-24'), 0)
    check(
      '超过宽限期后按天扣',
      affinityDecay({ points: 100, lastActive: '2026-09-21' }, '2026-09-26'),
      2 * AFFINITY_DECAY.IDLE_PER_DAY,
    )
    /* 已结算过的天数不再重复扣 —— 否则同一天里每次互动都扣一遍 */
    check(
      '已结算的不重复扣',
      affinityDecay({ points: 100, lastActive: '2026-09-21', decaySettledDays: 2 }, '2026-09-26'),
      0,
    )
    check('没有 lastActive 不衰减', affinityDecay({ points: 100 }, '2026-09-26'), 0)

    /* 惹她生气的判定：只认「针对她」的冒犯 */
    check('骂她算惹生气', isUpsetting('讨厌你'), true)
    check('赶她走算惹生气', isUpsetting('别烦我'), true)
    /* 关键：用户自己诉苦**不能**被算成惹她生气（那该被安慰） */
    check('用户自己委屈不算惹她', isUpsetting('今天好委屈'), false)
    check('用户自己难过不算惹她', isUpsetting('我想哭'), false)
    check('普通聊天不算惹她', isUpsetting('今天天气不错'), false)

    const before = (await service.affinity()).points
    await service.addAffinity(7)
    check('亲密度累加', (await service.affinity()).points, before + 7)
    check('连续天数为 1', (await service.affinity()).streakDays, 1)
    check('getState 带亲密度', (await service.getState()).affinity.points, before + 7)
    /*
     * 上限：到顶后继续互动不再涨，避免等级卡在最后一档还以为在涨。
     *
     * 注意**要跨多天**：现在每日额度是 60 点（全来源合计），
     * 同一天里怎么加都上不去 —— 这正是额度的作用。
     * 早先这条写成「一天连加 400 次」，加了额度之后自然失败。
     */
    for (let day = 0; day < 10; day++) {
      const d = new Date(2026, 8, 21 + day, 14, 0)
      /* 第 4 个参数是「时间」——不传的话每天都是同一天，测不出跨天重置 */
      for (let i = 0; i < 20; i++) await service.addAffinity(10, {}, null, d)
    }
    check('亲密度封顶', (await service.affinity()).points, AFFINITY_MAX_POINTS)
    check('封顶后 isMax', (await service.affinity()).isMax, true)
    await service.resetAffinity()
    check('重置归零', (await service.affinity()).points, 0)
    check('重置清空当日额度', (await service.affinity()).gainToday ?? 0, 0)
  }

  /* ---------- 16b. 聊天记亲密度 ---------- */
  {
    await service.resetAffinity()
    /*
     * 对话是提升亲密度最主要的途径，必须真的落库。
     * 用假接口时会失败，所以只验证「记账」这一步本身。
     */
    const before = (await service.affinity()).points
    const chatSession = await service.ensureChatSession()
    await service.addChatMessage(chatSession.id, 'user', '在吗')
    await service.addAffinity(AFFINITY_GAIN.chatMessage, { kind: 'chat' })
    check('聊天加分生效', (await service.affinity()).points, before + AFFINITY_GAIN.chatMessage)
    check('聊天计入当日额度', (await service.affinity()).gainToday, AFFINITY_GAIN.chatMessage)

    /*
     * 额度用完后再聊不加分 —— 且**点击也不行**。
     * 这是这次改动的重点：原来只封聊天，导致一直点立绘能无限刷。
     */
    await service.addAffinity(AFFINITY_DAILY_CAP * 10, { kind: 'chat' })
    const capped = (await service.affinity()).points
    check('当日额度封顶', (await service.affinity()).gainToday, AFFINITY_DAILY_CAP)
    await service.addAffinity(AFFINITY_GAIN.chatMessage, { kind: 'chat' })
    check('额度用尽后聊天不加分', (await service.affinity()).points, capped)
    await service.addAffinity(AFFINITY_GAIN.click)
    check('额度用尽后点击也不加分', (await service.affinity()).points, capped)

    /* meta 要下发规则，否则设置页只能写死文案 */
    const meta = await service.meta()
    check('meta 带亲密度等级表', meta.affinity.levels.length, affinityLevel(0).level ? 5 : 0)
    check('meta 带每日额度', meta.affinity.dailyCap, AFFINITY_DAILY_CAP)
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
     * 这套断言原先针对的是**视频**图鉴。视频已整体移除，
     * 但它守的两类真实故障与装扮同样成立 —— 所以移到这里继续守：
     *
     *   ① 只叫了一下她的名字（如「yuki 好乖」）就解锁了内容 ——
     *      根因是关键词里残留单字（"乖"）与泛词（"可爱"）。
     *   ② 「清晨刚醒」那段 anytime 都解锁 —— 根因是数据里写了
     *      `hoursBefore`，判定里却没实现，条件形同虚设。
     *      （装扮这份原本也只实现了 hoursAfter，已一并补上。）
     *
     * 按「会被误触发」和「条件必须真的生效」两个角度守住。
     */
    const { keywordCandidates, conditionUnlocks } =
      await import('../src/shared/outfitStories.js')

    /* ① 单字/泛词不能再当关键词 */
    const tooShort = []
    for (const [slug, d] of Object.entries(OUTFIT_STORIES)) {
      for (const k of d.keywords ?? []) {
        if (k.length <= 1) tooShort.push(slug + ':' + k)
      }
    }
    check('装扮关键词无单字（易误命中）', tooShort, [])

    /* ② 叫名字 + 泛泛的情绪词不该命中 */
    for (const t of ['yuki', 'yuki 好乖', 'yuki 你好可爱', '在吗 yuki']) {
      check(`「${t}」不该触发装扮`, keywordCandidates(t, []), [])
    }

    /* ③ 具体的请求必须能命中（别收得太死导致永不触发） */
    check('「穿旗袍给我看」能命中装扮', keywordCandidates('穿旗袍给我看', [], 300).length > 0, true)
    /* 亲密度不够时**不该**进候选 —— 挡在最省的地方，不白花一次模型调用 */
    check('亲密度不够不进候选', keywordCandidates('穿旗袍给我看', [], 0), [])

    /* ④ 时段条件必须真的生效 —— hoursBefore 曾漏实现 */
    check(
      '凌晨 2 点不触发「睡衣」(23点后)',
      conditionUnlocks({ hour: 2, points: 0 }, []).includes('pajamas'),
      false,
    )
    check(
      '已解锁的不重复',
      conditionUnlocks({ hour: 23, points: 0 }, ['pajamas']).includes('pajamas'),
      false,
    )

    /*
     * ⑤ 每个 condition 字段都必须真的被判定读到。
     *
     * 这是 ④ 的推广：与其一个个字段手写断言，不如**扫描数据里用到的
     * 字段**，与条件函数的实现比对 —— 新加字段忘了实现会立刻红。
     */
    const USED_CONDITION_FIELDS = new Set([
      ...Object.values(OUTFIT_STORIES)
        .filter((d) => d.unlock === 'condition')
        .flatMap((d) => Object.keys(d.condition ?? {})),
    ])
    const HANDLED = new Set(['minPoints', 'hoursAfter', 'hoursBefore', 'restDayOnly'])
    const unhandled = [...USED_CONDITION_FIELDS].filter((f) => !HANDLED.has(f))
    check('装扮条件字段都已被 conditionUnlocks 实现', unhandled, [])

    /*
     * ⑥ story 必须进判断提示词。
     *
     * 它一度只用于图鉴展示，模型看不到 —— 于是「演到哪一幕」全靠 hint 猜，
     * 用户精心写的剧情完全没起作用。
     */
    const { buildStoryJudgePrompt } = await import('../src/shared/outfitStories.js')

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
