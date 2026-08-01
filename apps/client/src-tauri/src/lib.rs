use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewBuilder};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, Runtime, WebviewUrl};
use tauri_plugin_decorum::WebviewWindowExt;
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
    favicon_url: String,
    favicon_urls: Vec<String>,
    can_go_back: bool,
    can_go_forward: bool,
    is_loading: bool,
    visible: bool,
}

struct BrowserState {
    pages: Mutex<Vec<BrowserPageState>>,
    active_page_id: Mutex<Option<u32>>,
    next_page_id: Mutex<u32>,
    last_bounds: Mutex<Option<BrowserBounds>>,
}

fn unique_download_path(download_dir: &Path, suggested: &Path) -> PathBuf {
    let file_name = suggested
        .file_name()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| std::ffi::OsStr::new("download"));
    let mut candidate = download_dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let stem = candidate
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download")
        .to_string();
    let extension = candidate
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_string);
    for index in 1..10_000 {
        let name = match extension.as_deref() {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        candidate = download_dir.join(name);
        if !candidate.exists() {
            break;
        }
    }
    candidate
}

fn browser_download_payload(url: &Url, path: Option<&Path>, status: &str) -> serde_json::Value {
    serde_json::json!({
        "url": url.as_str(),
        "path": path.map(|value| value.to_string_lossy().into_owned()),
        "fileName": path
            .and_then(Path::file_name)
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "download".to_string()),
        "status": status,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceOpener {
    id: &'static str,
    name: &'static str,
}

fn validated_workspace_root(root: &str) -> Result<PathBuf, String> {
    let root = root.trim();
    if root.is_empty() {
        return Err("Select a workspace first".to_string());
    }

    let path = PathBuf::from(root);
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map_err(|error| format!("Could not resolve the workspace: {error}"))?
            .join(path)
    };
    if !path.is_dir() {
        return Err("The workspace folder no longer exists".to_string());
    }
    Ok(path)
}

#[cfg(target_os = "windows")]
fn executable_on_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(target_os = "windows")]
fn first_existing_path(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(target_os = "windows")]
fn windows_vscode_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(root) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(root).join("Programs/Microsoft VS Code/Code.exe"));
    }
    if let Some(root) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(root).join("Microsoft VS Code/Code.exe"));
    }
    if let Some(root) = std::env::var_os("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(root).join("Microsoft VS Code/Code.exe"));
    }
    first_existing_path(candidates).or_else(|| executable_on_path("Code.exe"))
}

#[cfg(target_os = "windows")]
fn windows_visual_studio_executable() -> Option<PathBuf> {
    if let Some(path) = executable_on_path("devenv.exe") {
        return Some(path);
    }

    let installer_root = std::env::var_os("ProgramFiles(x86)")?;
    let vswhere =
        PathBuf::from(installer_root).join("Microsoft Visual Studio/Installer/vswhere.exe");
    if !vswhere.is_file() {
        return None;
    }
    let output = Command::new(vswhere)
        .args(["-latest", "-products", "*", "-property", "productPath"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    path.is_file().then_some(path)
}

#[cfg(target_os = "windows")]
fn windows_git_bash_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(root) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(root).join("Git/git-bash.exe"));
    }
    if let Some(root) = std::env::var_os("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(root).join("Git/git-bash.exe"));
    }
    if let Some(root) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(root).join("Programs/Git/git-bash.exe"));
    }
    first_existing_path(candidates).or_else(|| executable_on_path("git-bash.exe"))
}

#[cfg(target_os = "windows")]
fn workspace_solution(root: &Path) -> Option<PathBuf> {
    let mut solutions = fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(extension.to_ascii_lowercase().as_str(), "sln" | "slnx")
                })
        })
        .collect::<Vec<_>>();
    solutions.sort();
    solutions.into_iter().next()
}

#[cfg(target_os = "windows")]
fn available_workspace_openers(root: &Path) -> Vec<WorkspaceOpener> {
    let mut openers = Vec::new();
    if windows_vscode_executable().is_some() {
        openers.push(WorkspaceOpener {
            id: "vscode",
            name: "VS Code",
        });
    }
    if workspace_solution(root).is_some() && windows_visual_studio_executable().is_some() {
        openers.push(WorkspaceOpener {
            id: "visual_studio",
            name: "Visual Studio",
        });
    }
    openers.push(WorkspaceOpener {
        id: "explorer",
        name: "File Explorer",
    });
    openers.push(WorkspaceOpener {
        id: "terminal",
        name: "Terminal",
    });
    if windows_git_bash_executable().is_some() {
        openers.push(WorkspaceOpener {
            id: "git_bash",
            name: "Git Bash",
        });
    }
    openers
}

