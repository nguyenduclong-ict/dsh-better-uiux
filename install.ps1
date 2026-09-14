# dsh-better-uiux ' installer for DSH Desktop / DSH CLI on Windows.
#
# What it does:
#   1. `pnpm add <this package>` inside the target profile directory.
#   2. Adds the package name to `dsh.profile.bundles` in that profile's package.json.
#
# Usage:
#   pwsh -File .\install.ps1                                  # auto-detect, web profile
#   pwsh -File .\install.ps1 -ProfileDir "C:\path\to\profile"
#   pwsh -File .\install.ps1 -Link                            # link instead of copy (dev)
#   pwsh -File .\install.ps1 -Remove                          # uninstall
#
# NOTE: the browser half is 'client.js', which is GENERATED. Run 'node build.mjs'
# before installing if you changed 'core.js' or 'live-terminal.js'.

[CmdletBinding()]
param(
  [string]$ProfileDir,
  [string]$PackageName = 'dsh-better-uiux',
  [switch]$Remove,
  [switch]$Link
)

$ErrorActionPreference = 'Stop'
$packageDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-DefaultProfileDir {
  $candidates = @(
    (Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web'),
    (Join-Path $HOME '.config\dsh-desktop\harness\profiles\web'),
    (Join-Path $HOME 'Library/Application Support/dsh-desktop/harness/profiles/web')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path (Join-Path $candidate 'package.json'))) { return $candidate }
  }
  return $null
}

function Find-Pnpm {
  $candidates = @(
    (Join-Path $env:APPDATA 'dsh-desktop\harness\.desktop-bin\pnpm.cmd'),
    'pnpm.cmd',
    'pnpm'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }
  return $null
}

if (-not $ProfileDir) { $ProfileDir = Find-DefaultProfileDir }
if (-not $ProfileDir) { throw 'Could not locate a DSH profile directory. Pass -ProfileDir explicitly.' }

$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $manifestPath)) { throw "No package.json found at $manifestPath" }

$clientBundle = Join-Path $packageDir 'client.js'
if (-not (Test-Path $clientBundle)) {
  throw "client.js is missing: run 'node build.mjs' in $packageDir first."
}

Write-Host "[better-uiux] profile : $ProfileDir"
Write-Host "[better-uiux] package : $packageDir"

# --- install / remove the package itself ------------------------------------
if ($Link) {
  # Dev mode: a directory junction, so edits in the checkout are picked up live
  # without re-running pnpm. The profile's package.json entry is still written.
  $linkPath = Join-Path $ProfileDir "node_modules\$PackageName"
  if ($Remove) {
    if (Test-Path $linkPath) { (Get-Item $linkPath).Delete(); Write-Host "[better-uiux] removed junction $linkPath" }
  } else {
    if (Test-Path $linkPath) {
      Write-Host "[better-uiux] junction already present: $linkPath"
    } else {
      New-Item -ItemType Junction -Path $linkPath -Target $packageDir | Out-Null
      Write-Host "[better-uiux] linked $linkPath -> $packageDir"
    }
  }
} else {
  $pnpm = Find-Pnpm
  if (-not $pnpm) { throw 'pnpm not found. Install it, pass -Link for a junction, or pass the DSH Desktop .desktop-bin\pnpm.cmd path on your PATH.' }

  Push-Location $ProfileDir
  try {
    if ($Remove) {
      Write-Host "[better-uiux] removing dependency..."
      & $pnpm remove $PackageName
    } else {
      Write-Host "[better-uiux] installing dependency..."
      & $pnpm add $packageDir
    }
    if ($LASTEXITCODE -ne 0) { throw "pnpm exited with code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

# --- register / unregister the bundle entry ---------------------------------
$raw = Get-Content -Path $manifestPath -Raw
$manifest = $raw | ConvertFrom-Json

if (-not $manifest.dsh) { $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if (-not $manifest.dsh.profile) { $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
if (-not $manifest.dsh.profile.bundles) { $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }

$bundles = @($manifest.dsh.profile.bundles)
if ($Remove) {
  $bundles = @($bundles | Where-Object { $_ -ne $PackageName })
  Write-Host "[better-uiux] removed '$PackageName' from dsh.profile.bundles"
} elseif ($bundles -contains $PackageName) {
  Write-Host "[better-uiux] '$PackageName' already present in dsh.profile.bundles"
} else {
  $bundles = @($PackageName) + $bundles
  Write-Host "[better-uiux] added '$PackageName' to dsh.profile.bundles"
}

$manifest.dsh.profile.bundles = $bundles

Copy-Item -Path $manifestPath -Destination "$manifestPath.bak" -Force
$manifest | ConvertTo-Json -Depth 12 | Set-Content -Path $manifestPath -Encoding UTF8

Write-Host "[better-uiux] backup written to $manifestPath.bak"
Write-Host '[better-uiux] done ' restart DSH Desktop, then open Settings ' Better UIUX and switch features on.'
