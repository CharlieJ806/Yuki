/**
 * HTTP transport 注入点（TAURI_MIGRATION.md §2.2 决策 5）。
 *
 * chat.js / holiday.js 不直接用全局 fetch，而是经 httpTransport() 取发送函数：
 *   - 默认 = 全局 fetch：Node 测试（chat-test 的本地假服务器）与 Electron 版
 *     行为与迁移前完全一致，零改动；
 *   - Tauri 运行时在 service-host 启动时注入 Rust http 代理的 Response-like
 *     包装（renderer/lib/tauri-transport.js）——webview fetch 有 CORS 不确定性，
 *     且节假日 API 必须带 User-Agent，这两件事都要在 Rust 侧解决。
 *
 * 接口约定与 fetch 相同：(url, {method, headers, body, signal}) →
 * Promise<{ ok, status, body, text(), json() }>。body 只要求支持
 * getReader()（parseSSE 的唯一用法）；text/json 不要求可重复消费。
 */

let impl = null

/** 注入自定义 transport；传 null 恢复默认全局 fetch（测试收尾用） */
export function setHttpTransport(next) {
  impl = typeof next === 'function' ? next : null
}

export function httpTransport() {
  return impl ?? ((url, init) => fetch(url, init))
}
