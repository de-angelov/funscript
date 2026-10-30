# Optional developer toolchain helper

After cloning the repository, run `sh scripts/toolchain.sh status` on macOS/Linux or
`./scripts/toolchain.ps1 status` in PowerShell on Windows. The helper supports Node.js
20+ and npm. It links this checkout's `funscript` executable globally for the current
npm prefix; the project has no published CLI release channel yet. It does not install
Node.js or npm. Install Node.js 20+ from [nodejs.org](https://nodejs.org/) first.

Use `install`, `update`, or `uninstall` as the subcommand. Each displays the affected
tool and command, then asks for an interactive confirmation. `--dry-run` (PowerShell:
`-DryRun`) prints the proposed command without executing it. `status` is read-only.
Only the FunScript npm link is removed by `uninstall`; Node, npm, editors, and their
configuration are never changed.

The helper supports POSIX shells on macOS/Linux and PowerShell on Windows, provided
`node` and `npm` are on PATH. Other package managers and unsupported environments
should use the manual route: install Node.js 20+, run `npm install` in this checkout,
then `npm link`. To repair a link, run `npm unlink -g funscript` and `npm link` from
the checkout. To roll back, run `npm unlink -g funscript`.

VS Code is detected when its `code` command is available. The extension is not
published as a VSIX or marketplace package yet, so extension installation is manual
and is not part of the helper. Corepack and other recommended tools are optional and
are not modified.

Inspect the complete helper before running it: `sed -n '1,240p' scripts/toolchain.sh`
or `Get-Content scripts/toolchain.ps1`. All commands are repository-owned; nothing is
downloaded or executed remotely.
