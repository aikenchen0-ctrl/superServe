param(
    [string]$Binary,
    [switch]$Quick,
    [ValidateRange(8,512)][int]$Samples = 64,
    [ValidateRange(1,64)][int]$Warmup = 8,
    [ValidateRange(1,4)][int]$MemoryRepeats = 2,
    [ValidateSet('all','heap','buffered')][string]$Strategy = 'buffered',
    [ValidateSet('ties','varied')][string]$Workload = 'ties',
    [switch]$CompareHeads
)
$ErrorActionPreference = 'Stop'
if ($Samples % 4 -ne 0) { throw '样本数必须为 4 的倍数。' }
if ($Quick -and $CompareHeads) { throw '同场策略对照使用完整 release 矩阵，不能与 Quick 同时启用。' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (-not $Binary) { $Binary = Join-Path $root 'vedioServer/target/release/examples/recall_cost_matrix.exe' }
$executable = (Resolve-Path -LiteralPath $Binary).Path
$run = Join-Path $root ('.artifacts/recall-cost/' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run | Out-Null
$previousSamples = $env:COST_SAMPLES
$previousWarmup = $env:COST_WARMUP
$previousStrategy = $env:COST_HEAD_STRATEGY
$previousWorkload = $env:COST_WORKLOAD
$completed = $false
$matrix = $null
$matrixExit = $null
$memory = @()
try {
    $env:COST_SAMPLES = "$Samples"
    $env:COST_WARMUP = "$Warmup"
    $env:COST_HEAD_STRATEGY = $Strategy
    $env:COST_WORKLOAD = $Workload
    $arguments = @()
    if ($Quick) { $arguments += '--quick' }
    if ($CompareHeads) { $arguments += '--compare-heads' }
    & $executable @arguments > (Join-Path $run 'matrix.json') 2> (Join-Path $run 'matrix-error.log')
    $matrixExit = $LASTEXITCODE
    if ($matrixExit -notin @(0,2)) { throw '成本矩阵执行失败，请检查错误日志。' }
    $matrix = Get-Content -LiteralPath (Join-Path $run 'matrix.json') -Raw | ConvertFrom-Json
    $schema = if ($CompareHeads) { 'recall-head-comparison-v1' } else { 'recall-cost-matrix-v2' }
    $expectedCells = if ($CompareHeads) { 192 } elseif ($Quick) { 16 } else { 64 }
    if ($matrix.schema -ne $schema -or $matrix.cells.Count -ne $expectedCells -or
        $matrix.head_strategy -ne $Strategy -or $matrix.samples_per_cell -ne $Samples -or
        $matrix.warmup_pairs -ne $Warmup -or
        @($matrix.cells | Where-Object { $_.measurements.Count -ne $Samples }).Count -ne 0) {
        throw '成本矩阵版本或测量样本数不符。'
    }
    if (($matrixExit -eq 0) -ne $matrix.quality_gate.passed) { throw '成本门禁退出码与报告不一致。' }
    if (-not $Quick -and $matrix.build -ne 'release') { throw '完整成本矩阵必须为 release 构建。' }
    $probeCases = if ($Quick) { @(@(1024,10),@(1024,1024)) } else { @(@(10000,100),@(10000,1000),@(10000,10000)) }
    foreach ($case in $probeCases) {
        for ($repeat=0; $repeat -lt $MemoryRepeats; $repeat++) {
            $start = [Diagnostics.ProcessStartInfo]::new($executable)
            $start.WorkingDirectory = $root
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.RedirectStandardInput = $true
            $start.RedirectStandardOutput = $true
            $start.RedirectStandardError = $true
            foreach ($argument in @('--memory-probe',"$($case[0])","$($case[1])")) { $start.ArgumentList.Add($argument) }
            $owned = [Diagnostics.Process]::new()
            $owned.StartInfo = $start
            [void]$owned.Start()
            $errorTask = $owned.StandardError.ReadToEndAsync()
            $stages = @()
            try {
                foreach ($phase in @('ready','catalog','indexed','queried','index_dropped')) {
                    $lineTask = $owned.StandardOutput.ReadLineAsync()
                    if (-not $lineTask.Wait(10000)) { throw '内存探针阶段等待超时。' }
                    $line = $lineTask.GetAwaiter().GetResult()
                    if ($null -eq $line) { throw '内存探针提前结束。' }
                    $message = $line | ConvertFrom-Json
                    if ($message.schema -ne 'recall-memory-probe-v1' -or
                        $message.phase -ne $phase -or $message.pid -ne $owned.Id) {
                        throw '内存探针阶段或进程身份不符。'
                    }
                    # 只读取本脚本启动的进程，阶段暂停时采样；不将差值等同于索引分配。
                    $owned.Refresh()
                    $stages += [ordered]@{
                        phase=$phase;working_set_bytes=$owned.WorkingSet64
                        private_bytes=$owned.PrivateMemorySize64
                        peak_working_set_bytes=$owned.PeakWorkingSet64
                        total_cpu_ms=$owned.TotalProcessorTime.TotalMilliseconds
                        details=$message.details
                    }
                    $owned.StandardInput.WriteLine('continue')
                    $owned.StandardInput.Flush()
                }
                if (-not $owned.WaitForExit(5000)) { throw '内存探针未结束。' }
                if ($owned.ExitCode -ne 0) { throw '内存探针退出失败。' }
                $memory += [ordered]@{size=$case[0];groups=$case[1];repeat=$repeat;pid=$owned.Id;stages=$stages;owned_process_stopped=$owned.HasExited}
            } finally {
                if (-not $owned.HasExited) { $owned.Kill(); $owned.WaitForExit() }
                $errorTask.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $run "memory-$($case[1])-$repeat-error.log") -Encoding utf8NoBOM
                $owned.Dispose()
            }
        }
    }
    $completed = $true
} finally {
    $env:COST_SAMPLES = $previousSamples
    $env:COST_WARMUP = $previousWarmup
    $env:COST_HEAD_STRATEGY = $previousStrategy
    $env:COST_WORKLOAD = $previousWorkload
    $sources = @(
        'vedioServer/crates/vs-core/examples/recall_cost_matrix.rs',
        'vedioServer/crates/vs-core/examples/support/cost_workload.rs',
        'vedioServer/crates/vs-core/src/grouped_recall.rs',
        'vedioServer/crates/vs-core/src/recommendation.rs',
        'vedioServer/crates/vs-core/src/upstream/bounded_heap.rs',
        'vedioServer/crates/vs-core/src/upstream/buffered_top_k.rs',
        'vedioServer/crates/vs-core/src/upstream/mod.rs',
        'vedioServer/LICENSES/qdrant-Apache-2.0.txt',
        'vedioServer/Cargo.lock',
        'vedioServer/rust-toolchain.toml'
    ) | ForEach-Object { Join-Path $root $_ }
    $inputs = foreach ($file in @($executable,$PSCommandPath) + $sources) {
        [ordered]@{path=$file;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    [ordered]@{
        schema='recall-cost-run-v2';completed=$completed;matrix_exit_code=$matrixExit;head_strategy=$Strategy;workload=$Workload
        compared_heads=[bool]$CompareHeads
        quality_gate_passed=($null -ne $matrix -and $matrix.quality_gate.passed)
        quick=[bool]$Quick;inputs=$inputs;memory_probes=$memory
        timestamp_utc=[DateTime]::UtcNow.ToString('o')
        host_environment=[ordered]@{os=[Environment]::OSVersion.VersionString;logical_processors=[Environment]::ProcessorCount;architecture=[Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()}
        memory_scope='Windows暂停阶段的独立进程工作集、私有字节和进程累计峰值；不等于存活索引分配，不归因为泄漏。'
        production_performance_claim=$false;physical_cluster_tested=$false
    } | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath (Join-Path $run 'run.json') -Encoding utf8NoBOM
    Write-Output "成本矩阵目录：$run"
}
