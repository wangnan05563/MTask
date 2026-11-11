# MTask one-click publish orchestrator (UTF-8 BOM required for PowerShell 5.1).
# Invoked by 一键发布.bat. All build/publish logic lives here so the .bat stays pure ASCII.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$RepoRoot = [System.IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))

# T02696: resolve both managed runtimes by availability, never by a hard-coded version directory.
# Same root cause as T02616: those directories move (node: 22.22.2-3 is gone, only 22.22.2-6 and the
# 'current' pointer remain; python likewise), a stale literal then makes Test-Path quietly false,
# the PATH override never happens, and this entry publishes on whatever interpreter is already on
# PATH while the comment still promises an ABI match. The helpers print the chosen path or nothing;
# this script owns the user-facing warning - and always prints which interpreter it used, so a
# published artifact stays traceable to the interpreter that produced it.
if (-not $env:MTASK_MG_NODE_ROOT) {
  $env:MTASK_MG_NODE_ROOT = [System.Environment]::ExpandEnvironmentVariables('%USERPROFILE%\.workbuddy\binaries\node\versions')
}
$MGNode = @(powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'lib\resolve-managed-node.ps1') |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) }) | Select-Object -Last 1
if ($MGNode) {
  $env:PATH = "$MGNode;" + $env:PATH
  Write-Host "  node:   $MGNode (managed)"
} else {
  Write-Host "  [WARN] no usable managed node under $env:MTASK_MG_NODE_ROOT"
  Write-Host '  [WARN] this publish runs on the node already on PATH - native module ABI is not guaranteed'
  Write-Host "  node:   $((Get-Command node -ErrorAction SilentlyContinue).Source)"
}

if (-not $env:MTASK_MG_PYTHON_ROOT) {
  $env:MTASK_MG_PYTHON_ROOT = [System.Environment]::ExpandEnvironmentVariables('%USERPROFILE%\.workbuddy\binaries\python\versions')
}
$PY = @(powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'lib\resolve-managed-python.ps1') |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) }) | Select-Object -Last 1
if ($PY) {
  Write-Host "  python: $PY (managed)"
} else {
  Write-Host "  [WARN] no usable managed python under $env:MTASK_MG_PYTHON_ROOT"
  $p = Get-Command python -ErrorAction SilentlyContinue
  if ($p) { $PY = $p.Source } else { $PY = 'python' }
  Write-Host "  [WARN] this publish runs on python from PATH: $PY"
}

$BuildScript = Join-Path $RepoRoot 'scripts\构建打包.bat'
$AssetGlob   = 'MTask Setup *.exe'
$AssetPrefix = 'MTask Setup '
$Publisher   = Join-Path $RepoRoot 'scripts\publish-release.py'
$NotesGen    = Join-Path $RepoRoot 'scripts\gen-release-notes.py'
$PackSkill   = Join-Path $RepoRoot 'scripts\pack-skill.py'
$ReleaseDir  = Join-Path $RepoRoot 'release'

Write-Host '============================================'
Write-Host ' MTask One-Click Publish'
Write-Host '============================================'

