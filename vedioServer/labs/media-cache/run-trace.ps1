param(
    [string]$Binary,
    [ValidateRange(16,256)][int]$Samples = 64
)
$ErrorActionPreference = 'Stop'
if ($Samples % 4 -ne 0) { throw '样本数必须为4的倍数。' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (-not $Binary) { $Binary = Join-Path $root 'vedioServer/target/release/examples/media_cache_trace.exe' }
$executable = (Resolve-Path -LiteralPath $Binary).Path
$run = Join-Path $root ('.artifacts/media-cache/' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run | Out-Null
$previous = $env:CACHE_SAMPLES
$owned = $null
$completed = $false
$report = $null
$processMetrics = $null
try {
    $env:CACHE_SAMPLES = "$Samples"
    $owned = Start-Process -FilePath $executable -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $run 'trace.json') `
        -RedirectStandardError (Join-Path $run 'trace-error.log')
    $peakObserved = 0L
    while (-not $owned.WaitForExit(500)) {
        $owned.Refresh()
        if (-not $owned.HasExited) { $peakObserved = [Math]::Max($peakObserved, $owned.WorkingSet64) }
    }
    if ($owned.ExitCode -ne 0) { throw '缓存轨迹执行失败，请查看错误日志。' }
    $processMetrics = [ordered]@{
        total_cpu_ms=$owned.TotalProcessorTime.TotalMilliseconds
        process_peak_working_set_bytes=$owned.PeakWorkingSet64
        sampled_peak_working_set_bytes=$peakObserved
        scope='整份报告同时包含源站夹具、直通、缓存、HTTP客户端与两套并发批次；无按单元RSS或CPU归因。'
    }
    $report = Get-Content -LiteralPath (Join-Path $run 'trace.json') -Raw | ConvertFrom-Json
    if ($report.schema -ne 'media-cache-trace-v1' -or $report.build -ne 'release' -or
        $report.samples_per_cell -ne $Samples -or $report.cells.Count -ne 8 -or
        -not $report.quality_gate_passed -or
        @($report.cells | Where-Object {
            $_.samples -ne $Samples -or $_.measurements.Count -ne $Samples -or
            -not $_.quality_gate.passed -or -not $_.client_bytes_equal
        }).Count -ne 0 -or
        -not $report.burst.direct.quality_gate_passed -or
        -not $report.burst.cached.quality_gate_passed) {
        throw '缓存报告版本、样本或保真门禁不符。'
    }
    $completed = $true
} finally {
    if ($owned -and -not $owned.HasExited) {
        Stop-Process -InputObject $owned
        $owned.WaitForExit()
    }
    $env:CACHE_SAMPLES = $previous
    $sources = @(
        'vedioServer/crates/vs-storage/src/media_cache.rs',
        'vedioServer/crates/vs-storage/src/lib.rs',
        'vedioServer/crates/vs-storage/src/observability.rs',
        'vedioServer/crates/vs-storage/Cargo.toml',
        'vedioServer/crates/vs-service/src/lib.rs',
        'vedioServer/crates/vs-service/src/main.rs',
        'vedioServer/crates/vs-service/examples/media_cache_trace.rs',
        'vedioServer/crates/vs-service/examples/support/cache_fixture.rs',
        'vedioServer/Cargo.lock',
        'vedioServer/rust-toolchain.toml'
    ) | ForEach-Object { Join-Path $root $_ }
    $fingerprints = foreach ($file in @($executable,$PSCommandPath) + $sources) {
        [ordered]@{path=$file;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    [ordered]@{
        schema='media-cache-run-v1';completed=$completed;samples_per_cell=$Samples
        quality_gate_passed=($null -ne $report -and $report.quality_gate_passed)
        inputs=$fingerprints;process=$processMetrics
        owned_process_stopped=($null -eq $owned -or $owned.HasExited)
        timestamp_utc=[DateTime]::UtcNow.ToString('o')
        host=[ordered]@{
            os=[Environment]::OSVersion.VersionString
            logical_processors=[Environment]::ProcessorCount
            architecture=[Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
        }
        production_performance_claim=$false;physical_cluster_tested=$false
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $run 'run.json') -Encoding utf8NoBOM
    Write-Output "缓存轨迹收据：$run"
}