#[cfg(not(target_os = "windows"))]
fn available_workspace_openers(_root: &Path) -> Vec<WorkspaceOpener> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn spawn_workspace_opener(root: &Path, opener_id: &str) -> Result<(), String> {
    let mut command = match opener_id {
        "vscode" => Command::new(
            windows_vscode_executable().ok_or_else(|| "VS Code is not installed".to_string())?,
        ),
        "visual_studio" => {
            let mut command = Command::new(
                windows_visual_studio_executable()
                    .ok_or_else(|| "Visual Studio is not installed".to_string())?,
            );
            command.arg(workspace_solution(root).ok_or_else(|| {
                "No Visual Studio solution was found in this workspace".to_string()
            })?);
            command
        }
        "explorer" => Command::new("explorer.exe"),
        "terminal" => {
            if let Some(executable) = executable_on_path("wt.exe") {
                let mut command = Command::new(executable);
                command.arg("-d").arg(root);
                command
            } else {
                let mut command = Command::new("cmd.exe");
                command.arg("/K").current_dir(root);
                command
            }
        }
        "git_bash" => Command::new(
            windows_git_bash_executable().ok_or_else(|| "Git Bash is not installed".to_string())?,
        ),
        _ => return Err("Unknown workspace application".to_string()),
    };

    if matches!(opener_id, "vscode" | "explorer") {
        command.arg(root);
    }
    if opener_id == "git_bash" {
        command.current_dir(root);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the workspace: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn spawn_workspace_opener(_root: &Path, _opener_id: &str) -> Result<(), String> {
    Err("Opening workspaces in external applications is not available on this platform".to_string())
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserEvaluateOptions {
    page_id: Option<u32>,
    #[serde(rename = "function")]
    function_source: String,
    args: Option<Vec<serde_json::Value>>,
    dialog_action: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSnapshotOptions {
    page_id: Option<u32>,
    verbose: Option<bool>,
    file_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserScreenshotOptions {
    page_id: Option<u32>,
    path: Option<String>,
    full_page: Option<bool>,
    uid: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserClickOptions {
    page_id: Option<u32>,
    uid: String,
    dbl_click: Option<bool>,
    include_snapshot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserHoverOptions {
    page_id: Option<u32>,
    uid: String,
    include_snapshot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFillOptions {
    page_id: Option<u32>,
    uid: String,
    value: String,
    include_snapshot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFillFormElement {
    uid: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFillFormOptions {
    page_id: Option<u32>,
    elements: Vec<BrowserFillFormElement>,
    include_snapshot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserUploadFileOptions {
    page_id: Option<u32>,
    uid: String,
    file_path: String,
    include_snapshot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserWaitForOptions {
    page_id: Option<u32>,
    text: serde_json::Value,
    timeout: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPressKeyOptions {
    page_id: Option<u32>,
    key: String,
    include_snapshot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserTypeTextOptions {
    page_id: Option<u32>,
    text: String,
    submit_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserHandleDialogOptions {
    page_id: Option<u32>,
    action: String,
    prompt_text: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserResult {
    page: Option<BrowserPageState>,
    pages: Vec<BrowserPageState>,
    active_page_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    matched: Option<String>,
}

struct CapturedImage {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

impl AgentServer {
    fn start(app: &tauri::App) -> Self {
        let child = start_agent_server(app).ok();

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

fn app_data_moke_dir(app: &tauri::App) -> PathBuf {
    if tauri::is_dev() {
        return repo_dir().join(".moke");
    }

    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            app.path()
                .app_data_dir()
                .unwrap_or_else(|_| repo_dir().join(".moke"))
        })
        .join("Moke")
}

fn append_agent_server_log(app: &tauri::App, message: &str) {
    let log_dir = app_data_moke_dir(app).join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("agent-server.log");
    let _ = fs::write(log_path, format!("{message}\n"));
}

fn agent_server_log_file(app: &tauri::App) -> Option<fs::File> {
    let log_dir = app_data_moke_dir(app).join("logs");
    fs::create_dir_all(&log_dir).ok()?;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("agent-server.log"))
        .ok()
}

fn ensure_user_env_file(app: &tauri::App, env_path: &Path) {
    if tauri::is_dev() || env_path.exists() {
        return;
    }

    if let Some(parent) = env_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let template = app
        .path()
        .resource_dir()
        .ok()
        .map(|resource_dir| resource_dir.join(".env.example"))
        .filter(|path| path.exists());

    if let Some(template) = template {
        let _ = fs::copy(template, env_path);
    } else {
        let _ = fs::write(
            env_path,
            "PORT=4010\nOPENAI_API_KEY=test\nOPENAI_MODEL=qwen3.6-35BA3B\nOPENAI_BASE_URL=http://localhost:8080/v1\nOPENAI_TIMEOUT_MS=1800000\nMOKE_MCP_CONFIG=.moke/mcp.json\n",
        );
    }
}

fn start_agent_server(app: &tauri::App) -> Result<Child, String> {
    let data_dir = app_data_moke_dir(app);
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let state_path = data_dir.join("state.json");
    let mcp_config_path = data_dir.join("mcp.json");

    let (program, args, current_dir, workspace_dir, env_path) = if tauri::is_dev() {
        let repo_dir = repo_dir();
        (
            PathBuf::from("npx"),
            vec!["tsx".to_string(), "apps/server/server.ts".to_string()],
            repo_dir.clone(),
            repo_dir.clone(),
            repo_dir.join(".env"),
        )
    } else {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        let server_dir = resource_dir.join("server");
        (
            server_dir.join("node.exe"),
            vec!["server.cjs".to_string()],
            server_dir,
            data_dir.clone(),
            data_dir.join(".env"),
        )
    };

    ensure_user_env_file(app, &env_path);

    let stdout = agent_server_log_file(app)
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);
    let stderr = agent_server_log_file(app)
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);
    let mut command = Command::new(&program);
    command
        .args(args)
        .current_dir(current_dir)
        .env("PORT", "4010")
        .env("MOKE_WORKSPACE", &workspace_dir)
        .env("MOKE_ENV_PATH", &env_path)
        .env("MOKE_STATE_PATH", &state_path)
        .env("MOKE_MCP_CONFIG", &mcp_config_path)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const DETACHED_PROCESS: u32 = 0x00000008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }

    command.spawn().map_err(|error| {
        let message = format!(
            "Failed to start agent server with {}: {error}",
            program.to_string_lossy()
        );
        append_agent_server_log(app, &message);
        message
    })
}

fn normalize_url(value: Option<&str>) -> Result<Url, String> {
    let raw = value.unwrap_or("about:blank").trim();
    let with_scheme = if raw.contains("://") || raw == "about:blank" {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPageReport {
    url: Option<String>,
    title: Option<String>,
    favicon_url: Option<String>,
    favicon_urls: Option<Vec<String>>,
    can_go_back: Option<bool>,
    can_go_forward: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserStateChange {
    #[serde(rename = "eventType")]
    event_type: String,
    page_id: Option<u32>,
    state: BrowserResult,
}

const BROWSER_STATE_QUERY_SCRIPT: &str = r#"
(() => {
  const faviconUrls = [];
  const addFavicon = (value) => {
    const url = String(value || "");
    const isAllowed = /^https?:\/\//i.test(url) || (/^data:image\//i.test(url) && url.length <= 32768);
    if (isAllowed && !faviconUrls.includes(url) && faviconUrls.length < 12) faviconUrls.push(url);
  };
  const faviconLinks = Array.from(document.querySelectorAll('link[rel][href]'))
    .map((link) => {
      const tokens = String(link.rel || "").toLowerCase().split(/\s+/);
      if (tokens.includes("icon") && !tokens.includes("mask-icon")) return { priority: 0, href: link.href };
      if (tokens.includes("apple-touch-icon") || tokens.includes("apple-touch-icon-precomposed")) return { priority: 1, href: link.href };
      if (tokens.includes("fluid-icon")) return { priority: 2, href: link.href };
      return null;
    })
    .filter(Boolean)
    .sort((left, right) => left.priority - right.priority);
  faviconLinks.forEach((link) => addFavicon(link.href));
  try {
    addFavicon(new URL("/favicon.ico", window.location.href).href);
  } catch {}
  const navigation = window.navigation;
  return {
    url: String(window.location.href || ""),
    title: String(document.title || ""),
    faviconUrl: faviconUrls[0] || "",
    faviconUrls,
    canGoBack: typeof navigation?.canGoBack === "boolean" ? navigation.canGoBack : window.history.length > 1,
    canGoForward: typeof navigation?.canGoForward === "boolean" ? navigation.canGoForward : false
  };
})()
"#;

const BROWSER_PAGE_INITIALIZATION_SCRIPT: &str = r#"
document.addEventListener("contextmenu", (event) => event.preventDefault(), true);
"#;

const BROWSER_HISTORY_NAVIGATION_SCRIPT: &str = r#"
(() => {
  const direction = __MOKE_HISTORY_DIRECTION__;
  const navigation = window.navigation;
  if (direction === "back") {
    if (typeof navigation?.back === "function") {
      if (!navigation.canGoBack) return { ok: false, direction };
      navigation.back();
    } else {
      if (window.history.length <= 1) return { ok: false, direction };
      window.history.back();
    }
    return { ok: true, direction };
  }
  if (direction === "forward") {
    if (typeof navigation?.forward === "function") {
      if (!navigation.canGoForward) return { ok: false, direction };
      navigation.forward();
    } else {
      window.history.forward();
    }
    return { ok: true, direction };
  }
  return { ok: false, direction };
})()
"#;

const BROWSER_SNAPSHOT_SCRIPT: &str = r#"
(() => {
  const verbose = Boolean(__MOKE_VERBOSE__);
  const interactiveSelector = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[role]",
    "[contenteditable=true]",
    "summary",
    "label"
  ].join(",");
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const compactText = (value, limit = 80) => String(value || "").trim().replace(/\s+/g, " ").slice(0, limit);
  const directTextFor = (el) => Array.from(el.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || "")
    .join(" ");
  const headingTextFor = (el) => {
    const heading = el.querySelector?.("h1,h2,h3,h4,h5,h6,[role=heading]");
    return heading ? heading.textContent || "" : "";
  };
  const textForMarkdown = (value) => String(value || "").trim().replace(/\s+/g, " ");
  const escapeMarkdown = (value) => textForMarkdown(value).replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
  const tableToMarkdown = (table) => {
    const rows = Array.from(table.querySelectorAll("tr")).slice(0, 12).map((row) =>
      Array.from(row.querySelectorAll("th,td")).slice(0, 6).map((cell) => textForMarkdown(cell.innerText || cell.textContent))
    ).filter((cells) => cells.length);
    if (!rows.length) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => Array.from({ length: width }, (_, index) => escapeMarkdown(row[index] || "")));
    const header = normalized[0];
    const separator = Array.from({ length: width }, () => "---");
    return [header, separator, ...normalized.slice(1)].map((row) => `| ${row.join(" | ")} |`).join("\n");
  };
  const contentForSnapshot = () => {
    const root = document.querySelector("main,article,[role=main],[role=article]") || document.body;
    const selector = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table";
    const parts = [];
    for (const el of Array.from(root.querySelectorAll(selector))) {
      if (!visible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const text = textForMarkdown(el.innerText || el.textContent);
      if (!text && tag !== "table") continue;
      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag.slice(1));
        parts.push(`${Array(level + 1).join('#')} ${text}`);
      } else if (tag === "li") {
        parts.push(`- ${text}`);
      } else if (tag === "blockquote") {
        parts.push(`> ${text}`);
      } else if (tag === "pre") {
        parts.push("```\n" + String(el.innerText || el.textContent || "").trim() + "\n```");
      } else if (tag === "table") {
        const tableMarkdown = tableToMarkdown(el);
        if (tableMarkdown) parts.push(tableMarkdown);
      } else {
        parts.push(text);
      }
    }
    const maxLength = verbose ? 20000 : 8000;
    const markdown = parts.join("\n\n").trim();
    return {
      markdown: markdown.slice(0, maxLength),
      truncated: markdown.length > maxLength
    };
  };
  const nameFor = (el) => {
    const direct = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt");
    if (direct) return compactText(direct);
    if (el.labels && el.labels.length) return compactText(Array.from(el.labels).map((label) => label.innerText.trim()).filter(Boolean).join(" "));
    const directText = compactText(directTextFor(el));
    if (directText) return directText;
    const headingText = compactText(headingTextFor(el));
    if (headingText) return headingText;
    if ("value" in el && typeof el.value === "string") {
      const valueText = compactText(el.value);
      if (valueText) return valueText;
    }
    return compactText(el.innerText || el.textContent);
  };
  const roleFor = (el) => {
    if (el.getAttribute("role")) return el.getAttribute("role");
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") return el.type || "input";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (el.isContentEditable) return "textbox";
    return tag;
  };
  const interactiveElements = Array.from(document.querySelectorAll(interactiveSelector))
    .filter((el) => verbose || visible(el))
    .slice(0, verbose ? 300 : 120);
  const elements = interactiveElements.map((el, index) => {
    const uid = `e${index + 1}`;
    el.setAttribute("data-moke-uid", uid);
    const node = {
      uid,
      role: roleFor(el),
      name: nameFor(el),
      tag: el.tagName.toLowerCase(),
      visible: visible(el)
    };
    if ("value" in el && typeof el.value === "string") node.value = el.value;
    if (el.href) node.href = el.href;
    if (el.disabled) node.disabled = true;
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    if (text && text !== node.name) node.text = text.slice(0, verbose ? 500 : 180);
    return node;
  });
  const content = contentForSnapshot();
  return {
    url: String(window.location.href || ""),
    title: String(document.title || ""),
    content,
    elements
  };
})()
"#;

const BROWSER_ELEMENT_SCRIPT: &str = r#"
(async () => {
  const action = __MOKE_ACTION__;
  const uid = __MOKE_UID__;
  const value = __MOKE_VALUE__;
  const dblClick = Boolean(__MOKE_DBL_CLICK__);
  const key = __MOKE_KEY__;
  const text = __MOKE_TEXT__;
  const submitKey = __MOKE_SUBMIT_KEY__;
  const el = uid ? document.querySelector(`[data-moke-uid="${String(uid).replace(/"/g, '\\"')}"]`) : document.activeElement;
  if (!el) throw new Error(uid ? `Element not found: ${uid}` : "No active element");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const showAiPointer = async (target) => {
    if (!uid || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = target.getBoundingClientRect();
    const x = Math.max(8, rect.left + rect.width / 2 - 3);
    const y = Math.max(8, rect.top + rect.height / 2 - 1);

    let style = document.getElementById("moke-ai-pointer-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "moke-ai-pointer-style";
      style.textContent = `
        .moke-ai-pointer {
          position: fixed;
          left: 0;
          top: 0;
          width: 18px;
          height: 22px;
          z-index: 2147483647;
          color: rgb(37 99 235);
          filter: drop-shadow(0 3px 8px rgba(15, 23, 42, 0.22));
          pointer-events: none;
          transform: translate3d(var(--moke-x), var(--moke-y), 0);
        }
      `;
      document.documentElement.appendChild(style);
    }

    document.getElementById("moke-ai-pointer")?.remove();
    const pointer = document.createElement("div");
    pointer.id = "moke-ai-pointer";
    pointer.className = "moke-ai-pointer";
    pointer.style.setProperty("--moke-x", `${x}px`);
    pointer.style.setProperty("--moke-y", `${y}px`);
    pointer.innerHTML = '<svg viewBox="0 0 18 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 2L16 12L9.7 13.1L6.7 20L2 2Z" fill="currentColor" stroke="white" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(pointer);
    await sleep(3000);
    pointer.remove();
  };

  const eventInit = { bubbles: true, cancelable: true, view: window };
  const dispatchMouse = (type) => el.dispatchEvent(new MouseEvent(type, eventInit));
  const dispatchPointer = (type) => {
    if (typeof PointerEvent === "function") {
      el.dispatchEvent(new PointerEvent(type, { ...eventInit, pointerType: "mouse", isPrimary: true }));
      return;
    }
    dispatchMouse(type.replace(/^pointer/, "mouse"));
  };
  const dispatchInput = () => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const setValue = (target, nextValue) => {
    target.focus();
    if (target.tagName === "SELECT") {
      target.value = String(nextValue);
      dispatchInput();
      return;
    }
    if (target.isContentEditable) {
      target.textContent = String(nextValue);
      dispatchInput();
      return;
    }
    if ("value" in target) {
      target.value = String(nextValue);
      dispatchInput();
      return;
    }
    throw new Error("Element cannot be filled");
  };
  const keyEvent = (type, combo) => {
    const parts = String(combo).split("+").map((part) => part.trim()).filter(Boolean);
    const main = parts.pop() || "";
    const init = {
      bubbles: true,
      cancelable: true,
      key: main,
      ctrlKey: parts.some((part) => /^ctrl|control$/i.test(part)),
      shiftKey: parts.some((part) => /^shift$/i.test(part)),
      altKey: parts.some((part) => /^alt|option$/i.test(part)),
      metaKey: parts.some((part) => /^meta|cmd|command$/i.test(part))
    };
    el.dispatchEvent(new KeyboardEvent(type, init));
  };

  if (action === "click") {
    await showAiPointer(el);
    el.focus();
    dispatchPointer("pointerdown");
    dispatchMouse("mousedown");
    dispatchPointer("pointerup");
    dispatchMouse("mouseup");
    el.click();
    if (dblClick) dispatchMouse("dblclick");
  } else if (action === "hover") {
    await showAiPointer(el);
    dispatchPointer("pointerover");
    dispatchMouse("mouseover");
    dispatchPointer("pointerenter");
    dispatchMouse("mouseenter");
    dispatchPointer("pointermove");
    dispatchMouse("mousemove");
  } else if (action === "fill") {
    await showAiPointer(el);
    setValue(el, value);
  } else if (action === "press_key") {
    el.focus();
    keyEvent("keydown", key);
    keyEvent("keyup", key);
  } else if (action === "type_text") {
    const current = "value" in el ? el.value : (el.textContent || "");
    setValue(el, `${current}${text || ""}`);
    if (submitKey) {
      keyEvent("keydown", submitKey);
      keyEvent("keyup", submitKey);
    }
  } else {
    throw new Error(`Unsupported browser action: ${action}`);
  }

  return { ok: true };
})()
"#;

const BROWSER_SCREENSHOT_METRICS_SCRIPT: &str = r#"
(() => {
  const doc = document.documentElement;
  const body = document.body;
  const scrollX = window.scrollX || window.pageXOffset || 0;
  const scrollY = window.scrollY || window.pageYOffset || 0;
  const viewportWidth = window.innerWidth || doc.clientWidth || 0;
  const viewportHeight = window.innerHeight || doc.clientHeight || 0;
  const scrollWidth = Math.max(
    doc.scrollWidth || 0,
    body ? body.scrollWidth || 0 : 0,
    viewportWidth
  );
  const scrollHeight = Math.max(
    doc.scrollHeight || 0,
    body ? body.scrollHeight || 0 : 0,
    viewportHeight
  );
  return {
    scrollX,
    scrollY,
    viewportWidth,
    viewportHeight,
    scrollWidth,
    scrollHeight,
    devicePixelRatio: window.devicePixelRatio || 1
  };
})()
"#;

const BROWSER_ELEMENT_RECT_SCRIPT: &str = r#"
(() => {
  const uid = __MOKE_UID__;
  const el = document.querySelector(`[data-moke-uid="${String(uid).replace(/"/g, '\\"')}"]`);
  if (!el) throw new Error(`Element not found: ${uid}`);
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const rect = el.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    scrollX: window.scrollX || window.pageXOffset || 0,
    scrollY: window.scrollY || window.pageYOffset || 0,
    viewportWidth: window.innerWidth || document.documentElement.clientWidth || 0,
    viewportHeight: window.innerHeight || document.documentElement.clientHeight || 0,
    devicePixelRatio: window.devicePixelRatio || 1
  };
})()
"#;

const BROWSER_UPLOAD_FILE_SCRIPT: &str = r#"
(async () => {
  const uid = __MOKE_UID__;
  const fileName = __MOKE_FILE_NAME__;
  const mimeType = __MOKE_MIME_TYPE__;
  const base64 = __MOKE_BASE64__;
  const root = document.querySelector(`[data-moke-uid="${String(uid).replace(/"/g, '\\"')}"]`);
  if (!root) throw new Error(`Element not found: ${uid}`);
  const input = root.matches && root.matches('input[type="file"]')
    ? root
    : root.querySelector && root.querySelector('input[type="file"]');
  if (!input) throw new Error(`Element is not a file input: ${uid}`);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const showAiPointer = async (target) => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = target.getBoundingClientRect();
    const x = Math.max(8, rect.left + rect.width / 2 - 3);
    const y = Math.max(8, rect.top + rect.height / 2 - 1);

    let style = document.getElementById("moke-ai-pointer-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "moke-ai-pointer-style";
      style.textContent = `
        .moke-ai-pointer {
          position: fixed;
          left: 0;
          top: 0;
          width: 18px;
          height: 22px;
          z-index: 2147483647;
          color: rgb(37 99 235);
          filter: drop-shadow(0 3px 8px rgba(15, 23, 42, 0.22));
          pointer-events: none;
          transform: translate3d(var(--moke-x), var(--moke-y), 0);
        }
      `;
      document.documentElement.appendChild(style);
    }

    document.getElementById("moke-ai-pointer")?.remove();
    const pointer = document.createElement("div");
    pointer.id = "moke-ai-pointer";
    pointer.className = "moke-ai-pointer";
    pointer.style.setProperty("--moke-x", `${x}px`);
    pointer.style.setProperty("--moke-y", `${y}px`);
    pointer.innerHTML = '<svg viewBox="0 0 18 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 2L16 12L9.7 13.1L6.7 20L2 2Z" fill="currentColor" stroke="white" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(pointer);
    await sleep(3000);
    pointer.remove();
  };

  await showAiPointer(root);

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const file = new File([bytes], fileName, { type: mimeType || "application/octet-stream" });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    ok: true,
    fileName,
    mimeType: file.type,
    size: file.size
  };
})()
"#;

fn scroll_script(x: f64, y: f64) -> String {
    format!(
        r#"
new Promise((resolve) => {{
  window.scrollTo({{ left: {x}, top: {y}, behavior: "instant" }});
  requestAnimationFrame(() => requestAnimationFrame(() => resolve({{
    scrollX: window.scrollX || window.pageXOffset || 0,
    scrollY: window.scrollY || window.pageYOffset || 0
  }})));
}})
"#
    )
}

fn element_rect_script(uid: &str) -> Result<String, String> {
    Ok(BROWSER_ELEMENT_RECT_SCRIPT.replace(
        "__MOKE_UID__",
        &js_literal(&serde_json::Value::String(uid.to_string()))?,
    ))
}

fn resolve_repo_path(file_path: &str) -> PathBuf {
    let path = PathBuf::from(file_path);
    if path.is_absolute() {
        path
    } else {
        repo_dir().join(path)
    }
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "txt" | "log" | "md" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn upload_file_script(uid: &str, path: &Path, bytes: &[u8]) -> Result<String, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "filePath must include a file name".to_string())?;
    let base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let replacements = [
        ("__MOKE_UID__", serde_json::Value::String(uid.to_string())),
        (
            "__MOKE_FILE_NAME__",
            serde_json::Value::String(file_name.to_string()),
        ),
        (
            "__MOKE_MIME_TYPE__",
            serde_json::Value::String(mime_type_for_path(path).to_string()),
        ),
        ("__MOKE_BASE64__", serde_json::Value::String(base64)),
    ];

    let mut script = BROWSER_UPLOAD_FILE_SCRIPT.to_string();
    for (placeholder, value) in replacements {
        script = script.replace(placeholder, &js_literal(&value)?);
    }
    Ok(script)
}

fn update_browser_page_from_report(
    state: &BrowserState,
    page_id: u32,
    payload: BrowserPageReport,
) -> Result<(), String> {
    update_browser_page(state, page_id, |page| {
        if let Some(url) = payload.url {
            page.url = url;
        }
        if let Some(title) = payload.title {
            page.title = title;
        }
        if let Some(favicon_url) = payload.favicon_url {
            page.favicon_url = sanitize_browser_favicon_url(&favicon_url);
        }
        if let Some(favicon_urls) = payload.favicon_urls {
            page.favicon_urls = sanitize_browser_favicon_urls(favicon_urls);
            page.favicon_url = page.favicon_urls.first().cloned().unwrap_or_default();
        } else {
            page.favicon_urls = if page.favicon_url.is_empty() {
                Vec::new()
            } else {
                vec![page.favicon_url.clone()]
            };
        }
        if let Some(can_go_back) = payload.can_go_back {
            page.can_go_back = can_go_back;
        }
        if let Some(can_go_forward) = payload.can_go_forward {
            page.can_go_forward = can_go_forward;
        }
        page.is_loading = false;
    })
}

fn refresh_browser_page_state(
    app: &tauri::AppHandle,
    state: &BrowserState,
    page_id: u32,
) -> Result<(), String> {
    let webview = browser_webview(app, state, page_id)?;
    let callback_app = app.clone();
    webview
        .eval_with_callback(BROWSER_STATE_QUERY_SCRIPT, move |value| {
            let Ok(payload) = serde_json::from_str::<BrowserPageReport>(&value) else {
                return;
            };
            if let Some(state) = callback_app.try_state::<BrowserState>() {
                let _ = update_browser_page_from_report(&state, page_id, payload);
                emit_browser_state_change(&callback_app, &state, "state-refreshed", Some(page_id));
            }
        })
        .map_err(|error| error.to_string())
}

fn js_literal(value: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn eval_browser_json(
    app: &tauri::AppHandle,
    state: &BrowserState,
    page_id: Option<u32>,
    script: String,
    timeout_ms: u64,
) -> Result<serde_json::Value, String> {
    let page_id = active_page_id(state, page_id)?;
    let webview = browser_webview(app, state, page_id)?;
    let (sender, receiver) = mpsc::channel::<Result<serde_json::Value, String>>();

    webview
        .eval_with_callback(&script, move |value| {
            let parsed = serde_json::from_str::<serde_json::Value>(&value)
                .map_err(|error| format!("Browser script returned invalid JSON: {error}"));
            let _ = sender.send(parsed);
        })
        .map_err(|error| error.to_string())?;

    receiver
        .recv_timeout(Duration::from_millis(timeout_ms))
        .map_err(|_| "Browser script timed out".to_string())?
}

fn unwrap_browser_value(value: serde_json::Value) -> Result<serde_json::Value, String> {
    if value
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return Ok(value
            .get("value")
            .cloned()
            .unwrap_or(serde_json::Value::Null));
    }

    let message = value
        .get("error")
        .and_then(|value| value.as_str())
        .unwrap_or("Browser script failed");
    Err(message.to_string())
}

fn snapshot_script(verbose: bool) -> String {
    BROWSER_SNAPSHOT_SCRIPT.replace("__MOKE_VERBOSE__", if verbose { "true" } else { "false" })
}

fn history_navigation_script(direction: &str) -> Result<String, String> {
    Ok(BROWSER_HISTORY_NAVIGATION_SCRIPT.replace(
        "__MOKE_HISTORY_DIRECTION__",
        &js_literal(&serde_json::Value::String(direction.to_string()))?,
    ))
}

fn element_script(
    action: &str,
    uid: Option<&str>,
    value: Option<&str>,
    dbl_click: bool,
    key: Option<&str>,
    text: Option<&str>,
    submit_key: Option<&str>,
) -> Result<String, String> {
    let replacements = [
        (
            "__MOKE_ACTION__",
            serde_json::Value::String(action.to_string()),
        ),
        (
            "__MOKE_UID__",
            uid.map(|value| serde_json::Value::String(value.to_string()))
                .unwrap_or(serde_json::Value::Null),
        ),
        (
            "__MOKE_VALUE__",
            value
                .map(|value| serde_json::Value::String(value.to_string()))
                .unwrap_or(serde_json::Value::Null),
        ),
        ("__MOKE_DBL_CLICK__", serde_json::Value::Bool(dbl_click)),
        (
            "__MOKE_KEY__",
            key.map(|value| serde_json::Value::String(value.to_string()))
                .unwrap_or(serde_json::Value::Null),
        ),
        (
            "__MOKE_TEXT__",
            text.map(|value| serde_json::Value::String(value.to_string()))
                .unwrap_or(serde_json::Value::Null),
        ),
        (
            "__MOKE_SUBMIT_KEY__",
            submit_key
                .map(|value| serde_json::Value::String(value.to_string()))
                .unwrap_or(serde_json::Value::Null),
        ),
    ];

    let mut script = BROWSER_ELEMENT_SCRIPT.to_string();
    for (placeholder, value) in replacements {
        script = script.replace(placeholder, &js_literal(&value)?);
    }
    Ok(script)
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
        snapshot: None,
        value: None,
        matched: None,
    })
}

fn browser_result_with_value(
    state: &BrowserState,
    value: Option<serde_json::Value>,
    snapshot: Option<serde_json::Value>,
    matched: Option<String>,
) -> Result<BrowserResult, String> {
    let mut result = browser_result(state)?;
    result.value = value;
    result.snapshot = snapshot;
    result.matched = matched;
    Ok(result)
}

fn repo_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should live under the client app")
        .parent()
        .expect("client app should live under apps")
        .parent()
        .expect("apps should live under the repository root")
        .to_path_buf()
}

fn screenshot_file_path(path: Option<String>) -> PathBuf {
    if let Some(path) = path {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            return path;
        }
        return repo_dir().join(path);
    }

    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    repo_dir()
        .join(".moke")
        .join("screenshots")
        .join(format!("browser-{millis}.png"))
}

fn write_png(path: &Path, image: &CapturedImage) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    fs::write(path, encode_png(image)?).map_err(|error| error.to_string())
}

fn sanitize_browser_favicon_url(value: &str) -> String {
    const MAX_FAVICON_URL_BYTES: usize = 32 * 1024;

    if value.len() > MAX_FAVICON_URL_BYTES {
        return String::new();
    }

    let Ok(url) = url::Url::parse(value) else {
        return String::new();
    };
    let allowed = matches!(url.scheme(), "http" | "https")
        || (url.scheme() == "data" && value.to_ascii_lowercase().starts_with("data:image/"));
    if allowed {
        value.to_string()
    } else {
        String::new()
    }
}

fn sanitize_browser_favicon_urls(values: Vec<String>) -> Vec<String> {
    const MAX_FAVICON_CANDIDATES: usize = 12;

    let mut sanitized = Vec::with_capacity(values.len().min(MAX_FAVICON_CANDIDATES));
    for value in values {
        let value = sanitize_browser_favicon_url(&value);
        if value.is_empty() || sanitized.contains(&value) {
            continue;
        }
        sanitized.push(value);
        if sanitized.len() == MAX_FAVICON_CANDIDATES {
            break;
        }
    }
    sanitized
}

fn encode_png(image: &CapturedImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, image.width, image.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut png_writer = encoder.write_header().map_err(|error| error.to_string())?;
        png_writer
            .write_image_data(&image.rgba)
            .map_err(|error| error.to_string())?;
    }
    Ok(bytes)
}

fn crop_image(
    image: &CapturedImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<CapturedImage, String> {
    if width == 0 || height == 0 {
        return Err("Screenshot crop area is empty".to_string());
    }
    if x >= image.width || y >= image.height {
        return Err("Screenshot crop origin is outside the image".to_string());
    }
    let width = width.min(image.width - x);
    let height = height.min(image.height - y);
    let mut rgba = vec![0_u8; (width as usize) * (height as usize) * 4];
    for row in 0..height {
        let source_start = (((y + row) * image.width + x) * 4) as usize;
        let source_end = source_start + (width as usize) * 4;
        let target_start = (row * width * 4) as usize;
        rgba[target_start..target_start + (width as usize) * 4]
            .copy_from_slice(&image.rgba[source_start..source_end]);
    }
    Ok(CapturedImage {
        width,
        height,
        rgba,
    })
}

fn stitch_vertical(
    parts: Vec<(CapturedImage, u32)>,
    width: u32,
    height: u32,
) -> Result<CapturedImage, String> {
    if width == 0 || height == 0 {
        return Err("Screenshot stitch area is empty".to_string());
    }
    let mut rgba = vec![255_u8; (width as usize) * (height as usize) * 4];
    for (part, target_y) in parts {
        let copy_width = width.min(part.width);
        let copy_height = part.height.min(height.saturating_sub(target_y));
        for row in 0..copy_height {
            let source_start = (row * part.width * 4) as usize;
            let target_start = (((target_y + row) * width) * 4) as usize;
            rgba[target_start..target_start + (copy_width as usize) * 4].copy_from_slice(
                &part.rgba[source_start..source_start + (copy_width as usize) * 4],
            );
        }
    }
    Ok(CapturedImage {
        width,
        height,
        rgba,
    })
}

fn capture_browser_viewport(
    app: &tauri::AppHandle,
    bounds: BrowserBounds,
) -> Result<CapturedImage, String> {
    let main_window = app
        .get_window("main")
        .ok_or_else(|| "Main window was not found".to_string())?;
    let title = main_window.title().map_err(|error| error.to_string())?;
    let windows = xcap::Window::all().map_err(|error| error.to_string())?;
    let captured_window = windows
        .into_iter()
        .find(|window| window.title() == title)
        .ok_or_else(|| format!("Could not find screenshot window for title: {title}"))?;
    let image = captured_window
        .capture_image()
        .map_err(|error| error.to_string())?;
    let image_width = image.width();
    let image_height = image.height();
    let rgba = image.into_raw();
    let window_image = CapturedImage {
        width: image_width,
        height: image_height,
        rgba,
    };
    let scale_x = if let Ok(size) = main_window.inner_size() {
        if size.width > 0 {
            window_image.width as f64 / size.width as f64
        } else {
            main_window.scale_factor().unwrap_or(1.0)
        }
    } else {
        main_window.scale_factor().unwrap_or(1.0)
    };
    let scale_y = if let Ok(size) = main_window.inner_size() {
        if size.height > 0 {
            window_image.height as f64 / size.height as f64
        } else {
            main_window.scale_factor().unwrap_or(1.0)
        }
    } else {
        main_window.scale_factor().unwrap_or(1.0)
    };
    let x = (bounds.x * scale_x).round().max(0.0) as u32;
    let y = (bounds.y * scale_y).round().max(0.0) as u32;
    let width = (bounds.width * scale_x).round().max(1.0) as u32;
    let height = (bounds.height * scale_y).round().max(1.0) as u32;
    crop_image(&window_image, x, y, width, height)
}

#[cfg(windows)]
fn read_preview_stream(stream: &windows::Win32::System::Com::IStream) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::{STREAM_SEEK_END, STREAM_SEEK_SET};

    const MAX_PREVIEW_BYTES: u64 = 32 * 1024 * 1024;
    let mut length = 0_u64;
    unsafe {
        stream
            .Seek(0, STREAM_SEEK_END, Some(&mut length))
            .map_err(|error| error.to_string())?;
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|error| error.to_string())?;
    }
    if length > MAX_PREVIEW_BYTES || length > u32::MAX as u64 {
        return Err("Browser preview is too large".to_string());
    }

    let mut bytes = vec![0_u8; length as usize];
    let mut bytes_read = 0_u32;
    unsafe {
        stream
            .Read(
                bytes.as_mut_ptr().cast(),
                length as u32,
                Some(&mut bytes_read),
            )
            .ok()
            .map_err(|error| error.to_string())?;
    }
    bytes.truncate(bytes_read as usize);
    Ok(bytes)
}

#[cfg(windows)]
fn capture_webview_preview(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    use std::sync::mpsc;
    use webview2_com::{
        CapturePreviewCompletedHandler,
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::{
        Win32::Foundation::HGLOBAL, Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal,
    };

    let (sender, receiver) = mpsc::channel::<Result<Vec<u8>, String>>();
    webview
        .with_webview(move |platform_webview| {
            let start_sender = sender.clone();
            let started = (|| -> Result<(), String> {
                unsafe {
                    let controller = platform_webview.controller();
                    let core_webview = controller
                        .CoreWebView2()
                        .map_err(|error| error.to_string())?;
                    let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)
                        .map_err(|error| error.to_string())?;
                    let completed_stream = stream.clone();
                    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                        let preview = result
                            .map_err(|error| error.to_string())
                            .and_then(|_| read_preview_stream(&completed_stream));
                        let _ = sender.send(preview);
                        Ok(())
                    }));
                    core_webview
                        .CapturePreview(
                            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                            &stream,
                            &handler,
                        )
                        .map_err(|error| error.to_string())
                }
            })();
            if let Err(error) = started {
                let _ = start_sender.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;

    receiver
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "Browser preview timed out".to_string())?
}

fn emit_browser_state_change(
    app: &tauri::AppHandle,
    state: &BrowserState,
    event_type: &str,
    page_id: Option<u32>,
) {
    if let Ok(result) = browser_result(state) {
        let _ = app.emit(
            "browser_state_change",
            BrowserStateChange {
                event_type: event_type.to_string(),
                page_id,
                state: result,
            },
        );
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

fn browser_webview(
    app: &tauri::AppHandle,
    state: &BrowserState,
    page_id: u32,
) -> Result<tauri::Webview, String> {
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
    let download_app = app.clone();
    let main_window = app
        .get_window("main")
        .ok_or_else(|| "Main window was not found".to_string())?;
    let webview_builder = WebviewBuilder::new(&label, WebviewUrl::External(url.clone()))
        .initialization_script(BROWSER_PAGE_INITIALIZATION_SCRIPT)
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
                    page.url = url;
                    page.is_loading = is_loading;
                });
                emit_browser_state_change(
                    &page_load_app,
                    &state,
                    if is_loading {
                        "page-load-started"
                    } else {
                        "page-load-finished"
                    },
                    Some(load_page_id),
                );
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
                emit_browser_state_change(&title_app, &state, "title-changed", Some(title_page_id));
            }
        })
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    if let Ok(download_dir) = download_app.path().download_dir() {
                        if fs::create_dir_all(&download_dir).is_ok() {
                            *destination = unique_download_path(&download_dir, destination);
                        }
                    }
                    let _ = download_app.emit(
                        "browser_download_change",
                        browser_download_payload(&url, Some(destination), "downloading"),
                    );
                }
                DownloadEvent::Finished { url, path, success } => {
                    let _ = download_app.emit(
                        "browser_download_change",
                        browser_download_payload(
                            &url,
                            path.as_deref(),
                            if success { "completed" } else { "failed" },
                        ),
                    );
                }
                _ => {}
            }
            true
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
            title: "New page".to_string(),
            favicon_url: String::new(),
            favicon_urls: Vec::new(),
            can_go_back: false,
            can_go_forward: false,
            is_loading: true,
            visible,
        });
    }
    if visible {
        show_browser_page(app, state, page_id, Some(bounds))?;
    }

    let result = browser_result(state)?;
    emit_browser_state_change(app, state, "tab-created", Some(page_id));
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
    let payload = eval_browser_json(
        &app,
        &state,
        Some(page_id),
        BROWSER_STATE_QUERY_SCRIPT.to_string(),
        3000,
    )?;
    let report = serde_json::from_value::<BrowserPageReport>(payload)
        .map_err(|error| format!("Browser state returned invalid data: {error}"))?;
    update_browser_page_from_report(&state, page_id, report)?;
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
    create_browser_page(
        &app,
        &state,
        url,
        options.visible.unwrap_or(true),
        options.bounds,
    )
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
            webview
                .navigate(url.clone())
                .map_err(|error| error.to_string())?;
            update_browser_page(&state, page_id, |page| {
                page.url = url.to_string();
                page.is_loading = true;
            })?;
        }
        "reload" => {
            if options.ignore_cache.unwrap_or(false) {
                let current_url = webview.url().map_err(|error| error.to_string())?;
                webview
                    .navigate(current_url)
                    .map_err(|error| error.to_string())?;
            } else {
                webview.reload().map_err(|error| error.to_string())?;
            }
            update_browser_page(&state, page_id, |page| {
                page.is_loading = true;
            })?;
        }
        "back" | "forward" => {
            let native_result = eval_browser_json(
                &app,
                &state,
                Some(page_id),
                history_navigation_script(&options.nav_type)?,
                1000,
            )?;
            if !native_result
                .get("ok")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                return Err(format!(
                    "Cannot navigate {} from this page",
                    options.nav_type
                ));
            }
            update_browser_page(&state, page_id, |page| page.is_loading = true)?;
        }
        _ => return Err("type must be url, back, forward, or reload".to_string()),
    }

    browser_result(&state)
}

