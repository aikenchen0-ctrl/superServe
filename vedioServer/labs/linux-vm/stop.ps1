param([Parameter(Mandatory)][string]$LaunchFile)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$receipt = Get-Content -LiteralPath $LaunchFile -Raw | ConvertFrom-Json
if ($receipt.schema -ne 'video-linux-vm-launch-v1' -or
    !$receipt.run.StartsWith('O:\CodexVideoBuild\linux-runtime\run-',[StringComparison]::OrdinalIgnoreCase)) {
    throw '不是本轮虚拟机启动收据'
}
$outputDirectory = $receipt.run
if ($receipt.attempt) {
    $outputDirectory = [IO.Path]::GetFullPath($receipt.attempt)
    if (!$outputDirectory.StartsWith($receipt.run+'\',[StringComparison]::OrdinalIgnoreCase)) {
        throw '清理回执目标不在本轮来宾目录'
    }
}
$processes = @()
foreach ($entry in @(
    @{id=$receipt.vm_pid;started=$receipt.vm_started_utc;name='qemu-system-x86_64'},
    @{id=$receipt.seed_pid;started=$receipt.seed_started_utc;name='python'}
)) {
    if (!$entry.id) { continue }
    $process = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
    if (!$process) { continue }
    if ($process.ProcessName -ne $entry.name -or
        [Math]::Abs(($process.StartTime.ToUniversalTime() - ([DateTimeOffset]$entry.started).UtcDateTime).TotalMilliseconds) -gt 1) {
        throw '进程身份发生变化，拒绝终止'
    }
    $processes += $process
}
foreach ($process in $processes) {
    $process.Kill()
    if (!$process.WaitForExit(5000)) { throw '本轮虚拟机进程未回收' }
}
[ordered]@{
    schema='video-linux-vm-cleanup-v1';processes_reclaimed=$true
    stopped=@($processes | ForEach-Object Id);guest_graceful_shutdown_proven=$false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputDirectory 'cleanup.json') -Encoding utf8NoBOM
