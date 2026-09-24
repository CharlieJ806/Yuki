//! 窗口外壳 —— Electron src/main/index.js 窗口层的移植。
//!
//! 行为对齐 Electron 基线：4 窗规格、托盘找回矩阵、hide 优先不销毁。
//! 与 Electron 的差异都有注释：Tauri 没有 show/hide/ready-to-show 事件，
//! 用「页面加载完成」与「我们自己的每个显隐入口」补位。

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri::webview::PageLoadEvent;

use crate::position::{self, FRect};
use crate::scale::{clamp_scale, pet_size};
use crate::tray;

pub const PET: &str = "pet";
pub const PANEL: &str = "panel";
pub const CHAT: &str = "chat";
pub const CHATPET: &str = "chatpet";
pub const PETMENU: &str = "petmenu";

/// 面板逻辑尺寸（不可缩放），与 Electron PANEL_SIZE 一致。
const PANEL_SIZE: (f64, f64) = (1080.0, 720.0);
/// 对话窗逻辑尺寸，与 Electron CHAT_PANEL_SIZE 一致（min 320×360 / max 720×900 在 builder 上）。
const CHAT_SIZE: (f64, f64) = (420.0, 560.0);
/// 侧边立绘小窗尺寸，与 Electron CHAT_PET_SIZE 一致。
const CHATPET_SIZE: (f64, f64) = (132.0, 232.0);
/// 右键菜单窗逻辑尺寸：面板内容宽 ~324 + 两侧留白；高度为内容上限，超出内部滚动。
const PETMENU_SIZE: (f64, f64) = (340.0, 560.0);

fn get_window(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    app.get_webview_window(label)
}

fn alive(app: &AppHandle, label: &str) -> bool {
    get_window(app, label).is_some()
}

fn visible(app: &AppHandle, label: &str) -> bool {
    get_window(app, label).map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false)
}

/// 主显示器工作区（逻辑像素）。取不到显示器时退化为 1920×1040，
/// 与 Electron screen.getPrimaryDisplay() 的「必有值」对齐——宁可位置略偏也不建窗失败。
fn work_area(app: &AppHandle) -> FRect {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return FRect::new(0.0, 0.0, 1920.0, 1040.0);
    };
    let f = monitor.scale_factor();
    /* work_area 为物理像素，转成与窗口坐标同系的逻辑像素 */
    let wa = monitor.work_area();
    FRect::new(
        wa.position.x as f64 / f,
        wa.position.y as f64 / f,
        wa.size.width as f64 / f,
        wa.size.height as f64 / f,
    )
}

/// 窗口外框矩形（逻辑像素）。窗口已销毁等情况下返回 None。
pub(crate) fn window_logical_rect(win: &WebviewWindow) -> Option<FRect> {
    let f = win.scale_factor().ok()?;
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    Some(FRect::new(
        pos.x as f64 / f,
        pos.y as f64 / f,
        size.width as f64 / f,
        size.height as f64 / f,
    ))
}

/// DESK_DEBUG_PORT：设了才给窗口挂 WebView2 远程调试端口（与基线同语义，
/// 默认关闭——CDP 端口本地任意进程可连，不能随 release 发布）。
///
/// **铁律**：WebView2 的浏览器进程参数由第一个窗口决定，所有窗口必须
/// 完全一致——不一致时后续窗口 build 返回 Ok 但 webview 静默不落地。
/// 所以这里要么全窗都带（env 存在），要么全窗都不带（env 缺省），
/// 不存在部分窗口带参的中间态。
pub(crate) fn apply_debug_args<R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'_, R, M>,
) -> WebviewWindowBuilder<'_, R, M> {
    match std::env::var("DESK_DEBUG_PORT") {
        Ok(port) => builder.additional_browser_args(&format!("--remote-debugging-port={port}")),
        Err(_) => builder,
    }
}

