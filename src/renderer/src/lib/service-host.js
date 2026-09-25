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
  /* 照片存在性：正式包里照片内嵌进二进制、dev 由 vite 服务——都无法同步
     查文件系统。启动时一次性拉全表缓存成 Set，deps.photoExists 做同步查询
     （service 的判断接口是同步的：在 gallery 的 filter 里逐个调用）。
     表未返回时 Set 为空，界面优雅退回立绘，不影响功能。 */
  const photoSet = new Set(await invoke('photo_list').catch(() => []))
  const service = createService(store, {
    loadSelfPortrait,
    photoExists: (kind, slug, relPath) => photoSet.has(relPath),
  })

  /* createIpcHandlers 直接返回通道表（Electron 侧 Object.entries 同一形态）。
     petScale 归位后的窗口贴合由渲染层 ResizeObserver 自动完成，壳层无需接手 */
  const handlers = createIpcHandlers(service)

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
  /* 启动补齐：节假日表走网络——不能 await（无网/慢网时拉取长时间 pending，
     会把 bus:ready 与渲染层首帧 state 一起拖住 15s+，桌宠窗无法贴合、
     面板拿不到数据）；失败退回周末规则。完成后补广播一次 state，
     节假日语义（状态文案/补卡日历）自动更新。 */
  service
    .ensureHolidays()
    .then((r) => {
      if (r?.ok) console.log(`[desk-pet] 节假日表就绪（${r.count} 天${r.cached ? '，来自缓存' : ''}）`)
      return service.getState()
    })
    .then((state) => emit('desk:event', { event: 'state', payload: state }).catch(() => {}))
    .catch(() => {})
  emit('desk:event', { event: 'state', payload: await service.getState() }).catch(() => {})
  await pushTraySnapshot(await service.getState()).catch(() => {})
  const settings = await service.getSettings()
  await invoke('pet_set_always_on_top', { flag: Boolean(settings.petAlwaysOnTop) }).catch(() => {})

  /* 开机自启对账：注册表记的是 exe 绝对路径，便携目录挪动后失效；
     意图在 settings.autoStart，这里按意图重写一次（幂等，兼自愈）。
     意图关且系统本就关时不碰注册表；系统调用失败不阻塞启动。
     desk-shim 是 main.js 首位 import，window.desk 此处必然已就绪。 */
  try {
    const wantAutoStart = Boolean(settings.autoStart)
    if (wantAutoStart || (await window.desk.autostartGet())) {
      await window.desk.autostartSet(wantAutoStart)
    }
  } catch (err) {
    console.warn('[service-host] 开机自启对账失败:', err)
  }

  /* 门控放行：启动早于本宿主的窗口（少见）收到广播即知就绪；
     之后才创建的窗口靠客户端 bus:ping 探测（见 service-bus.js） */
  await emit('bus:ready').catch(() => {})
  return service
}
