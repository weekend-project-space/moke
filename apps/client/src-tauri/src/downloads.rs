use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::Manager;
use url::Url;

pub(crate) fn unique_download_path(download_dir: &Path, suggested: &Path) -> PathBuf {
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

pub(crate) fn browser_download_payload(
    url: &Url,
    path: Option<&Path>,
    status: &str,
) -> serde_json::Value {
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

pub(crate) fn validated_download_path(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<PathBuf, String> {
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
pub(crate) fn open_download_path(path: &Path, reveal: bool) -> Result<(), String> {
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
pub(crate) fn open_download_path(path: &Path, reveal: bool) -> Result<(), String> {
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
pub(crate) fn browser_open_download(
    app: tauri::AppHandle,
    path: String,
    reveal: bool,
) -> Result<(), String> {
    open_download_path(&validated_download_path(&app, &path)?, reveal)
}
