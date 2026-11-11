<#
.SYNOPSIS
  Parse mtask_list_tasks MCP output and list todo tasks, sorted by task_no ascending.

.DESCRIPTION
  mtask_list_tasks returns a doubly-nested JSON-string text (outer MCP wrapper, inner is the
  task array). This script strips the wrapper, parses twice, filters status=todo and sorts by
  numeric task_no.
  IMPORTANT: This script is pure ASCII to stay compatible with Windows PowerShell 5.1,
  which reads .ps1 using the local ANSI codepage (UTF-8-without-BOM would garble Chinese).

.PARAMETER InputFile
  Path to the raw output file of mtask_list_tasks (required).

.PARAMETER ProjectFilter
  Optional: only show tasks belonging to this project_id. Empty means all.

.PARAMETER ShowAll
  Switch: show all statuses (not only todo) for audit.

.EXAMPLE
  PS> .\list-todo.ps1 -InputFile tasks.txt

.EXAMPLE
  PS> .\list-todo.ps1 -InputFile tasks.txt -ProjectFilter 97510316-0063-4d25-a22c-566021c93ae8
#>
param(
  [Parameter(Mandatory = $true)][string]$InputFile,
  [string]$ProjectFilter = "",
  [switch]$ShowAll
)

$ErrorActionPreference = 'Stop'

function Get-TasksFromMtaskOutput {
  param([string]$Path)
  if (-not (Test-Path $Path)) { throw "File not found: $Path" }
  # Use -Raw so multi-line JSON stays intact. Read as Unicode to respect any BOM;
  # fall back to raw bytes decoding is avoided here to keep statuses/ids ASCII-safe.
  $raw = Get-Content -Raw -Encoding UTF8 $Path
  if ($null -eq $raw) { $raw = Get-Content -Raw $Path }
  $raw = $raw.Trim()
  $prefix = 'The MCP server responded with: '
  $jsonText = $raw
  if ($raw.StartsWith($prefix)) { $jsonText = $raw.Substring($prefix.Length) }
  $outer = $jsonText | ConvertFrom-Json
  $payloads = if ($outer -is [System.Array]) { $outer } else { @($outer) }
  foreach ($p in $payloads) {
    $t = $p.text
    if ($null -eq $t) { continue }
    if (($t -is [string]) -and ($t.TrimStart().StartsWith('['))) {
      try {
        $arr = $t | ConvertFrom-Json
        # return must be unrolled so a single-element array isn't flattened
        return @($arr)
      } catch {
        throw "Inner JSON parse failed: $($_.Exception.Message)"
      }
    }
  }
  throw "Could not locate the task array in the MCP output."
}

function Get-OrderKey {
  param([object]$t)
  $m = [regex]::Match($t.task_no, '(\d+)')
  if ($m.Success) { return [long]$m.Groups[1].Value }
  return [long]0
}

$tasks = Get-TasksFromMtaskOutput -Path $InputFile
if ($null -eq $tasks) { Write-Error 'No tasks parsed.'; exit 1 }
if ($ProjectFilter -ne "") { $tasks = @($tasks | Where-Object { $_.project_id -eq $ProjectFilter }) }

Write-Output ("Total tasks: {0}" -f $tasks.Count)
if (-not $ShowAll) {
  $todo = @($tasks | Where-Object { $_.status -eq 'todo' })
  Write-Output ("Todo count: {0}" -f $todo.Count)
  $sorted = $todo | Sort-Object -Property @{ Expression = { Get-OrderKey $_ } }
  $sorted | ForEach-Object {
    Write-Output ("{0} | {1} | project={2} | {3}" -f $_.task_no, $_.id, $_.project_id, $_.title)
  }
} else {
  $tasks | Group-Object status | ForEach-Object { Write-Output ("  {0}: {1}" -f $_.Name, $_.Count) }
  $sorted = $tasks | Sort-Object -Property @{ Expression = { Get-OrderKey $_ } }
  $sorted | ForEach-Object {
    Write-Output ("{0} | {1} | {2} | project={3} | {4}" -f $_.task_no, $_.status, $_.id, $_.project_id, $_.title)
  }
}