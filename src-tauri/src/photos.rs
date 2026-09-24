//! 照片存在性 —— 生活照/服饰照片是分批生成的静态资源，service 的
//! `deps.photoExists` 需要同步判断某张照片是否真的在包里。
//!
//! 为什么整表返回而不是单张查询：service 的判断接口是**同步**的
//! （photoExists 在 filter 里逐个调用），而 JS→Rust 只有异步 invoke——
//! 所以启动时一次性拉全表，前端缓存成 Set 后做同步查询。
//!
//! 为什么走资产解析器而不是文件系统：正式包里 dist/ 全部**内嵌进 exe**，
//! 磁盘上没有这个目录；`AssetResolver` 对内嵌与 dev 两种形态都查得到
//! （dev 下内嵌表为空，回退读仓库里的 dist/photos）。

use tauri::AppHandle;

#[tauri::command]
pub fn photo_list(app: AppHandle) -> Vec<String> {
    /* 正式包：dist 内嵌进二进制，资产解析器直接给全表 */
    let embedded: Vec<String> = app
        .asset_resolver()
        .iter()
        .filter(|(p, _)| p.starts_with("photos/"))
        .map(|(p, _)| p.into_owned())
        .collect();
    if !embedded.is_empty() {
        return embedded;
    }

    /* dev（devUrl 指向 vite，资产解析器为空）：回退读仓库里的 dist/photos。
       CARGO_MANIFEST_DIR 指向 src-tauri，dist 在仓库根。
       递归扫描 photos 目录（含 life 子目录）的全部 PNG，
       与 photoPathsOf 的路径格式（正斜杠、photos/ 前缀）保持一致。 */
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/photos");
    let mut out = Vec::new();
    walk_dir(&dir, "photos/", &mut out);
    out
}

fn walk_dir(dir: &std::path::Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if path.is_dir() {
            walk_dir(&path, &format!("{prefix}{name}/"), out);
        } else if name.to_lowercase().ends_with(".png") {
            out.push(format!("{prefix}{name}"));
        }
    }
}
