param(
    [Parameter(Mandatory)][string]$Binary,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [ValidateRange(1, 8)][int]$Repeats = 3,
    [ValidateSet('full', 'topk', 'pruned', 'blockmax')][string[]]$Backends = @('full', 'topk', 'pruned')
)

$ErrorActionPreference = 'Stop'
. 'D:/CodexVideoTools/enter.ps1' -KeepLocation
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$executable = (Resolve-Path -LiteralPath $Binary).Path
if ([IO.Path]::GetFullPath($OutputDirectory).StartsWith('C:', [StringComparison]::OrdinalIgnoreCase)) {
    throw '内存探针输出必须位于非C盘'
}
if (Test-Path -LiteralPath $OutputDirectory) { throw '内存探针输出目录必须尚不存在' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$outputRoot = (Resolve-Path -LiteralPath $OutputDirectory).Path
$measurements = @()
foreach ($groups in @(1, 12, 10000)) {
    foreach ($backend in $Backends) {
        for ($repeat = 0; $repeat -lt $Repeats; $repeat++) {
            $start = [Diagnostics.ProcessStartInfo]::new($executable)
            $start.WorkingDirectory = $root
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.RedirectStandardInput = $true
            $start.RedirectStandardOutput = $true
            $start.RedirectStandardError = $true
            foreach ($argument in @('--memory-probe', '10000', "$groups", $backend)) {
                $start.ArgumentList.Add($argument)
            }
            $owned = [Diagnostics.Process]::new()
            $owned.StartInfo = $start
            [void]$owned.Start()
            $errorTask = $owned.StandardError.ReadToEndAsync()
            $stages = @()
            try {
                foreach ($phase in @('ready', 'loaded', 'indexed', 'queried', 'index_dropped')) {
                    $lineTask = $owned.StandardOutput.ReadLineAsync()
                    if (-not $lineTask.Wait(10000)) { throw '内存阶段等待超时。' }
                    $line = $lineTask.GetAwaiter().GetResult()
                    if ($null -eq $line) { throw '内存探针提前退出。' }
                    $message = $line | ConvertFrom-Json
                    if ($message.schema -ne 'model-pruned-memory-v1' -or
                        $message.phase -ne $phase -or $message.pid -ne $owned.Id) {
                        throw '内存探针阶段或进程身份不符。'
                    }
                    # 只采样本脚本启动的进程；进程差值不替代索引持有字节口径。
                    $owned.Refresh()
                    $stages += [ordered]@{
                        phase = $phase
                        working_set_bytes = $owned.WorkingSet64
                        private_bytes = $owned.PrivateMemorySize64
                        peak_working_set_bytes = $owned.PeakWorkingSet64
                        total_cpu_ms = $owned.TotalProcessorTime.TotalMilliseconds
                        details = $message.details
                    }
                    $owned.StandardInput.WriteLine('continue')
                    $owned.StandardInput.Flush()
                }
                $tailTask = $owned.StandardOutput.ReadToEndAsync()
                if (-not $owned.WaitForExit(5000)) { throw '内存探针结束超时。' }
                $tail = $tailTask.GetAwaiter().GetResult() | ConvertFrom-Json
                if ($owned.ExitCode -ne 0 -or $tail.schema -ne 'model-pruned-memory-end-v1' -or
                    -not $tail.passed) { throw '内存探针未成功完成。' }
                $measurements += [ordered]@{
                    size = 10000; groups = $groups; backend = $backend
                    repeat = $repeat; pid = $owned.Id; stages = $stages
                    owned_process_stopped = $owned.HasExited
                }
            } finally {
                if (-not $owned.HasExited) { $owned.Kill(); $owned.WaitForExit() }
                $errorTask.GetAwaiter().GetResult() | Set-Content -LiteralPath (
                    Join-Path $outputRoot "memory-$groups-$backend-$repeat-error.log"
                ) -Encoding utf8NoBOM
                $owned.Dispose()
            }
        }
    }
}
[ordered]@{
    schema = 'model-pruned-memory-report-v1'
    binary_sha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    repeats = $Repeats
    measurements = $measurements
    scope = '同机独立进程的工作集、私有字节和累计CPU；不证明跨机或生产容量。'
} | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath (
    Join-Path $outputRoot 'memory.json'
) -Encoding utf8NoBOM
Write-Output "内存采样完成：$($measurements.Count)个独立进程。"
