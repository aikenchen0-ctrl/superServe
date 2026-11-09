param([Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$TaskProcessId)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$process = Get-Process -Id $TaskProcessId -ErrorAction Stop
$process.Refresh()
[ordered]@{
    schema = 'playback-process-snapshot-v1'
    pid = $process.Id
    process_name = $process.ProcessName
    start_time_utc = $process.StartTime.ToUniversalTime().ToString('o')
    sampled_utc = [DateTime]::UtcNow.ToString('o')
    cpu_total_ms = $process.TotalProcessorTime.TotalMilliseconds
    working_set_bytes = $process.WorkingSet64
    private_memory_bytes = $process.PrivateMemorySize64
    peak_working_set_bytes = $process.PeakWorkingSet64
    scope = 'Rust媒体与内存源站合并进程；端点采样非RSS峰值轨迹，不含浏览器或封装启动成本'
} | ConvertTo-Json
