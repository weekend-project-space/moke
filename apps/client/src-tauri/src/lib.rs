use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use url::Url;

struct AgentServer {
    child: Mutex<Option<Child>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPageState {
    page_id: u32,
    label: String,
    url: String,
    title: String,
    can_go_back: bool,
    can_go_forward: bool,
    is_loading: bool,
    visible: bool,
}

struct BrowserState {
    pages: Mutex<Vec<BrowserPageState>>,
    active_page_id: Mutex<Option<u32>>,
    next_page_id: Mutex<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPageOptions {
    url: Option<String>,
    visible: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNavigateOptions {
    page_id: Option<u32>,
    #[serde(rename = "type")]
    nav_type: String,
    url: Option<String>,
    ignore_cache: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserListResult {
    pages: Vec<BrowserPageState>,
    active_page_id: Option<u32>,
}

impl AgentServer {
    fn start() -> Self {
        let repo_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri should live under the client app")
            .parent()
            .expect("client app should live under apps")
            .parent()
            .expect("apps should live under the repository root")
            .to_path_buf();

        let child = Command::new("npx")
            .arg("tsx")
            .arg("apps/server/server.ts")
            .current_dir(repo_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok();

        Self {
            child: Mutex::new(child),
        }
    }

    fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *child = None;
        }
    }
}

fn normalize_url(value: Option<&str>) -> Result<Url, String> {
    let raw = value.unwrap_or("about:blank").trim();
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else if raw == "about:blank" {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };

    Url::parse(&with_scheme).map_err(|error| format!("Invalid URL: {error}"))
}

fn list_browser_pages(state: &BrowserState) -> Result<BrowserListResult, String> {
    let pages = state
        .pages
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?
        .clone();
    let active_page_id = *state
        .active_page_id
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?;

    Ok(BrowserListResult {
        pages,
        active_page_id,
    })
}

fn active_page_id(state: &BrowserState, page_id: Option<u32>) -> Result<u32, String> {
    if let Some(page_id) = page_id {
        return Ok(page_id);
    }

    state
        .active_page_id
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?
        .ok_or_else(|| "No active browser page".to_string())
}

fn find_page_label(state: &BrowserState, page_id: u32) -> Result<String, String> {
    state
        .pages
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?
        .iter()
        .find(|page| page.page_id == page_id)
        .map(|page| page.label.clone())
        .ok_or_else(|| format!("Browser page {page_id} was not found"))
}

fn update_page<F>(state: &BrowserState, page_id: u32, update: F) -> Result<(), String>
where
    F: FnOnce(&mut BrowserPageState),
{
    let mut pages = state
        .pages
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?;
    let page = pages
        .iter_mut()
        .find(|page| page.page_id == page_id)
        .ok_or_else(|| format!("Browser page {page_id} was not found"))?;
    update(page);
    Ok(())
}

fn select_browser_page(
    app: &tauri::AppHandle,
    state: &BrowserState,
    page_id: u32,
) -> Result<(), String> {
    let pages = {
        state
            .pages
            .lock()
            .map_err(|_| "Browser state is unavailable".to_string())?
            .clone()
    };

    if !pages.iter().any(|page| page.page_id == page_id) {
        return Err(format!("Browser page {page_id} was not found"));
    }

    for page in pages {
        if let Some(window) = app.get_webview_window(&page.label) {
            if page.page_id == page_id {
                window.show().map_err(|error| error.to_string())?;
                window.set_focus().map_err(|error| error.to_string())?;
            } else {
                window.hide().map_err(|error| error.to_string())?;
            }
        }
    }

    {
        let mut pages = state
            .pages
            .lock()
            .map_err(|_| "Browser state is unavailable".to_string())?;
        for page in pages.iter_mut() {
            page.visible = page.page_id == page_id;
        }
    }
    *state
        .active_page_id
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())? = Some(page_id);

    Ok(())
}

#[tauri::command]
async fn browser_list_pages(state: tauri::State<'_, BrowserState>) -> Result<BrowserListResult, String> {
    list_browser_pages(&state)
}

#[tauri::command]
async fn browser_create_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserPageOptions,
) -> Result<BrowserListResult, String> {
    let page_id = {
        let mut next_page_id = state
            .next_page_id
            .lock()
            .map_err(|_| "Browser state is unavailable".to_string())?;
        let page_id = *next_page_id;
        *next_page_id += 1;
        page_id
    };
    let label = format!("browser-page-{page_id}");
    let url = normalize_url(options.url.as_deref())?;
    println!("Creating browser window {page_id} -> {url}");

    let page_load_id = page_id;
    let title_id = page_id;
    let page_load_app = app.clone();
    let title_app = app.clone();
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url.clone()))
        .title("Moke Browser")
        .inner_size(980.0, 720.0)
        .resizable(true)
        .visible(options.visible.unwrap_or(true))
        .center()
        .on_page_load(move |_webview, payload| {
            let is_loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            if let Some(state) = page_load_app.try_state::<BrowserState>() {
                let _ = update_page(&state, page_load_id, |page| {
                    page.url = payload.url().to_string();
                    page.is_loading = is_loading;
                });
            }
        })
        .on_document_title_changed(move |_webview, title| {
            if let Some(state) = title_app.try_state::<BrowserState>() {
                let _ = update_page(&state, title_id, |page| {
                    page.title = title;
                });
            }
        })
        .build()
        .map_err(|error| error.to_string())?;

    if options.visible.unwrap_or(true) {
        window.set_focus().map_err(|error| error.to_string())?;
    }

    {
        let mut pages = state
            .pages
            .lock()
            .map_err(|_| "Browser state is unavailable".to_string())?;
        pages.push(BrowserPageState {
            page_id,
            label,
            url: url.to_string(),
            title: "新页面".to_string(),
            can_go_back: false,
            can_go_forward: false,
            is_loading: true,
            visible: options.visible.unwrap_or(true),
        });
    }
    *state
        .active_page_id
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())? = Some(page_id);

    list_browser_pages(&state)
}

