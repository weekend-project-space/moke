use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, Runtime, WebviewUrl};
use tauri::webview::{NewWindowResponse, WebviewBuilder};
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
    #[serde(skip_serializing)]
    history: Vec<String>,
    #[serde(skip_serializing)]
    history_index: usize,
}

struct BrowserState {
    pages: Mutex<Vec<BrowserPageState>>,
    active_page_id: Mutex<Option<u32>>,
    next_page_id: Mutex<u32>,
    last_bounds: Mutex<Option<BrowserBounds>>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPageOptions {
    page_id: Option<u32>,
    url: Option<String>,
    visible: Option<bool>,
    bounds: Option<BrowserBounds>,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserResult {
    page: Option<BrowserPageState>,
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

fn normalized_bounds(bounds: Option<BrowserBounds>) -> BrowserBounds {
    let bounds = bounds.unwrap_or(BrowserBounds {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    });

    BrowserBounds {
        x: bounds.x.max(0.0),
        y: bounds.y.max(0.0),
        width: bounds.width.max(1.0),
        height: bounds.height.max(1.0),
    }
}

fn resolve_browser_bounds(
    state: &BrowserState,
    bounds: Option<BrowserBounds>,
) -> Result<BrowserBounds, String> {
    if let Some(bounds) = bounds {
        let bounds = normalized_bounds(Some(bounds));
        *state
            .last_bounds
            .lock()
            .map_err(|_| "Browser state is unavailable".to_string())? = Some(bounds);
        return Ok(bounds);
    }

    Ok(state
        .last_bounds
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?
        .unwrap_or_else(|| normalized_bounds(None)))
}

fn apply_webview_bounds<R: Runtime>(
    webview: &tauri::Webview<R>,
    bounds: Option<BrowserBounds>,
) -> Result<(), String> {
    let bounds = normalized_bounds(bounds);
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| error.to_string())?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn is_trackable_url(url: &str) -> bool {
    !url.trim().is_empty()
}

fn refresh_history_flags(page: &mut BrowserPageState) {
    page.can_go_back = page.history_index > 0;
    page.can_go_forward = page.history_index + 1 < page.history.len();
}

fn push_history_entry(page: &mut BrowserPageState, url: String) {
    if !is_trackable_url(&url) {
        return;
    }

    if page.history.get(page.history_index).is_some_and(|current| current == &url) {
        refresh_history_flags(page);
        return;
    }

    if page.history_index + 1 < page.history.len() {
        page.history.truncate(page.history_index + 1);
    }

    page.history.push(url);
    page.history_index = page.history.len().saturating_sub(1);
    refresh_history_flags(page);
}

fn history_target(page: &BrowserPageState, direction: &str) -> Option<String> {
    match direction {
        "back" if page.history_index > 0 => page.history.get(page.history_index - 1).cloned(),
        "forward" if page.history_index + 1 < page.history.len() => page.history.get(page.history_index + 1).cloned(),
        _ => None,
    }
}

fn set_history_index_for_url(page: &mut BrowserPageState, url: &str) -> bool {
    if let Some(index) = page.history.iter().position(|entry| entry == url) {
        page.history_index = index;
        refresh_history_flags(page);
        true
    } else {
        false
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPageReport {
    url: Option<String>,
    title: Option<String>,
    can_go_back: Option<bool>,
    can_go_forward: Option<bool>,
}

const BROWSER_STATE_QUERY_SCRIPT: &str = r#"
(() => ({
  url: String(window.location.href || ""),
  title: String(document.title || ""),
  canGoBack: window.history.length > 1,
  canGoForward: false
}))()
"#;

fn update_browser_page_from_report(
    state: &BrowserState,
    page_id: u32,
    payload: BrowserPageReport,
) -> Result<(), String> {
    update_browser_page(state, page_id, |page| {
        if let Some(url) = payload.url {
            page.url = url.clone();
            if !set_history_index_for_url(page, &url) {
                push_history_entry(page, url);
            }
        }
        if let Some(title) = payload.title {
            page.title = title;
        }
        let _ = (payload.can_go_back, payload.can_go_forward);
        page.is_loading = false;
    })
}

fn refresh_browser_page_state(app: &tauri::AppHandle, state: &BrowserState, page_id: u32) -> Result<(), String> {
    let webview = browser_webview(app, state, page_id)?;
    let callback_app = app.clone();
    webview
        .eval_with_callback(BROWSER_STATE_QUERY_SCRIPT, move |value| {
            let Ok(payload) = serde_json::from_str::<BrowserPageReport>(&value) else {
                return;
            };
            if let Some(state) = callback_app.try_state::<BrowserState>() {
                let _ = update_browser_page_from_report(&state, page_id, payload);
                emit_browser_state(&callback_app, &state);
            }
        })
        .map_err(|error| error.to_string())
}

fn browser_result(state: &BrowserState) -> Result<BrowserResult, String> {
    let pages = state
        .pages
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?
        .clone();
    let active_page_id = *state
        .active_page_id
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?;
    let page = active_page_id.and_then(|id| pages.iter().find(|page| page.page_id == id).cloned());

    Ok(BrowserResult {
        page,
        pages,
        active_page_id,
    })
}

fn emit_browser_state(app: &tauri::AppHandle, state: &BrowserState) {
    if let Ok(result) = browser_result(state) {
        let _ = app.emit("browser_state_changed", result);
    }
}

fn active_page_id(state: &BrowserState, page_id: Option<u32>) -> Result<u32, String> {
    if let Some(page_id) = page_id {
        return Ok(page_id);
    }

    state
        .active_page_id
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?
        .ok_or_else(|| "No browser page is open".to_string())
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

fn update_browser_page<F>(state: &BrowserState, page_id: u32, update: F) -> Result<(), String>
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

fn browser_webview(app: &tauri::AppHandle, state: &BrowserState, page_id: u32) -> Result<tauri::Webview, String> {
    let label = find_page_label(state, page_id)?;
    app.get_webview(&label)
        .ok_or_else(|| format!("Browser webview {label} was not found"))
}

fn show_browser_page(
    app: &tauri::AppHandle,
    state: &BrowserState,
    page_id: u32,
    bounds: Option<BrowserBounds>,
) -> Result<(), String> {
    let bounds = resolve_browser_bounds(state, bounds)?;
    let pages = state
        .pages
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?
        .clone();

    if !pages.iter().any(|page| page.page_id == page_id) {
        return Err(format!("Browser page {page_id} was not found"));
    }

    for page in &pages {
        if let Some(webview) = app.get_webview(&page.label) {
            if page.page_id == page_id {
                apply_webview_bounds(&webview, Some(bounds))?;
                webview.show().map_err(|error| error.to_string())?;
                webview.set_focus().map_err(|error| error.to_string())?;
            } else {
                webview.hide().map_err(|error| error.to_string())?;
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

fn hide_active_browser_page(app: &tauri::AppHandle, state: &BrowserState) -> Result<(), String> {
    let pages = state
        .pages
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?
        .clone();

    for page in &pages {
        if let Some(webview) = app.get_webview(&page.label) {
            webview.hide().map_err(|error| error.to_string())?;
        }
    }

    let mut pages = state
        .pages
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?;
    for page in pages.iter_mut() {
        page.visible = false;
    }

    Ok(())
}

fn create_browser_page(
    app: &tauri::AppHandle,
    state: &BrowserState,
    url: Url,
    visible: bool,
    bounds: Option<BrowserBounds>,
) -> Result<BrowserResult, String> {
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

    println!("Creating browser webview {page_id} -> {url}");

    let load_page_id = page_id;
    let title_page_id = page_id;
    let page_load_app = app.clone();
    let title_app = app.clone();
    let popup_app = app.clone();
    let main_window = app
        .get_window("main")
        .ok_or_else(|| "Main window was not found".to_string())?;
    let webview_builder = WebviewBuilder::new(&label, WebviewUrl::External(url.clone()))
        .on_new_window(move |url, _features| {
            let app = popup_app.clone();
            let handler_app = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(state) = handler_app.try_state::<BrowserState>() {
                    if let Err(error) = create_browser_page(&handler_app, &state, url, true, None) {
                        eprintln!("Failed to open browser popup tab: {error}");
                    }
                }
            });
            NewWindowResponse::Deny
        })
        .on_page_load(move |_webview, payload| {
            let is_loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            if let Some(state) = page_load_app.try_state::<BrowserState>() {
                let _ = update_browser_page(&state, load_page_id, |page| {
                    let url = payload.url().to_string();
                    page.url = url.clone();
                    if !is_loading && !set_history_index_for_url(page, &url) {
                        push_history_entry(page, url);
                    }
                    page.is_loading = is_loading;
                });
                emit_browser_state(&page_load_app, &state);
                if !is_loading {
                    let _ = refresh_browser_page_state(&page_load_app, &state, load_page_id);
                }
            }
        })
        .on_document_title_changed(move |_webview, title| {
            if let Some(state) = title_app.try_state::<BrowserState>() {
                let _ = update_browser_page(&state, title_page_id, |page| {
                    page.title = title;
                });
                emit_browser_state(&title_app, &state);
            }
        });
    let bounds = resolve_browser_bounds(state, bounds)?;
    let webview = main_window
        .add_child(
            webview_builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| error.to_string())?;

    if visible {
        webview.show().map_err(|error| error.to_string())?;
        webview.set_focus().map_err(|error| error.to_string())?;
    } else {
        webview.hide().map_err(|error| error.to_string())?;
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
            visible,
            history: vec![url.to_string()],
            history_index: 0,
        });
    }
    if visible {
        show_browser_page(app, state, page_id, Some(bounds))?;
    }

    let result = browser_result(state)?;
    let _ = app.emit("browser_state_changed", result.clone());
    Ok(result)
}

#[tauri::command]
async fn browser_state(state: tauri::State<'_, BrowserState>) -> Result<BrowserResult, String> {
    browser_result(&state)
}

#[tauri::command]
async fn browser_refresh_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: Option<u32>,
) -> Result<BrowserResult, String> {
    let page_id = active_page_id(&state, page_id)?;
    refresh_browser_page_state(&app, &state, page_id)?;
    browser_result(&state)
}

#[tauri::command]
async fn browser_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserPageOptions,
) -> Result<BrowserResult, String> {
    let url = normalize_url(options.url.as_deref())?;
    if let Some(page_id) = options.page_id {
        let webview = browser_webview(&app, &state, page_id)?;
        apply_webview_bounds(&webview, options.bounds)?;
        if options.visible.unwrap_or(true) {
            show_browser_page(&app, &state, page_id, options.bounds)?;
        } else {
            webview.hide().map_err(|error| error.to_string())?;
            update_browser_page(&state, page_id, |page| {
                page.visible = false;
            })?;
        }
        return browser_result(&state);
    }
    create_browser_page(&app, &state, url, options.visible.unwrap_or(true), options.bounds)
}

#[tauri::command]
async fn browser_navigate(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserNavigateOptions,
) -> Result<BrowserResult, String> {
    let page_id = active_page_id(&state, options.page_id)?;
    let webview = browser_webview(&app, &state, page_id)?;

    match options.nav_type.as_str() {
        "url" => {
            let url = normalize_url(options.url.as_deref())?;
            webview.navigate(url.clone()).map_err(|error| error.to_string())?;
            update_browser_page(&state, page_id, |page| {
                page.url = url.to_string();
                push_history_entry(page, url.to_string());
                page.is_loading = true;
            })?;
        }
        "reload" => {
            if options.ignore_cache.unwrap_or(false) {
                let current_url = webview.url().map_err(|error| error.to_string())?;
                webview.navigate(current_url).map_err(|error| error.to_string())?;
            } else {
                webview.reload().map_err(|error| error.to_string())?;
            }
            update_browser_page(&state, page_id, |page| {
                page.is_loading = true;
            })?;
        }
        "back" | "forward" => {
            let target_url = {
                let pages = state
                    .pages
                    .lock()
                    .map_err(|_| "Browser state is unavailable".to_string())?;
                let page = pages
                    .iter()
                    .find(|page| page.page_id == page_id)
                    .ok_or_else(|| format!("Browser page {page_id} was not found"))?;
                history_target(page, &options.nav_type)
                    .ok_or_else(|| format!("Cannot navigate {} from this page", options.nav_type))?
            };
            let url = normalize_url(Some(&target_url))?;
            webview.navigate(url.clone()).map_err(|error| error.to_string())?;
            update_browser_page(&state, page_id, |page| {
                page.url = url.to_string();
                let _ = set_history_index_for_url(page, url.as_str());
                page.is_loading = true;
            })?;
        }
        _ => return Err("type must be url, back, forward, or reload".to_string()),
    }

    browser_result(&state)
}

#[tauri::command]
async fn list_pages(state: tauri::State<'_, BrowserState>) -> Result<BrowserResult, String> {
    browser_result(&state)
}

#[tauri::command]
async fn create_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    url: Option<String>,
    visible: Option<bool>,
    bounds: Option<BrowserBounds>,
) -> Result<BrowserResult, String> {
    browser_open(
        app,
        state,
        BrowserPageOptions {
            page_id: None,
            url,
            visible,
            bounds,
        },
    )
    .await
}

#[tauri::command]
async fn navigate_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserNavigateOptions,
) -> Result<BrowserResult, String> {
    browser_navigate(app, state, options).await
}

#[tauri::command]
async fn select_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: u32,
    bounds: Option<BrowserBounds>,
) -> Result<BrowserResult, String> {
    show_browser_page(&app, &state, page_id, bounds)?;
    browser_result(&state)
}

#[tauri::command]
async fn resize_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: Option<u32>,
    width: f64,
    height: f64,
) -> Result<BrowserResult, String> {
    let page_id = active_page_id(&state, page_id)?;
    let webview = browser_webview(&app, &state, page_id)?;
    let bounds = BrowserBounds {
        x: 0.0,
        y: 0.0,
        width,
        height,
    };
    apply_webview_bounds(
        &webview,
        Some(bounds),
    )?;
    let _ = resolve_browser_bounds(&state, Some(bounds))?;
    browser_result(&state)
}

