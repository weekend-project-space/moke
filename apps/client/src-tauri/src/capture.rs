use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;

use crate::browser::{browser_webview, BrowserBounds, BrowserDataKind, BrowserState};
use crate::downloads::unique_download_path;

#[derive(Serialize)]
pub(crate) struct LocalImage {
    pub(crate) name: String,
    pub(crate) mime_type: String,
    pub(crate) data_url: String,
}

pub(crate) fn clear_browser_data_with_webview(
    webview: &tauri::Webview,
    kind: BrowserDataKind,
) -> Result<(), String> {
    use webview2_com::{
        ClearBrowsingDataCompletedHandler,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Profile2, ICoreWebView2_13,
            COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_DOM_STORAGE,
            COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE,
            COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES, COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
            COREWEBVIEW2_BROWSING_DATA_KINDS_FILE_SYSTEMS,
            COREWEBVIEW2_BROWSING_DATA_KINDS_INDEXED_DB,
            COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS,
            COREWEBVIEW2_BROWSING_DATA_KINDS_WEB_SQL,
        },
    };
    use windows::core::Interface;

    let (sender, receiver) = mpsc::channel::<Result<(), String>>();
    let start_sender = sender.clone();
    webview
        .with_webview(move |platform_webview| {
            let started = (|| -> Result<(), String> {
                unsafe {
                    let core_webview = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| error.to_string())?;
                    let profile = core_webview
                        .cast::<ICoreWebView2_13>()
                        .map_err(|error| error.to_string())?
                        .Profile()
                        .map_err(|error| error.to_string())?
                        .cast::<ICoreWebView2Profile2>()
                        .map_err(|error| error.to_string())?;
                    let data_kinds = match kind {
                        BrowserDataKind::Cache => {
                            COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE
                                | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE
                                | COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS
                        }
                        BrowserDataKind::Cookies => {
                            COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES
                                | COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE
                                | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE
                                | COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_DOM_STORAGE
                                | COREWEBVIEW2_BROWSING_DATA_KINDS_FILE_SYSTEMS
                                | COREWEBVIEW2_BROWSING_DATA_KINDS_INDEXED_DB
                                | COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS
                                | COREWEBVIEW2_BROWSING_DATA_KINDS_WEB_SQL
                        }
                    };
                    let completed_sender = sender.clone();
                    let handler =
                        ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                            let outcome = result.map_err(|error| error.to_string());
                            let _ = completed_sender.send(outcome);
                            Ok(())
                        }));
                    profile
                        .ClearBrowsingData(data_kinds, &handler)
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            })();
            if let Err(error) = started {
                let _ = start_sender.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;

    receiver
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "Clearing browser data timed out".to_string())?
}

#[cfg(not(windows))]
pub(crate) fn clear_browser_data_with_webview(
    _webview: &tauri::Webview,
    _kind: BrowserDataKind,
) -> Result<(), String> {
    Err("Clearing browser data separately is not supported on this platform".to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]

pub(crate) struct CapturedImage {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rgba: Vec<u8>,
}

pub(crate) fn validate_workspace_relative_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if path.is_absolute()
        || path.components().any(|component| {
            !matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return Err(format!(
            "{label} path must stay inside the current workspace"
        ));
    }

    Ok(path.to_path_buf())
}

pub(crate) fn validate_screenshot_relative_path(path: &str) -> Result<PathBuf, String> {
    let path = validate_workspace_relative_path(path, "Screenshot")?;
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
    {
        return Err("Screenshot path must end in .png".to_string());
    }
    Ok(path.to_path_buf())
}

pub(crate) fn ensure_path_in_workspace(
    workspace_root: &Path,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    let outside_error = || format!("{label} path must stay inside the current workspace");
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|error| format!("Could not resolve {label} workspace: {error}"))?;
    let mut ancestor = path.parent().unwrap_or(workspace_root);
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or_else(outside_error)?;
    }
    let canonical_ancestor = fs::canonicalize(ancestor)
        .map_err(|error| format!("Could not resolve {label} directory: {error}"))?;
    if !canonical_ancestor.starts_with(&canonical_root) {
        return Err(outside_error());
    }
    if fs::symlink_metadata(path).is_ok() {
        let canonical_path = fs::canonicalize(path)
            .map_err(|error| format!("Could not resolve {label} path: {error}"))?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err(outside_error());
        }
    }
    Ok(())
}

pub(crate) fn ensure_screenshot_path_in_workspace(
    workspace_root: &Path,
    path: &Path,
) -> Result<(), String> {
    ensure_path_in_workspace(workspace_root, path, "Screenshot")
}

