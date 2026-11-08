#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod frame;

use bridge::Bridge;
use std::{
    error::Error,
    ptr::null_mut,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{
    webview::NewWindowResponse, App, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

type Service = Arc<Mutex<Option<Bridge>>>;

fn setup(app: &mut App) -> Result<(), Box<dyn Error>> {
    let service = Bridge::start(&app.path().resource_dir()?.join("backend"))?;
    let config = serde_json::json!({
        "apiBase": format!("http://127.0.0.1:{}", service.port),
        "token": service.token,
    });
    // WebView2 injects initialization scripts into subframes too. Only the
    // trusted top-level application document receives credentials.
    let startup = format!(
        r#"
      if (window === window.top && location.origin === 'http://tauri.localhost' && location.pathname === '/desktop.html') {{
        Object.defineProperty(window, '__FOLIO_DESKTOP__', {{ value: Object.freeze({config}) }});
      }}
    "#
    );
    let (width, height) = app
        .primary_monitor()?
        .map(|m| {
            let area = m.work_area().size.to_logical::<f64>(m.scale_factor());
            (
                (area.width * 0.93).min(1440.0),
                (area.height * 0.92).min(900.0),
            )
        })
        .unwrap_or((1200.0, 760.0));
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("desktop.html".into()))
        .title("Folio")
        .inner_size(width, height)
        .min_inner_size(width.min(680.0), height.min(440.0))
        .decorations(false)
        .resizable(true)
        .shadow(false)
        .center()
        .visible(false)
        .disable_drag_drop_handler()
        .initialization_script(startup)
        .on_navigation(|url| url.origin().ascii_serialization() == "http://tauri.localhost")
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()?;
    let handle = window.hwnd()?.0 as usize;
    frame::install(handle as _)?;
    let corners = frame::Corners::default();
    corners.clip(handle as _);
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            corners.clip(handle as _);
        }
    });
    window.show()?;
    let service = Arc::new(Mutex::new(Some(service)));
    app.manage(service.clone());
    let app_handle = app.handle().clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let mut guard = service.lock().unwrap();
        let Some(child) = guard.as_mut() else { break };
        if child.has_exited() {
            guard.take();
            drop(guard);
            if let Some(window) = app_handle.get_webview_window("main") {
                if let Ok(hwnd) = window.hwnd() {
                    frame::alert(
                        hwnd.0,
                        "本地 API 服务已退出。当前作品仍可查看，请重新打开 Folio 以继续生成。",
                    );
                }
            }
            break;
        }
    });
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            if let Err(error) = setup(app) {
                frame::alert(null_mut(), &format!("Folio 无法启动：{error}"));
                app.handle().exit(1);
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|handle, event| {
            if matches!(event, RunEvent::Exit) {
                if let Some(service) = handle.try_state::<Service>() {
                    service.lock().unwrap().take();
                }
            }
        }),
        Err(err) => frame::alert(null_mut(), &format!("Folio 无法启动：{err}")),
    }
}