/// 窗口显隐必须同步 WebView2 的 IsVisible：HWND 隐藏不会联动 controller，
/// 隐藏窗会继续渲染且 Chromium 不修剪其渲染树（实测藏面板后全树私有内存
/// 不降；同步后 visibilityState 正确变 hidden，隐藏窗动画暂停，与 Electron
/// 基线行为对齐）。
///
/// 刻意走 `with_webview` 稳定 API 直接 `SetIsVisible`，不用 unstable feature
/// 的 `Manager::get_webview`——后者会连带把 webview 宿主从 WindowContent 翻成
/// WindowChild，破坏无边框可调窗（chat）的边缘拖拽缩放覆盖层挂载，违反
/// 「等价替换」铁律（详见 REVIEW_FINDINGS P2/P7）。
fn set_shown(win: &WebviewWindow, shown: bool) {
    let _ = if shown { win.show() } else { win.hide() };
    let _ = win.with_webview(move |webview| {
        unsafe {
            let _ = webview.controller().SetIsVisible(shown);
        }
    });
}

/* ---------- 桌宠窗（常驻宿主） ---------- */

pub fn create_pet(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    /* 缩放与位置都只信持久化值（与 Electron 建窗时读 settings/meta 同语义），
       表还没由 JS 建好的极端情况下回退默认值。 */
    let scale = app
        .try_state::<crate::db::Db>()
        .and_then(|d| crate::db::settings_get(&d, "petScale"))
        .and_then(|v| v.as_f64())
        .map(clamp_scale)
        .unwrap_or(1.0);
    let saved = app
        .try_state::<crate::db::Db>()
        .and_then(|d| crate::db::meta_get(&d, "petPosition"))
        .and_then(|v| {
            let x = v.get("x")?.as_f64()?;
            let y = v.get("y")?.as_f64()?;
            Some((x, y))
        });
    let work = work_area(app);
    let w = (PET_SIZE.0 * scale).round();
    let h = (PET_SIZE.1 * scale).round();
    let (x, y) = position::resolve_pet_position(saved, w, h, work);

    let builder = apply_debug_args(
        WebviewWindowBuilder::new(app, PET, WebviewUrl::App("index.html?route=pet".into()))
            .title("desk-pet")
            .inner_size(w, h)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .shadow(false)
            .always_on_top(true),
    );
    let win = builder.build()?;
    /* 定位不走 builder.position：tao 建窗时检查「左上角是否落在某个显示器内」，
       不命中任何显示器就静默回退 CW_USEDEFAULT（Windows 级联随机位）。保存位
       允许挂在屏幕上缘（is_on_screen 四周 20px 余量），左上角出屏恰好触发。
       SetWindowPos 无此检查，运行时 set_position 任意坐标都精确（与
       apply_pet_scale 同路径）。 */
    let _ = win.set_position(LogicalPosition::new(x.round(), y.round()));

    /* moved：Tauri 拖拽过程中持续发 Moved，比 Electron 的 moved 事件更频繁，
       但只是一次 meta upsert，成本可忽略。meta 表未建好时写入静默失败
       （schema 由 JS 侧建），只影响最早那几秒。 */
    let w2 = win.clone();
    /* 与 Electron 基线对齐：初始摆放不写 meta（set_position 会触发一次与解析位
       相同的 Moved，跳过它——屏幕外的失效保存位得以保留，外接屏重插后还能回去）。 */
    let initial = (x.round(), y.round());
    win.on_window_event(move |e| {
        if let WindowEvent::Moved(p) = e {
            let Ok(f) = w2.scale_factor() else { return };
            let lx = p.x as f64 / f;
            let ly = p.y as f64 / f;
            if (lx - initial.0).abs() < 0.5 && (ly - initial.1).abs() < 0.5 {
                return;
            }
            if let Some(db) = w2.app_handle().try_state::<crate::db::Db>() {
                crate::db::meta_set(
                    &db,
                    "petPosition",
                    &serde_json::json!({ "x": lx, "y": ly }),
                );
            }
        }
    });

    /* Alt+F4 等外部销毁后托盘文案要变回「找回桌宠」 */
    let a2 = app.clone();
    win.on_window_event(move |e| {
        if matches!(e, WindowEvent::Destroyed) {
            tray::rebuild(&a2);
        }
    });
    Ok(win)
}

