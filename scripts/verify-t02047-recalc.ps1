# T02047 acceptance: PRD section 9 "three-track" assertion, track 3 = real Excel recalculation.
# Opens the exported xlsx through Excel COM, runs a full recalculation, writes back the recalculated
# Value2 for every cell address listed in cells.json, so the caller can compare them against the
# cached <v> values that the export wrote (track 2). Exit codes: 0 ok, 2 Excel COM unavailable.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-t02047-recalc.ps1 <xlsx> <cells.json> <out.json>
#
# Kept ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as the ANSI codepage,
# so non-ASCII comments would turn into mojibake and could break parsing.
param(
  [Parameter(Mandatory = $true)][string]$XlsxPath,
  [Parameter(Mandatory = $true)][string]$CellsPath,
  [Parameter(Mandatory = $true)][string]$OutPath
)

$ErrorActionPreference = 'Stop'
$fail = {
  param($msg)
  $payload = @{ ok = $false; error = $msg } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($OutPath, $payload, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "RECALC_FAIL: $msg"
  exit 2
}

if (-not (Test-Path -LiteralPath $XlsxPath)) { & $fail "xlsx not found: $XlsxPath" }

$cells = Get-Content -LiteralPath $CellsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$excel = $null
$wb = $null
try {
  $excel = New-Object -ComObject Excel.Application
} catch {
  & $fail "Excel COM unavailable: $($_.Exception.Message)"
}
try {
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $wb = $excel.Workbooks.Open((Resolve-Path -LiteralPath $XlsxPath).Path, 0, $false)
  # full recalculation, then let the recalculated values be read back
  $excel.CalculateFull()
  $wb.Application.CalculateFull()
  $sheet = $wb.Worksheets.Item(1)
  $used = @{}
  foreach ($c in $cells) {
    $addr = [string]$c.addr
    $v = $sheet.Range($addr).Value2
    $num = $null
    if ($v -ne $null) {
      try { $num = [double]$v } catch { $num = $null }
    }
    $used[$addr] = @{ cached = $c.cached; recalc = $num; raw = [string]$v }
  }
  $payload = @{
    ok = $true
    engine = "Excel $($excel.Version)"
    cells = $used
  }
  [System.IO.File]::WriteAllText($OutPath, ($payload | ConvertTo-Json -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "RECALC_OK cells=$($used.Count) excel=$($excel.Version)"
} catch {
  & $fail "recalc error: $($_.Exception.Message)"
} finally {
  if ($wb -ne $null) { $wb.Close($false) | Out-Null }
  if ($excel -ne $null) { $excel.Quit() }
  foreach ($o in @($wb, $excel)) {
    if ($o -ne $null) {
      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) | Out-Null
    }
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
exit 0
