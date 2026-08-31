use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::Manager;

pub(crate) struct AgentServer {
    pub(crate) child: Mutex<Option<Child>>,
    pub(crate) token: String,
}

impl AgentServer {
    pub(crate) fn start(app: &tauri::App) -> Self {
        let token = generate_api_token();
        let child = start_agent_server(app, &token).ok();

        Self {
            child: Mutex::new(child),
            token,
        }
    }

    pub(crate) fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *child = None;
        }
    }
}

pub(crate) fn app_data_moke_dir(app: &tauri::App) -> PathBuf {
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

pub(crate) fn append_agent_server_log(app: &tauri::App, message: &str) {
    let log_dir = app_data_moke_dir(app).join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("agent-server.log");
    let _ = fs::write(log_path, format!("{message}\n"));
}

pub(crate) fn agent_server_log_file(app: &tauri::App) -> Option<fs::File> {
    let log_dir = app_data_moke_dir(app).join("logs");
    fs::create_dir_all(&log_dir).ok()?;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("agent-server.log"))
        .ok()
}

pub(crate) fn ensure_user_env_file(app: &tauri::App, env_path: &Path) {
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

pub(crate) fn start_agent_server(app: &tauri::App, api_token: &str) -> Result<Child, String> {
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
            server_dir.join(if cfg!(windows) { "node.exe" } else { "node" }),
            vec!["server.cjs".to_string()],
            server_dir,
            data_dir.clone(),
            data_dir.join(".env"),
        )
    };

    #[cfg(windows)]
    let sandbox_helper_path = if tauri::is_dev() {
        repo_dir()
            .join("packages/shell/native/windows-sandbox/target/release/moke-windows-sandbox.exe")
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| error.to_string())?
            .join("shell/moke-windows-sandbox.exe")
    };

    #[cfg(target_os = "macos")]
    let sandbox_helper_path = if tauri::is_dev() {
        repo_dir().join("packages/shell/native/macos-sandbox/target/release/moke-macos-sandbox")
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| error.to_string())?
            .join("shell/moke-macos-sandbox")
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
        .env("MOKE_API_TOKEN", api_token)
        .env("MOKE_WORKSPACE", &workspace_dir)
        .env("MOKE_ENV_PATH", &env_path)
        .env("MOKE_STATE_PATH", &state_path)
        .env("MOKE_MCP_CONFIG", &mcp_config_path)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);

    #[cfg(windows)]
    command.env("MOKE_WINDOWS_SANDBOX_HELPER", &sandbox_helper_path);

    #[cfg(target_os = "macos")]
    command.env("MOKE_MACOS_SANDBOX_HELPER", &sandbox_helper_path);

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

pub(crate) fn generate_api_token() -> String {
    let bytes: [u8; 32] = rand::random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn repo_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should live under the client app")
        .parent()
        .expect("client app should live under apps")
        .parent()
        .expect("apps should live under the repository root")
        .to_path_buf()
}

#[tauri::command]
pub(crate) fn agent_api_token(state: tauri::State<'_, AgentServer>) -> String {
    state.token.clone()
}