pub fn pet_alive(app: &AppHandle) -> bool {
    alive(app, PET)
}

pub fn pet_visible(app: &AppHandle) -> bool {
    visible(app, PET)
}

/// `pet:refit` —— 窗口贴合：渲染层 ResizeObserver 量得内容尺寸后，
/// 按右下角锚定重设桌宠窗（x += 旧宽−新宽，y += 旧高−新高），桌宠视觉不跳。
/// 尺寸真值源是渲染层布局，壳层不维护尺寸公式。
#[tauri::command]
pub async fn pet_refit(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    let Some(win) = get_window(&app, PET) else {
        return Err("桌宠窗不存在".into());
    };
    let Some(rect) = window_logical_rect(&win) else {
        return Err("桌宠窗不可测".into());
    };
    let w = width.max(80.0);
    let h = height.max(80.0);
    let _ = win.set_size(LogicalSize::new(w, h));
    let _ = win.set_position(LogicalPosition::new(
        (rect.x + rect.w - w).round(),
        (rect.y + rect.h - h).round(),
    ));
    Ok(())
}

/// `pet:menuResize` —— 菜单窗按内容高度贴合（宽度定 340，顶边不动）。
#[tauri::command]
pub async fn pet_menu_resize(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    let Some(win) = get_window(&app, PETMENU) else {
        return Err("菜单窗不存在".into());
    };
    let h = height.max(120.0);
    let _ = win.set_size(LogicalSize::new(PETMENU_SIZE.0, h));
    Ok(())
}

/* ---------- 桌宠右键菜单窗 ----------
 *
 * 独立无边框小窗（与桌宠窗解耦）：平时隐藏，右键时定位到光标显示。
 * 桌宠窗只包住气泡+本体，不再为菜单预留整块不可穿透的桌面区域。
 * 失焦即藏回——点菜单外任何地方（含桌宠本体）都算关闭，与原生菜单手感一致。
 */

/// 常驻隐藏的右键菜单窗。首屏加载完成即 set_shown(false)：HWND 隐藏不会
/// 联动 WebView2 IsVisible，不同步的话隐藏窗会继续渲染（见 set_shown 注释）。
pub fn create_petmenu(app: &AppHandle) -> tauri::Result<()> {
    if get_window(app, PETMENU).is_some() {
        return Ok(());
    }
    let builder = apply_debug_args(
        WebviewWindowBuilder::new(app, PETMENU, WebviewUrl::App("index.html?route=petmenu".into()))
            .title("pet-menu")
            .inner_size(PETMENU_SIZE.0, PETMENU_SIZE.1)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .shadow(false)
            .always_on_top(true)
            .visible(false),
    );
    let a2 = app.clone();
    let builder = builder.on_page_load(move |_wv, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let a = a2.clone();
            let _ = tauri::async_runtime::spawn(async move {
                if let Some(w) = a.get_webview_window(PETMENU) {
                    set_shown(&w, false);
                }
            });
        }
    });
    builder.build()?;
    Ok(())
}

/// `pet:menuShow` —— 右键菜单弹出到光标处。
///
/// 光标物理坐标先换算逻辑像素（与窗口定位同系），再夹进主显示器工作区：
/// 右/下缘内收防溢出，左/上缘贴边。跨多显示器时以主屏为准（与 chat 钳制同口径）。
/// 光标取不到（无交互桌面的进程上下文）时回落到桌宠窗正上方。
#[tauri::command]
pub async fn pet_menu_show(app: tauri::AppHandle) -> Result<(), String> {
    if get_window(&app, PETMENU).is_none() {
        create_petmenu(&app).map_err(|e| e.to_string())?;
    }
    let Some(win) = get_window(&app, PETMENU) else {
        return Err("菜单窗创建失败".into());
    };
    let wa = work_area(&app);
    let (mw, mh) = PETMENU_SIZE;
    let f = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    /* 首选光标位置；取不到就锚定桌宠窗（贴其右上角外侧） */
    let (mut x, mut y) = match app.cursor_position() {
        Ok(cur) => (cur.x as f64 / f, cur.y as f64 / f),
        Err(_) => match get_window(&app, PET).as_ref().and_then(|w| window_logical_rect(w)) {
            Some(rect) => (rect.x + rect.w + 8.0, rect.y),
            None => (wa.x + wa.w - mw, wa.y + 24.0),
        },
    };
    x = x.max(wa.x).min(wa.x + wa.w - mw);
    y = y.max(wa.y).min(wa.y + wa.h - mh);
    let _ = win.set_position(LogicalPosition::new(x.round(), y.round()));
    set_shown(&win, true);
    let _ = win.set_focus();
    Ok(())
}

