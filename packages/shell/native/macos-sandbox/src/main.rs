#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("moke-sandbox: the macOS sandbox helper only runs on macOS");
    std::process::exit(127);
}

#[cfg(target_os = "macos")]
mod macos_main {
    use std::env;
    use std::ffi::{CStr, CString};
    use std::fs;
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, ExitStatus};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    type Result<T> = std::result::Result<T, String>;

    #[link(name = "sandbox")]
    unsafe extern "C" {
        fn sandbox_init(
            profile: *const libc::c_char,
            flags: u64,
            errorbuf: *mut *mut libc::c_char,
        ) -> libc::c_int;
        fn sandbox_free_error(errorbuf: *mut libc::c_char);
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        ReadOnly,
        WorkspaceWrite,
    }

    struct Args {
        mode: Mode,
        workspace: Option<PathBuf>,
        cwd: PathBuf,
        cancel_file: PathBuf,
        command: Vec<String>,
    }

    pub fn run() -> Result<i32> {
        let args = parse_args()?;
        let private_temp = create_private_temp()?;
        let outcome = execute(&args, &private_temp);
        let cleanup = fs::remove_dir_all(&private_temp)
            .map_err(|error| format!("remove private temp {}: {error}", private_temp.display()));
        match (outcome, cleanup) {
            (Ok(code), Ok(())) => Ok(code),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(error), Err(cleanup)) => Err(format!("{error}; cleanup failed: {cleanup}")),
        }
    }

    fn parse_args() -> Result<Args> {
        let values: Vec<String> = env::args().skip(1).collect();
        if values.as_slice() == ["--version"] {
            println!("moke-macos-sandbox 0.1.0");
            std::process::exit(0);
        }

        let mut mode = None;
        let mut workspace = None;
        let mut cwd = None;
        let mut cancel_file = None;
        let mut index = 0;
        while index < values.len() {
            match values[index].as_str() {
                "--" => {
                    index += 1;
                    break;
                }
                "--mode" => mode = Some(parse_mode(value_at(&values, &mut index, "--mode")?)?),
                "--workspace" => {
                    workspace = Some(PathBuf::from(value_at(&values, &mut index, "--workspace")?))
                }
                "--cwd" => cwd = Some(PathBuf::from(value_at(&values, &mut index, "--cwd")?)),
                "--cancel-file" => {
                    cancel_file = Some(PathBuf::from(value_at(
                        &values,
                        &mut index,
                        "--cancel-file",
                    )?))
                }
                option => return Err(format!("unknown option: {option}")),
            }
            index += 1;
        }
        let command = values[index..].to_vec();
        if command.is_empty() {
            return Err("a command is required after --".to_string());
        }
        let mode = mode.ok_or("--mode is required")?;
        let cwd = canonical_directory(cwd.ok_or("--cwd is required")?, "cwd")?;
        let workspace = match workspace {
            Some(path) => Some(canonical_directory(path, "workspace")?),
            None => None,
        };
        if mode == Mode::WorkspaceWrite {
            let workspace = workspace
                .as_ref()
                .ok_or("workspace-write requires --workspace")?;
            if !cwd.starts_with(workspace) {
                return Err(format!(
                    "cwd {} is outside workspace {}",
                    cwd.display(),
                    workspace.display()
                ));
            }
        }
        Ok(Args {
            mode,
            workspace,
            cwd,
            cancel_file: cancel_file.ok_or("--cancel-file is required")?,
            command,
        })
    }

    fn value_at<'a>(values: &'a [String], index: &mut usize, option: &str) -> Result<&'a str> {
        *index += 1;
        values
            .get(*index)
            .map(String::as_str)
            .ok_or_else(|| format!("{option} requires a value"))
    }

    fn parse_mode(value: &str) -> Result<Mode> {
        match value {
            "read-only" => Ok(Mode::ReadOnly),
            "workspace-write" => Ok(Mode::WorkspaceWrite),
            _ => Err(format!("unsupported mode: {value}")),
        }
    }

    fn canonical_directory(path: PathBuf, name: &str) -> Result<PathBuf> {
        let path = fs::canonicalize(&path)
            .map_err(|error| format!("resolve {name} {}: {error}", path.display()))?;
        if !path.is_dir() {
            return Err(format!("{name} is not a directory: {}", path.display()));
        }
        Ok(path)
    }

    fn create_private_temp() -> Result<PathBuf> {
        let root = env::temp_dir();
        for attempt in 0..64 {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_nanos();
            let path = root.join(format!(
                "moke-sandbox-{}-{nonce}-{attempt}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                        .map_err(|error| format!("set private temp permissions: {error}"))?;
                    return fs::canonicalize(&path).map_err(|error| {
                        format!("resolve private temp {}: {error}", path.display())
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!("create private temp {}: {error}", path.display()))
                }
            }
        }
        Err("create private temp: too many name collisions".to_string())
    }

    fn execute(args: &Args, private_temp: &Path) -> Result<i32> {
        let profile = CString::new(profile(args, private_temp)?)
            .map_err(|_| "sandbox profile contains a null byte".to_string())?;
        let mut command = Command::new(&args.command[0]);
        command
            .args(&args.command[1..])
            .current_dir(&args.cwd)
            .env("TMPDIR", private_temp)
            .env("TMP", private_temp)
            .env("TEMP", private_temp)
            .env("HOME", private_temp)
            .env("XDG_CACHE_HOME", private_temp)
            .env("XDG_CONFIG_HOME", private_temp);
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                initialize_sandbox(&profile).map_err(io::Error::other)
            });
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("start command: {error}"))?;
        wait_for_child(&mut child, &args.cancel_file)
    }

    fn profile(args: &Args, private_temp: &Path) -> Result<String> {
        let private_temp = sbpl_path(private_temp)?;
        let mut rules = vec![
            "(version 1)".to_string(),
            "(deny default)".to_string(),
            "(allow file-read*)".to_string(),
            "(allow process-exec)".to_string(),
            "(allow process-fork)".to_string(),
            "(allow process-signal)".to_string(),
            "(allow network*)".to_string(),
            "(allow sysctl-read)".to_string(),
            format!("(allow file-write* (subpath \"{private_temp}\"))"),
        ];
        if args.mode == Mode::WorkspaceWrite {
            rules.push(format!(
                "(allow file-write* (subpath \"{}\"))",
                sbpl_path(args.workspace.as_ref().ok_or("workspace missing")?)?
            ));
        }
        Ok(rules.join("\n"))
    }

    fn sbpl_path(path: &Path) -> Result<String> {
        let path = path
            .to_str()
            .ok_or_else(|| format!("path is not valid UTF-8: {}", path.display()))?;
        Ok(path.replace('\\', "\\\\").replace('"', "\\\""))
    }

    fn initialize_sandbox(profile: &CString) -> Result<()> {
        let mut error = std::ptr::null_mut();
        let result = unsafe { sandbox_init(profile.as_ptr(), 0, &mut error) };
        if result == 0 {
            return Ok(());
        }
        let message = if error.is_null() {
            format!("sandbox_init failed with status {result}")
        } else {
            let message = unsafe { CStr::from_ptr(error).to_string_lossy().into_owned() };
            unsafe { sandbox_free_error(error) };
            format!("sandbox_init failed: {message}")
        };
        Err(message)
    }

    fn wait_for_child(child: &mut std::process::Child, cancel_file: &Path) -> Result<i32> {
        loop {
            if cancel_file.exists() {
                unsafe { libc::killpg(child.id() as libc::pid_t, libc::SIGKILL) };
            }
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("wait for command: {error}"))?
            {
                return exit_code(status);
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    fn exit_code(status: ExitStatus) -> Result<i32> {
        if let Some(code) = status.code() {
            return Ok(code);
        }
        Ok(1)
    }
}

#[cfg(target_os = "macos")]
fn main() {
    match macos_main::run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("moke-sandbox: {error}");
            std::process::exit(127);
        }
    }
}
