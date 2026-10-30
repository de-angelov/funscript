param(
  [ValidateSet('status','install','update','uninstall')][string]$Action = 'status',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Output 'Node.js 20+ and npm are required. Install Node.js from https://nodejs.org/ and retry (manual path).'
  if ($Action -ne 'status') { exit 1 }
  exit 0
}
$NodeVersion = (& node --version).Trim()
$NpmVersion = (& npm --version).Trim()
$Linked = (& npm ls -g --depth=0 funscript 2>$null | Out-String) -match 'funscript@'
Write-Output "Node.js: $NodeVersion (supported baseline: 20+)"
Write-Output "npm: $NpmVersion"
Write-Output "FunScript CLI: $(if ($Linked) { 'linked' } else { 'not linked' })"
Write-Output "VS Code CLI: $(if (Get-Command code -ErrorAction SilentlyContinue) { 'available (extension setup is manual; see docs/toolchain.md)' } else { 'missing' })"
if ($Action -eq 'status') { exit 0 }
switch ($Action) {
  { $_ -in 'install','update' } { $Command = "Set-Location '$Root'; npm link"; break }
  'uninstall' { $Command = 'npm unlink -g funscript'; break }
}
Write-Output "Action: $Action FunScript CLI"
Write-Output "Command: $Command"
if ($DryRun) { exit 0 }
if ([Console]::IsInputRedirected) { throw 'Interactive confirmation required; run in a terminal (or use -DryRun).' }
$Answer = Read-Host 'Proceed with this command? [y/N]'
if ($Answer -notin @('y','Y','yes','YES')) { Write-Output 'Cancelled.'; exit 0 }
if ($Action -in 'install','update') { Push-Location $Root; try { & npm link } finally { Pop-Location } }
else { & npm unlink -g funscript }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
