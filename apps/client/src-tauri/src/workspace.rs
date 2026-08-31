use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceOpener {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
}

pub(crate) fn validated_workspace_root(root: &str) -> Result<PathBuf, String> {
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
pub(crate) fn executable_on_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(target_os = "windows")]
pub(crate) fn first_existing_path(
    candidates: impl IntoIterator<Item = PathBuf>,
) -> Option<PathBuf> {
    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_vscode_executable() -> Option<PathBuf> {
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
pub(crate) fn windows_visual_studio_executable() -> Option<PathBuf> {
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
pub(crate) fn windows_git_bash_executable() -> Option<PathBuf> {
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
pub(crate) fn workspace_solution(root: &Path) -> Option<PathBuf> {
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
pub(crate) fn available_workspace_openers(root: &Path) -> Vec<WorkspaceOpener> {
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
pub(crate) fn available_workspace_openers(_root: &Path) -> Vec<WorkspaceOpener> {
    Vec::new()
}

#[cfg(target_os = "windows")]
pub(crate) fn spawn_workspace_opener(root: &Path, opener_id: &str) -> Result<(), String> {
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
pub(crate) fn spawn_workspace_opener(_root: &Path, _opener_id: &str) -> Result<(), String> {
    Err("Opening workspaces in external applications is not available on this platform".to_string())
}

#[tauri::command]
pub(crate) fn list_workspace_openers(root: String) -> Result<Vec<WorkspaceOpener>, String> {
    let root = validated_workspace_root(&root)?;
    Ok(available_workspace_openers(&root))
}

#[tauri::command]
pub(crate) fn open_workspace_with(root: String, opener_id: String) -> Result<(), String> {
    let root = validated_workspace_root(&root)?;
    spawn_workspace_opener(&root, &opener_id)
}
