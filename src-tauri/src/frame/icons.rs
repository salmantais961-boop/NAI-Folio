use std::ptr::null;
use windows_sys::Win32::{
    Foundation::HWND,
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
        WindowsAndMessaging::{
            LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_SHARED, SM_CXICON,
            SM_CXSMICON, WM_SETICON,
        },
    },
};

// Tauri's default RGBA icon is a single raster. Ask Windows for the matching
// size in the executable's multi-resolution ICO instead of scaling that raster.
// LR_SHARED keeps resource handles cached/owned by Windows, including DPI swaps.
pub fn apply(hwnd: HWND) {
    unsafe {
        let module = GetModuleHandleW(null());
        let dpi = GetDpiForWindow(hwnd).max(96);
        for (kind, metric) in [(ICON_BIG, SM_CXICON), (ICON_SMALL, SM_CXSMICON)] {
            let size = GetSystemMetricsForDpi(metric, dpi);
            let icon = LoadImageW(
                module,
                32512usize as *const u16,
                IMAGE_ICON,
                size,
                size,
                LR_SHARED,
            );
            if !icon.is_null() {
                SendMessageW(hwnd, WM_SETICON, kind as usize, icon as isize);
            }
        }
    }
}
