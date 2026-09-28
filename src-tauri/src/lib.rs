//! 摸鱼桌宠 —— Tauri 2 外壳（见 TAURI_MIGRATION.md）。
//!
//! 模块职责（§3 目录结构）：
//! - `windows`  4 窗创建/规格/找回矩阵 + 窗口类 IPC command
//! - `tray`     托盘图标/动态菜单/单击兜底/通知
//! - `scale`    apply_pet_scale 唯一缩放路径 + pet:* 缩放 command
//! - `position` 定位纯函数（cargo test 覆盖）
//! - `db`       rusqlite 桥（业务总线宿主专用）
//! - `http_proxy` HTTP 流代理（webview fetch 的 CORS/UA 缺口）

mod db;
mod http_proxy;
mod photos;
mod position;
mod scale;
mod tray;
mod windows;

use std::sync::Mutex;

use tauri::Manager;

/// `pet:quit` —— 退出唯一入口（托盘菜单与渲染层共用）。
#[tauri::command]
fn pet_quit(app: tauri::AppHandle) -> bool {
    app.exit(0);
    true
}

/// 业务敏感命令的收权门：只允许 pet 窗调用。
///
/// Tauri 2 的 ACL（capabilities）**不覆盖 app 自定义命令**——
/// generate_handler 注册的命令对全部 webview 无条件开放（capabilities 只管
/// plugin 命令）。db/http/tray 快照若不设防，任一窗被注入即可任意读写
/// 用户库、经代理出网。业务宿主（service-host）只跑在 pet 窗，其他窗的
/// 业务调用本就经总线转发到 pet 窗，这里按调用窗 label 收权后语义不变。
pub fn ensure_pet_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == windows::PET {
        Ok(())
    } else {
        Err(format!("该命令仅限 pet 窗调用（当前窗口: {}）", window.label()))
    }
}

/// `system:openDataDir` —— 打开数据目录（设置页「备份数据」；
/// Electron 侧等价物是 shell.openPath(userData)）。
#[tauri::command]
fn system_open_data_dir() -> Result<(), String> {
    let dir = db::default_db_path()
        .parent()
        .ok_or("数据目录不可得")?
        .to_path_buf();
    std::process::Command::new("explorer")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开目录失败: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        /* 单实例必须第一个注册：second-instance → 开面板（Electron 同语义）。
           回调跑在主线程，建窗丢工作线程防死锁。 */
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app = app.clone();
            let _ = tauri::async_runtime::spawn(async move {
                if let Err(e) = windows::create_panel(&app) {
                    eprintln!("[desk-pet] 建面板窗失败: {e}");
                }
            });
        }))
        .plugin(tauri_plugin_notification::init())
        /* 开机自启：Windows 写 HKCU Run 项（值 = 当前 exe 路径）。启动参数 None——
           启动即按常规流程建 pet/托盘等全窗，无需隐藏类标记 */
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            app.manage(Mutex::new(tray::TraySnapshot::default()));
            /* DB 路径显式复用 %APPDATA%\desk-pet\，与 Electron 版共用同一文件（§6）；
               schema 由 JS 侧 store-bridge 建表，这里只开连接 */
            let database = db::open_at(&db::default_db_path()).map_err(|e| std::io::Error::other(e))?;
            app.manage(database);
            /* HTTP 流代理的取消池 + 共享连接池（chat.js/holiday.js 的传输层） */
            app.manage(http_proxy::HttpPool::new());
            windows::create_pet(app.handle())?;
            tray::create(app.handle())?;
            /* 桌宠右键菜单窗：常驻隐藏，右键时由 pet_menu_show 定位显示 */
            windows::create_petmenu(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            /* 窗口/系统类：Tauri command 名不允许冒号，与 preload channel 的
               对应关系见各命令注释（desk-shim 负责映射） */
            windows::chat_open_window,
            windows::chat_hide_window,
            windows::chat_toggle_pet,
            windows::window_toggle_pet,
            windows::window_pet_visible,
            windows::window_show_everything,
            windows::window_open_panel,
            windows::window_hide_panel,
            windows::window_minimize,
            scale::pet_set_always_on_top,
            windows::pet_refit,
            windows::pet_menu_resize,
            windows::pet_menu_show,
            windows::pet_menu_hide,
            pet_quit,
            /* 数据目录入口（设置页「备份数据」） */
            system_open_data_dir,
            /* rusqlite 桥（仅业务总线宿主使用；收权到 pet 窗，见 ensure_pet_window） */
            db::db_exec,
            db::db_select,
            tray::tray_update_snapshot,
            /* 照片存在性全表（service 的 deps.photoExists 用） */
            photos::photo_list,
            /* HTTP 流代理（webview fetch 的 CORS/UA 缺口；收权到 pet 窗） */
            http_proxy::http_fetch_stream,
            http_proxy::http_fetch_once,
            http_proxy::http_abort,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            /* 基线的 window-all-closed 空函数：桌宠是常驻窗口，全部关闭也不退出。
               Tauri 默认最后一个窗口销毁即退出（托盘随之消失，找回入口不复存在），
               这里拦截「无退出码」的退出请求——pet:quit / 托盘退出走 app.exit(0)，
               code = Some，不受影响。 */
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
