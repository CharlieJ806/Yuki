//! HTTP 流代理（TAURI_MIGRATION.md §2.2 决策 2）——reqwest 代发 webview 的网络请求。
//!
//! 为什么走 Rust 而不是 webview fetch：对话 API 是否回 CORS 头因服务商而异
//! （DeepSeek 回、别的保不齐），节假日 API 挡无 User-Agent 的请求；Electron
//! 时代主进程 fetch 天然没有这两个问题，Tauri 下等价物就是这里的代理。
//!
//! 三个命令：
//! - `http_fetch_stream` 流式：按完整行（'\n'）切分后逐条推送。字节安全的关键
//!   在 UTF-8 的性质——多字节序列不含 0x0A，按字节找 '\n' 永远不会切断中文
//!   （迁移验证确认 `Channel<Vec<u8>>` 原始字节路径在 WebView2 不送达，
//!   文本行是定型方案，JS 侧 TextEncoder 转回字节后 parseSSE 零改动）。
//! - `http_fetch_once` 整包：非流式对话 / 节假日表 / 测试连接用。
//! - `http_abort` 取消：id → 取消令牌，select 竞速让读循环立即退出。
//!
//! id 由 JS 侧生成并在 invoke 前注册 abort 监听，避免「等 streamId 返回的
//! 窗口期里 abort 丢失」的竞态。
//!
//! 代理假设：reqwest 默认读 HTTP_PROXY/HTTPS_PROXY 环境变量（本机无系统代理，
//! 需要时显式设 env，见 TAURI_MIGRATION.md「本机事实」）；不读 Windows 系统
//! 代理设置。响应体按 UTF-8 文本处理——本项目全部接口都是 JSON/SSE 文本。

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::watch;

/// 流式通道的帧协议：status 先于任何数据行（chat.js 在消费 body 前就要读
/// `res.ok`/`res.status`），line 是一条完整行（含行尾 '\n'），end 表示流毕。
#[derive(Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum StreamFrame {
    Status { status: u16 },
    Line { data: String },
    End { ok: bool },
}

/// 请求取消池：id → 取消开关。`http_abort` 置 true，任务侧 select 竞速退出。
/// client 共享一份连接池（对话/节假日请求频次低，但 keep-alive 白拿）。
pub struct HttpPool {
    client: reqwest::Client,
    cancels: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl HttpPool {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            cancels: Mutex::new(HashMap::new()),
        }
    }

    fn register(&self, id: &str) -> watch::Receiver<bool> {
        let (tx, rx) = watch::channel(false);
        self.cancels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.to_string(), tx);
        rx
    }

    fn unregister(&self, id: &str) {
        self.cancels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
    }

    fn abort(&self, id: &str) -> bool {
        if let Some(tx) = self
            .cancels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
        {
            let _ = tx.send(true);
            true
        } else {
            false
        }
    }
}

/// 等待取消信号。sender 被 drop（任务正常结束前的 unregister 竞态）视为未取消。
async fn wait_cancelled(mut rx: watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() {
            return;
        }
        if rx.changed().await.is_err() {
            return;
        }
    }
}

fn build_request(
    client: &reqwest::Client,
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: &str,
) -> Result<reqwest::RequestBuilder, String> {
    let verb = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("未知 HTTP 方法: {method}"))?;
    let mut req = client.request(verb, url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if !body.is_empty() {
        req = req.body(body.to_string());
    }
    Ok(req)
}

/// 从缓冲里切出所有完整行（含行尾 '\n'），残缺部分留在缓冲。纯函数，cargo test 覆盖。
fn drain_complete_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        out.push(String::from_utf8_lossy(&line).into_owned());
    }
    out
}

#[derive(Serialize)]
pub struct OnceReply {
    status: u16,
    body: String,
}

/// 整包请求（非流式对话 / 节假日表 / 测试连接）。响应体按 UTF-8 文本返回。
#[tauri::command]
pub async fn http_fetch_once(
    pool: tauri::State<'_, HttpPool>,
    id: String,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
) -> Result<OnceReply, String> {
    let rx = pool.register(&id);
    let req = build_request(&pool.client, &url, &method, &headers, &body);
    let out = match req {
        Err(e) => Err(e),
        Ok(req) => {
            tokio::select! {
                _ = wait_cancelled(rx) => Err("已取消".to_string()),
                r = async {
                    let res = req.send().await.map_err(|e| e.to_string())?;
                    let status = res.status().as_u16();
                    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
                    Ok(OnceReply { status, body: String::from_utf8_lossy(&bytes).into_owned() })
                } => r,
            }
        }
    };
    pool.unregister(&id);
    out
}

/// 流式请求。status 帧先行（不等首个数据字节），随后逐行推送，end 帧收尾。
/// 返回值与 end 帧一致（JS 侧只认帧，返回值仅便于命令行调试）。
#[derive(Serialize)]
pub struct StreamReply {
    ok: bool,
    chunks: usize,
    bytes: usize,
}

#[tauri::command]
pub async fn http_fetch_stream(
    pool: tauri::State<'_, HttpPool>,
    id: String,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
    on_frame: Channel<StreamFrame>,
) -> Result<StreamReply, String> {
    let rx = pool.register(&id);
    let out = do_stream(&pool.client, &url, &method, &headers, &body, &on_frame, rx).await;
    pool.unregister(&id);
    out
}

