/**
 * 换装状态 —— 桌宠窗 / 对话旁立绘窗 / 右键菜单 / 对话窗共用的同一套逻辑。
 *
 * 之前这段逻辑复制了 4 份，且已经出现行为分叉：对话窗的求值点漏了
 * 「未解锁回落」守卫，直接写 settings 就能让它显示未解锁的服饰。
 * 收敛到一处，守卫规则只有一份：
 * - 展示求值点必须带守卫 —— settings 的写入口不止换装菜单
 *   （设置页、IPC、重置都会写），只在菜单挡是绕得过去的；
 * - 可换清单只列已解锁的；
 * - 图鉴未就绪时保守视为「只有初始那套」，宁可少显示也不漏守卫。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { DEFAULT_OUTFIT, OUTFITS, OUTFIT_SLUGS, outfitForTime, outfitInfo } from '@shared/interactions.js'
import { saveSettings, state } from '../stores/app.js'

export function useOutfitState() {
  /** 每分钟对一次时间：自动换装要跨过时段边界（23:00 该换睡衣） */
  const clockTick = ref(Date.now())
  let clockTimer = null
  clockTimer = window.setInterval(() => (clockTick.value = Date.now()), 60_000)
  onBeforeUnmount(() => {
    if (clockTimer) window.clearInterval(clockTimer)
  })

  /** 已解锁的服饰集合 */
  const unlockedOutfits = computed(() => {
    const list = state.gallery?.outfit?.unlocked
    return new Set(Array.isArray(list) ? list : [DEFAULT_OUTFIT])
  })

  const currentOutfitSlug = computed(() => {
    /*
     * 自动模式**必须把已解锁池传进去**：`outfitForTime(now)` 在没有池子时
     * 直接回落默认那套（自动模式恒为 JK）。合并前 4 个调用点各自传池，
     * 收敛到本模块后由这里统一传 —— 调用点不用再关心。
     */
    if (state.settings.outfitMode !== 'fixed')
      return outfitForTime(new Date(clockTick.value), [...unlockedOutfits.value])
    const s = state.settings.outfitSlug
    if (!OUTFIT_SLUGS.includes(s)) return DEFAULT_OUTFIT
    /* 未解锁的一律回落到默认（守卫在求值点，写入口再多也绕不过） */
    if (!unlockedOutfits.value.has(s)) return DEFAULT_OUTFIT
    return s
  })

  const currentOutfitLabel = computed(() => outfitInfo(currentOutfitSlug.value).label)

  /** 可换清单：只列已解锁的（列全量等于绕过图鉴） */
  const outfits = computed(() => OUTFITS.filter((o) => unlockedOutfits.value.has(o.slug)))

  /**
   * 选中一套即固定；选「跟随时间」恢复自动（null 表示自动）。
   * 菜单没列出来的也不能选（再挡一道）。
   */
  async function chooseOutfit(slug) {
    if (slug === null) {
      await saveSettings({ outfitMode: 'auto' })
      return
    }
    if (!unlockedOutfits.value.has(slug)) return
    await saveSettings({ outfitMode: 'fixed', outfitSlug: slug })
  }

  return { clockTick, unlockedOutfits, currentOutfitSlug, currentOutfitLabel, outfits, chooseOutfit }
}
