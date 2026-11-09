param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [ValidateSet('demo','holdout')][string]$Fixture = 'demo',
    [ValidateRange(1,32)][int]$TimingSamples = 1
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$server = (Resolve-Path -LiteralPath $Binary).Path
$replay = Join-Path $root 'vedioServer/target/debug/examples/recommendation_replay.exe'
$publisher = Join-Path $root 'vedioServer/target/debug/examples/publish_recall.exe'
if (-not (Test-Path -LiteralPath $replay) -or -not (Test-Path -LiteralPath $publisher)) {
    throw '请先构建 recommendation_replay 和 publish_recall 两个示例。'
}
if ((& $server --version | Out-String).Trim() -ne 'qdrant 1.20.0') {
    throw '实验要求固定的 Qdrant 1.20.0 二进制。'
}
$run = Join-Path $root ('.artifacts/replay-runs/qdrant-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run | Out-Null
$variables = @(
    'QDRANT__SERVICE__HOST','QDRANT__SERVICE__HTTP_PORT','QDRANT__SERVICE__GRPC_PORT',
    'QDRANT__CLUSTER__ENABLED','QDRANT__STORAGE__STORAGE_PATH','QDRANT__STORAGE__SNAPSHOTS_PATH',
    'QDRANT__SERVICE__API_KEY','VS_QDRANT_URL','VS_QDRANT_API_KEY','VS_CATALOG','REPLAY_RECALL_MODE',
    'REPLAY_TIMING_SAMPLES'
)
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$owned = $null
$runs = @()
$failed = $false
try {
    $catalog = Join-Path $run 'catalog.json'
    $trace = Join-Path $run 'trace.json'
    & $replay "--$Fixture-catalog" | Set-Content -LiteralPath $catalog -Encoding utf8NoBOM
    if ($LASTEXITCODE -ne 0) { throw '导出合成目录失败。' }
    & $replay "--$Fixture-trace" | Set-Content -LiteralPath $trace -Encoding utf8NoBOM
    if ($LASTEXITCODE -ne 0) { throw '导出合成轨迹失败。' }
    $env:QDRANT__SERVICE__HOST = '127.0.0.1'
    $env:QDRANT__SERVICE__HTTP_PORT = "$port"
    $env:QDRANT__SERVICE__GRPC_PORT = '0'
    $env:QDRANT__CLUSTER__ENABLED = 'false'
    # 固定绝对路径前缀，避免 Windows 载荷索引路径不一致。
    $env:QDRANT__STORAGE__STORAGE_PATH = '\\?\' + (Join-Path $run 'storage')
    $env:QDRANT__STORAGE__SNAPSHOTS_PATH = '\\?\' + (Join-Path $run 'snapshots')
    $env:QDRANT__SERVICE__API_KEY = [Guid]::NewGuid().ToString('N')
    $env:VS_QDRANT_URL = "http://127.0.0.1:$port"
    $env:VS_QDRANT_API_KEY = $env:QDRANT__SERVICE__API_KEY
    $env:VS_CATALOG = $catalog
    $env:REPLAY_TIMING_SAMPLES = "$TimingSamples"
    $owned = Start-Process -FilePath $server -ArgumentList '--disable-telemetry' `
        -WorkingDirectory $run -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $run 'qdrant.log') -RedirectStandardError (Join-Path $run 'qdrant-error.log')
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($owned.HasExited) { throw '实验 Qdrant 提前退出。' }
        try {
            $null = Invoke-RestMethod -Uri "$env:VS_QDRANT_URL/readyz" -Headers @{'api-key'=$env:VS_QDRANT_API_KEY} -TimeoutSec 1
            $ready = $true
            break
        } catch { Start-Sleep -Milliseconds 50 }
    }
    if (-not $ready) { throw '实验 Qdrant 就绪超时。' }
    & $publisher > (Join-Path $run 'publication.json') 2> (Join-Path $run 'publication-error.log')
    if ($LASTEXITCODE -ne 0) { throw '实验目录发布失败。' }
    foreach ($mode in @('prior','exact-sparse-reference','exact-signed-reference','qdrant','qdrant-signed','grouped')) {
        $env:REPLAY_RECALL_MODE = $mode
        $report = Join-Path $run "report-$mode.json"
        & $replay $catalog $trace --require-no-regression > $report 2> (Join-Path $run "report-$mode-error.log")
        $gateExit = $LASTEXITCODE
        if ($gateExit -notin @(0,2)) { throw "回放执行失败：$mode" }
        $result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
        if ($result.schema -ne 'recommendation-replay-report-v4' -or
            $result.measurement_scope.samples_per_case -ne $TimingSamples -or
            @($result.cases | Where-Object { $_.measurements.Count -ne $TimingSamples }).Count -ne 0) {
            throw "报告未执行要求的重复测量，请重新构建回放示例：$mode"
        }
        if (($gateExit -eq 0) -ne $result.quality_gate.passed) { throw "门禁退出码与报告不一致：$mode" }
        $runs += [ordered]@{mode=$mode;gate_exit_code=$gateExit;summary=$result.summary}
    }
} catch {
    $failed = $true
    throw
} finally {
    if ($owned) {
        if (-not $owned.HasExited) { Stop-Process -InputObject $owned }
        $owned.WaitForExit()
    }
    $fingerprints = foreach ($file in @($server,$replay,$publisher,$PSCommandPath) + @(
        Get-ChildItem -LiteralPath $run -File | Where-Object { $_.Extension -eq '.json' } | ForEach-Object FullName
    )) {
        [ordered]@{path=$file;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    [ordered]@{
        schema='recommendation-replay-run-v4';data_kind='synthetic';fixture=$Fixture;timing_samples=$TimingSamples
        completed=(-not $failed);quality_gate_passed=($runs.Count -eq 6 -and @($runs | Where-Object gate_exit_code -ne 0).Count -eq 0)
        runs=$runs;inputs=$fingerprints;physical_cluster_tested=$false;owned_process_stopped=($null -eq $owned -or $owned.HasExited)
    } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $run 'run.json') -Encoding utf8NoBOM
    foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') }
    Write-Output "回放目录：$run"
}
