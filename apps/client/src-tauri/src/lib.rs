#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod capture;
mod downloads;
mod sidecar;
mod window;
mod workspace;

use browser::{
    browser_capture_preview, browser_clear_data, browser_click, browser_close,
    browser_evaluate_script, browser_fill, browser_fill_form, browser_handle_dialog, browser_hide,
    browser_hover, browser_navigate, browser_open, browser_press_key, browser_refresh_state,
    browser_resize, browser_show, browser_state, browser_take_screenshot, browser_take_snapshot,
    browser_type_text, browser_upload_file, browser_wait_for, resize_page, select_page,
    BrowserState,
};
use capture::read_local_image;
use downloads::browser_open_download;
use sidecar::{agent_api_token, AgentServer};
use tauri::{Manager, RunEvent};
use workspace::{list_workspace_openers, open_workspace_with};

#[cfg(test)]
use browser::{
    history_navigation_script, is_windows_drive_path, normalize_url, sanitize_browser_favicon_url,
    sanitize_browser_favicon_urls, BROWSER_STATE_QUERY_SCRIPT,
};
#[cfg(test)]
use capture::{
    decode_png, encode_png, snapshot_file_path, validate_screenshot_relative_path, write_png,
    CapturedImage,
};
#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::path::PathBuf;
#[cfg(test)]
use workspace::{spawn_workspace_opener, validated_workspace_root};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_decorum::init())
        .on_menu_event(window::handle_menu_event)
        .manage(BrowserState {
            pages: std::sync::Mutex::new(Vec::new()),
            active_page_id: std::sync::Mutex::new(None),
            next_page_id: std::sync::Mutex::new(1),
            last_bounds: std::sync::Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            browser_state,
            browser_clear_data,
            browser_refresh_state,
            browser_open,
            browser_navigate,
            browser_evaluate_script,
            browser_take_snapshot,
            browser_take_screenshot,
            browser_capture_preview,
            browser_open_download,
            browser_click,
            browser_hover,
            browser_fill,
            browser_fill_form,
            browser_upload_file,
            browser_wait_for,
            browser_press_key,
            browser_type_text,
            browser_handle_dialog,
            browser_resize,
            browser_show,
            browser_hide,
            browser_close,
            select_page,
            resize_page,
            list_workspace_openers,
            open_workspace_with,
            read_local_image,
            agent_api_token,
        ])
        .setup(|app| {
            window::setup(app)?;
            app.manage(AgentServer::start(app));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(server) = app.try_state::<AgentServer>() {
                    server.stop();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::{is_windows_drive_path, normalize_url};

    #[test]
    fn workspace_opener_rejects_an_empty_root() {
        assert_eq!(
            validated_workspace_root("  ").unwrap_err(),
            "Select a workspace first"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn workspace_opener_rejects_unknown_application_ids() {
        let root = std::env::current_dir().expect("current directory");
        assert_eq!(
            spawn_workspace_opener(&root, "powershell").unwrap_err(),
            "Unknown workspace application"
        );
    }

    #[test]
    fn browser_state_query_uses_native_navigation_capabilities() {
        assert!(BROWSER_STATE_QUERY_SCRIPT.contains("window.navigation"));
        assert!(BROWSER_STATE_QUERY_SCRIPT.contains("canGoBack"));
        assert!(BROWSER_STATE_QUERY_SCRIPT.contains("canGoForward"));
    }

    #[test]
    fn normalizes_windows_drive_paths_as_file_urls() {
        assert!(is_windows_drive_path("E:/root/login.html"));
        assert_eq!(
            normalize_url(Some("E:/root/login.html"))
                .unwrap()
                .to_string(),
            "file:///E:/root/login.html"
        );
    }

    #[test]
    fn browser_state_query_collects_favicon_fallbacks() {
        assert!(BROWSER_STATE_QUERY_SCRIPT.contains("apple-touch-icon"));
        assert!(BROWSER_STATE_QUERY_SCRIPT.contains("/favicon.ico"));
        assert!(BROWSER_STATE_QUERY_SCRIPT.contains("faviconUrls"));
    }

    #[test]
    fn history_navigation_delegates_without_reconstructing_a_target_url() {
        let script = history_navigation_script("back").expect("history script");

        assert!(script.contains("navigation.back()"));
        assert!(script.contains("window.history.back()"));
        assert!(!script.contains("targetUrl"));
        assert!(!script.contains("target_url"));
    }

    #[test]
    fn favicon_urls_are_limited_to_safe_image_sources() {
        assert_eq!(
            sanitize_browser_favicon_url("https://example.com/favicon.ico"),
            "https://example.com/favicon.ico"
        );
        assert_eq!(
            sanitize_browser_favicon_url("data:image/png;base64,AA=="),
            "data:image/png;base64,AA=="
        );
        assert!(sanitize_browser_favicon_url("file:///C:/Windows/System32/icon.ico").is_empty());
        assert!(sanitize_browser_favicon_url(&format!(
            "data:image/png;base64,{}",
            "a".repeat(32 * 1024)
        ))
        .is_empty());

        assert_eq!(
            sanitize_browser_favicon_urls(vec![
                "https://example.com/favicon.ico".to_string(),
                "file:///C:/Windows/System32/icon.ico".to_string(),
                "https://example.com/favicon.ico".to_string(),
                "https://example.com/apple-touch-icon.png".to_string(),
            ]),
            vec![
                "https://example.com/favicon.ico".to_string(),
                "https://example.com/apple-touch-icon.png".to_string(),
            ]
        );
    }

    #[test]
    fn screenshot_relative_paths_stay_in_the_workspace() {
        assert_eq!(
            validate_screenshot_relative_path("artifacts/page.PNG").unwrap(),
            PathBuf::from("artifacts/page.PNG")
        );
        assert!(validate_screenshot_relative_path("../page.png").is_err());
        assert!(validate_screenshot_relative_path("artifacts/page.jpg").is_err());
    }

    #[test]
    fn snapshot_file_path_stays_in_the_workspace_and_creates_parent_directories() {
        let directory = std::env::temp_dir().join(format!(
            "moke-snapshot-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();

        let output = snapshot_file_path(&directory, "artifacts/page.json").unwrap();

        assert_eq!(output, directory.join("artifacts/page.json"));
        assert!(output.parent().unwrap().is_dir());
        assert!(snapshot_file_path(&directory, "../page.json").is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn screenshot_relative_paths_reject_absolute_windows_paths() {
        assert!(validate_screenshot_relative_path("C:\\Temp\\page.png").is_err());
    }

    #[test]
    fn screenshot_png_round_trips_rgba_pixels() {
        let original = CapturedImage {
            width: 2,
            height: 1,
            rgba: vec![10, 20, 30, 255, 40, 50, 60, 128],
        };
        let decoded = decode_png(&encode_png(&original).unwrap()).unwrap();

        assert_eq!(decoded.width, original.width);
        assert_eq!(decoded.height, original.height);
        assert_eq!(decoded.rgba, original.rgba);
    }

    #[test]
    fn screenshot_writer_does_not_overwrite_existing_files() {
        let directory = std::env::temp_dir().join(format!(
            "moke-screenshot-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("capture.png");
        let image = CapturedImage {
            width: 1,
            height: 1,
            rgba: vec![0, 0, 0, 255],
        };

        write_png(&path, &image).unwrap();
        assert!(write_png(&path, &image).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
