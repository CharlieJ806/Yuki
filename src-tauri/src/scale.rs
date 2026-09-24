//! 桌宠缩放 —— petScale 的唯一真相操作路径。
//!
//! 硬规则：三条修改路径（托盘/右键菜单、设置滑块、重置设置）都必须收口到
//! [`apply_pet_scale`]，禁止旁路直接 set_size。持久化与 state 广播在
//! 业务侧完成（desk-shim 的 setPetScale = settings:update 持久化广播 +
//! 本模块缩窗；settings:reset 的归位经 service-host 的 onAfterReset 钩子）。

//! 桌宠缩放 —— petScale 的持久化与广播在业务侧完成（desk-shim 的
//! setPetScale = settings:update 持久化广播）；窗口尺寸由渲染层
//! ResizeObserver 量内容后经 windows::pet_refit 贴合，壳层不维护尺寸公式。
//! 本模块只剩 petScale 钳制纯函数、建窗初值 pet_size 与置顶回放命令。

use tauri::{AppHandle, Manager};

/// 桌宠窗建窗初值（逻辑像素，仅首帧使用——渲染层挂载后 ResizeObserver
/// 会把窗口贴合到真实内容尺寸）。公式与 Electron 版同式：
/// 宽 160×缩放（气泡 144 + 留白）；高 = 固定部分 164 + 立绘 136×缩放。
pub fn pet_size(scale: f64) -> (f64, f64) {
    ((160.0 * scale).round(), (164.0 + 136.0 * scale).round())
}

pub fn clamp_scale(raw: f64) -> f64 {
    /* 复刻基线 `Number(x) || 1` 的语义：NaN/0 回退 1；其余照常夹取
       （负数 → 0.6，Infinity → 2，与 Math.max/min 链一致） */
    if raw == 0.0 || raw.is_nan() {
        return 1.0;
    }
    raw.clamp(0.6, 2.0)
}

/// `pet:setAlwaysOnTop`（preload: setPetAlwaysOnTop）。置顶的持久化由
/// desk-shim 组合路径完成；启动回放在 service-host。
#[tauri::command]
pub async fn pet_set_always_on_top(app: AppHandle, flag: bool) -> bool {
    if let Some(win) = app.get_webview_window("pet") {
        let _ = win.set_always_on_top(flag);
    }
    flag
}
