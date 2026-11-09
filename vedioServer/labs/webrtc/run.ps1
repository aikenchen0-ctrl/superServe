param(
    [string]$TargetDirectory = 'O:\CodexVideoBuild\target',
    [int]$Port = 0,
    [int]$RunSeconds = 300,
    [string]$AccessConfig,
    [string]$RoomControlConfig
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1' -KeepLocation
if ($Port -lt 0 -or $Port -gt 65535 -or $RunSeconds -lt 30 -or $RunSeconds -gt 900) {
    throw '监听端口或运行期限无效'
}
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$binary = Join-Path $TargetDirectory 'debug\vs-live.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw '请先构建vs-live二进制' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$run = Join-Path $workspace ".artifacts\webrtc\run-$stamp"
New-Item -ItemType Directory -Path $run | Out-Null
$stdout = Join-Path $run 'stdout.log'
$stderr = Join-Path $run 'stderr.log'
$env:VS_LIVE_BIND = "127.0.0.1:$Port"
$env:VS_LIVE_RUN_SECONDS = [string]$RunSeconds
if ($AccessConfig) {
    $env:VS_LIVE_ACCESS_CONFIG = (Resolve-Path -LiteralPath $AccessConfig).Path
} else {
    Remove-Item Env:VS_LIVE_ACCESS_CONFIG -ErrorAction SilentlyContinue
}
if ($RoomControlConfig) {
    $env:VS_LIVE_ROOM_CONTROL_CONFIG = (Resolve-Path -LiteralPath $RoomControlConfig).Path
} else {
    Remove-Item Env:VS_LIVE_ROOM_CONTROL_CONFIG -ErrorAction SilentlyContinue
}
$process = Start-Process -FilePath $binary -WorkingDirectory (Join-Path $workspace 'vedioServer') `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$deadline = (Get-Date).AddSeconds(10)
$ready = $null
while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { throw "媒体实验提前退出，见$stderr" }
    if ((Test-Path -LiteralPath $stdout) -and (Get-Item -LiteralPath $stdout).Length -gt 0) {
        try { $ready = (Get-Content -LiteralPath $stdout -TotalCount 1) | ConvertFrom-Json } catch {}
        if ($ready) { break }
    }
    Start-Sleep -Milliseconds 50
}
if (!$ready) {
    $process.Kill()
    throw "媒体实验未在期限内就绪，见$stderr"
}
$receipt = [ordered]@{
    schema = 'live-sfu-launch-v1'
    launch_file = (Join-Path $run 'launch.json')
    pid = $process.Id
    started_at = $process.StartTime.ToUniversalTime().ToString('o')
    executable = (Resolve-Path -LiteralPath $binary).Path
    sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    url = $ready.url
    udp_port = $ready.udp_port
    run_seconds = $RunSeconds
    access_required = $ready.access_required
    binding = $ready.binding
    assignment_cluster = $ready.assignment_cluster
    stdout = $stdout
    stderr = $stderr
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'launch.json') -Encoding utf8
[pscustomobject]$receipt
