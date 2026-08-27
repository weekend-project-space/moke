# @moke/shell

Standalone shell execution contracts and process management.

The package defines three filesystem authority modes:

- `read-only`: a sandbox runner must enforce no persistent writes.
- `workspace-write`: a sandbox runner must restrict writes to `workspaceRoot` and its private temporary area.
- `danger-full-access`: executes with the host user's authority.

`ShellExecutor` fails closed with `SANDBOX_UNAVAILABLE` when no runner explicitly supports a confined mode. The bundled `LocalShellRunner` therefore supports only `danger-full-access`.

On Windows, `WindowsSandboxRunner` uses the native helper under `native/windows-sandbox`. Build it with `npm run build:native:windows --workspace @moke/shell`. The runner resolves an explicit constructor path first, then `MOKE_WINDOWS_SANDBOX_HELPER`, a packaged sibling `resources/shell` directory, and finally the development release path. It verifies the helper version before the first command.

The helper uses a write-restricted access token, temporary ACL capabilities, and a kill-on-close Job Object. The mechanism restricts writes but does not restrict reads, network access, or process visibility, so results report `enforcement: 'partial'` and `runner: 'windows-acl'`.

On macOS, `MacSandboxRunner` uses the native `native/macos-sandbox` helper. Build it with `npm run build:native:macos --workspace @moke/shell`. It loads a Seatbelt profile through `libsandbox` in the child process, grants writes only to the private temporary directory and, for `workspace-write`, the canonical workspace directory. The helper is found through an explicit constructor path, `MOKE_MACOS_SANDBOX_HELPER`, the packaged sibling directory, or the development release path. Its `macos-seatbelt` result also reports `enforcement: 'partial'`: reads, network access, and process execution are deliberately available to support shell commands.

Tests live in `tests/` and production sources live in `src/`.
