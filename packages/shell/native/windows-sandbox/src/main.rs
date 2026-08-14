#[cfg(not(windows))]
fn main() {
    eprintln!("moke-sandbox: the Windows sandbox helper only runs on Windows");
    std::process::exit(127);
}

#[cfg(windows)]
mod windows_main {
    use sha2::{Digest, Sha256};
    use std::ffi::c_void;
    use std::fs;
    use std::mem::{size_of, zeroed};
    use std::path::{Path, PathBuf};
    use std::ptr::null_mut;
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, LocalFree, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, HLOCAL,
        WAIT_ABANDONED_0, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::Security::Authorization::{
        ConvertStringSidToSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
        EXPLICIT_ACCESS_W, GRANT_ACCESS, REVOKE_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
        TRUSTEE_IS_UNKNOWN,
    };
    use windows::Win32::Security::{
        CreateRestrictedToken, CreateWellKnownSid, GetTokenInformation, TokenGroups, WinWorldSid,
        ACL, CREATE_RESTRICTED_TOKEN_FLAGS, DACL_SECURITY_INFORMATION, DISABLE_MAX_PRIVILEGE,
        LUA_TOKEN, PSECURITY_DESCRIPTOR, PSID, SID_AND_ATTRIBUTES,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY,
        TOKEN_DUPLICATE, TOKEN_GROUPS, TOKEN_QUERY, WRITE_RESTRICTED,
    };
    use windows::Win32::Storage::FileSystem::{DELETE, FILE_GENERIC_WRITE};
    use windows::Win32::System::Console::{
        GetStdHandle, SetConsoleCP, SetConsoleOutputCP, STD_ERROR_HANDLE, STD_INPUT_HANDLE,
        STD_OUTPUT_HANDLE,
    };
    use windows::Win32::System::Diagnostics::Debug::{
        SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::SystemServices::SE_GROUP_LOGON_ID;
    use windows::Win32::System::Threading::{
        CreateMutexW, CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess,
        OpenProcessToken, ReleaseMutex, ResumeThread, WaitForSingleObject, CREATE_SUSPENDED,
        INFINITE, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
    };

    type Result<T> = std::result::Result<T, String>;

    const SANDBOX_ERROR_MODE: u32 = SEM_FAILCRITICALERRORS.0 | SEM_NOGPFAULTERRORBOX.0;
    const SANDBOX_JOB_LIMITS: u32 =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0 | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION.0;
    const PROCESS_DEFAULT_HARD_ERROR_MODE: i32 = 12;

    #[link(name = "ntdll")]
    unsafe extern "system" {
        #[link_name = "NtSetInformationProcess"]
        fn nt_set_information_process(
            process: HANDLE,
            information_class: i32,
            information: *const c_void,
            information_length: u32,
        ) -> i32;
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

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    struct LocalSid(PSID);
    impl Drop for LocalSid {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = LocalFree(Some(HLOCAL(self.0 .0)));
                }
            }
        }
    }

    struct Grant {
        path: PathBuf,
        sid: PSID,
    }

    struct MutexGuard(Handle);
    impl Drop for MutexGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = ReleaseMutex(self.0 .0);
            }
        }
    }

    pub fn run() -> Result<i32> {
        suppress_system_error_dialogs();
        configure_utf8_console();
        let args = parse_args()?;
        let mut temp_dir = None;
        let mut write_sids = Vec::new();
        let workspace_sid = if args.mode == Mode::WorkspaceWrite {
            let workspace = args
                .workspace
                .as_ref()
                .ok_or("workspace-write requires --workspace")?;
            let private_temp = create_private_temp()?;
            let workspace_sid = LocalSid(parse_sid(&capability_sid("workspace", workspace))?);
            let temp_sid = LocalSid(parse_sid(&capability_sid("temp", &private_temp))?);
            if let Err(error) = grant_write(workspace, workspace_sid.0) {
                let _ = fs::remove_dir_all(&private_temp);
                return Err(error);
            }
            if let Err(error) = grant_write(&private_temp, temp_sid.0) {
                let _ = fs::remove_dir_all(&private_temp);
                return Err(error);
            }
            std::env::set_var("TMP", &private_temp);
            std::env::set_var("TEMP", &private_temp);
            write_sids.push(workspace_sid.0);
            write_sids.push(temp_sid.0);
            temp_dir = Some((
                private_temp.clone(),
                Grant {
                    path: private_temp,
                    sid: temp_sid.0,
                },
                temp_sid,
            ));
            Some(workspace_sid)
        } else {
            None
        };

        let execution = execute_restricted(&args, &write_sids);
        let mut cleanup_errors = Vec::new();
        if let Some((path, temp_grant, _temp_sid)) = temp_dir {
            if let Err(error) = revoke_write(&temp_grant.path, temp_grant.sid) {
                cleanup_errors.push(error);
            }
            if let Err(error) = fs::remove_dir_all(path) {
                cleanup_errors.push(format!("remove private temp: {error}"));
            }
        }
        drop(workspace_sid);
        if !cleanup_errors.is_empty() {
            return Err(format!("cleanup failed: {}", cleanup_errors.join("; ")));
        }
        execution
    }

    fn suppress_system_error_dialogs() {
        unsafe {
            SetErrorMode(
                windows::Win32::System::Diagnostics::Debug::THREAD_ERROR_MODE(SANDBOX_ERROR_MODE),
            );
        }
    }

    fn configure_utf8_console() {
        unsafe {
            let _ = SetConsoleCP(65001);
            let _ = SetConsoleOutputCP(65001);
        }
    }

    fn suppress_child_error_dialogs(process: HANDLE) -> Result<()> {
        let mode = SANDBOX_ERROR_MODE;
        let status = unsafe {
            nt_set_information_process(
                process,
                PROCESS_DEFAULT_HARD_ERROR_MODE,
                &mode as *const u32 as *const c_void,
                size_of::<u32>() as u32,
            )
        };
        if status < 0 {
            return Err(format!(
                "NtSetInformationProcess(ProcessDefaultHardErrorMode): NTSTATUS 0x{:08X}",
                status as u32
            ));
        }
        Ok(())
    }

    fn parse_args() -> Result<Args> {
        let values: Vec<String> = std::env::args().skip(1).collect();
        if values.as_slice() == ["--version"] {
            println!("moke-windows-sandbox {}", env!("CARGO_PKG_VERSION"));
            std::process::exit(0);
        }
        let split = values
            .iter()
            .position(|value| value == "--")
            .ok_or("missing -- before command")?;
        let mut mode = None;
        let mut workspace = None;
        let mut cwd = None;
        let mut cancel_file = None;
        let mut index = 0;
        while index < split {
            let flag = &values[index];
            let value = values
                .get(index + 1)
                .ok_or_else(|| format!("missing value for {flag}"))?;
            match flag.as_str() {
                "--mode" => {
                    mode = Some(match value.as_str() {
                        "read-only" => Mode::ReadOnly,
                        "workspace-write" => Mode::WorkspaceWrite,
                        _ => return Err(format!("unsupported mode: {value}")),
                    })
                }
                "--workspace" => workspace = Some(canonical_directory(value)?),
                "--cwd" => cwd = Some(canonical_directory(value)?),
                "--cancel-file" => cancel_file = Some(PathBuf::from(value)),
                _ => return Err(format!("unknown argument: {flag}")),
            }
            index += 2;
        }
        let command = values[(split + 1)..].to_vec();
        if command.is_empty() {
            return Err("missing command".into());
        }
        let cwd = cwd.ok_or("missing --cwd")?;
        let cancel_file = cancel_file.ok_or("missing --cancel-file")?;
        if !cancel_file.is_absolute() {
            return Err("cancel file must be an absolute path".into());
        }
        if mode == Some(Mode::WorkspaceWrite) {
            let root = workspace
                .as_ref()
                .ok_or("workspace-write requires --workspace")?;
            if !cwd.starts_with(root) {
                return Err("cwd must be inside workspace".into());
            }
        }
        Ok(Args {
            mode: mode.ok_or("missing --mode")?,
            workspace,
            cwd,
            cancel_file,
            command,
        })
    }

    fn canonical_directory(value: &str) -> Result<PathBuf> {
        let path =
            fs::canonicalize(value).map_err(|error| format!("canonicalize {value}: {error}"))?;
        if !path.is_dir() {
            return Err(format!("not a directory: {}", path.display()));
        }
        Ok(path)
    }

    fn create_private_temp() -> Result<PathBuf> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("moke-sandbox-{}-{nonce}", std::process::id()));
        fs::create_dir(&path)
            .map_err(|error| format!("create private temp {}: {error}", path.display()))?;
        Ok(path)
    }

    fn capability_sid(namespace: &str, path: &Path) -> String {
        let mut hash = Sha256::new();
        hash.update(namespace.as_bytes());
        hash.update([0]);
        hash.update(path.to_string_lossy().to_lowercase().as_bytes());
        let bytes = hash.finalize();
        let values: Vec<u32> = bytes
            .chunks_exact(4)
            .take(4)
            .map(|part| u32::from_le_bytes(part.try_into().unwrap()))
            .collect();
        format!(
            "S-1-4-{}-{}-{}-{}",
            values[0], values[1], values[2], values[3]
        )
    }

    fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        value.as_ref().encode_wide().chain(Some(0)).collect()
    }

    fn parse_sid(value: &str) -> Result<PSID> {
        let value = wide(value);
        let mut sid = PSID::default();
        unsafe { ConvertStringSidToSidW(PCWSTR(value.as_ptr()), &mut sid) }
            .map_err(|error| format!("ConvertStringSidToSidW: {error}"))?;
        Ok(sid)
    }

    fn grant_write(path: &Path, sid: PSID) -> Result<()> {
        update_acl(path, sid, GRANT_ACCESS, FILE_GENERIC_WRITE.0 | DELETE.0)
    }

    fn revoke_write(path: &Path, sid: PSID) -> Result<()> {
        update_acl(path, sid, REVOKE_ACCESS, 0)
    }

    fn update_acl(
        path: &Path,
        sid: PSID,
        mode: windows::Win32::Security::Authorization::ACCESS_MODE,
        permissions: u32,
    ) -> Result<()> {
        let _guard = acquire_acl_mutex(path)?;
        let path_wide = wide(path.as_os_str());
        let mut old_acl: *mut ACL = null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let get_result = unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(path_wide.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut old_acl),
                None,
                &mut descriptor,
            )
        };
        if !get_result.is_ok() {
            return Err(format!(
                "GetNamedSecurityInfoW({}): {}",
                path.display(),
                get_result.0
            ));
        }

        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: permissions,
            grfAccessMode: mode,
            grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            Trustee: windows::Win32::Security::Authorization::TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: Default::default(),
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: PWSTR(sid.0 as *mut u16),
            },
        };
        let mut new_acl: *mut ACL = null_mut();
        let merge_result = unsafe { SetEntriesInAclW(Some(&[entry]), Some(old_acl), &mut new_acl) };
        if !descriptor.0.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            }
        }
        if !merge_result.is_ok() {
            return Err(format!(
                "SetEntriesInAclW({}): {}",
                path.display(),
                merge_result.0
            ));
        }
        let apply_result = unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(path_wide.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(new_acl),
                None,
            )
        };
        if !new_acl.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(new_acl as *mut c_void)));
            }
        }
        if !apply_result.is_ok() {
            return Err(format!(
                "SetNamedSecurityInfoW({}): {}",
                path.display(),
                apply_result.0
            ));
        }
        Ok(())
    }

    fn acquire_acl_mutex(path: &Path) -> Result<MutexGuard> {
        let mut hash = Sha256::new();
        hash.update(path.to_string_lossy().to_lowercase().as_bytes());
        let digest = hash.finalize();
        let suffix = digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = wide(format!("Local\\MokeShellAcl-{suffix}"));
        let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
            .map_err(|error| format!("CreateMutexW({}): {error}", path.display()))?;
        let guard = MutexGuard(Handle(handle));
        let wait = unsafe { WaitForSingleObject(guard.0 .0, INFINITE) };
        if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED_0 {
            return Err(format!(
                "WaitForSingleObject(ACL mutex for {}) failed: {}",
                path.display(),
                wait.0
            ));
        }
        Ok(guard)
    }

    fn execute_restricted(args: &Args, write_sids: &[PSID]) -> Result<i32> {
        unsafe {
            let mut current_token = HANDLE::default();
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY,
                &mut current_token,
            )
            .map_err(|error| format!("OpenProcessToken: {error}"))?;
            let current_token = Handle(current_token);
            let groups = token_groups(current_token.0)?;
            let logon_sid = find_logon_sid(&groups)?;
            let mut world_storage = vec![0u8; 68];
            let mut world_size = world_storage.len() as u32;
            let world_sid = PSID(world_storage.as_mut_ptr() as *mut c_void);
            CreateWellKnownSid(WinWorldSid, None, Some(world_sid), &mut world_size)
                .map_err(|error| format!("CreateWellKnownSid: {error}"))?;
            let mut restrictions = vec![
                SID_AND_ATTRIBUTES {
                    Sid: logon_sid,
                    Attributes: 0,
                },
                SID_AND_ATTRIBUTES {
                    Sid: world_sid,
                    Attributes: 0,
                },
            ];
            restrictions.extend(write_sids.iter().map(|sid| SID_AND_ATTRIBUTES {
                Sid: *sid,
                Attributes: 0,
            }));
            let mut restricted_token = HANDLE::default();
            CreateRestrictedToken(
                current_token.0,
                CREATE_RESTRICTED_TOKEN_FLAGS(
                    DISABLE_MAX_PRIVILEGE.0 | LUA_TOKEN.0 | WRITE_RESTRICTED.0,
                ),
                None,
                None,
                Some(&restrictions),
                &mut restricted_token,
            )
            .map_err(|error| format!("CreateRestrictedToken: {error}"))?;
            let restricted_token = Handle(restricted_token);

            let stdin = GetStdHandle(STD_INPUT_HANDLE)
                .map_err(|error| format!("GetStdHandle(stdin): {error}"))?;
            let stdout = GetStdHandle(STD_OUTPUT_HANDLE)
                .map_err(|error| format!("GetStdHandle(stdout): {error}"))?;
            let stderr = GetStdHandle(STD_ERROR_HANDLE)
                .map_err(|error| format!("GetStdHandle(stderr): {error}"))?;
            for handle in [stdin, stdout, stderr] {
                if !handle.is_invalid() {
                    SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT)
                        .map_err(|error| format!("SetHandleInformation: {error}"))?;
                }
            }

            let mut startup: STARTUPINFOW = zeroed();
            startup.cb = size_of::<STARTUPINFOW>() as u32;
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = stdin;
            startup.hStdOutput = stdout;
            startup.hStdError = stderr;
            let mut process_info: PROCESS_INFORMATION = zeroed();
            let mut command_line = wide(build_command_line(&args.command));
            let cwd = wide(args.cwd.as_os_str());
            CreateProcessAsUserW(
                Some(restricted_token.0),
                None,
                Some(PWSTR(command_line.as_mut_ptr())),
                None,
                None,
                true,
                CREATE_SUSPENDED,
                None,
                PCWSTR(cwd.as_ptr()),
                &startup,
                &mut process_info,
            )
            .map_err(|error| format!("CreateProcessAsUserW: {error}"))?;
            let process = Handle(process_info.hProcess);
            let thread = Handle(process_info.hThread);

            let job = Handle(
                CreateJobObjectW(None, None)
                    .map_err(|error| format!("CreateJobObjectW: {error}"))?,
            );
            let mut job_info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            job_info.BasicLimitInformation.LimitFlags =
                windows::Win32::System::JobObjects::JOB_OBJECT_LIMIT(SANDBOX_JOB_LIMITS);
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &job_info as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|error| format!("SetInformationJobObject: {error}"))?;
            AssignProcessToJobObject(job.0, process.0)
                .map_err(|error| format!("AssignProcessToJobObject: {error}"))?;
            suppress_child_error_dialogs(process.0)?;
            if ResumeThread(thread.0) == u32::MAX {
                return Err("ResumeThread failed".into());
            }
            let mut terminated = false;
            loop {
                let wait = WaitForSingleObject(process.0, 25);
                if wait == WAIT_OBJECT_0 {
                    break;
                }
                if wait != WAIT_TIMEOUT {
                    return Err("WaitForSingleObject failed".into());
                }
                if !terminated && args.cancel_file.exists() {
                    TerminateJobObject(job.0, 1)
                        .map_err(|error| format!("TerminateJobObject: {error}"))?;
                    terminated = true;
                }
            }
            let mut exit_code = 0;
            GetExitCodeProcess(process.0, &mut exit_code)
                .map_err(|error| format!("GetExitCodeProcess: {error}"))?;
            Ok(exit_code as i32)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn sandbox_suppresses_system_error_dialogs() {
            assert_ne!(SANDBOX_ERROR_MODE & SEM_FAILCRITICALERRORS.0, 0);
            assert_ne!(SANDBOX_ERROR_MODE & SEM_NOGPFAULTERRORBOX.0, 0);
            assert_eq!(PROCESS_DEFAULT_HARD_ERROR_MODE, 12);
            assert_ne!(
                SANDBOX_JOB_LIMITS & JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION.0,
                0
            );
            assert_ne!(SANDBOX_JOB_LIMITS & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0, 0);
        }
    }

    fn token_groups(token: HANDLE) -> Result<Vec<u8>> {
        unsafe {
            let mut size = 0;
            let _ = GetTokenInformation(token, TokenGroups, None, 0, &mut size);
            if size == 0 {
                return Err("GetTokenInformation(TokenGroups) returned no size".into());
            }
            let mut buffer = vec![0u8; size as usize];
            GetTokenInformation(
                token,
                TokenGroups,
                Some(buffer.as_mut_ptr() as *mut c_void),
                size,
                &mut size,
            )
            .map_err(|error| format!("GetTokenInformation(TokenGroups): {error}"))?;
            Ok(buffer)
        }
    }

    fn find_logon_sid(groups: &[u8]) -> Result<PSID> {
        let groups = unsafe { &*(groups.as_ptr() as *const TOKEN_GROUPS) };
        let first = groups.Groups.as_ptr();
        for index in 0..groups.GroupCount as usize {
            let group = unsafe { &*first.add(index) };
            if group.Attributes & SE_GROUP_LOGON_ID as u32 == SE_GROUP_LOGON_ID as u32 {
                return Ok(group.Sid);
            }
        }
        Err("current token has no logon SID".into())
    }

    fn build_command_line(parts: &[String]) -> String {
        parts
            .iter()
            .map(|part| quote_windows_arg(part))
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn quote_windows_arg(value: &str) -> String {
        if !value.is_empty() && !value.chars().any(|ch| ch.is_whitespace() || ch == '"') {
            return value.into();
        }
        let mut result = String::from("\"");
        let mut slashes = 0;
        for ch in value.chars() {
            if ch == '\\' {
                slashes += 1;
                continue;
            }
            if ch == '"' {
                result.push_str(&"\\".repeat(slashes * 2 + 1));
                result.push('"');
            } else {
                result.push_str(&"\\".repeat(slashes));
                result.push(ch);
            }
            slashes = 0;
        }
        result.push_str(&"\\".repeat(slashes * 2));
        result.push('"');
        result
    }
}

#[cfg(windows)]
fn main() {
    match windows_main::run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("moke-sandbox: {error}");
            std::process::exit(127);
        }
    }
}
