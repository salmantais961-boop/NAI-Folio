mod shadow;

use std::{io, ptr::null_mut, sync::Mutex};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
    Graphics::{
        Dwm::{DwmSetWindowAttribute, DWMNCRP_DISABLED, DWMWA_NCRENDERING_POLICY},
        Gdi::{
            CreateRoundRectRgn, DeleteObject, GetMonitorInfoW, MonitorFromWindow, SetWindowRgn,
            MONITORINFO, MONITOR_DEFAULTTONEAREST,
        },
    },
    UI::{
        HiDpi::GetDpiForWindow,
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            DestroyWindow, GetWindowLongW, GetWindowRect, IsIconic, IsZoomed, MessageBoxW,
            SetWindowLongW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE, MB_ICONERROR, MB_OK, MINMAXINFO,
            STYLESTRUCT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
            WM_DPICHANGED, WM_GETMINMAXINFO, WM_NCDESTROY, WM_STYLECHANGING, WM_WINDOWPOSCHANGED,
            WS_CAPTION, WS_EX_WINDOWEDGE,
        },
    },
};

fn frame_style(index: i32, style: u32) -> u32 {
    match index {
        GWL_STYLE => style & !WS_CAPTION,
        GWL_EXSTYLE => style & !WS_EX_WINDOWEDGE,
        _ => style,
    }
}

unsafe extern "system" fn borderless_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    shadow_handle: usize,
) -> LRESULT {
    if message == WM_STYLECHANGING {
        // Tao re-applies its complete style on visibility/maximize transitions.
        // Remove only the caption and edge; keep the native resize and snap flags.
        let change = &mut *(lparam as *mut STYLESTRUCT);
        change.styleNew = frame_style(wparam as i32, change.styleNew);
    } else if message == WM_GETMINMAXINFO {
        // Windows otherwise reserves an invisible native frame around the
        // maximized window, including over a secondary monitor's taskbar.
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info) != 0 {
            let limits = &mut *(lparam as *mut MINMAXINFO);
            let work = info.rcWork;
            limits.ptMaxPosition.x = work.left - info.rcMonitor.left;
            limits.ptMaxPosition.y = work.top - info.rcMonitor.top;
            limits.ptMaxSize.x = work.right - work.left;
            limits.ptMaxSize.y = work.bottom - work.top;
        }
        return result;
    } else if matches!(message, WM_WINDOWPOSCHANGED | WM_DPICHANGED) {
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        shadow::sync(hwnd, shadow_handle as HWND);
        return result;
    } else if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(borderless_proc), id);
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

pub fn install(hwnd: HWND) -> io::Result<()> {
    unsafe {
        let shadow = shadow::create(hwnd);
        if SetWindowSubclass(hwnd, Some(borderless_proc), 1, shadow as usize) == 0 {
            if !shadow.is_null() {
                DestroyWindow(shadow);
            }
            return Err(io::Error::other("无法初始化桌面窗口边框。"));
        }
        for index in [GWL_STYLE, GWL_EXSTYLE] {
            let style = GetWindowLongW(hwnd, index) as u32;
            SetWindowLongW(hwnd, index, frame_style(index, style) as i32);
        }
        let policy = DWMNCRP_DISABLED;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_NCRENDERING_POLICY as u32,
            (&policy as *const i32).cast(),
            size_of_val(&policy) as u32,
        );
        SetWindowPos(
            hwnd,
            null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
    Ok(())
}

#[derive(Default)]
pub struct Corners(Mutex<Option<(i32, i32, u32)>>);

impl Corners {
    pub fn clip(&self, hwnd: HWND) {
        // The region clips the WebView child as well as the native window. Keep
        // the 18-DIP component radius when the window crosses monitor DPI scales.
        unsafe {
            if IsIconic(hwnd) != 0 {
                return;
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect) == 0 {
                return;
            }
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            if width <= 0 || height <= 0 {
                return;
            }
            let zoomed = IsZoomed(hwnd) != 0;
            let dpi = if zoomed {
                0
            } else {
                GetDpiForWindow(hwnd).max(96)
            };
            let new = (width, height, dpi);
            if self.0.lock().unwrap().replace(new) == Some(new) {
                return;
            }
            if zoomed {
                SetWindowRgn(hwnd, null_mut(), 1);
                return;
            }
            let diameter = ((2 * shadow::RADIUS_DIP as u32 * dpi + 48) / 96) as i32;
            let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter);
            if !region.is_null() && SetWindowRgn(hwnd, region, 1) == 0 {
                // Windows owns the HRGN only when SetWindowRgn succeeds.
                DeleteObject(region);
            }
        }
    }
}

pub fn alert(hwnd: HWND, message: &str) {
    let text: Vec<_> = message.encode_utf16().chain([0]).collect();
    let caption: Vec<_> = "Folio".encode_utf16().chain([0]).collect();
    unsafe {
        MessageBoxW(hwnd, text.as_ptr(), caption.as_ptr(), MB_OK | MB_ICONERROR);
    }
}
