use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewBuilder};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl};
use url::Url;

#[cfg(windows)]
use crate::capture::capture_webview_preview;
#[cfg(not(windows))]
use crate::capture::encode_png;
use crate::capture::{
    capture_browser_viewport, clear_browser_data_with_webview, crop_image, screenshot_file_path,
    snapshot_file_path, stitch_vertical, write_png, CapturedImage,
};
use crate::downloads::{browser_download_payload, unique_download_path};
use crate::sidecar::repo_dir;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPageState {
    pub(crate) page_id: u32,
    pub(crate) label: String,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) favicon_url: String,
    pub(crate) favicon_urls: Vec<String>,
    pub(crate) can_go_back: bool,
    pub(crate) can_go_forward: bool,
    pub(crate) is_loading: bool,
    pub(crate) visible: bool,
}

pub(crate) struct BrowserState {
    pub(crate) pages: Mutex<Vec<BrowserPageState>>,
    pub(crate) active_page_id: Mutex<Option<u32>>,
    pub(crate) next_page_id: Mutex<u32>,
    pub(crate) last_bounds: Mutex<Option<BrowserBounds>>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BrowserDataKind {
    Cache,
    Cookies,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserBounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPageOptions {
    pub(crate) page_id: Option<u32>,
    pub(crate) url: Option<String>,
    pub(crate) visible: Option<bool>,
    pub(crate) bounds: Option<BrowserBounds>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserNavigateOptions {
    pub(crate) page_id: Option<u32>,
    #[serde(rename = "type")]
    pub(crate) nav_type: String,
    pub(crate) url: Option<String>,
    pub(crate) ignore_cache: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserEvaluateOptions {
    pub(crate) page_id: Option<u32>,
    #[serde(rename = "function")]
    pub(crate) function_source: String,
    pub(crate) args: Option<Vec<serde_json::Value>>,
    pub(crate) dialog_action: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSnapshotOptions {
    pub(crate) page_id: Option<u32>,
    pub(crate) verbose: Option<bool>,
    pub(crate) file_path: Option<String>,
    pub(crate) workspace_root: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserScreenshotOptions {
    pub(crate) page_id: Option<u32>,
    pub(crate) workspace_root: String,
    pub(crate) path: Option<String>,
    pub(crate) full_page: Option<bool>,
    pub(crate) uid: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserClickOptions {
    pub(crate) page_id: Option<u32>,
    pub(crate) uid: String,
    pub(crate) dbl_click: Option<bool>,
    pub(crate) include_snapshot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserHoverOptions {
    pub(crate) page_id: Option<u32>,
    pub(crate) uid: String,
    pub(crate) include_snapshot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserFillOptions {
    pub(crate) page_id: Option<u32>,
    pub(crate) uid: String,
    pub(crate) value: String,
    pub(crate) include_snapshot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserFillFormElement {
    pub(crate) uid: String,
    pub(crate) value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserFillFormOptions {
    pub(crate) page_id: Option<u32>,
    pub(crate) elements: Vec<BrowserFillFormElement>,
    pub(crate) include_snapshot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserUploadFileOptions {
    pub(crate) page_id: Option<u32>,
    pub(crate) uid: String,
    pub(crate) file_path: String,
    pub(crate) include_snapshot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserWaitForOptions {
    pub(crate) page_id: Option<u32>,
    pub(crate) text: serde_json::Value,
    pub(crate) timeout: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPressKeyOptions {
    pub(crate) page_id: Option<u32>,
    pub(crate) key: String,
    pub(crate) include_snapshot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTypeTextOptions {
    pub(crate) page_id: Option<u32>,
    pub(crate) text: String,
    pub(crate) submit_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserHandleDialogOptions {
    pub(crate) page_id: Option<u32>,
    pub(crate) action: String,
    pub(crate) prompt_text: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserResult {
    pub(crate) page: Option<BrowserPageState>,
    pub(crate) pages: Vec<BrowserPageState>,
    pub(crate) active_page_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) snapshot: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) matched: Option<String>,
}

pub(crate) fn normalize_url(value: Option<&str>) -> Result<Url, String> {
    let raw = value.unwrap_or("about:blank").trim();
    if Path::new(raw).is_absolute() || is_windows_drive_path(raw) {
        return Url::from_file_path(raw).map_err(|_| "Invalid local file path".to_string());
    }
    let with_scheme = if raw.contains("://") || raw == "about:blank" {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };

    Url::parse(&with_scheme).map_err(|error| format!("Invalid URL: {error}"))
}

pub(crate) fn is_windows_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

pub(crate) fn normalized_bounds(bounds: Option<BrowserBounds>) -> BrowserBounds {
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

pub(crate) fn resolve_browser_bounds(
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

pub(crate) fn apply_webview_bounds<R: Runtime>(
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
pub(crate) struct BrowserPageReport {
    pub(crate) url: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) favicon_url: Option<String>,
    pub(crate) favicon_urls: Option<Vec<String>>,
    pub(crate) can_go_back: Option<bool>,
    pub(crate) can_go_forward: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserStateChange {
    #[serde(rename = "eventType")]
    pub(crate) event_type: String,
    pub(crate) page_id: Option<u32>,
    pub(crate) state: BrowserResult,
}

pub(crate) const BROWSER_STATE_QUERY_SCRIPT: &str = r#"
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

pub(crate) const BROWSER_PAGE_INITIALIZATION_SCRIPT: &str = r#"
document.addEventListener("contextmenu", (event) => event.preventDefault(), true);
"#;

pub(crate) const BROWSER_HISTORY_NAVIGATION_SCRIPT: &str = r#"
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

pub(crate) const BROWSER_SNAPSHOT_SCRIPT: &str = r#"
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

pub(crate) const BROWSER_ELEMENT_SCRIPT: &str = r#"
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

pub(crate) const BROWSER_SCREENSHOT_METRICS_SCRIPT: &str = r#"
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

pub(crate) const BROWSER_ELEMENT_RECT_SCRIPT: &str = r#"
(async () => {
  const uid = __MOKE_UID__;
  const el = document.querySelector(`[data-moke-uid="${String(uid).replace(/"/g, '\\"')}"]`);
  if (!el) throw new Error(`Element not found: ${uid}`);
  const doc = document.documentElement;
  const previousScrollBehavior = doc.style.scrollBehavior;
  doc.style.scrollBehavior = "auto";
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  doc.style.scrollBehavior = previousScrollBehavior;
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

pub(crate) const BROWSER_UPLOAD_FILE_SCRIPT: &str = r#"
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

pub(crate) fn scroll_script(x: f64, y: f64) -> String {
    format!(
        r#"
new Promise((resolve) => {{
  const doc = document.documentElement;
  const previousScrollBehavior = doc.style.scrollBehavior;
  doc.style.scrollBehavior = "auto";
  window.scrollTo({{ left: {x}, top: {y}, behavior: "auto" }});
  requestAnimationFrame(() => requestAnimationFrame(() => {{
    doc.style.scrollBehavior = previousScrollBehavior;
    resolve({{
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0
    }});
  }}));
}})
"#
    )
}

pub(crate) fn element_rect_script(uid: &str) -> Result<String, String> {
    Ok(BROWSER_ELEMENT_RECT_SCRIPT.replace(
        "__MOKE_UID__",
        &js_literal(&serde_json::Value::String(uid.to_string()))?,
    ))
}

pub(crate) fn resolve_repo_path(file_path: &str) -> PathBuf {
    let path = PathBuf::from(file_path);
    if path.is_absolute() {
        path
    } else {
        repo_dir().join(path)
    }
}

pub(crate) fn mime_type_for_path(path: &Path) -> &'static str {
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

pub(crate) fn upload_file_script(uid: &str, path: &Path, bytes: &[u8]) -> Result<String, String> {
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

pub(crate) fn update_browser_page_from_report(
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

pub(crate) fn refresh_browser_page_state(
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

pub(crate) fn js_literal(value: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

pub(crate) fn eval_browser_json(
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

pub(crate) fn unwrap_browser_value(value: serde_json::Value) -> Result<serde_json::Value, String> {
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

pub(crate) fn snapshot_script(verbose: bool) -> String {
    BROWSER_SNAPSHOT_SCRIPT.replace("__MOKE_VERBOSE__", if verbose { "true" } else { "false" })
}

pub(crate) fn history_navigation_script(direction: &str) -> Result<String, String> {
    Ok(BROWSER_HISTORY_NAVIGATION_SCRIPT.replace(
        "__MOKE_HISTORY_DIRECTION__",
        &js_literal(&serde_json::Value::String(direction.to_string()))?,
    ))
}

pub(crate) fn element_script(
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

pub(crate) fn browser_result(state: &BrowserState) -> Result<BrowserResult, String> {
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

pub(crate) fn browser_result_with_value(
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

pub(crate) fn sanitize_browser_favicon_url(value: &str) -> String {
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

pub(crate) fn sanitize_browser_favicon_urls(values: Vec<String>) -> Vec<String> {
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

pub(crate) fn emit_browser_state_change(
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

pub(crate) fn active_page_id(state: &BrowserState, page_id: Option<u32>) -> Result<u32, String> {
    if let Some(page_id) = page_id {
        return Ok(page_id);
    }

    state
        .active_page_id
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?
        .ok_or_else(|| "No browser page is open".to_string())
}

pub(crate) fn find_page_label(state: &BrowserState, page_id: u32) -> Result<String, String> {
    state
        .pages
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?
        .iter()
        .find(|page| page.page_id == page_id)
        .map(|page| page.label.clone())
        .ok_or_else(|| format!("Browser page {page_id} was not found"))
}

pub(crate) fn update_browser_page<F>(
    state: &BrowserState,
    page_id: u32,
    update: F,
) -> Result<(), String>
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

pub(crate) fn browser_webview(
    app: &tauri::AppHandle,
    state: &BrowserState,
    page_id: u32,
) -> Result<tauri::Webview, String> {
    let label = find_page_label(state, page_id)?;
    app.get_webview(&label)
        .ok_or_else(|| format!("Browser webview {label} was not found"))
}

pub(crate) fn show_browser_page(
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

pub(crate) fn select_browser_page(state: &BrowserState, page_id: u32) -> Result<(), String> {
    let pages = state
        .pages
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?;
    if !pages.iter().any(|page| page.page_id == page_id) {
        return Err(format!("Browser page {page_id} was not found"));
    }
    drop(pages);

    *state
        .active_page_id
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())? = Some(page_id);
    Ok(())
}

pub(crate) fn hide_active_browser_page(
    app: &tauri::AppHandle,
    state: &BrowserState,
) -> Result<(), String> {
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

pub(crate) fn create_browser_page(
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
    } else {
        select_browser_page(state, page_id)?;
    }

    let result = browser_result(state)?;
    emit_browser_state_change(app, state, "tab-created", Some(page_id));
    Ok(result)
}

#[tauri::command]
pub(crate) async fn browser_state(
    state: tauri::State<'_, BrowserState>,
) -> Result<BrowserResult, String> {
    browser_result(&state)
}

#[tauri::command]
pub(crate) async fn browser_clear_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    kind: BrowserDataKind,
) -> Result<(), String> {
    let webview = {
        let pages = state
            .pages
            .lock()
            .map_err(|_| "Browser state is unavailable".to_string())?;
        pages
            .iter()
            .find_map(|page| app.get_webview(&page.label))
            .or_else(|| app.get_webview("main"))
            .ok_or_else(|| "Browser webview is not available".to_string())?
    };
    clear_browser_data_with_webview(&webview, kind)
}

#[tauri::command]
pub(crate) async fn browser_refresh_state(
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
pub(crate) async fn browser_open(
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
pub(crate) async fn browser_navigate(
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
pub(crate) async fn browser_evaluate_script(
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
pub(crate) async fn browser_take_snapshot(
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
        let workspace_root = options
            .workspace_root
            .ok_or_else(|| "Snapshot workspace is unavailable".to_string())?;
        let output_path = snapshot_file_path(Path::new(&workspace_root), &file_path)?;
        let content = serde_json::to_string_pretty(&snapshot).map_err(|error| error.to_string())?;
        fs::write(output_path, content)
            .map_err(|error| format!("Could not write snapshot: {error}"))?;
    }
    browser_result_with_value(&state, None, Some(snapshot), None)
}

#[tauri::command]
pub(crate) async fn browser_take_screenshot(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    options: BrowserScreenshotOptions,
) -> Result<BrowserResult, String> {
    let BrowserScreenshotOptions {
        page_id,
        workspace_root,
        path,
        full_page,
        uid,
    } = options;
    let page_id = active_page_id(&state, page_id)?;
    show_browser_page(&app, &state, page_id, None)?;
    let bounds = resolve_browser_bounds(&state, None)?;
    let workspace_root = PathBuf::from(workspace_root);
    let output_path = screenshot_file_path(&workspace_root, path)?;
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

    let capture_result = (|| -> Result<(CapturedImage, &'static str), String> {
        if let Some(uid) = uid {
            let rect = eval_browser_json(
                &app,
                &state,
                Some(page_id),
                element_rect_script(&uid)?,
                30000,
            )?;
            let viewport = capture_browser_viewport(&app, &state, page_id, bounds)?;
            let viewport_width = rect
                .get("viewportWidth")
                .and_then(|value| value.as_f64())
                .unwrap_or(bounds.width)
                .max(1.0);
            let viewport_height = rect
                .get("viewportHeight")
                .and_then(|value| value.as_f64())
                .unwrap_or(bounds.height)
                .max(1.0);
            let scale_x = viewport.width as f64 / viewport_width;
            let scale_y = viewport.height as f64 / viewport_height;
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
            Ok((crop_image(&viewport, x, y, width, height)?, "element"))
        } else if full_page.unwrap_or(false) {
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
                let viewport = capture_browser_viewport(&app, &state, page_id, bounds)?;
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
            Ok((
                stitch_vertical(parts, first_width, output_height)?,
                "fullPage",
            ))
        } else {
            Ok((
                capture_browser_viewport(&app, &state, page_id, bounds)?,
                "viewport",
            ))
        }
    })();

    let restore_result = eval_browser_json(
        &app,
        &state,
        Some(page_id),
        scroll_script(original_x, original_y),
        30000,
    );
    let (image, mode) = capture_result?;
    restore_result
        .map_err(|error| format!("Could not restore browser scroll position: {error}"))?;
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
pub(crate) async fn browser_click(
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
pub(crate) async fn browser_hover(
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
pub(crate) async fn browser_fill(
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
pub(crate) async fn browser_fill_form(
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
pub(crate) async fn browser_upload_file(
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
pub(crate) async fn browser_wait_for(
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
pub(crate) async fn browser_press_key(
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
pub(crate) async fn browser_type_text(
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
pub(crate) async fn browser_handle_dialog(
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
pub(crate) async fn select_page(
    state: tauri::State<'_, BrowserState>,
    page_id: u32,
) -> Result<BrowserResult, String> {
    select_browser_page(&state, page_id)?;
    browser_result(&state)
}

#[tauri::command]
pub(crate) async fn resize_page(
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
pub(crate) async fn browser_resize(
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
pub(crate) async fn browser_show(
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
pub(crate) async fn browser_hide(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<BrowserResult, String> {
    hide_active_browser_page(&app, &state)?;
    browser_result(&state)
}

#[tauri::command]
pub(crate) async fn browser_close(
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
    let closed_page_was_visible = state
        .pages
        .lock()
        .map_err(|_| "Browser state is unavailable".to_string())?
        .iter()
        .find(|page| page.page_id == page_id)
        .map(|page| page.visible)
        .unwrap_or(false);
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
        if closed_page_was_visible {
            show_browser_page(&app, &state, next_active, None)?;
        } else {
            select_browser_page(&state, next_active)?;
        }
    }

    let result = browser_result(&state)?;
    emit_browser_state_change(&app, &state, "tab-closed", Some(page_id));
    Ok(result)
}
#[tauri::command]
pub(crate) async fn browser_capture_preview(
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
        encode_png(&capture_browser_viewport(&app, &state, page_id, bounds)?)?
    };
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}
