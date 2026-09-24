//! 托盘 —— Electron 版托盘的移植：程序化猫脸图标、跟随状态重建的菜单、
//! 单击兜底找回（硬规则：不许让用户失去找回入口）。
//!
//! 菜单里的业务数字（今日收入/累计天数/等级/打卡态）由 pet 窗的 service 总线宿主
//! 在 state 变更时推给 Rust 重建；宿主未就绪前显示占位快照。

use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::windows;

const TRAY_ID: &str = "tray";
const TOOLTIP: &str = "摸鱼桌宠 —— 单击显示/隐藏面板，右键打开菜单";

/// 托盘菜单展示的业务态快照。
/// 默认值是「零数据」占位；pet 窗的 service 宿主在每次 state 广播后
/// 经 `tray_update_snapshot` 命令推入真实值并触发菜单重建。
#[derive(Clone)]
pub struct TraySnapshot {
    pub earned_line: String,
    pub days_line: String,
    pub checked_in: bool,
}

impl Default for TraySnapshot {
    fn default() -> Self {
        Self {
            earned_line: "今日已摸鱼赚到 ¥0.00".into(),
            days_line: "累计摸鱼 0 天 · 职场萌新".into(),
            checked_in: false,
        }
    }
}

/* ---------- 托盘图标 ---------- */

/// 32×32 猫脸 RGBA，逐像素移植 Electron 的 trayImage()。
/// 不走图标文件：算法与 Electron 版同源，缩略下同样能认出是猫，
/// 也省掉一道「改图标要重新生成资源」的流程。
///
/// 颜色说明：Electron nativeImage 在 Windows 按 BGRA 解释裸位图——基线
/// 已改为写 B,G,R，屏幕显示同为代码本意的青色（ACCENT），两版同色。
const S: usize = 32;
const ACCENT: [u8; 3] = [0x14, 0xb8, 0xa6];
const DARK: [u8; 3] = [0x0f, 0x2e, 0x2a];

fn put(buf: &mut [u8], x: i32, y: i32, c: [u8; 3]) {
    if x < 0 || y < 0 || x >= S as i32 || y >= S as i32 {
        return;
    }
    let i = ((y as usize * S) + x as usize) * 4;
    buf[i] = c[0];
    buf[i + 1] = c[1];
    buf[i + 2] = c[2];
    buf[i + 3] = 255;
}

fn cat_face_rgba() -> Vec<u8> {
    let mut buf = vec![0u8; S * S * 4];
    /* 头（实心圆） */
    let (cx, cy, r) = (16i32, 18i32, 10i32);
    for y in 0..S {
        for x in 0..S {
            let dx = x as i32 - cx;
            let dy = y as i32 - cy;
            if dx * dx + dy * dy <= r * r {
                put(&mut buf, x as i32, y as i32, ACCENT);
            }
        }
    }
    /* 两只耳朵（三角形扫描填充） */
    let ear = |base_x: i32, dir: i32, buf: &mut [u8]| {
        for h in 0..8i32 {
            let w = (((h as f64 / 7.0) * 6.0).round() as i32).max(1);
            for k in 0..w {
                put(buf, base_x + dir * k, cy - 8 - h, ACCENT);
            }
        }
    };
    ear(9, -1, &mut buf);
    ear(23, 1, &mut buf);
    /* 两只眼睛（深色），缩略后仍能看出是猫 */
    let eye = |ex: i32, buf: &mut [u8]| {
        for y in (cy - 4)..=(cy - 1) {
            for x in (ex - 1)..=(ex + 1) {
                put(buf, x, y, DARK);
            }
        }
    };
    eye(12, &mut buf);
    eye(20, &mut buf);
    buf
}