#[tauri::command]
async fn browser_evaluate_script(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserEvaluateOptions,
) -> Result<BrowserResult, String> {
    let args = options.args.unwrap_or_default();
    let args_json = js_literal(&serde_json::Value::Array(args))?;
    let function_source = options.function_source;
    let _ = options.dialog_action;
    let script = format!(
        r#"
(() => {{
  const fn = ({function_source});
  const args = {args_json};
  try {{
    const value = fn(...args);
    if (value && typeof value.then === "function") {{
      return {{
        ok: false,
        error: "evaluate_script does not support Promise return values yet"
      }};
    }}
    return {{ ok: true, value }};
  }} catch (error) {{
    return {{
      ok: false,
      error: error && error.message ? String(error.message) : String(error)
    }};
  }}
}})()
"#
    );
    let value = unwrap_browser_value(eval_browser_json(
        &app,
        &state,
        options.page_id,
        script,
        30000,
    )?)?;
    browser_result_with_value(&state, Some(value), None, None)
}

#[tauri::command]
async fn browser_take_snapshot(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserSnapshotOptions,
) -> Result<BrowserResult, String> {
    let snapshot = eval_browser_json(
        &app,
        &state,
        options.page_id,
        snapshot_script(options.verbose.unwrap_or(false)),
        30000,
    )?;
    if let Some(file_path) = options.file_path {
        let content = serde_json::to_string_pretty(&snapshot).map_err(|error| error.to_string())?;
        fs::write(file_path, content).map_err(|error| error.to_string())?;
    }
    browser_result_with_value(&state, None, Some(snapshot), None)
}

