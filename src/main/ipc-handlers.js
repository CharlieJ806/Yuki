/**
 * IPC 业务通道表 —— Electron ipcMain.handle 与 Tauri serviceBus 宿主**共用同一张表**，
 * 是两条运行时行为一致的基石（TAURI_MIGRATION.md §2.2 决策 4）。
 *
 * 范围：只含业务类通道（state/checkin/settings/session/…/chat）。
 * 窗口/系统类（window:* / pet:* / chat:openWindow 等）**不在这里**——
 * 窗口状态只有壳层知道：Electron 在 src/main/index.js，Tauri 在 Rust command。
 *
 * service 层全异步，表里的每个处理器都是 async；
 * Electron 的 ipcMain.handle 与总线宿主都会自动 await。
 *
 * @param {object} service createService() 实例
 * @param {object} [hooks] 壳层差异的注入点
 * @param {(state) => void} [hooks.onAfterReset] 重置设置后由壳层同步窗口尺寸等
 */
export function createIpcHandlers(service, hooks = {}) {
  /*
   * 当前活跃会话 id —— 桌宠跟着它走（换装/亲密度都按会话隔离）。
   *
   * 桌宠是常驻窗，自己不知道用户正在聊哪个会话，所以由对话窗切换时
   * 通过 IPC 告知。**持久化**到 meta：重启后桌宠应该还是同一个她，
   * 不能每次开机都回落到「第一个会话」。
   *
   * touched 防覆盖竞态：setActive 先于 meta 恢复完成时，
   * 恢复结果不得反写刚设置的新值。
   */
  let activeSessionId = null
  let activeSessionTouched = false
  const restoreActive = service
    .getMeta('activeSessionId', null)
    .then((v) => {
      if (!activeSessionTouched) activeSessionId = v ?? null
    })
    .catch(() => {})

  return {
    /* 只读状态 */
    'state:get': () => service.getState(),
    'meta:get': () => service.meta(),

    /* 打卡 */
    'checkin:create': () => service.checkIn(),
    'checkin:list': (args) => service.listCheckins(args ?? {}),

    /* 补卡：先预览再确认写入 */
    'backfill:preview': (fromKey) => service.previewBackfill(fromKey),
    'backfill:apply': (fromKey) => service.applyBackfill(fromKey),

    /* 设置 */
    'settings:update': (patch, sessionId) => service.updateSettings(patch, sessionId),
    'settings:reset': async () => {
      const next = await service.resetSettings()
      /* service 已广播 state；petScale 归位等窗口动作由壳层接手 */
      await hooks.onAfterReset?.(next)
      return next
    },

    /* 桌宠窗本地行为指令（气泡开关/退出挥手）：菜单窗发出，广播给全窗，桌宠窗消费 */
    'ui:pet': (action) => service.emit('pet-ui', { action }),

    /*
     * 当前活跃会话 —— 桌宠跟它走。
     * 写 meta 持久化；广播经 service.emit 走 onChange 桥（各壳负责真正投递）。
     */
    'session:getActive': async () => {
      await restoreActive
      return activeSessionId
    },
    'session:setActive': async (sessionId) => {
      activeSessionTouched = true
      activeSessionId = sessionId ?? null
      /* 记不上不影响本次运行 */
      try {
        await service.setMeta('activeSessionId', activeSessionId)
      } catch {}
      /* 广播给所有窗口：桌宠要跟着换衣服、面板要刷新图鉴 */
      service.emit('session-active', { sessionId: activeSessionId })
      return activeSessionId
    },

    /* 逐会话状态：渲染端切换会话时必须传 sessionId */
    'session:affinity': (sessionId) => service.sessionAffinity(sessionId),
    'session:settings': (sessionId) => service.sessionSettings(sessionId),
    'session:setSetting': (sessionId, key, value) => service.setSessionSetting(sessionId, key, value),
    'gallery:get': (sessionId) => service.sessionGallery(sessionId),
    'gallery:clear': (sessionId) => service.clearSessionGallery(sessionId),
    'gallery:explain': (text, sessionId) => service.explainTriggers(text, sessionId),

    /* 摸鱼时长记账 */
    'moyu:log': (minutes) => service.logMoyu(minutes),
    'worklog:list': (dateKey) => service.listWorklogs(dateKey),

    /* 云同步预留 */
    'sync:pending': () => service.pendingChanges(),
    'sync:mark': (ids) => service.markSynced(ids),

    /* 节假日 */
    'holiday:info': (dateKey) => service.holidayInfo(dateKey),
    'holiday:month': (year, month) => service.monthSummary(year, month),
    'holiday:refresh': (year) => service.refreshHolidays(year ?? new Date().getFullYear(), { force: true }),

    /* 亲密度 */
    'affinity:get': () => service.affinity(),
    'affinity:level': () => service.affinityLevel(),
    'affinity:add': (delta, opts, sessionId) => service.addAffinity(delta, opts, sessionId),
    'affinity:reset': (sessionId) => service.resetAffinity(sessionId),

    /* 人设 */
    'persona:list': () => service.listPersonas(),
    'persona:create': (payload) => service.createPersona(payload),
    'persona:duplicate': (id) => service.duplicatePersona(id),
    'persona:update': (id, patch) => service.updatePersona(id, patch),
    'persona:delete': (id) => service.deletePersona(id),

    /* 对话 */
    'chat:status': () => service.chatStatus(),
    'chat:test': () => service.chatTest(),
    'chat:diagnose': () => service.chatDiagnose(),
    'chat:sessions': () => service.listChatSessions(),
    'chat:chatterLine': () => service.generateChatterLine(),
    'chat:ensure': () => service.ensureChatSession(),
    'chat:create': (title) => service.createChatSession(title),
    'chat:rename': (id, title) => service.renameChatSession(id, title),
    'chat:delete': (id) => service.deleteChatSession(id),
    'chat:load': (id) => service.loadChatSession(id),
    'chat:send': (payload) => service.sendChat(payload ?? {}),
    'chat:abort': (requestId) => service.abortChat(requestId),
  }
}
