param([Parameter(Mandatory)][string]$LaunchFile)

$ErrorActionPreference = 'Stop'
$LaunchFile = (Resolve-Path -LiteralPath $LaunchFile).Path
$receipt = Get-Content -LiteralPath $LaunchFile -Raw | ConvertFrom-Json
if ($receipt.schema -ne 'xiu-live-launch-v1') { throw '不是有效的直播实验启动收据' }
$running = @()
$absent = @()
foreach ($item in @(
    @{ Id=$receipt.xiu_process_id; Started=$receipt.xiu_started_utc },
    @{ Id=$receipt.publisher_process_id; Started=$receipt.publisher_started_utc }
)) {
    if (!$item.Id -or !$item.Started) { throw '启动收据缺少进程身份' }
    $process = Get-Process -Id $item.Id -ErrorAction SilentlyContinue
    if (!$process) { $absent += $item.Id; continue }
    # 保留JSON日期的时区，避免先转字符串再解析造成八小时偏移。
    $expected = ([DateTimeOffset]$item.Started).UtcDateTime
    if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $expected).TotalSeconds) -gt 0.001) {
        throw '进程号已被复用，拒绝停止该进程'
    }
    $running += $process
}
foreach ($process in $running) {
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    if (!$process.WaitForExit(5000)) { throw '直播实验进程未在限定时间内退出' }
}
$result = [ordered]@{
    schema = 'xiu-live-cleanup-v1'
    stopped_process_ids = @($running | ForEach-Object Id)
    already_exited_process_ids = $absent
    process_cleanup_completed = $true
}
$result | ConvertTo-Json | Out-File (Join-Path (Split-Path -Parent $LaunchFile) 'cleanup.json') -Encoding utf8
$result | ConvertTo-Json