/* ---------- 菜单 ---------- */

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let snap = app
        .try_state::<std::sync::Mutex<TraySnapshot>>()
        .map(|s| s.lock().map(|g| g.clone()).unwrap_or_default())
        .unwrap_or_default();
    let earned = MenuItemBuilder::with_id("info-earned", snap.earned_line)
        .enabled(false)
        .build(app)?;
    let level = MenuItemBuilder::with_id("info-level", snap.days_line)
        .enabled(false)
        .build(app)?;
    let checkin_label = if snap.checked_in { "今日已打卡" } else { "打卡" };
    let checkin = MenuItemBuilder::with_id("checkin", checkin_label)
        .enabled(!snap.checked_in)
        .build(app)?;

    /* 明确写「找回」而不是「显示」，用户找不到时才会想到点它 */
    let pet_label = if windows::pet_visible(app) {
        "隐藏桌宠"
    } else if windows::pet_alive(app) {
        "显示桌宠"
    } else {
        "找回桌宠"
    };
    let pet_item = MenuItemBuilder::with_id("toggle-pet", pet_label).build(app)?;
    /* 面板/桌宠两个动态开关相邻；「打开摸鱼面板」与「显示面板」在面板未
       前台时完全同义，已并入这一个动态项（Electron rebuildTrayMenu 同构） */
    let panel_label = if windows::panel_visible(app) { "隐藏面板" } else { "显示面板" };
    let panel_item = MenuItemBuilder::with_id("toggle-panel", panel_label).build(app)?;
    let chat_item = MenuItemBuilder::with_id("open-chat", "AI 对话").build(app)?;
    let show_all = MenuItemBuilder::with_id("show-all", "全部显示（找不到界面时点这里）").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;

    let s1 = PredefinedMenuItem::separator(app)?;
    let s2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &earned, &level, &s1, &checkin, &panel_item, &pet_item, &chat_item, &s2, &show_all,
            &quit,
        ],
    )
}

/// 重建托盘菜单（Electron rebuildTrayMenu）。每个窗口显隐变更点都要调用，
/// 否则菜单文案与实际状态不一致。
pub fn rebuild(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    match build_menu(app) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(e) => log::warn!("[tray] 菜单重建失败：{e}"),
    }
}

/// `tray:updateSnapshot` —— service 宿主在 state 广播后推入托盘文案并重建菜单。
#[tauri::command]
pub async fn tray_update_snapshot(
    app: AppHandle,
    earned_line: String,
    days_line: String,
    checked_in: bool,
) -> Result<(), String> {
    if let Some(s) = app.try_state::<std::sync::Mutex<TraySnapshot>>() {
        if let Ok(mut g) = s.lock() {
            *g = TraySnapshot { earned_line, days_line, checked_in };
        }
    }
    rebuild(&app);
    Ok(())
}

/* ---------- 托盘创建 ---------- */

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let rgba = cat_face_rgba();
    let icon = tauri::image::Image::new(&rgba, S as u32, S as u32);
    let menu = build_menu(app)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(TOOLTIP)
        .menu(&menu)
        /* 左键是自定义兜底逻辑，不弹菜单；右键由系统弹菜单 */
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(handle_tray_event)
        .build(app)?;
    Ok(())
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    /* 菜单事件在主线程的事件回调里派发：这里若直接建窗/操作窗口，
       build() 会同步等事件循环——而循环正卡在本回调里，死锁
       （实测：菜单点了没反应 + 窗口无响应就是这个）。
       一律丢到工作线程，让窗口操作走正常的事件循环代理。 */
    let app = app.clone();
    let id = event.id().as_ref().to_string();
    let _ = tauri::async_runtime::spawn(async move {
        dispatch_action(&app, &id);
    });
}

fn dispatch_action(app: &AppHandle, id: &str) {
    match id {
        /* 打卡是业务动作：派给 pet 窗（业务宿主）。窗被销毁时先建回来；
           「窗在但宿主 JS 未就绪」的秒级窗口期是已知限制（REVIEW_FINDINGS.md L1）。 */
        "checkin" => {
            if !windows::pet_alive(app) {
                let _ = windows::create_pet(app);
            }
            let _ = app.emit_to(windows::PET, "tray:checkin", ());
        }
        "toggle-pet" => {
            windows::toggle_pet(app);
        }
        "toggle-panel" => {
            windows::toggle_panel(app);
        }
        "open-chat" => {
            windows::open_chat_window(app);
        }
        "show-all" => {
            windows::show_everything(app);
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

fn handle_tray_event(tray: &tauri::tray::TrayIcon<tauri::Wry>, event: TrayIconEvent) {
    /* 同 handle_menu_event：托盘事件回调在主线程，动作丢工作线程执行 */
    let app = tray.app_handle().clone();
    match event {
        /* 单击：有窗口可见就切面板，全隐藏了就兜底恢复桌宠 */
        TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
            let _ = tauri::async_runtime::spawn(async move {
                if !windows::restore_any_window(&app) {
                    windows::toggle_panel(&app);
                }
            });
        }
        TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
            let _ = tauri::async_runtime::spawn(async move {
                let _ = windows::create_panel(&app);
            });
        }
        _ => {}
    }
}

/// restoreAnyWindow 里的 displayBalloon 等价物（Windows toast）。
pub fn notify_restored(app: &AppHandle) {
    let _ = app
        .notification()
        .builder()
        .title("摸鱼桌宠")
        .body("桌宠已重新显示")
        .show();
}
