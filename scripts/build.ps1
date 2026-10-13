<#
.SYNOPSIS
    Builds the desktop-cat installers on Windows.

.DESCRIPTION
    A thin wrapper so the build can be run straight from a PowerShell prompt without
    going through npm. Every argument is passed through untouched.

.EXAMPLE
    .\scripts\build.ps1
    .\scripts\build.ps1 --win --arch x64 --arch arm64
    .\scripts\build.ps1 --help
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'node is not on PATH. Install Node.js 20 or newer.'
    exit 1
}

# rustup installs into the user profile; a terminal opened before it ran will not
# have it on PATH yet, so look there before giving up.
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (-not (Get-Command cargo -ErrorAction SilentlyContinue) -and (Test-Path $cargoBin)) {
    $env:Path = "$env:Path;$cargoBin"
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Error 'cargo is not on PATH. Install Rust from https://rustup.rs.'
    exit 1
}

if (-not (Test-Path (Join-Path $root 'node_modules/@tauri-apps/cli'))) {
    Write-Host 'installing dependencies...'
    & npm --prefix $root ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& node (Join-Path $PSScriptRoot 'build-installers.mjs') @args
exit $LASTEXITCODE
