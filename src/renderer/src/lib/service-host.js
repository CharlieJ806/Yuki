/**
 * pet 窗业务宿主 —— service 在 Tauri 运行时的家（TAURI_MIGRATION.md §2.2 决策 1）。
 *
 * 桌宠是常驻单例（hide 不销毁 + 托盘兜底重建），业务层随它存活：
 * 本模块只在该窗口装载（main.js 按 route=pet 动态 import），职责：
 *   1. 打开桥接数据层 → 组装 service → 注册业务通道表（与 Electron 同一张表）
 *   2. 挂总线宿主（其他窗口的业务调用经 bus:req 进来）
 *   3. service.onChange → `desk:event` 全窗广播（对齐 Electron broadcast 语义）
 *   4. 托盘：接 `tray:checkin` 打卡指令；每次 state 变更推送托盘快照文案
 *   5. 启动补齐：节假日表、置顶设置回放
 */
import { createService } from '../../../main/service.js'
import { createIpcHandlers } from '../../../main/ipc-handlers.js'
import { openStoreBridge } from '@shared/bridge/store-bridge.js'
import { SELF_PORTRAIT_SLUG } from '@shared/content.js'
import { installTauriTransport } from './tauri-transport.js'
import { installServiceBusHost } from './service-bus.js'

/** 参考图（对话自画像注入）：资源与渲染层同源，直接 fetch 转 data URL */
async function loadSelfPortrait() {
  try {
    const res = await fetch(`./yuki-${SELF_PORTRAIT_SLUG}.png`)
    if (!res.ok) return ''
    const blob = await res.blob()
    return await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => resolve('')
      reader.readAsDataURL(blob)
    })
  } catch {
    /* 没有参考图也能正常聊，不该因此让对话整个失败 */
    return ''
  }
}

export async function bootServiceHost() {
  const { invoke } = window.__TAURI__.core
  const { emit, listen } = window.__TAURI__.event

  /* chat.js/holiday.js 的 HTTP 全部改走 Rust 代理（CORS/UA 缺口，见模块注释），
     必须在 service 起来之前装好——首帧 ensureHolidays 就要发网络请求 */
  installTauriTransport()

  const store = openStoreBridge()
  await store.ready
  const service = createService(store, { loadSelfPortrait })

  /* createIpcHandlers 直接返回通道表（Electron 侧 Object.entries 同一形态） */
  const handlers = createIpcHandlers(service, {
    /* 重置会把 petScale 恢复成 1，窗口尺寸必须跟着回去（热区对齐） */
    onAfterReset: (next) => invoke('pet_set_scale', { scale: next.settings.petScale }),
  })

  /* 总线宿主 + pet 窗内直调入口（desk-shim 优先走它，不经事件绕行） */
  installServiceBusHost(handlers)
  window.__DESK_BUS_HOST__ = {
    call: (channel, ...args) => {
      const fn = handlers[channel]
      if (typeof fn !== 'function') return Promise.reject(new Error(`未知业务通道: ${channel}`))
      return fn(...args)
    },
  }

  /* 广播语义对齐 Electron：service 事件 → 全窗 desk:event（payload 结构不变） */
  service.onChange((event, payload) => {
    emit('desk:event', { event, payload }).catch(() => {})
    if (event === 'state') pushTraySnapshot(payload).catch(() => {})
  })

  /* 托盘「打卡」→ 业务执行者 */
  listen('tray:checkin', () => {
    service.checkIn().catch(() => {})
  }).catch(() => {})

  async function pushTraySnapshot(state) {
    if (!state) return
    await invoke('tray_update_snapshot', {
      earnedLine: `今日已摸鱼赚到 ${state.todayEarnedText}`,
      daysLine: `累计摸鱼 ${state.days} 天 · ${state.level?.level?.name ?? ''}`,
      checkedIn: Boolean(state.checkedInToday),
    })
  }

  /* 启动补齐：节假日表（失败退回周末规则，不阻塞）；置顶设置回放；
     首帧 state 推一次（窗口就绪的渲染端立即可见） */
  await service.ensureHolidays().catch(() => {})
  emit('desk:event', { event: 'state', payload: await service.getState() }).catch(() => {})
  await pushTraySnapshot(await service.getState()).catch(() => {})
  const settings = await service.getSettings()
  await invoke('pet_set_always_on_top', { flag: Boolean(settings.petAlwaysOnTop) }).catch(() => {})

  /* 门控放行：启动早于本宿主的窗口（少见）收到广播即知就绪；
     之后才创建的窗口靠客户端 bus:ping 探测（见 service-bus.js） */
  await emit('bus:ready').catch(() => {})
  return service
}