#[tauri::command]
async fn browser_navigate_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserNavigateOptions,
) -> Result<BrowserListResult, String> {
    let page_id = active_page_id(&state, options.page_id)?;
    let label = find_page_label(&state, page_id)?;
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Browser window {label} was not found"))?;

    match options.nav_type.as_str() {
        "url" => {
            let url = normalize_url(options.url.as_deref())?;
            window.navigate(url.clone()).map_err(|error| error.to_string())?;
            update_page(&state, page_id, |page| {
                page.url = url.to_string();
                page.is_loading = true;
            })?;
        }
        "reload" => {
            if options.ignore_cache.unwrap_or(false) {
                let current_url = window.url().map_err(|error| error.to_string())?;
                window.navigate(current_url).map_err(|error| error.to_string())?;
            } else {
                window.reload().map_err(|error| error.to_string())?;
            }
            update_page(&state, page_id, |page| {
                page.is_loading = true;
            })?;
        }
        "back" | "forward" => {
            return Err(format!("Navigation type `{}` is not available in the first native WebView tier", options.nav_type));
        }
        _ => return Err("type must be url, back, forward, or reload".to_string()),
    }

    list_browser_pages(&state)
}

#[tauri::command]
async fn browser_select_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: u32,
) -> Result<BrowserListResult, String> {
    select_browser_page(&app, &state, page_id)?;
    list_browser_pages(&state)
}

#[tauri::command]
async fn browser_close_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: u32,
) -> Result<BrowserListResult, String> {
    let label = find_page_label(&state, page_id)?;
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|error| error.to_string())?;
    }

    let next_active = {
        let mut pages = state
            .pages
            .lock()
            .map_err(|_| "Browser state is unavailable".to_string())?;
        pages.retain(|page| page.page_id != page_id);
        pages.last().map(|page| page.page_id)
    };

    *state
        .active_page_id
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())? = next_active;

    if let Some(next_active) = next_active {
        select_browser_page(&app, &state, next_active)?;
    }

    list_browser_pages(&state)
}

#[tauri::command]
async fn browser_resize_page(
    state: tauri::State<'_, BrowserState>,
    page_id: Option<u32>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<BrowserListResult, String> {
    let _ = (page_id, width, height);
    list_browser_pages(&state)
}

#[tauri::command]
async fn browser_show(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: Option<u32>,
) -> Result<BrowserListResult, String> {
    let page_id = active_page_id(&state, page_id)?;
    let label = find_page_label(&state, page_id)?;
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Browser window {label} was not found"))?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    update_page(&state, page_id, |page| {
        page.visible = true;
    })?;
    list_browser_pages(&state)
}

#[tauri::command]
async fn browser_hide(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: Option<u32>,
) -> Result<BrowserListResult, String> {
    let page_id = active_page_id(&state, page_id)?;
    let label = find_page_label(&state, page_id)?;
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Browser window {label} was not found"))?;
    window.hide().map_err(|error| error.to_string())?;
    update_page(&state, page_id, |page| {
        page.visible = false;
    })?;
    list_browser_pages(&state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BrowserState {
            pages: Mutex::new(Vec::new()),
            active_page_id: Mutex::new(None),
            next_page_id: Mutex::new(1),
        })
        .invoke_handler(tauri::generate_handler![
            browser_list_pages,
            browser_create_page,
            browser_navigate_page,
            browser_select_page,
            browser_close_page,
            browser_resize_page,
            browser_show,
            browser_hide,
        ])
        .setup(|app| {
            app.manage(AgentServer::start());
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
