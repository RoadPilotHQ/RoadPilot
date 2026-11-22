# B1 runtime validation: samples private bytes per process type of RoadPilot (roadpilot.exe and
# the WebView2 processes whose command line contains -Mark, i.e. RoadPilot's user data folder
# only) and the GPU process's dedicated/shared GPU memory per adapter (LUID), about every 0.6 s
# plus the time the queries take, as JSON lines. Stops when -StopFile exists. Read-only.
param([string]$Out, [string]$StopFile, [string]$Mark)
$ErrorActionPreference = 'SilentlyContinue'
if (-not $Mark) { throw 'sampler.ps1: -Mark (the app identifier) is required' }
$enc = New-Object System.Text.UTF8Encoding $false
while (-not (Test-Path $StopFile)) {
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $procs = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like "*$Mark*" }
  $byType = @{}
  $gpuPid = $null
  foreach ($p in $procs) {
    $type = 'browser'
    if ($p.CommandLine -match '--type=([a-z-]+)') { $type = $Matches[1] }
    if ($type -eq 'utility' -and $p.CommandLine -match 'network') { $type = 'utility-network' }
    if ($type -eq 'gpu-process') { $gpuPid = $p.ProcessId }
    $byType[$type] = [int64]($byType[$type]) + [int64]$p.PrivatePageCount
  }
  $host_ = Get-CimInstance Win32_Process -Filter "Name='roadpilot.exe'"
  if ($host_) { $byType['app'] = [int64](($host_ | Measure-Object PrivatePageCount -Sum).Sum) }
  $adapters = @{}
  if ($gpuPid) {
    $c = Get-Counter -Counter "\GPU Process Memory(pid_$($gpuPid)_*)\Dedicated Usage","\GPU Process Memory(pid_$($gpuPid)_*)\Shared Usage"
    foreach ($s in $c.CounterSamples) {
      if ($s.InstanceName -match 'luid_(0x[0-9a-f]+_0x[0-9a-f]+)') {
        $l = $Matches[1]
        if (-not $adapters[$l]) { $adapters[$l] = @{ dedicated = 0; shared = 0 } }
        if ($s.Path -like '*dedicated usage') { $adapters[$l].dedicated += [int64]$s.CookedValue } else { $adapters[$l].shared += [int64]$s.CookedValue }
      }
    }
  }
  $ded = [int64]0; $sh = [int64]0
  foreach ($a in $adapters.Values) { $ded += $a.dedicated; $sh += $a.shared }
  $webviewTotal = [int64]0
  foreach ($k in $byType.Keys) { if ($k -ne 'app') { $webviewTotal += $byType[$k] } }
  $line = @{ t = $t; types = $byType; webviewTotal = $webviewTotal; total = $webviewTotal + [int64]$byType['app']; gpuDedicated = $ded; gpuShared = $sh; adapters = $adapters; gpuPid = $gpuPid } | ConvertTo-Json -Compress -Depth 4
  [System.IO.File]::AppendAllText($Out, $line + [Environment]::NewLine, $enc)
  Start-Sleep -Milliseconds 600
}
