# T02696: resolve a usable WorkBuddy managed Python interpreter - the Python twin of
# resolve-managed-node.ps1, same output contract, same reason for existing.
#
# Why: scripts/publish-oneclick.ps1 used to carry a hard-coded version directory
# (...\.workbuddy\binaries\python\versions\3.13.12\python.exe). Version directories move; when the
# literal went stale "if (Test-Path)" simply stopped matching and the publish ran on whatever
# python sat on PATH, silently - the same shape of decay T02616 fixed for managed Node.
# Resolution is therefore by availability, never by a literal version:
#   1) <root>\current  - a one-line text pointer holding the version directory name
#   2) the highest <root>\* directory that really contains python.exe
# Output contract: print exactly the chosen python.exe on stdout, or print nothing at all when no
# directory is usable - never print a message a caller could mistake for a path. The caller owns
# the user-facing warning for the fallback case, and it must print one (silence is the defect).
#
# Root comes from $env:MTASK_MG_PYTHON_ROOT (the caller owns the machine-specific default; the
# verification gate points it at a fixture). Unexpected failures go to stderr and still exit 0:
# a hint helper must not become a new blocker, and must not swallow its own breakage either.

$ErrorActionPreference = 'Stop'
try {
  $root = $env:MTASK_MG_PYTHON_ROOT
  if (-not $root) { exit 0 }
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { exit 0 }

  function Test-PyDir([string]$dir) {
    return Test-Path -LiteralPath (Join-Path $dir 'python.exe') -PathType Leaf
  }

  $chosen = ''
  $pointer = Join-Path $root 'current'
  if (Test-Path -LiteralPath $pointer -PathType Leaf) {
    $name = ''
    $line = Get-Content -LiteralPath $pointer -TotalCount 1
    if ($line) { $name = ([string]$line).Trim() }
    if ($name -and -not [System.IO.Path]::IsPathRooted($name)) { $name = Join-Path $root $name }
    # The pointer is authoritative, but only for a directory that really has python.exe -
    # a stale pointer must fall through to enumeration instead of naming an unusable dir.
    if ($name -and (Test-PyDir $name)) { $chosen = Join-Path $name 'python.exe' }
  }

  if (-not $chosen) {
    $zero = [Version]'0.0'
    $best = Get-ChildItem -LiteralPath $root -Directory |
      Where-Object { Test-PyDir $_.FullName } |
      Sort-Object -Property {
        $v = $zero
        if (-not [Version]::TryParse(($_.Name -split '-')[0], [ref]$v)) { $v = $zero }
        $v
      }, {
        $tail = ($_.Name -split '-')[1]
        if ($tail -match '^\d+$') { [int]$tail } else { -1 }
      } |
      Select-Object -Last 1
    if ($best) { $chosen = Join-Path $best.FullName 'python.exe' }
  }

  if ($chosen) { Write-Output $chosen }
  exit 0
} catch {
  [Console]::Error.WriteLine('resolve-managed-python: ' + $_.Exception.Message)
  exit 0
}