/// `pet:menuHide` —— 菜单窗藏回（失焦/Esc/动作完成）。
#[tauri::command]
pub async fn pet_menu_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = get_window(&app, PETMENU) {
        set_shown(&win, false);
    }
    Ok(())
}

/// 窗口显隐必须同步 webview 显隐：WebView2 的 IsVisible 不联动 HWND 隐藏，
/// 隐藏窗会继续渲染且 Chromium 不修剪其渲染树（实测藏面板后全树私有内存不降）。
pub fn panel_visible(app: &AppHandle) -> bool {
    visible(app, PANEL)
}

fn show_or_create_pet(app: &AppHandle) {
    match get_window(app, PET) {
        Some(w) => {
            set_shown(&w, true);
        }
        None => {
            let _ = create_pet(app);
        }
    }
}

/* ---------- 面板窗 ---------- */

pub fn create_panel(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(win) = get_window(app, PANEL) {
        set_shown(&win, true);
        let _ = win.set_focus();
        return Ok(win);
    }
    let work = work_area(app);
    let (w, h) = PANEL_SIZE;
    let x = (work.x + (work.w - w) / 2.0).round();
    let y = (work.y + (work.h - h) / 2.0).round();

    let builder = apply_debug_args(
        WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("index.html?route=panel".into()))
            .title("摸鱼面板")
            .inner_size(w, h)
            .min_inner_size(860.0, 600.0)
            .position(x, y)
            /* 基线 backgroundColor 防首帧白闪的等价物 */
            .background_color(tauri::utils::config::Color(245, 245, 247, 255))
            /* Electron 用 ready-to-show 再显示防白闪；Tauri 用页面加载完成事件对齐 */
            .visible(false),
    );
    let a3 = app.clone();
    /* 回调跑在主线程事件派发里，窗口操作必须丢工作线程（否则死锁，
       与托盘菜单同一坑）；显示的同时刷新托盘「显示/隐藏面板」文案 */
    let builder = builder.on_page_load(move |_wv, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let a = a3.clone();
            let _ = tauri::async_runtime::spawn(async move {
                if let Some(w) = a.get_webview_window(PANEL) {
                    set_shown(&w, true);
                    let _ = w.set_focus();
                    tray::rebuild(&a);
                }
            });
        }
    });
    let win = builder.build()?;

    /* 用户点标题栏 X：窗口销毁（与 Electron 一致，重建走本函数），
       托盘「显示/隐藏面板」文案要跟着翻面 */
    let a2 = app.clone();
    win.on_window_event(move |e| {
        if matches!(e, WindowEvent::Destroyed) {
            tray::rebuild(&a2);
        }
    });
    Ok(win)
}

pub fn toggle_panel(app: &AppHandle) {
    if let Some(win) = get_window(app, PANEL) {
        if win.is_visible().unwrap_or(false) {
            set_shown(&win, false);
        } else {
            set_shown(&win, true);
            let _ = win.set_focus();
        }
        tray::rebuild(app);
        return;
    }
    let _ = create_panel(app);
}

/* ---------- 对话窗 + 侧边立绘窗 ---------- */