#[tauri::command]
async fn browser_take_screenshot(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserScreenshotOptions,
) -> Result<BrowserResult, String> {
    let page_id = active_page_id(&state, options.page_id)?;
    show_browser_page(&app, &state, page_id, None)?;
    let bounds = resolve_browser_bounds(&state, None)?;
    let output_path = screenshot_file_path(options.path);
    let original_metrics = eval_browser_json(
        &app,
        &state,
        Some(page_id),
        BROWSER_SCREENSHOT_METRICS_SCRIPT.to_string(),
        30000,
    )?;
    let original_x = original_metrics
        .get("scrollX")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);
    let original_y = original_metrics
        .get("scrollY")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);

    let (image, mode) = if let Some(uid) = options.uid {
        let rect = eval_browser_json(
            &app,
            &state,
            Some(page_id),
            element_rect_script(&uid)?,
            30000,
        )?;
        let viewport = capture_browser_viewport(&app, bounds)?;
        let scale_x = viewport.width as f64 / bounds.width.max(1.0);
        let scale_y = viewport.height as f64 / bounds.height.max(1.0);
        let x = (rect
            .get("x")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0)
            .max(0.0)
            * scale_x)
            .round() as u32;
        let y = (rect
            .get("y")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0)
            .max(0.0)
            * scale_y)
            .round() as u32;
        let width = (rect
            .get("width")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0)
            .max(1.0)
            * scale_x)
            .round() as u32;
        let height = (rect
            .get("height")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0)
            .max(1.0)
            * scale_y)
            .round() as u32;
        (crop_image(&viewport, x, y, width, height)?, "element")
    } else if options.full_page.unwrap_or(false) {
        let viewport_height = original_metrics
            .get("viewportHeight")
            .and_then(|value| value.as_f64())
            .unwrap_or(bounds.height)
            .max(1.0);
        let scroll_height = original_metrics
            .get("scrollHeight")
            .and_then(|value| value.as_f64())
            .unwrap_or(viewport_height)
            .max(viewport_height);
        let mut parts = Vec::new();
        let mut y = 0.0;
        while y < scroll_height {
            let target_y = if y + viewport_height >= scroll_height {
                (scroll_height - viewport_height).max(0.0)
            } else {
                y
            };
            let actual = eval_browser_json(
                &app,
                &state,
                Some(page_id),
                scroll_script(original_x, target_y),
                30000,
            )?;
            let actual_y = actual
                .get("scrollY")
                .and_then(|value| value.as_f64())
                .unwrap_or(target_y);
            let viewport = capture_browser_viewport(&app, bounds)?;
            let scale_y = viewport.height as f64 / viewport_height;
            let target_pixel_y = (actual_y * scale_y).round().max(0.0) as u32;
            parts.push((viewport, target_pixel_y));
            if target_y + viewport_height >= scroll_height {
                break;
            }
            y = target_y + viewport_height;
        }
        let first_width = parts
            .first()
            .map(|(image, _)| image.width)
            .unwrap_or(bounds.width.max(1.0).round() as u32);
        let first_height = parts
            .first()
            .map(|(image, _)| image.height)
            .unwrap_or(bounds.height.max(1.0).round() as u32);
        let scale_y = first_height as f64 / viewport_height;
        let output_height = (scroll_height * scale_y).ceil().max(first_height as f64) as u32;
        (
            stitch_vertical(parts, first_width, output_height)?,
            "fullPage",
        )
    } else {
        (capture_browser_viewport(&app, bounds)?, "viewport")
    };

    let _ = eval_browser_json(
        &app,
        &state,
        Some(page_id),
        scroll_script(original_x, original_y),
        30000,
    );
    write_png(&output_path, &image)?;
    browser_result_with_value(
        &state,
        Some(serde_json::json!({
            "filePath": output_path.to_string_lossy(),
            "width": image.width,
            "height": image.height,
            "mode": mode,
        })),
        None,
        None,
    )
}

