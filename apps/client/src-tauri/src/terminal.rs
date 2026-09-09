use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_OUTPUT_CHUNK_BYTES: usize = 64 * 1024;

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>,
}

#[derive(Default)]
pub(crate) struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCreated {
    pub(crate) session_id: String,
    pub(crate) shell: String,
    pub(crate) cwd: String,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data_base64: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
    code: Option<u32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalError {
    session_id: Option<String>,
    message: String,
}

#[tauri::command]
pub(crate) fn terminal_create(
    app: AppHandle,
    state: State<'_, TerminalManager>,
    cwd: String,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<TerminalCreated, String> {
    let cwd_path = validate_cwd(&cwd)?;
    let shell_path = resolve_shell(shell.as_deref())?;
    let cols = cols.unwrap_or(100).clamp(20, 500);
    let rows = rows.unwrap_or(30).clamp(4, 200);
    let session_id = format!("terminal-{}", uuid_like_id());

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to create PTY: {error}"))?;

    let mut command = CommandBuilder::new(&shell_path);
    command.cwd(&cwd_path);
    configure_shell(&mut command, &shell_path);

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to start shell: {error}"))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to read PTY output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to open PTY input: {error}"))?;
    let child = Arc::new(Mutex::new(Some(child)));

    let session = TerminalSession {
        master: pair.master,
        writer,
        child: Arc::clone(&child),
    };

    state
        .sessions
        .lock()
        .map_err(|_| "Terminal manager is unavailable".to_string())?
        .insert(session_id.clone(), session);

    spawn_reader(app.clone(), session_id.clone(), reader);
    spawn_waiter(app, session_id.clone(), child);

    Ok(TerminalCreated {
        session_id,
        shell: shell_path,
        cwd: cwd_path.to_string_lossy().into_owned(),
        cols,
        rows,
    })
}

#[tauri::command]
pub(crate) fn terminal_write(
    state: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal manager is unavailable".to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|error| format!("Failed to write to terminal: {error}"))
}

#[tauri::command]
pub(crate) fn terminal_resize(
    state: State<'_, TerminalManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal manager is unavailable".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.clamp(4, 200),
            cols: cols.clamp(20, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to resize terminal: {error}"))
}

#[tauri::command]
pub(crate) fn terminal_interrupt(
    state: State<'_, TerminalManager>,
    session_id: String,
) -> Result<(), String> {
    terminal_write(state, session_id, "\u{3}".to_string())
}

#[tauri::command]
pub(crate) fn terminal_close(
    state: State<'_, TerminalManager>,
    session_id: String,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "Terminal manager is unavailable".to_string())?
        .remove(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    if let Ok(mut child) = session.child.lock() {
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
        }
        *child = None;
    }
    Ok(())
}

pub(crate) fn close_all(state: &TerminalManager) {
    if let Ok(mut sessions) = state.sessions.lock() {
        for (_, session) in sessions.drain() {
            if let Ok(mut child) = session.child.lock() {
                if let Some(child) = child.as_mut() {
                    let _ = child.kill();
                }
            }
        }
    }
}

fn spawn_reader(app: AppHandle, session_id: String, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut buffer = vec![0_u8; MAX_OUTPUT_CHUNK_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    let _ = app.emit(
                        "terminal-output",
                        TerminalOutput {
                            session_id: session_id.clone(),
                            data_base64: BASE64.encode(&buffer[..length]),
                        },
                    );
                }
                Err(error) => {
                    let _ = app.emit(
                        "terminal-error",
                        TerminalError {
                            session_id: Some(session_id.clone()),
                            message: format!("Failed to read terminal output: {error}"),
                        },
                    );
                    break;
                }
            }
        }
    });
}

