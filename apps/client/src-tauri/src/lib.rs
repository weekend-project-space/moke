use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, RunEvent};

struct AgentServer {
    child: Mutex<Option<Child>>,
}

impl AgentServer {
    fn start() -> Self {
        let client_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri should live under the client app")
            .to_path_buf();

        let child = Command::new("node")
            .arg("../mock-server/server.mjs")
            .current_dir(client_dir)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