#[tauri::command]
async fn browser_click(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserClickOptions,
) -> Result<BrowserResult, String> {
    let script = element_script(
        "click",
        Some(&options.uid),
        None,
        options.dbl_click.unwrap_or(false),
        None,
        None,
        None,
    )?;
    let value = eval_browser_json(&app, &state, options.page_id, script, 30000)?;
    let snapshot = if options.include_snapshot.unwrap_or(false) {
        Some(eval_browser_json(
            &app,
            &state,
            options.page_id,
            snapshot_script(false),
            30000,
        )?)
    } else {
        None
    };
    browser_result_with_value(&state, Some(value), snapshot, None)
}

#[tauri::command]
async fn browser_hover(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserHoverOptions,
) -> Result<BrowserResult, String> {
    let script = element_script("hover", Some(&options.uid), None, false, None, None, None)?;
    let value = eval_browser_json(&app, &state, options.page_id, script, 30000)?;
    let snapshot = if options.include_snapshot.unwrap_or(false) {
        Some(eval_browser_json(
            &app,
            &state,
            options.page_id,
            snapshot_script(false),
            30000,
        )?)
    } else {
        None
    };
    browser_result_with_value(&state, Some(value), snapshot, None)
}

#[tauri::command]
async fn browser_fill(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserFillOptions,
) -> Result<BrowserResult, String> {
    let script = element_script(
        "fill",
        Some(&options.uid),
        Some(&options.value),
        false,
        None,
        None,
        None,
    )?;
    let value = eval_browser_json(&app, &state, options.page_id, script, 30000)?;
    let snapshot = if options.include_snapshot.unwrap_or(false) {
        Some(eval_browser_json(
            &app,
            &state,
            options.page_id,
            snapshot_script(false),
            30000,
        )?)
    } else {
        None
    };
    browser_result_with_value(&state, Some(value), snapshot, None)
}