/// 把立绘小窗贴到对话框左侧（positionChatPetWindow 的移植）。
pub fn position_chat_pet(app: &AppHandle) {
    let Some(pet) = get_window(app, CHATPET) else { return };
    let anchor = get_window(app, CHAT).and_then(|w| window_logical_rect(&w));
    let work = work_area(app);
    let (w, h) = CHATPET_SIZE;
    let (x, y) = position::chat_pet_position(anchor, w, h, work);
    let _ = pet.set_position(LogicalPosition::new(x.round(), y.round()));
}

fn destroy_chat_pet(app: &AppHandle) {
    if let Some(w) = get_window(app, CHATPET) {
        let _ = w.close();
    }
}

/// 侧边立绘窗：独立无边框小窗，贴对话框外侧（详见 Electron 版注释）。
/// 已存在时只重新定位、**不主动显示**——用户上一轮点过「隐藏立绘」的意愿要保持。
pub fn create_chat_pet(app: &AppHandle) -> tauri::Result<()> {
    if get_window(app, CHATPET).is_some() {
        position_chat_pet(app);
        return Ok(());
    }
    let builder = apply_debug_args(
        WebviewWindowBuilder::new(app, CHATPET, WebviewUrl::App("index.html?route=chatpet".into()))
            .title("chat-pet")
            .inner_size(CHATPET_SIZE.0, CHATPET_SIZE.1)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .shadow(false)
            .always_on_top(true)
            .visible(false)
            /* 它只是装饰，不该抢焦点（否则打字会断） */
            .focusable(false),
    );
    let a2 = app.clone();
    let builder = builder.on_page_load(move |_wv, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let a = a2.clone();
            let _ = tauri::async_runtime::spawn(async move {
                position_chat_pet(&a);
                if let Some(w) = a.get_webview_window(CHATPET) {
                    set_shown(&w, true);
                }
            });
        }
    });
    builder.build()?;
    Ok(())
}

pub fn create_chat(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(win) = get_window(app, CHAT) {
        set_shown(&win, true);
        let _ = win.set_focus();
        let _ = create_chat_pet(app);
        return Ok(win);
    }

    let work = work_area(app);
    let (w, h) = CHAT_SIZE;
    /* 贴着桌宠弹出，并夹在当前显示器工作区内 */
    let pet_anchor = get_window(app, PET).and_then(|w| window_logical_rect(&w));
    let (x, y) = position::chat_default_position(pet_anchor, w, h, work);

    let builder = apply_debug_args(
        WebviewWindowBuilder::new(app, CHAT, WebviewUrl::App("index.html?route=chat".into()))
            .title("AI 对话")
            .inner_size(w, h)
            .position(x, y)
            .decorations(false)
            .transparent(true)
            .resizable(true)
            .min_inner_size(320.0, 360.0)
            .max_inner_size(720.0, 900.0)
            .skip_taskbar(true)
            .always_on_top(true)
            .shadow(false),
    );
    /* Electron 用 ready-to-show 再显示并挂上立绘；Tauri 用页面加载完成事件对齐。
       回调里建窗必须丢工作线程（主线程死锁坑，见 create_panel 注释）。 */
    let a3 = app.clone();
    let builder = builder.on_page_load(move |_wv, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let a = a3.clone();
            let _ = tauri::async_runtime::spawn(async move {
                if let Some(w) = a.get_webview_window(CHAT) {
                    set_shown(&w, true);
                    /* 首次打开要在窗口就位后再定位立绘 */
                    let _ = create_chat_pet(&a);
                }
            });
        }
    });
    let win = builder.build()?;

    /* 对话框一动/一改尺寸，立绘窗就得跟着动 */
    let w2 = win.clone();
    win.on_window_event(move |e| {
        if matches!(e, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            position_chat_pet(&w2.app_handle());
        }
    });
    /* 对话框没了，立绘窗也不该留着变成孤儿窗口 */
    let a2 = app.clone();
    win.on_window_event(move |e| {
        if matches!(e, WindowEvent::Destroyed) {
            destroy_chat_pet(&a2);
        }
    });
    Ok(win)
}

