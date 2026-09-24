//! spike 验证窗口与字节路径回归命令，从旧 lib.rs 原样搬入。
//! 回归验证窗原先在 tauri.conf.json 静态配置，移到代码里是为了让
//! additionalBrowserArgs 走统一的 env 逻辑（windows::apply_debug_args）：
//! 调试端口只在 DESK_DEBUG_PORT 存在时开启。
//!
//! 生产用的 http 代理在 http_proxy.rs（stream/once/abort）；这里的
//! http_stream 保留作「Channel<Vec<u8>> 原始字节路径不送达」的回归对照。

use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::AppHandle;

/// 回归验证窗（spike.html），供迁移期 CDP 断言使用。
pub fn create_window(app: &AppHandle) -> tauri::Result<()> {
    crate::windows::apply_debug_args(
        tauri::WebviewWindowBuilder::new(app, "spike", tauri::WebviewUrl::App("spike.html?route=spike".into()))
            .title("SPIKE")
            .inner_size(420.0, 560.0)
            .position(120.0, 140.0)
            .resizable(false)
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false),
    )
    .build()?;
    Ok(())
}

#[derive(Serialize)]
pub struct StreamResult {
    chunks: usize,
    total: usize,
    send_errors: usize,
}

/// http_stream —— bytes_stream 逐块经 Channel 推给 webview。
/// `Channel<Vec<u8>>` 在 WebView2 不送达（迁移验证反发现 #1），本命令仅供
/// 回归对照：确认「字节路径仍然不通」这一行为没变。
#[tauri::command]
pub async fn http_stream(url: String, on_chunk: Channel<Vec<u8>>) -> Result<StreamResult, String> {
    let res = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut chunks = 0usize;
    let mut total = 0usize;
    let mut send_errors = 0usize;
    while let Some(item) = stream.next().await {
        let bytes = item.map_err(|e| e.to_string())?;
        chunks += 1;
        total += bytes.len();
        if on_chunk.send(bytes.to_vec()).is_err() {
            send_errors += 1;
        }
    }
    Ok(StreamResult {
        chunks,
        total,
        send_errors,
    })
}
