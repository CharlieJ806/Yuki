//! 窗口定位的纯计算 —— Electron src/main/index.js 的定位算法逐条移植。
//! 只做算术、不碰 tauri 类型，方便 cargo test 覆盖；坐标系统一为逻辑像素
//! （与 Electron 的 DIP 语义一致），物理像素换算在调用方完成。

/// 逻辑像素坐标系下的矩形（工作区 / 窗口锚点通用）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl FRect {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }
}

/// 桌宠默认位：工作区右下角，留 24px 边距（createPetWindow 的 x/y 兜底值）。
pub fn pet_default_position(work: FRect, w: f64, h: f64) -> (f64, f64) {
    (work.x + work.w - w - 24.0, work.y + work.h - h - 24.0)
}

/// 保存的位置是否还落在可视区内（换分辨率 / 拔掉外接屏检测）。
/// 与 Electron 相同：四周各留 20px 余量，完全出屏才算丢。
pub fn is_on_screen(x: f64, y: f64, w: f64, h: f64, work: FRect) -> bool {
    let m = 20.0;
    x + w > work.x + m
        && x < work.x + work.w - m
        && y + h > work.y + m
        && y < work.y + work.h - m
}

/// 桌宠位置解析：保存位有效就用，否则回右下角默认位。
pub fn resolve_pet_position(
    saved: Option<(f64, f64)>,
    w: f64,
    h: f64,
    work: FRect,
) -> (f64, f64) {
    match saved {
        Some((x, y)) if x.is_finite() && y.is_finite() && is_on_screen(x, y, w, h, work) => (x, y),
        _ => pet_default_position(work, w, h),
    }
}

/// 对话窗默认位：贴着桌宠弹出（右边缘对齐桌宠、底部上移 40px），
/// 没有桌宠就落右下角；最后夹进工作区（四周 8px）。
pub fn chat_default_position(
    pet: Option<FRect>,
    w: f64,
    h: f64,
    work: FRect,
) -> (f64, f64) {
    let m = 8.0;
    let (mut x, mut y) = match pet {
        Some(p) => (p.x + p.w - w, p.y - h + 40.0),
        None => (work.x + work.w - w - 40.0, work.y + work.h - h - 60.0),
    };
    x = x.clamp(work.x + m, work.x + work.w - w - m);
    y = y.clamp(work.y + m, work.y + work.h - h - m);
    (x, y)
}

/// 立绘小窗贴对话框左侧（间距 8px、底部对齐）；左边放不下改贴右侧，
/// 没有锚点就落右下角；最后夹进工作区（四周 4px）。
/// 移植自 positionChatPetWindow。
pub fn chat_pet_position(anchor: Option<FRect>, w: f64, h: f64, work: FRect) -> (f64, f64) {
    let m = 4.0;
    let (mut x, mut y) = match anchor {
        Some(a) => {
            let mut x = a.x - w - 8.0;
            if x < work.x + m {
                x = a.x + a.w + 8.0;
            }
            (x, a.y + a.h - h)
        }
        None => (work.x + work.w - w - 24.0, work.y + work.h - h - 24.0),
    };
    x = x.clamp(work.x + m, work.x + work.w - w - m);
    y = y.clamp(work.y + m, work.y + work.h - h - m);
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1920×1080 工作区（逻辑像素）。
    fn work() -> FRect {
        FRect::new(0.0, 0.0, 1920.0, 1040.0)
    }

    #[test]
    fn pet_default_lands_bottom_right_with_margin() {
        let (x, y) = pet_default_position(work(), 340.0, 700.0);
        assert_eq!(x, 1920.0 - 340.0 - 24.0);
        assert_eq!(y, 1040.0 - 700.0 - 24.0);
    }

    #[test]
    fn saved_position_inside_workarea_is_kept() {
        let p = resolve_pet_position(Some((100.0, 200.0)), 340.0, 700.0, work());
        assert_eq!(p, (100.0, 200.0));
    }

    #[test]
    fn saved_position_offscreen_falls_back_to_default() {
        // 屏幕整体右移后旧位置完全出屏（右缘越过工作区右缘 - 20）
        let (x, _) = resolve_pet_position(Some((1900.0, 200.0)), 340.0, 700.0, work());
        assert_eq!(x, 1920.0 - 340.0 - 24.0);
        // NaN 防御
        let (x, _) = resolve_pet_position(Some((f64::NAN, 0.0)), 340.0, 700.0, work());
        assert_eq!(x, 1920.0 - 340.0 - 24.0);
    }

    #[test]
    fn chat_anchors_to_pet_when_it_fits() {
        // 桌宠位置选得让对话窗算出的 y 落在工作区内（600-560+40=80）
        let pet = FRect::new(600.0, 600.0, 340.0, 700.0);
        let (x, y) = chat_default_position(Some(pet), 420.0, 560.0, work());
        assert_eq!(x, 600.0 + 340.0 - 420.0);
        assert_eq!(y, 80.0);
    }

    #[test]
    fn chat_clamps_into_workarea() {
        // 桌宠贴在最左，默认位会算出负 x，必须被夹回 8px
        let pet = FRect::new(0.0, 300.0, 340.0, 700.0);
        let (x, _) = chat_default_position(Some(pet), 420.0, 560.0, work());
        assert_eq!(x, 8.0);
    }

    #[test]
    fn chat_pet_hugs_left_of_anchor() {
        let anchor = FRect::new(600.0, 300.0, 420.0, 560.0);
        let (x, y) = chat_pet_position(Some(anchor), 132.0, 232.0, work());
        assert_eq!(x, 600.0 - 132.0 - 8.0);
        assert_eq!(y, 300.0 + 560.0 - 232.0);
    }

    #[test]
    fn chat_pet_flips_to_right_when_left_is_tight() {
        // 锚点贴左边，左侧放不下 → 改贴右侧
        let anchor = FRect::new(8.0, 300.0, 420.0, 560.0);
        let (x, _) = chat_pet_position(Some(anchor), 132.0, 232.0, work());
        assert_eq!(x, 8.0 + 420.0 + 8.0);
    }

    #[test]
    fn chat_pet_clamps_without_anchor() {
        let (x, y) = chat_pet_position(None, 132.0, 232.0, work());
        assert_eq!(x, 1920.0 - 132.0 - 24.0);
        assert_eq!(y, 1040.0 - 232.0 - 24.0);
    }
}