# [1] Build and package the installer (skip with SKIP_BUILD=1 to re-publish).
if ($env:SKIP_BUILD) {
  Write-Host "[1] SKIP_BUILD set - reusing existing artifact in $ReleaseDir"
} else {
  Write-Host '[1] Build and package installer...'
  # echo. feeds the build script's trailing `pause` so the flow stays one-click.
  $batArg = "/c echo. | call `"$BuildScript`""
  $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList $batArg -NoNewWindow -Wait -PassThru
  if ($proc.ExitCode -ne 0) {
    Write-Host '[ERROR] build/packaging failed'
    exit 1
  }
}

# [2] Locate the freshly built setup exe (newest by write time).
# The build entry falls forward to release2..9 whenever release\win-unpacked cannot be
# deleted (antivirus / Explorer holds app.asar). Looking only in `release` then silently
# publishes the PREVIOUS installer with the wrong tag. Search every release* dir instead.
Write-Host '[2] Locate installer artifact...'
$asset = $null
Get-ChildItem -Path $RepoRoot -Directory -Filter 'release*' -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ChildItem -Path $_.FullName -Filter $AssetGlob -File -ErrorAction SilentlyContinue } |
  Sort-Object LastWriteTime -Descending |
  ForEach-Object { if (-not $asset) { $asset = $_.FullName } }
if (-not $asset) {
  Write-Host "[ERROR] no '$AssetGlob' found under any release* dir in $RepoRoot"
  Write-Host '  Run without SKIP_BUILD=1 first, or place the artifact there.'
  exit 1
}
Write-Host "  found: $asset"

# [3] Derive version from the filename (strip prefix and .exe suffix).
$APPVER = ([System.IO.Path]::GetFileName($asset)) `
  -replace [regex]::Escape($AssetPrefix), '' `
  -replace '\.exe$', ''
if (-not $APPVER) {
  Write-Host "[ERROR] could not derive version from filename: $asset"
  exit 1
}
Write-Host "  version: $APPVER"

# A stale artifact must never be published as a new version: after a real build the
# installer filename must carry exactly the version bump-version.js left in package.json.
# Read as UTF-8 and extract with a regex, NOT ConvertFrom-Json: PS 5.1 Get-Content defaults
# to the ANSI codepage, which turns the Chinese description into invalid JSON and throws.
if (-not $env:SKIP_BUILD) {
  $pkgRaw = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'package.json') -Encoding UTF8
  $expected = $null
  if ($pkgRaw -match '"version"\s*:\s*"([^"]+)"') { $expected = $Matches[1] }
  if (-not $expected) {
    Write-Host '[ERROR] cannot read version from package.json - refusing to publish.'
    exit 1
  }
  if ($APPVER -ne $expected) {
    Write-Host "[ERROR] stale installer: artifact version $APPVER != package.json version $expected"
    Write-Host '  The build did not produce a fresh artifact. Refusing to publish.'
    exit 1
  }
}

# [4] Generate release notes from git log (falls back to version-only if no commits).
Write-Host '[4] Generate release notes...'
$notes = Join-Path (Split-Path $asset -Parent) ("release-notes-" + $APPVER + '.md')
& $PY $NotesGen $APPVER $notes
if ($LASTEXITCODE -ne 0) {
  Write-Host '[ERROR] release notes generation failed'
  exit 1
}

# [4.5] Build the skill bundle as a SECOND, independently downloadable artifact.
# The installer stays a bare .exe on purpose: electron/update-state.js picks the
# Windows asset by name (setup|installer|.exe) and downloads it straight to disk
# to run, so wrapping the exe in a zip would break in-app self-update. The skill
# bundle is a separate zip users can grab without installing MTask.
Write-Host '[4.5] Pack skill bundle...'
$skillZip = Join-Path (Split-Path $asset -Parent) ("MTask_Skill_v" + $APPVER + '.zip')
& $PY $PackSkill $APPVER $skillZip
if ($LASTEXITCODE -ne 0) {
  Write-Host '[ERROR] skill bundle packaging failed'
  exit 1
}
Write-Host "  skill:  $skillZip"

# [5] Publish both assets to the SAME GitHub Release.
# publish-release.py is idempotent: an existing Release is reused and an already
# uploaded asset is skipped, so calling it once per asset is safe. The installer
# goes first so it stays the first matching Windows asset for the updater.
Write-Host '[5] Publish to GitHub Releases...'
$env:GH_TAG = $APPVER
foreach ($item in @($asset, $skillZip)) {
  Write-Host ("  uploading: " + [System.IO.Path]::GetFileName($item))
  & $PY $Publisher $item $notes ([System.IO.Path]::GetFileName($item))
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] publish failed for $item"
    exit 1
  }
}

Write-Host ''
Write-Host '============================================'
Write-Host ' Publish done'
Write-Host '============================================'
Write-Host "  installer: $asset"
Write-Host "  skill:     $skillZip"
Write-Host "  version:   $APPVER"
Write-Host "  notes:     $notes"