#[tauri::command]
async fn browser_fill_form(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserFillFormOptions,
) -> Result<BrowserResult, String> {
    for element in &options.elements {
        let script = element_script(
            "fill",
            Some(&element.uid),
            Some(&element.value),
            false,
            None,
            None,
            None,
        )?;
        let _ = eval_browser_json(&app, &state, options.page_id, script, 30000)?;
    }
    let snapshot = if options.include_snapshot.unwrap_or(false) {
        Some(eval_browser_json(
            &app,
            &state,
            options.page_id,
            snapshot_script(false),
            30000,
        )?)
    } else {
        None
    };
    browser_result_with_value(
        &state,
        Some(serde_json::json!({ "ok": true })),
        snapshot,
        None,
    )
}

#[tauri::command]
async fn browser_upload_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserUploadFileOptions,
) -> Result<BrowserResult, String> {
    let file_path = resolve_repo_path(&options.file_path);
    let metadata = fs::metadata(&file_path)
        .map_err(|error| format!("Failed to read upload file metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("filePath must point to a file".to_string());
    }
    let bytes =
        fs::read(&file_path).map_err(|error| format!("Failed to read upload file: {error}"))?;
    let script = upload_file_script(&options.uid, &file_path, &bytes)?;
    let value = eval_browser_json(&app, &state, options.page_id, script, 30000)?;
    let snapshot = if options.include_snapshot.unwrap_or(false) {
        Some(eval_browser_json(
            &app,
            &state,
            options.page_id,
            snapshot_script(false),
            30000,
        )?)
    } else {
        None
    };
    browser_result_with_value(&state, Some(value), snapshot, None)
}

#[tauri::command]
async fn browser_wait_for(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserWaitForOptions,
) -> Result<BrowserResult, String> {
    let targets = match options.text {
        serde_json::Value::Array(values) => values
            .into_iter()
            .filter_map(|value| value.as_str().map(|text| text.to_string()))
            .collect::<Vec<_>>(),
        serde_json::Value::String(value) => vec![value],
        _ => return Err("text must be a string or string array".to_string()),
    };
    if targets.is_empty() {
        return Err("text must not be empty".to_string());
    }
    let timeout = options.timeout.unwrap_or(30000);
    let targets_json =
        js_literal(&serde_json::to_value(&targets).map_err(|error| error.to_string())?)?;
    let script = format!(
        r#"
new Promise((resolve, reject) => {{
  const targets = {targets_json};
  const deadline = Date.now() + {timeout};
  const check = () => {{
    const text = document.body ? document.body.innerText || "" : "";
    const matched = targets.find((target) => text.includes(target));
    if (matched) {{
      resolve({{ matched }});
      return;
    }}
    if (Date.now() > deadline) {{
      reject(new Error("Timed out waiting for text"));
      return;
    }}
    setTimeout(check, 250);
  }};
  check();
}})
"#
    );
    let value = eval_browser_json(&app, &state, options.page_id, script, timeout + 1000)?;
    let matched = value
        .get("matched")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    browser_result_with_value(&state, Some(value), None, matched)
}

#[tauri::command]
async fn browser_press_key(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserPressKeyOptions,
) -> Result<BrowserResult, String> {
    let script = element_script(
        "press_key",
        None,
        None,
        false,
        Some(&options.key),
        None,
        None,
    )?;
    let value = eval_browser_json(&app, &state, options.page_id, script, 30000)?;
    let snapshot = if options.include_snapshot.unwrap_or(false) {
        Some(eval_browser_json(
            &app,
            &state,
            options.page_id,
            snapshot_script(false),
            30000,
        )?)
    } else {
        None
    };
    browser_result_with_value(&state, Some(value), snapshot, None)
}

#[tauri::command]
async fn browser_type_text(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserTypeTextOptions,
) -> Result<BrowserResult, String> {
    let script = element_script(
        "type_text",
        None,
        None,
        false,
        None,
        Some(&options.text),
        options.submit_key.as_deref(),
    )?;
    let value = eval_browser_json(&app, &state, options.page_id, script, 30000)?;
    browser_result_with_value(&state, Some(value), None, None)
}

#[tauri::command]
async fn browser_handle_dialog(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserHandleDialogOptions,
) -> Result<BrowserResult, String> {
    if options.action != "accept" && options.action != "dismiss" {
        return Err("action must be accept or dismiss".to_string());
    }

    let action = js_literal(&serde_json::Value::String(options.action))?;
    let prompt_text = js_literal(
        &options
            .prompt_text
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    )?;
    let script = format!(
        r#"
(() => {{
  const action = {action};
  const promptText = {prompt_text};
  window.__mokeDialogPolicy = {{ action, promptText }};
  if (!window.__mokeDialogPatched) {{
    const nativeAlert = window.alert.bind(window);
    const nativeConfirm = window.confirm.bind(window);
    const nativePrompt = window.prompt.bind(window);
    Object.defineProperty(window, "__mokeDialogNative", {{
      value: {{ alert: nativeAlert, confirm: nativeConfirm, prompt: nativePrompt }},
      configurable: false
    }});
    window.alert = (message) => {{
      window.__mokeLastDialog = {{ type: "alert", message: String(message ?? ""), action: window.__mokeDialogPolicy?.action || "accept" }};
      return undefined;
    }};
    window.confirm = (message) => {{
      const currentAction = window.__mokeDialogPolicy?.action || "accept";
      window.__mokeLastDialog = {{ type: "confirm", message: String(message ?? ""), action: currentAction }};
      return currentAction === "accept";
    }};
    window.prompt = (message, defaultValue) => {{
      const policy = window.__mokeDialogPolicy || {{ action: "accept", promptText: null }};
      window.__mokeLastDialog = {{ type: "prompt", message: String(message ?? ""), defaultValue: String(defaultValue ?? ""), action: policy.action }};
      if (policy.action !== "accept") return null;
      return policy.promptText == null ? String(defaultValue ?? "") : String(policy.promptText);
    }};
    window.__mokeDialogPatched = true;
  }}
  return {{ handled: true, action, promptText, lastDialog: window.__mokeLastDialog || null }};
}})()
"#
    );
    let value = eval_browser_json(&app, &state, options.page_id, script, 30000)?;
    browser_result_with_value(&state, Some(value), None, None)
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
    let previous_bounds = resolve_browser_bounds(&state, None)?;
    let bounds = BrowserBounds {
        x: previous_bounds.x,
        y: previous_bounds.y,
        width,
        height,
    };
    apply_webview_bounds(&webview, Some(bounds))?;
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
    apply_webview_bounds(&webview, Some(bounds))?;
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

    let current_active = *state
        .active_page_id
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?;
    let next_active = {
        let mut pages = state
            .pages
            .lock()
            .map_err(|_| "Browser state is unavailable".to_string())?;
        let closed_index = pages.iter().position(|page| page.page_id == page_id);
        pages.retain(|page| page.page_id != page_id);
        if current_active != Some(page_id)
            && pages
                .iter()
                .any(|page| Some(page.page_id) == current_active)
        {
            current_active
        } else {
            closed_index
                .and_then(|index| pages.get(index.min(pages.len().saturating_sub(1))))
                .or_else(|| pages.last())
                .map(|page| page.page_id)
        }
    };

    *state
        .active_page_id
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())? = next_active;

    if let Some(next_active) = next_active {
        show_browser_page(&app, &state, next_active, None)?;
    }

    let result = browser_result(&state)?;
    emit_browser_state_change(&app, &state, "tab-closed", Some(page_id));
    Ok(result)
}

