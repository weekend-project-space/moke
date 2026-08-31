use tauri::Manager;
use tauri_plugin_decorum::WebviewWindowExt;

#[cfg(target_os = "macos")]
pub(crate) fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    use tauri::Emitter;

    let event_name = match event.id().as_ref() {
        "app-menu-new-chat" => Some("app-menu:new-chat"),
        "app-menu-settings" => Some("app-menu:settings"),
        _ => None,
    };
    if let Some(event_name) = event_name {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit(event_name, ());
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn handle_menu_event(_app: &tauri::AppHandle, _event: tauri::menu::MenuEvent) {}

pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

        let new_chat = MenuItemBuilder::with_id("app-menu-new-chat", "New chat").build(app)?;
        let settings = MenuItemBuilder::with_id("app-menu-settings", "Settings").build(app)?;
        let file_menu = SubmenuBuilder::with_id(app, "app-menu-file", "File")
            .item(&new_chat)
            .item(&settings)
            .build()?;
        let menu = MenuBuilder::new(app).item(&file_menu).build()?;
        app.set_menu(menu)?;
    }

    #[cfg(not(target_os = "macos"))]
    app.get_webview_window("main")
        .expect("main window is not available")
        .create_overlay_titlebar()?;

    Ok(())
}
