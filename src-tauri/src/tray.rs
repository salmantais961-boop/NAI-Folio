//! Tray icon and its custom menu.
//!
//! The native context menu cannot be styled, so a right click opens a small
//! borderless, transparent webview (`tray-menu.html`) drawn in Folio's own
//! paper. The page measures itself and asks to be shown beside the cursor;
//! picking an entry hides it, brings the main window back and forwards the
//! action to the workspace as a `folio:tray` event.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const TRAY_ID: &str = "folio";
const MENU: &str = "tray-menu";
fn tray_image(app: &AppHandle) -> Image<'static> {
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let size = (16.0 * scale).round() as u32;
    let (pixels, side): (&[u8], u32) = match size {
        0..=16 => (include_bytes!("../icons/tray-16.rgba"), 16),
        17..=20 => (include_bytes!("../icons/tray-20.rgba"), 20),
        21..=24 => (include_bytes!("../icons/tray-24.rgba"), 24),
        25..=28 => (include_bytes!("../icons/tray-28.rgba"), 28),
        29..=32 => (include_bytes!("../icons/tray-32.rgba"), 32),
        33..=40 => (include_bytes!("../icons/tray-40.rgba"), 40),
        41..=48 => (include_bytes!("../icons/tray-48.rgba"), 48),
        49..=56 => (include_bytes!("../icons/tray-56.rgba"), 56),
        _ => (include_bytes!("../icons/tray-64.rgba"), 64),
    };
    Image::new_owned(pixels.to_vec(), side, side)
}

/// Whether the window's close button keeps Folio running in the tray.
/// Off by default: closing quits, as the setting's default promises.
pub struct CloseToTray(pub Arc<AtomicBool>);
/// Where the last right click happened, in physical screen pixels.
#[derive(Default)]
pub struct MenuAnchor(Mutex<Option<(f64, f64)>>);

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_menu(app: &AppHandle) {
    if let Some(menu) = app.get_webview_window(MENU) {
        let _ = menu.hide();
    }
}

fn open_menu(app: &AppHandle, x: f64, y: f64) {
    if let Some(anchor) = app.try_state::<MenuAnchor>() {
        *anchor.0.lock().unwrap() = Some((x, y));
    }
    if let Some(menu) = app.get_webview_window(MENU) {
        // An existing page re-renders and then asks to be shown.
        let _ = menu.eval("window.__folioTrayOpen && window.__folioTrayOpen()");
        return;
    }
    let built = WebviewWindowBuilder::new(app, MENU, WebviewUrl::App("tray-menu.html".into()))
        .title("Folio")
        .inner_size(280.0, 420.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .focused(false)
        .disable_drag_drop_handler()
        .on_navigation(|url| url.origin().ascii_serialization() == "http://tauri.localhost")
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build();
    if let Ok(menu) = built {
        let handle = app.clone();
        menu.on_window_event(move |event| {
            if let WindowEvent::Focused(false) = event {
                hide_menu(&handle);
            }
        });
    }
}

pub fn ensure_tray(app: &AppHandle) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_icon(Some(tray_image(app)))?;
        return Ok(());
    }
    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Folio")
        .icon(tray_image(app))
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                hide_menu(tray.app_handle());
                show_main(tray.app_handle());
            }
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                position,
                ..
            } => open_menu(tray.app_handle(), position.x, position.y),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Called by the window frame whenever the close preference changes.
#[tauri::command]
pub fn set_close_action(
    app: AppHandle,
    state: State<'_, CloseToTray>,
    action: String,
) -> Result<(), String> {
    let tray = action == "tray";
    // Keep shortcuts available while running regardless of close preference.
    // Never hide the main window unless a usable tray icon already exists.
    ensure_tray(&app).map_err(|error| error.to_string())?;
    state.0.store(tray, Ordering::Relaxed);
    Ok(())
}

/// The menu page reports its rendered size; place it beside the cursor,
/// inside the work area of the monitor that was clicked, then show it.
#[tauri::command]
pub fn tray_menu_show(
    window: WebviewWindow,
    anchor: State<'_, MenuAnchor>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if window.label() != MENU {
        return Err("not the tray menu".into());
    }
    let Some((x, y)) = *anchor.0.lock().unwrap() else {
        return Ok(());
    };
    let monitor = window
        .monitor_from_point(x, y)
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    if !width.is_finite() || !height.is_finite() {
        return Err("invalid menu size".into());
    }
    let max_height = monitor
        .as_ref()
        .map(|m| m.work_area().size.height as f64 / scale - 8.0)
        .unwrap_or(720.0)
        .max(80.0);
    let (w, h) = (
        width.clamp(160.0, 420.0),
        height.clamp(80.0, max_height.min(900.0)),
    );
    window
        .set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    let (pw, ph) = (w * scale, h * scale);
    let (mut left, mut top) = (x - pw, y - ph);
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let (ax, ay) = (area.position.x as f64, area.position.y as f64);
        let (aw, ah) = (area.size.width as f64, area.size.height as f64);
        if left < ax {
            left = x;
        }
        if top < ay {
            top = y;
        }
        left = left.clamp(ax, (ax + aw - pw).max(ax));
        top = top.clamp(ay, (ay + ah - ph).max(ay));
    }
    window
        .set_position(PhysicalPosition::new(
            left.round() as i32,
            top.round() as i32,
        ))
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn tray_menu_hide(window: WebviewWindow) {
    if window.label() == MENU {
        let _ = window.hide();
    }
}

/// A choice from the tray menu: quit, or bring Folio forward and let the
/// workspace navigate (page, chat, settings…).
#[tauri::command]
pub fn tray_action(
    app: AppHandle,
    window: WebviewWindow,
    action: String,
    id: Option<String>,
) -> Result<(), String> {
    if window.label() != MENU {
        return Err("not the tray menu".into());
    }
    if !matches!(
        action.as_str(),
        "quit"
            | "show"
            | "studio"
            | "agent"
            | "lab"
            | "archive"
            | "atlas"
            | "thread"
            | "threads"
            | "new-chat"
            | "agent-settings"
            | "settings"
            | "theme"
    ) {
        return Err("unknown tray action".into());
    }
    let _ = window.hide();
    if action == "quit" {
        app.exit(0);
        return Ok(());
    }
    show_main(&app);
    if action != "show" {
        app.emit_to(
            "main",
            "folio:tray",
            serde_json::json!({ "action": action, "id": id }),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