pub fn open_chat_window(app: &AppHandle) {
    let _ = create_chat(app);
}

pub fn hide_chat_window(app: &AppHandle) {
    if let Some(w) = get_window(app, CHAT) {
        set_shown(&w, false);
    }
    /* 与 Electron 的 chatWindow.on('hide') 一致：对话框藏起来立绘跟着藏 */
    if let Some(w) = get_window(app, CHATPET) {
        set_shown(&w, false);
    }
}

/// 立绘小窗开关，返回切换后的可见状态（Electron 'chat:togglePet' 语义）。
pub fn toggle_chat_pet(app: &AppHandle) -> bool {
    if !alive(app, CHATPET) {
        return create_chat_pet(app).is_ok();
    }
    if visible(app, CHATPET) {
        if let Some(w) = get_window(app, CHATPET) {
            set_shown(&w, false);
        }
        return false;
    }
    position_chat_pet(app);
    if let Some(w) = get_window(app, CHATPET) {
        set_shown(&w, true);
    }
    true
}

/* ---------- 找回矩阵（托盘行为的内核） ---------- */

pub fn toggle_pet(app: &AppHandle) -> bool {
    if !pet_alive(app) {
        let _ = create_pet(app);
        tray::rebuild(app);
        return pet_visible(app);
    }
    if pet_visible(app) {
        if let Some(w) = get_window(app, PET) {
            set_shown(&w, false);
        }
    } else if let Some(w) = get_window(app, PET) {
        set_shown(&w, true);
    }
    tray::rebuild(app);
    pet_visible(app)
}

/// 兜底恢复：全都不显示就说明用户「找不到了」。托盘单击默认走这里，
/// 保证任何情况下都有办法把界面叫回来（硬规则：不许让用户失去找回入口）。
pub fn restore_any_window(app: &AppHandle) -> bool {
    if pet_visible(app) || visible(app, PANEL) || visible(app, CHAT) {
        return false;
    }
    /* 桌宠优先恢复，它是最小、最不打扰的入口 */
    show_or_create_pet(app);
    tray::notify_restored(app);
    tray::rebuild(app);
    true
}

/// 把桌宠和面板都叫出来 —— 兜底入口。
pub fn show_everything(app: &AppHandle) {
    show_or_create_pet(app);
    let _ = create_panel(app);
    tray::rebuild(app);
}

/* ---------- 窗口/系统类 IPC（preload 的窗口控制方法，Tauri command 形态） ---------- */

/// `chat:openWindow`
#[tauri::command]
pub async fn chat_open_window(app: AppHandle) -> bool {
    open_chat_window(&app);
    true
}

/// `chat:hideWindow`
#[tauri::command]
pub async fn chat_hide_window(app: AppHandle) -> bool {
    hide_chat_window(&app);
    true
}

/// `chat:togglePet`
#[tauri::command]
pub async fn chat_toggle_pet(app: AppHandle) -> bool {
    toggle_chat_pet(&app)
}

/// `window:togglePet`
#[tauri::command]
pub async fn window_toggle_pet(app: AppHandle) -> bool {
    toggle_pet(&app)
}

/// `window:petVisible`
#[tauri::command]
pub async fn window_pet_visible(app: AppHandle) -> bool {
    pet_visible(&app)
}

/// `window:showEverything`
#[tauri::command]
pub async fn window_show_everything(app: AppHandle) -> bool {
    show_everything(&app);
    true
}

/// `window:openPanel`
#[tauri::command]
pub async fn window_open_panel(app: AppHandle) -> bool {
    let _ = create_panel(&app);
    true
}

/// `window:hidePanel`
#[tauri::command]
pub async fn window_hide_panel(app: AppHandle) -> bool {
    if let Some(w) = get_window(&app, PANEL) {
        set_shown(&w, false);
    }
    tray::rebuild(&app);
    true
}

/// `window:minimize` —— 最小化「发起调用的那个窗口」。
#[tauri::command]
pub async fn window_minimize(window: WebviewWindow) -> bool {
    let _ = window.minimize();
    true
}
