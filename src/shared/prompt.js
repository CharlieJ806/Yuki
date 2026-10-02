/**
 * system 提示词组装 —— 稳定块 + 易变块，**两端共用一份**。
 *
 * ## 为什么这个文件在 shared 而不是 src/main/chat.js
 *
 * 它原来住在 `src/main/chat.js`，但注释里写着「手机端 mobile/chat.js 直接调它」——
 * 而手机端**根本 import 不到**：`src/main/*` 是主进程代码（依赖 electron / node
 * 传输层），手机端是纯浏览器 PWA，构建脚本只把 `src/shared/*` 摊进
 * `mobile/vendor/`（见 mobile/build.js）。
 *
 * 于是那句注释是假的：手机端只好把同样的逻辑自己拼了一遍
 * （`[clock, relation].filter(Boolean).join('\n\n')`），两端各写一份。
 * 这正是「桌面改了、手机漏了」那类不一致的温床 —— 表现为同一份人设
 * 两端两个性格，而手机上看起来一切正常（她只是永远演最低档）。
 *
 * 所以把组装逻辑放到 shared：桌面 `src/main/chat.js` 与手机
 * `mobile/chat.js` 都从这里 import，改一处两端同时生效。
 *
 * ## 依赖方向
 *
 * 只依赖 `./moyu.js`（人设表 / 时间块）与 `./interactions.js`（档位视图）。
 * `moyu.js` 刻意不反向依赖 interactions（它在注释里写明档位计算不放在
 * 自己身上），所以这里不会形成循环。
 */

import { timeContextFor, affinityContextFor } from './moyu.js'
import { affinityView } from './interactions.js'

/**
 * 组装 system 提示词：**稳定内容在前，易变内容在后**。
 *
 * 这是为了命中 DeepSeek 的前缀缓存（命中价 $0.003/M vs 未命中 $0.15/M，差 50 倍）。
 * 前缀缓存是「从头逐字匹配」的 —— 开头一变，后面全部重算。
 *
 * 所以顺序必须是：
 *   [人设 / 固定提示词][易变块：时间块 + 关系块]
 *                     ↑ 时间块每分钟变、关系块每轮可能变，
 *                       但它们都在最后，不影响前面命中缓存
 *
 * 之前是反过来（时间块在最前），后果是 1560 字的人设**每轮都按未命中价重算**，
 * 实测这部分的费用是命中价的 50 倍。
 *
 * 易变块之间**顺序无所谓**（都在人设之后，前缀命中只看到人设结束为止），
 * 这里固定成「时间块 → 关系块」：时间块是每轮都变的，关系块只在档位
 * 变化时才变，把变得最勤的放最后，命中区间能多覆盖一点。
 *
 * @param {string} stable   稳定部分（人设 / 专用提示词）
 * @param {string} volatile 易变部分（时间块、关系块）；为空时只返回 stable
 */
export function composeSystemPrompt(stable, volatile = '') {
  const a = String(stable ?? '')
  const b = String(volatile ?? '')
  if (!b) return a
  if (!a) return b
  return `${a}\n\n${b}`
}

/**
 * 拼出本次请求的**易变块**（人设之后那一段）。
 *
 * 时间块 + 关系块都在这里，两端（桌面 / 手机）共用同一个函数，
 * 免得「两端各写一遍、改一处漏一处」。
 *
 * **挂机台词 / 主动搭话也走它**：那条路径的 system 是专用提示词
 * （CHATTER_SYSTEM_PROMPT / TOPIC_SYSTEM_PROMPT）而不是人设，但同样
 * 需要时间和档位 —— 不带时间她会在清晨冒一句「吃午饭了吗」，
 * 不带档位则一个刚认识的人也会说出「今天也想和你多待一会儿」。
 *
 * @param {object} runtime  运行时上下文
 * @param {number} [runtime.affinityPoints] 当前会话的亲密度点数
 * @param {boolean}[runtime.godMode]        上帝模式（读时覆盖成最高档）
 * @param {Date}   [runtime.now]
 * @param {boolean}[runtime.isRestDay]
 * @param {boolean}[runtime.withClock]       false = 不注入时间块（自检/测试用）
 * @param {boolean}[runtime.withAffinity]    false = 不注入关系块（自检/测试用）
 */
export function volatileContextFor(settings, runtime = {}) {
  const blocks = []

  const clock =
    runtime.withClock === false
      ? ''
      : timeContextFor(runtime.now ?? new Date(), {
          workStart: settings.workStart,
          workEnd: settings.workEnd,
          isRestDay: runtime.isRestDay,
        })
  if (clock) blocks.push(clock)

  /*
   * 关系块：把「她现在处在哪一档」告诉模型。
   *
   * 人设里那张档位表是**静态**的 —— 不注入当前档位，模型不知道自己在哪一格，
   * 只会按最高档（或随机一档）演。所以这一行是档位表生效的前提。
   *
   * `runtime.affinityPoints` 未传时按 0 算（等价于最低档）。
   * 不这么做的话，「忘了传 points」会静默变成「没有任何档位提示」，
   * 人设里的档位表又变成摆设 —— 宁可默认成最低档这种可观察的错。
   */
  if (runtime.withAffinity !== false) {
    const points = Math.max(0, Number(runtime.affinityPoints) || 0)
    const view = affinityView(points, runtime.godMode === true)
    const affinity = affinityContextFor(points, {
      name: view.level?.name,
      next: view.next,
      isMax: view.isMax,
      godMode: view.godMode === true,
    })
    if (affinity) blocks.push(affinity)
  }

  return blocks.join('\n\n')
}