fn spawn_waiter(
    app: AppHandle,
    session_id: String,
    child: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>,
) {
    thread::spawn(move || loop {
        let status = match child.lock() {
            Ok(mut child) => match child.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(status) => status,
                    Err(error) => {
                        let _ = app.emit(
                            "terminal-error",
                            TerminalError {
                                session_id: Some(session_id.clone()),
                                message: format!("Failed to inspect terminal process: {error}"),
                            },
                        );
                        return;
                    }
                },
                None => return,
            },
            Err(_) => return,
        };

        if let Some(status) = status {
            let code = status.exit_code();
            let _ = app.emit(
                "terminal-exit",
                TerminalExit {
                    session_id: session_id.clone(),
                    code: Some(code),
                },
            );
            if let Some(manager) = app.try_state::<TerminalManager>() {
                if let Ok(mut sessions) = manager.sessions.lock() {
                    sessions.remove(&session_id);
                }
            }
            if let Ok(mut child) = child.lock() {
                *child = None;
            }
            return;
        }

        thread::sleep(Duration::from_millis(50));
    });
}

fn validate_cwd(cwd: &str) -> Result<PathBuf, String> {
    let value = cwd.trim();
    if value.is_empty() {
        return Err("Terminal workspace is not set".to_string());
    }
    let path = PathBuf::from(value);
    if !path.is_dir() {
        return Err("Terminal working directory is not a directory".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve terminal working directory: {error}"))?;
    Ok(normalize_shell_path(canonical))
}

fn normalize_shell_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") {
            return PathBuf::from(format!("\\\\{rest}"));
        }
        if let Some(rest) = value.strip_prefix("\\\\?\\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn resolve_shell(requested: Option<&str>) -> Result<String, String> {
    if let Some(shell) = requested.map(str::trim).filter(|shell| !shell.is_empty()) {
        let allowed = ["pwsh", "powershell", "cmd", "bash", "zsh", "sh"];
        if !allowed.contains(&shell) {
            return Err("Unsupported terminal shell".to_string());
        }
        return Ok(shell.to_string());
    }

    #[cfg(windows)]
    {
        return Ok("powershell.exe".to_string());
    }

    #[cfg(not(windows))]
    {
        Ok(std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string()))
    }
}

fn configure_shell(command: &mut CommandBuilder, shell: &str) {
    #[cfg(windows)]
    {
        if shell.to_ascii_lowercase().contains("powershell") || shell.eq_ignore_ascii_case("pwsh") {
            command.arg("-NoLogo");
            command.arg("-NoExit");
            command.arg("-Command");
            command.arg("[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'; $PSDefaultParameterValues['Set-Content:Encoding'] = 'UTF8'");
        } else if shell.eq_ignore_ascii_case("cmd") || shell.eq_ignore_ascii_case("cmd.exe") {
            command.arg("/Q");
            command.arg("/K");
            command.arg("chcp 65001>nul");
        }
    }

    #[cfg(not(windows))]
    {
        let _ = shell;
        command.arg("-i");
    }
}

fn uuid_like_id() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_requires_an_existing_directory() {
        assert_eq!(
            validate_cwd("").unwrap_err(),
            "Terminal workspace is not set"
        );
        let missing =
            std::env::temp_dir().join(format!("moke-missing-terminal-{}", uuid_like_id()));
        assert_eq!(
            validate_cwd(&missing.to_string_lossy()).unwrap_err(),
            "Terminal working directory is not a directory"
        );
        assert!(validate_cwd(&std::env::temp_dir().to_string_lossy()).is_ok());
    }

    #[test]
    fn shell_selection_rejects_arbitrary_programs() {
        assert_eq!(
            resolve_shell(Some("unknown-shell")).unwrap_err(),
            "Unsupported terminal shell"
        );
        assert_eq!(resolve_shell(Some("bash")).unwrap(), "bash");
    }

    #[cfg(windows)]
    #[test]
    fn shell_paths_drop_windows_extended_prefixes() {
        assert_eq!(
            normalize_shell_path(PathBuf::from(r"\\?\E:\root")),
            PathBuf::from(r"E:\root")
        );
        assert_eq!(
            normalize_shell_path(PathBuf::from(r"\\?\UNC\server\share")),
            PathBuf::from(r"\\server\share")
        );
    }
}
