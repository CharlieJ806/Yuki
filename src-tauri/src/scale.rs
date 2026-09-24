//! 桌宠缩放 —— petScale 的唯一真相操作路径。
//!
//! 硬规则：三条修改路径（托盘/右键菜单、设置滑块、重置设置）都必须收口到
//! [`apply_pet_scale`]，禁止旁路直接 set_size。持久化与 state 广播在
//! 业务侧完成（desk-shim 的 setPetScale = settings:update 持久化广播 +
//! 本模块缩窗；settings:reset 的归位经 service-host 的 onAfterReset 钩子）。

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager};

/// 桌宠逻辑尺寸（scale=1 时），与 Electron 版 PET_SIZE 一致。
pub const PET_SIZE: (f64, f64) = (340.0, 700.0);

pub fn clamp_scale(raw: f64) -> f64 {
    /* 复刻基线 `Number(x) || 1` 的语义：NaN/0 回退 1；其余照常夹取
       （负数 → 0.6，Infinity → 2，与 Math.max/min 链一致） */
    if raw == 0.0 || raw.is_nan() {
        return 1.0;
    }
    raw.clamp(0.6, 2.0)
}

/// 按缩放值调整桌宠窗口尺寸，保持右下角锚定（applyPetScale 的移植）。
/// 返回夹取后的缩放值。
pub fn apply_pet_scale(app: &AppHandle, raw_scale: f64) -> f64 {
    let s = clamp_scale(raw_scale);
    let Some(win) = app.get_webview_window("pet") else {
        return s;
    };
    let Some(rect) = crate::windows::window_logical_rect(&win) else {
        return s;
    };
    let w = (PET_SIZE.0 * s).round();
    let h = (PET_SIZE.1 * s).round();
    let _ = win.set_size(LogicalSize::new(w, h));
    let _ = win.set_position(LogicalPosition::new(
        (rect.x + rect.w - w).round(),
        (rect.y + rect.h - h).round(),
    ));
    s
}

/// `pet:setScale`（preload: setPetScale）。只负责窗口尺寸；
/// settings 持久化与 state 广播由 desk-shim 的组合路径完成。
#[tauri::command]
pub async fn pet_set_scale(app: AppHandle, scale: f64) -> f64 {
    apply_pet_scale(&app, scale)
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
