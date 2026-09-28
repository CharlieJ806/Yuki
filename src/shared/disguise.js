/**
 * 偷偷摸摸模式（studyDisguise）—— 学习化渲染的单一出口。
 *
 * 第一性：伪装是「渲染策略」，必须在数据格式化的唯一出口（service 组装
 * state 文本字段）生效，而不是各组件就地三元判断——组件各自打补丁必然
 * 漏（历史上 6 处金额露出点全部漏过）。任何表面只要消费 state 文本字段
 * 或 surfaceText() 词汇表，就自动被覆盖。
 *
 * 语义（方案 A）：伪装开启后任何界面都不出现真实金额，要看钱就关开关。
 * 威胁模型是「路过者扫屏幕内容」：托盘 tooltip / 进程名 / 安装名里的
 * 「摸鱼桌宠」属于系统身份，无法伪装也不在此范围。
 *
 * 桌宠台词（台词库 / LLM 现编）不含在本模块：涉及「提示词稳定在前」约束，
 * 二期随对话提示词单独做。
 */

/** 伪装态的每日学习目标（词）：金额按「今日已赚 ÷ 日薪」线性映射到 0–目标词数 */
export const STUDY_DAILY_WORDS = 1000
export const STUDY_DAILY_TARGET = `${STUDY_DAILY_WORDS} 词`
export const STUDY_SALARY_MASK = '***'

/**
 * 金额 → 学习进度文案。
 * dailySalary 非正（配置为 0 / 脏数据）时退化为「封顶到目标」的保守值，
 * 避免除零出 Infinity。
 */
export function formatStudyProgress(todayEarned, dailySalary) {
  const earned = Number(todayEarned) || 0
  const daily = Number(dailySalary) || 0
  const words =
    daily > 0
      ? Math.round((earned / daily) * STUDY_DAILY_WORDS)
      : Math.min(Math.round(earned), STUDY_DAILY_WORDS)
  return `${words} 词`
}

/** 等级名学习化：LEVELS 里的「摸鱼」字样按词替换（职场萌新等本就干净的保持原样） */
export function studyLevelName(name) {
  return String(name ?? '').replace(/摸鱼/g, '学习')
}

/**
 * 可见文案词汇表：组件按 key 取文案，不再就地三元判断。
 * 新增可见文案先来这里登记——smoke 锁「伪装态可见文本不得含 摸鱼/已赚/¥」，
 * 漏登记的文案进不了这张表就会被测试抓出来。
 */
export const SURFACE_TEXT = {
  normal: {
    earnedTitle: '今日摸鱼收入',
    working: '摸鱼进行中',
    done: '今日已赚满 💰',
    doneShort: '今日已赚满',
    restDay: '今日休息，安心躺平',
    restDayShort: '今日休息',
    beforeWork: '尚未开工',
    disabled: '摸鱼进度未开启',
    earnedLabel: '今日摸鱼收入',
    workedLabel: '已摸鱼时长',
    totalLabel: '累计摸鱼',
    incomeDetail: '摸鱼收入详情',
    dailySalaryLabel: '日薪',
    monthlySalary: null, // 正常态显示真实月薪（salaryText）
    brand: '摸鱼桌宠',
    tagline: '只要胆子大，一周七天假',
    heroQuotes: [
      '为工资摸鱼，为自由争命。',
      '人在职场，摸鱼第一。老板是虚无的，工作是浮云，只有摸鱼才是实实在在的快乐。',
      '偷闲，是对生活的润滑剂。',
      '今天的努力，是为了明天更好地摸鱼。',
      '摸鱼不是偷懒，是在给生产力做保养。',
      '上班是为了活着，摸鱼是为了像个人。',
      '工资照发，鱼照摸，这是成年人的体面。',
    ],
    trayEarned: (earnedText) => `今日已摸鱼赚到 ${earnedText}`,
    trayTotal: (days, levelName) => `累计摸鱼 ${days} 天 · ${levelName}`,
  },
  study: {
    earnedTitle: '今日学习进度',
    working: '学习进行中',
    done: '今日目标达成 🎯',
    doneShort: '今日目标达成',
    restDay: '今日休息，安心躺平',
    restDayShort: '今日休息',
    beforeWork: '尚未开工',
    disabled: '进度未开启',
    earnedLabel: '今日学习进度',
    workedLabel: '已学习时长',
    totalLabel: '累计学习',
    incomeDetail: '学习进度详情',
    dailySalaryLabel: '今日目标',
    monthlySalary: STUDY_SALARY_MASK, // 伪装态月薪打码（日薪已是词数目标，无需打码）
    brand: 'Study Desk',
    tagline: '专注当下，持续精进',
    heroQuotes: [
      '专注当下，学习是最好的长期主义。',
      '今天的每一个知识点，都在为将来铺路。',
      '稳步前进，不慌不忙。',
      '积累从每天一页开始。',
      '保持节奏，剩下的交给时间。',
      '把难度拆小，把专注拉长。',
    ],
    /* 学习化等级名（studyLevelName），不露「摸鱼」字样 */
    trayEarned: (earnedText) => `今日已学习 ${earnedText}`,
    trayTotal: (days, levelName) => `累计学习 ${days} 天 · ${studyLevelName(levelName)}`,
  },
}

/** 按开关取对应文案表 */
export function surfaceText(disguise) {
  return disguise ? SURFACE_TEXT.study : SURFACE_TEXT.normal
}
