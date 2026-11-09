param([Parameter(Mandatory)][string]$LaunchFile)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1' -KeepLocation
$launch = Get-Content -LiteralPath $LaunchFile -Raw | ConvertFrom-Json
if ($launch.schema -ne 'live-sfu-launch-v1' -or
    [IO.Path]::GetFileName($launch.executable) -ne 'vs-live.exe') {
    throw '不是有效的实时媒体实验启动回执'
}
$process = Get-Process -Id $launch.pid -ErrorAction SilentlyContinue
if (!$process) {
    [pscustomobject]@{stopped=$true;already_exited=$true;pid=$launch.pid}
    return
}
if ($process.Path -ne $launch.executable -or
    $process.StartTime.ToUniversalTime() -ne ([datetime]$launch.started_at).ToUniversalTime()) {
    throw '进程号、程序路径或启动时间不符，拒绝停止'
}
Stop-Process -Id $process.Id -Force
Wait-Process -Id $launch.pid -Timeout 5 -ErrorAction SilentlyContinue
$receipt = [ordered]@{schema='live-sfu-stop-v1';stopped=$true;already_exited=$false;pid=$launch.pid}
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path (Split-Path $LaunchFile) 'cleanup.json') -Encoding utf8
[pscustomobject]$receipt
