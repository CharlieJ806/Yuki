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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        /* 单实例必须第一个注册：second-instance → 开面板（Electron 同语义）。
           回调跑在主线程，建窗丢工作线程防死锁。 */
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app = app.clone();
            let _ = tauri::async_runtime::spawn(async move {
                let _ = windows::create_panel(&app);
            });
        }))
        .plugin(tauri_plugin_notification::init())
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
            /* rusqlite 桥（仅业务总线宿主使用） */
            db::db_exec,
            db::db_select,
            tray::tray_update_snapshot,
            /* 照片存在性全表（service 的 deps.photoExists 用） */
            photos::photo_list,
            /* HTTP 流代理（webview fetch 的 CORS/UA 缺口） */
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
