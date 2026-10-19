# T02616: resolve a usable WorkBuddy managed Node directory.
#
# Why this exists: both release .bat entries used to carry a hard-coded version directory
# (22.22.2-3 in the build script, 22.22.2 in the twin). Both directories are gone, "if exist"
# failed, and the PATH override silently stopped happening - every build then ran on whatever
# node sat on PATH (a different NODE_MODULE_VERSION), while the comment still promised an ABI
# match. Resolution is therefore by availability, never by a literal version:
#   1) <root>\current  - a one-line text pointer holding the version directory name
#   2) the highest <root>\* directory that really contains node.exe
# Output contract (the .bat parses stdout with "for /f"): print exactly the chosen directory on
# stdout, or print nothing at all when no directory is usable - never print a message that the
# .bat could mistake for a path. The .bat owns the user-facing warning for the fallback case.
#
# Root comes from $env:MTASK_MG_NODE_ROOT (the .bat owns the machine-specific default; the
# verification gate points it at a fixture). Unexpected failures go to stderr: this helper
# used to swallow everything under SilentlyContinue, which is how a broken Sort-Object call
# turned into "no managed node" with no trace - the very silence this ticket is about.

$ErrorActionPreference = 'Stop'
try {
  $root = $env:MTASK_MG_NODE_ROOT
  if (-not $root) { exit 0 }
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { exit 0 }

  function Test-NodeDir([string]$dir) {
    return Test-Path -LiteralPath (Join-Path $dir 'node.exe') -PathType Leaf
  }

  $chosen = ''
  $pointer = Join-Path $root 'current'
  if (Test-Path -LiteralPath $pointer -PathType Leaf) {
    $name = ''
    $line = Get-Content -LiteralPath $pointer -TotalCount 1
    if ($line) { $name = ([string]$line).Trim() }
    if ($name -and -not [System.IO.Path]::IsPathRooted($name)) { $name = Join-Path $root $name }
    # The pointer is authoritative, but only for a directory that really has node.exe -
    # a stale pointer must fall through to enumeration instead of naming an unusable dir.
    if ($name -and (Test-NodeDir $name)) { $chosen = $name }
  }

  if (-not $chosen) {
    $zero = [Version]'0.0'
    $best = Get-ChildItem -LiteralPath $root -Directory |
      Where-Object { Test-NodeDir $_.FullName } |
      Sort-Object -Property {
        $v = $zero
        if (-not [Version]::TryParse(($_.Name -split '-')[0], [ref]$v)) { $v = $zero }
        $v
      }, {
        $tail = ($_.Name -split '-')[1]
        if ($tail -match '^\d+$') { [int]$tail } else { -1 }
      } |
      Select-Object -Last 1
    if ($best) { $chosen = $best.FullName }
  }

  if ($chosen) { Write-Output $chosen }
  exit 0
} catch {
  [Console]::Error.WriteLine('resolve-managed-node: ' + $_.Exception.Message)
  exit 0
}
