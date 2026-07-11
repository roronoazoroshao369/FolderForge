# Compatibility

FolderForge 2.0 requires Node.js 22 or newer. The release-candidate compatibility
contract covers the two supported LTS lines used by the project and the three
major GitHub-hosted desktop/server operating-system families.

## Tested matrix

| Operating system | Node 22 | Node 24 |
| --- | --- | --- |
| Ubuntu latest | Required | Required |
| macOS latest | Required | Required |
| Windows latest | Required | Required |

Every matrix entry installs with lifecycle scripts disabled and runs:

1. Typecheck and lint.
2. Unit and integration tests.
3. Production build.
4. Packed-tarball install and CLI/doctor/browser-setup smoke.
5. Authenticated HTTP MCP smoke.

Dependency audits run once on Ubuntu with Node 22 to avoid duplicating the same
registry query across all six jobs.

## Shell behavior

FolderForge executes configured shell commands with platform-specific arguments:

- `cmd.exe`: `/d /s /c <command>`
- PowerShell / `pwsh`: `-NoLogo -NoProfile -NonInteractive -Command <command>`
- POSIX shells and Git Bash: `-lc <command>`

The same invocation helper is used by `shell_exec`, managed processes, build
commands, and `project_verify`. Godot process commands quote literal paths for the
selected shell, including Windows paths containing spaces.

## Package scripts

The build and clean lifecycle scripts are platform-neutral Node scripts. Windows
never runs POSIX `chmod` or `rm -rf`; npm creates the normal `.cmd` shim for the
`folderforge` binary.

## Browser installation

Normal installation does not download Chromium. Browser setup remains explicit:

```bash
folderforge setup browser
```

`--with-deps` is intended for supported Linux environments where Playwright also
needs operating-system packages. Browser tools on macOS and Windows only require
the normal explicit browser setup command.
