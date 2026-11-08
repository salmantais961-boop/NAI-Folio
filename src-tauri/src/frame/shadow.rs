use std::ptr::{null, null_mut};
use windows_sys::Win32::{
    Foundation::{HWND, POINT, RECT, SIZE},
    Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, AC_SRC_ALPHA,
        AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS,
    },
    UI::{
        HiDpi::GetDpiForWindow,
        WindowsAndMessaging::{
            CreateWindowExW, GetWindowLongPtrW, GetWindowRect, IsIconic, IsWindowVisible, IsZoomed,
            SetWindowLongPtrW, SetWindowPos, ShowWindow, UpdateLayeredWindow, GWLP_USERDATA,
            SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE,
            SW_SHOWNOACTIVATE, ULW_ALPHA, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
            WS_EX_TRANSPARENT, WS_POPUP,
        },
    },
};

pub(super) const RADIUS_DIP: i32 = 18;
const REACH_DIP: i32 = 32;

pub(super) unsafe fn create(owner: HWND) -> HWND {
    // The owner keeps this tool window in its own z-order group and destroys it on exit.
    // A transparent center and click-through style leave the WebView and resize grips exposed.
    CreateWindowExW(
        WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT,
        windows_sys::w!("STATIC"),
        null(),
        WS_POPUP,
        0,
        0,
        0,
        0,
        owner,
        null_mut(),
        null_mut(),
        null(),
    )
}

pub(super) unsafe fn sync(owner: HWND, shadow: HWND) {
    if shadow.is_null() {
        return;
    }
    if IsWindowVisible(owner) == 0 || IsIconic(owner) != 0 || IsZoomed(owner) != 0 {
        if IsWindowVisible(shadow) != 0 {
            ShowWindow(shadow, SW_HIDE);
        }
        return;
    }
    let mut rect = RECT::default();
    if GetWindowRect(owner, &mut rect) == 0 || rect.right <= rect.left || rect.bottom <= rect.top {
        return;
    }
    let dpi = GetDpiForWindow(owner).max(96) as i32;
    let pad = (REACH_DIP * dpi + 48) / 96;
    let origin = POINT {
        x: rect.left - pad,
        y: rect.top - pad,
    };
    let size = SIZE {
        cx: rect.right - rect.left + 2 * pad,
        cy: rect.bottom - rect.top + 2 * pad,
    };
    let mut previous = RECT::default();
    GetWindowRect(shadow, &mut previous);
    if size.cx != previous.right - previous.left
        || size.cy != previous.bottom - previous.top
        || GetWindowLongPtrW(shadow, GWLP_USERDATA) != dpi as isize
    {
        if !paint(shadow, origin, size, pad, dpi) {
            ShowWindow(shadow, SW_HIDE);
            return;
        }
        SetWindowLongPtrW(shadow, GWLP_USERDATA, dpi as isize);
    } else if origin.x != previous.left || origin.y != previous.top {
        SetWindowPos(
            shadow,
            null_mut(),
            origin.x,
            origin.y,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER,
        );
    }
    if IsWindowVisible(shadow) == 0 {
        ShowWindow(shadow, SW_SHOWNOACTIVATE);
    }
}

unsafe fn paint(hwnd: HWND, origin: POINT, size: SIZE, pad: i32, dpi: i32) -> bool {
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size.cx,
            biHeight: -size.cy,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..Default::default()
        },
        ..Default::default()
    };
    let dc = CreateCompatibleDC(null_mut());
    if dc.is_null() {
        return false;
    }
    let mut bits = null_mut();
    let bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
    if bitmap.is_null() {
        DeleteDC(dc);
        return false;
    }
    let previous = SelectObject(dc, bitmap);
    let count = size.cx as usize * size.cy as usize;
    // DIB storage is uninitialized. The zeroed center stays entirely transparent.
    bits.cast::<u32>().write_bytes(0, count);
    let pixels = std::slice::from_raw_parts_mut(bits.cast::<u32>(), count);
    render(pixels, size.cx as usize, size.cy as usize, pad, dpi);
    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: 255,
        AlphaFormat: AC_SRC_ALPHA as u8,
    };
    let ok = UpdateLayeredWindow(
        hwnd,
        null_mut(),
        &origin,
        &size,
        dc,
        &POINT::default(),
        0,
        &blend,
        ULW_ALPHA,
    ) != 0;
    SelectObject(dc, previous);
    DeleteObject(bitmap);
    DeleteDC(dc);
    ok
}

fn render(pixels: &mut [u32], width: usize, height: usize, pad: i32, dpi: i32) {
    let scale = dpi as f32 / 96.0;
    let radius = RADIUS_DIP as f32;
    // x and y below are signed distances from the tangent points of the rounded rectangle.
    // The straight part of each row needs one sample, regardless of the monitor width.
    let tangent = pad as f32 + radius * scale;
    let left_cap = (tangent.ceil() as usize).min(width / 2);
    for (row_y, row) in pixels.chunks_exact_mut(width).enumerate() {
        let y = (row_y as f32 + 0.5) / scale;
        let bottom = height as f32 / scale - y;
        let vertical = y.min(bottom);
        let qy = tangent / scale - vertical;
        let lower_qy = tangent / scale - (y - 3.5).min(bottom + 3.5);
        let shade = |x: usize| {
            let qx = (tangent - x as f32 - 0.5) / scale;
            let distance = |dy: f32| qx.max(0.0).hypot(dy.max(0.0)) + qx.max(dy).min(0.0) - radius;
            let edge = distance(qy);
            if edge < 0.0 {
                return 0;
            }
            let ambient = distance(lower_qy).max(0.0);
            // Two soft ink washes: a narrow contact shadow and a wider, slightly lower falloff.
            let alpha = (18.0 * (-edge * edge / 28.0).exp()
                + 28.0 * (-ambient * ambient / 152.0).exp())
            .round() as u32;
            alpha << 24
        };
        for x in 0..left_cap {
            let value = shade(x);
            row[x] = value;
            row[width - 1 - x] = value;
        }
        if qy >= radius {
            row[left_cap..width - left_cap].fill(shade(left_cap));
        }
    }
}