#[tauri::command]
async fn show_browser(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: Option<u32>,
    bounds: Option<BrowserBounds>,
) -> Result<BrowserResult, String> {
    browser_show(app, state, page_id, bounds).await
}

#[tauri::command]
async fn hide_browser(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<BrowserResult, String> {
    browser_hide(app, state).await
}

#[tauri::command]
async fn close_page(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: u32,
) -> Result<BrowserResult, String> {
    browser_close(app, state, page_id).await
}

#[tauri::command]
async fn browser_resize(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: Option<u32>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let page_id = active_page_id(&state, page_id)?;
    let webview = browser_webview(&app, &state, page_id)?;
    let bounds = BrowserBounds {
        x: x.unwrap_or(0.0),
        y: y.unwrap_or(0.0),
        width: width.unwrap_or(1.0),
        height: height.unwrap_or(1.0),
    };
    apply_webview_bounds(
        &webview,
        Some(bounds),
    )?;
    let _ = resolve_browser_bounds(&state, Some(bounds))?;
    Ok(())
}

#[tauri::command]
async fn browser_show(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: Option<u32>,
    bounds: Option<BrowserBounds>,
) -> Result<BrowserResult, String> {
    let page_id = active_page_id(&state, page_id)?;
    show_browser_page(&app, &state, page_id, bounds)?;
    browser_result(&state)
}

#[tauri::command]
async fn browser_hide(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<BrowserResult, String> {
    hide_active_browser_page(&app, &state)?;
    browser_result(&state)
}

#[tauri::command]
async fn browser_close(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: u32,
) -> Result<BrowserResult, String> {
    let label = find_page_label(&state, page_id)?;
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|error| error.to_string())?;
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
        show_browser_page(&app, &state, next_active, None)?;
    }

    browser_result(&state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BrowserState {
            pages: Mutex::new(Vec::new()),
            active_page_id: Mutex::new(None),
            next_page_id: Mutex::new(1),
            last_bounds: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            browser_state,
            browser_refresh_state,
            browser_open,
            browser_navigate,
            browser_resize,
            browser_show,
            browser_hide,
            browser_close,
            list_pages,
            create_page,
            navigate_page,
            select_page,
            resize_page,
            show_browser,
            hide_browser,
            close_page,
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