pub(crate) fn screenshot_file_path(
    workspace_root: &Path,
    path: Option<String>,
) -> Result<PathBuf, String> {
    if !workspace_root.is_dir() {
        return Err("Screenshot workspace is unavailable".to_string());
    }

    if let Some(path) = path {
        let output_path = workspace_root.join(validate_screenshot_relative_path(&path)?);
        ensure_screenshot_path_in_workspace(workspace_root, &output_path)?;
        if output_path.exists() {
            return Err("Screenshot output already exists".to_string());
        }
        return Ok(output_path);
    }

    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let screenshot_dir = workspace_root.join(".moke").join("screenshots");
    ensure_screenshot_path_in_workspace(workspace_root, &screenshot_dir.join("pending.png"))?;
    Ok(unique_download_path(
        &screenshot_dir,
        Path::new(&format!("browser-{millis}.png")),
    ))
}

pub(crate) fn snapshot_file_path(workspace_root: &Path, path: &str) -> Result<PathBuf, String> {
    if !workspace_root.is_dir() {
        return Err("Snapshot workspace is unavailable".to_string());
    }

    let output_path = workspace_root.join(validate_workspace_relative_path(path, "Snapshot")?);
    ensure_path_in_workspace(workspace_root, &output_path, "Snapshot")?;
    if output_path.is_dir() {
        return Err("Snapshot output must be a file".to_string());
    }
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create snapshot directory: {error}"))?;
    }
    Ok(output_path)
}

pub(crate) fn write_png(path: &Path, image: &CapturedImage) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Could not create screenshot: {error}"))?;
    file.write_all(&encode_png(image)?)
        .map_err(|error| format!("Could not write screenshot: {error}"))
}

pub(crate) fn encode_png(image: &CapturedImage) -> Result<Vec<u8>, String> {
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

pub(crate) fn decode_png(bytes: &[u8]) -> Result<CapturedImage, String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| error.to_string())?;
    let source = &buffer[..info.buffer_size()];
    let pixel_count = (info.width as usize)
        .checked_mul(info.height as usize)
        .ok_or_else(|| "Browser screenshot dimensions are too large".to_string())?;
    let mut rgba = Vec::with_capacity(
        pixel_count
            .checked_mul(4)
            .ok_or_else(|| "Browser screenshot dimensions are too large".to_string())?,
    );
    match info.color_type {
        png::ColorType::Rgba => rgba.extend_from_slice(source),
        png::ColorType::Rgb => {
            for pixel in source.chunks_exact(3) {
                rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
            }
        }
        png::ColorType::Grayscale => {
            for value in source {
                rgba.extend_from_slice(&[*value, *value, *value, 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for pixel in source.chunks_exact(2) {
                rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], pixel[1]]);
            }
        }
        png::ColorType::Indexed => {
            return Err("Browser screenshot uses an unsupported PNG color format".to_string())
        }
    }
    if rgba.len() != pixel_count * 4 {
        return Err("Browser screenshot contains incomplete pixel data".to_string());
    }
    Ok(CapturedImage {
        width: info.width,
        height: info.height,
        rgba,
    })
}

pub(crate) fn crop_image(
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

pub(crate) fn stitch_vertical(
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

#[cfg(not(windows))]
pub(crate) fn capture_browser_viewport(
    app: &tauri::AppHandle,
    _state: &BrowserState,
    _page_id: u32,
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
pub(crate) fn capture_browser_viewport(
    app: &tauri::AppHandle,
    state: &BrowserState,
    page_id: u32,
    _bounds: BrowserBounds,
) -> Result<CapturedImage, String> {
    decode_png(&capture_webview_preview(&browser_webview(
        app, state, page_id,
    )?)?)
}

#[cfg(windows)]
pub(crate) fn read_preview_stream(
    stream: &windows::Win32::System::Com::IStream,
) -> Result<Vec<u8>, String> {
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
pub(crate) fn capture_webview_preview(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
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

#[tauri::command]
pub(crate) fn read_local_image(path: String) -> Result<LocalImage, String> {
    const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

    let path = PathBuf::from(path);
    let mime_type = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "gif" => "image/gif",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => return Err("Unsupported image format".to_string()),
    };
    let metadata = fs::metadata(&path).map_err(|error| format!("Could not read image: {error}"))?;
    if !metadata.is_file() {
        return Err("Selected image is not a file".to_string());
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err("Image exceeds the 4 MB limit".to_string());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Selected image has no file name".to_string())?
        .to_string();
    let bytes = fs::read(&path).map_err(|error| format!("Could not read image: {error}"))?;
    Ok(LocalImage {
        name,
        mime_type: mime_type.to_string(),
        data_url: format!(
            "data:{mime_type};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
    })
}