#[tauri::command]
async fn browser_capture_preview(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    page_id: u32,
) -> Result<String, String> {
    let page_id = active_page_id(&state, Some(page_id))?;
    #[cfg(windows)]
    let png = capture_webview_preview(&browser_webview(&app, &state, page_id)?)?;
    #[cfg(not(windows))]
    let png = {
        let bounds = resolve_browser_bounds(&state, None)?;
        encode_png(&capture_browser_viewport(&app, bounds)?)?
    };
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

fn validated_download_path(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let download_dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("Could not find the downloads folder: {error}"))?
        .canonicalize()
        .map_err(|error| format!("Could not open the downloads folder: {error}"))?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("The downloaded file is unavailable: {error}"))?;
    if !path.is_file() || !path.starts_with(download_dir) {
        return Err("The downloaded file is unavailable".to_string());
    }
    Ok(path)
}

#[cfg(target_os = "windows")]
fn open_download_path(path: &Path, reveal: bool) -> Result<(), String> {
    if reveal {
        return Command::new("explorer.exe")
            .arg("/select,")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Could not show the downloaded file: {error}"));
    }

    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation = HSTRING::from("open");
    let file = HSTRING::from(path.to_string_lossy().as_ref());
    let result = unsafe {
        ShellExecuteW(
            None,
            &operation,
            &file,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        return Err("Could not open the downloaded file".to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn open_download_path(path: &Path, reveal: bool) -> Result<(), String> {
    let target = if reveal {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(target_os = "macos"))]
    let program = "xdg-open";
    Command::new(program)
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the downloaded file: {error}"))
}

#[tauri::command]
fn browser_open_download(app: tauri::AppHandle, path: String, reveal: bool) -> Result<(), String> {
    open_download_path(&validated_download_path(&app, &path)?, reveal)
}

#[tauri::command]
fn list_workspace_openers(root: String) -> Result<Vec<WorkspaceOpener>, String> {
    let root = validated_workspace_root(&root)?;
    Ok(available_workspace_openers(&root))
}

#[tauri::command]
fn open_workspace_with(root: String, opener_id: String) -> Result<(), String> {
    let root = validated_workspace_root(&root)?;
    spawn_workspace_opener(&root, &opener_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_decorum::init())
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
            list_pages,
            create_page,
            navigate_page,
            select_page,
            resize_page,
            show_browser,
            hide_browser,
            close_page,
            list_workspace_openers,
            open_workspace_with,
        ])
        .setup(|app| {
            app.get_webview_window("main")
                .expect("main window is not available")
                .create_overlay_titlebar()
                .expect("could not create the overlay titlebar");
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
}