async fn do_stream(
    client: &reqwest::Client,
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: &str,
    on_frame: &Channel<StreamFrame>,
    rx: watch::Receiver<bool>,
) -> Result<StreamReply, String> {
    let req = build_request(client, url, method, headers, body)?;

    /* 连接与响应头阶段：被取消则静默退出（JS 侧已本地抛 AbortError），
       出错则 Err 回传——此时 JS 还在等 status 帧，会把它当连接失败包装成 network 类错误。 */
    let res = tokio::select! {
        _ = wait_cancelled(rx.clone()) => return Ok(StreamReply { ok: false, chunks: 0, bytes: 0 }),
        r = req.send() => r.map_err(|e| e.to_string())?,
    };

    on_frame
        .send(StreamFrame::Status { status: res.status().as_u16() })
        .map_err(|e| e.to_string())?;

    let mut stream = res.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut chunks = 0usize;
    let mut bytes_total = 0usize;
    loop {
        tokio::select! {
            _ = wait_cancelled(rx.clone()) => {
                let _ = on_frame.send(StreamFrame::End { ok: false });
                return Ok(StreamReply { ok: false, chunks, bytes: bytes_total });
            }
            item = stream.next() => match item {
                None => break,
                Some(Err(e)) => {
                    let _ = on_frame.send(StreamFrame::End { ok: false });
                    return Err(e.to_string());
                }
                Some(Ok(bytes)) => {
                    buf.extend_from_slice(&bytes);
                    for line in drain_complete_lines(&mut buf) {
                        chunks += 1;
                        bytes_total += line.len();
                        on_frame
                            .send(StreamFrame::Line { data: line })
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }
    /* 尾部无换行的残行也要送到（服务器最后一个事件可能不带 '\n'） */
    if !buf.is_empty() {
        chunks += 1;
        bytes_total += buf.len();
        let line = String::from_utf8_lossy(&buf).into_owned();
        on_frame.send(StreamFrame::Line { data: line }).map_err(|e| e.to_string())?;
    }
    let _ = on_frame.send(StreamFrame::End { ok: true });
    Ok(StreamReply { ok: true, chunks, bytes: bytes_total })
}

/// 取消进行中的请求。已结束的 id 返回 false（幂等，重复取消无害）。
#[tauri::command]
pub fn http_abort(pool: tauri::State<'_, HttpPool>, id: String) -> bool {
    pool.abort(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push(buf: &mut Vec<u8>, s: &str) {
        buf.extend_from_slice(s.as_bytes());
    }

    fn push_bytes(buf: &mut Vec<u8>, bytes: &[u8]) {
        buf.extend_from_slice(bytes);
    }

    #[test]
    fn lines_split_on_newline_and_keep_tail() {
        let mut buf = Vec::new();
        push(&mut buf, "data: a\ndata: b\n");
        assert_eq!(drain_complete_lines(&mut buf), vec!["data: a\n", "data: b\n"]);
        assert!(buf.is_empty());
    }

    #[test]
    fn lines_partial_chunk_stays_in_buffer() {
        let mut buf = Vec::new();
        push(&mut buf, "data: hel");
        assert!(drain_complete_lines(&mut buf).is_empty());
        push(&mut buf, "lo\nnext");
        assert_eq!(drain_complete_lines(&mut buf), vec!["data: hello\n"]);
        assert_eq!(buf, b"next");
    }

    #[test]
    fn lines_multibyte_utf8_never_broken() {
        /* 中文（每字符 3 字节）与换行符混排：按字节找 '\n' 不切断多字节序列 */
        let mut buf = Vec::new();
        push(&mut buf, "data: 你好呀\n");
        let lines = drain_complete_lines(&mut buf);
        assert_eq!(lines, vec!["data: 你好呀\n"]);
    }

    #[test]
    fn lines_multibyte_across_chunks() {
        /* 「鱼」= E9 B1 BC，逐字节到达时残缺部分必须留在缓冲 */
        let mut buf = Vec::new();
        push(&mut buf, "data: 摸");
        assert!(drain_complete_lines(&mut buf).is_empty());
        push_bytes(&mut buf, &[0xE9, 0xB1, 0xBC]);
        push(&mut buf, "\ndata: x\n");
        assert_eq!(
            drain_complete_lines(&mut buf),
            vec!["data: 摸鱼\n", "data: x\n"]
        );
    }

    #[test]
    fn lines_crlf_and_blank_lines_pass_through() {
        /* SSE 事件间的空行与 CRLF 原样保留，解析归 JS 侧 parseSSE */
        let mut buf = Vec::new();
        push(&mut buf, ": keep-alive\r\n\r\ndata: [DONE]\r\n");
        assert_eq!(
            drain_complete_lines(&mut buf),
            vec![": keep-alive\r\n", "\r\n", "data: [DONE]\r\n"]
        );
    }

    #[test]
    fn abort_unknown_id_is_false() {
        let pool = HttpPool::new();
        assert!(!pool.abort("nope"));
    }

    #[test]
    fn register_abort_unregister_cycle() {
        let pool = HttpPool::new();
        let rx = pool.register("req-1");
        assert!(pool.abort("req-1"));
        assert!(pool.abort("req-1"), "重复取消同一活跃 id 幂等（仍返回 true）");
        assert!(*rx.borrow(), "取消标志已置位");
        pool.unregister("req-1");
        assert!(!pool.abort("req-1"));
    }
}
