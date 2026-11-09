param(
    [string]$BinaryDirectory,
    [ValidateSet('single','grouped')][string]$CommitMode = 'single',
    [ValidateSet('debug','release')][string]$BuildType = 'debug'
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (-not $BinaryDirectory) { $BinaryDirectory = Join-Path $root 'vedioServer/target/debug' }
$server = (Resolve-Path -LiteralPath (Join-Path $BinaryDirectory 'vs-service.exe')).Path
$exporter = (Resolve-Path -LiteralPath (Join-Path $BinaryDirectory 'examples/export_training.exe')).Path
$trainer = (Resolve-Path -LiteralPath (Join-Path $BinaryDirectory 'examples/train_ranker.exe')).Path
$run = Join-Path $root ('.artifacts/learning-evidence/' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run | Out-Null
$token = 'evidence-lab-service-token-00000000000000'
$headers = @{ Authorization = "Bearer $token" }
$catalog = [ordered]@{
    version = 'evidence-http-v1'
    items = @(
        [ordered]@{id='video-a';domain='video';tags=@('rust');prior=0.8;media_sha256=$null},
        [ordered]@{id='article-b';domain='article';tags=@('storage');prior=0.2;media_sha256=$null}
    )
    assets = @()
}
$catalogPath = Join-Path $run 'catalog.json'
$catalog | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $catalogPath -Encoding utf8NoBOM
$catalogAsOf = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$processes = [Collections.Generic.List[Diagnostics.Process]]::new()
$ports = [Collections.Generic.List[int]]::new()
$measurements = [Collections.Generic.List[object]]::new()
$decisions = [Collections.Generic.List[string]]::new()
function Start-Replica([string]$Name, [bool]$Capture, [string]$Model, [string]$ModelHash) {
    $socket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $socket.Start()
    $port = $socket.LocalEndpoint.Port
    $socket.Stop()
    $ports.Add($port)
    $start = [Diagnostics.ProcessStartInfo]::new($server)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WorkingDirectory = $root
    foreach ($environmentName in @($start.Environment.Keys)) {
        if ($environmentName.StartsWith('VS_')) { [void]$start.Environment.Remove($environmentName) }
    }
    $start.Environment['VS_BIND'] = "127.0.0.1:$port"
    $start.Environment['VS_ROLE'] = 'api'
    $start.Environment['VS_SERVICE_TOKEN'] = $token
    $start.Environment['VS_CATALOG'] = $catalogPath
    if ($Capture) {
        $start.Environment['VS_LEARNING_JOURNAL'] = Join-Path $run "$Name.jsonl"
        $start.Environment['VS_LEARNING_SOURCE_ID'] = $Name
        $start.Environment['VS_LEARNING_COMMIT_MODE'] = $CommitMode
    }
    if ($Model) {
        $start.Environment['VS_RANK_MODEL'] = $Model
        $start.Environment['VS_RANK_MODEL_SHA256'] = $ModelHash
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    [void]$process.Start()
    $processes.Add($process)
    $endpoint = "http://127.0.0.1:$port"
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ($true) {
        if ($process.HasExited) { throw '实验API进程提前退出。' }
        try {
            $ready = Invoke-RestMethod "$endpoint/readyz" -Headers $headers -TimeoutSec 1
            if ($ready.ready) { break }
        } catch { }
        if ([DateTime]::UtcNow -ge $deadline) { throw '实验API启动超时。' }
        Start-Sleep -Milliseconds 30
    }
    return $endpoint
}
function Stop-OwnedReplicas {
    foreach ($process in $processes) {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
    $processes.Clear()
}
try {
    $endpoints = @(
        (Start-Replica 'baseline' $false '' ''),
        (Start-Replica 'replica-a' $true '' ''),
        (Start-Replica 'replica-b' $true '' '')
    )
    for ($sample = 0; $sample -lt 24; $sample++) {
        # 每轮旋转访问顺序；只测同机HTTP和本地持久化，不当作并发容量基准。
        for ($offset = 0; $offset -lt 3; $offset++) {
            $index = ($sample + $offset) % 3
            $body = @{
                request_id = "query-$sample"
                subject = 'synthetic-subject'
                domains = @('video','article')
                limit = 2
            } | ConvertTo-Json -Compress
            $clock = [Diagnostics.Stopwatch]::StartNew()
            $reply = Invoke-WebRequest "$($endpoints[$index])/v1/feed" -Method Post -Headers $headers `
                -ContentType 'application/json' -Body $body -TimeoutSec 5
            $clock.Stop()
            $decision = [string]($reply.Headers['x-learning-decision-id'] | Select-Object -First 1)
            if (($index -gt 0) -ne [bool]$decision) { throw '可选决策标识行为不符。' }
            if ($index -gt 0 -and $sample -eq 0) { $decisions.Add($decision) }
            $measurements.Add([ordered]@{replica=$index;sample=$sample;elapsed_us=$clock.Elapsed.TotalMicroseconds})
        }
    }
    if ($decisions.Count -ne 2 -or $decisions[0] -ceq $decisions[1]) {
        throw '两个副本的决策标识未隔离。'
    }
    # 这里只生成带synthetic标记的测试网关声明，不模拟真实显示。
    $visibleAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -le $visibleAt) {
        if ($clock.Elapsed.TotalSeconds -gt 3) { throw '系统时钟未按预期前进。' }
        Start-Sleep -Milliseconds 20
    }
    $feedbackAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $gateway = [ordered]@{
        schema='gateway-learning-events-v1';source_id='synthetic-gateway';data_kind='synthetic'
        events=@(
            @{event_id='shown-a';decision_id=$decisions[0];subject='synthetic-subject';candidate_id='video-a';at=$visibleAt;kind='visible'},
            @{event_id='liked-a';decision_id=$decisions[0];subject='synthetic-subject';candidate_id='video-a';at=$feedbackAt;kind='like'},
            @{event_id='shown-b';decision_id=$decisions[1];subject='synthetic-subject';candidate_id='article-b';at=$visibleAt;kind='visible'},
            @{event_id='disliked-b';decision_id=$decisions[1];subject='synthetic-subject';candidate_id='article-b';at=$feedbackAt;kind='dislike'}
        )
    }
    $gatewayPath = Join-Path $run 'gateway.json'
    $gateway | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $gatewayPath -Encoding utf8NoBOM
    Stop-OwnedReplicas
    $catalogHash = (Get-FileHash -LiteralPath $catalogPath).Hash.ToLowerInvariant()
    $manifest = [ordered]@{
        schema='learning-evidence-export-v1';data_kind='synthetic'
        catalog_sha256=$catalogHash;catalog_as_of=$catalogAsOf;train_before=$feedbackAt+1
        decision_logs=@('replica-a.jsonl','replica-b.jsonl' | ForEach-Object {
            @{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $run $_)).Hash.ToLowerInvariant()}
        })
        gateway_source_id='synthetic-gateway'
        gateway_events=@{path='gateway.json';sha256=(Get-FileHash -LiteralPath $gatewayPath).Hash.ToLowerInvariant()}
        excluded_subjects=@()
    }
    $manifestPath = Join-Path $run 'manifest.json'
    $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
    $training = Join-Path $run 'training.json'
    & $exporter $catalogPath $manifestPath $training `
        > (Join-Path $run 'export-receipt.json') 2> (Join-Path $run 'export-error.log')
    if ($LASTEXITCODE -ne 0) { throw '独立导出命令失败，请查看日志。' }
    $model = Join-Path $run 'model.json'
    & $trainer $catalogPath $training $model `
        > (Join-Path $run 'model-receipt.json') 2> (Join-Path $run 'model-error.log')
    if ($LASTEXITCODE -ne 0) { throw '独立训练命令失败，请查看日志。' }
    $modelReceipt = Get-Content -LiteralPath (Join-Path $run 'model-receipt.json') -Raw | ConvertFrom-Json
    $exportReceipt = Get-Content -LiteralPath (Join-Path $run 'export-receipt.json') -Raw | ConvertFrom-Json
    if ($exportReceipt.samples -ne 2 -or $exportReceipt.issued_without_visibility -ne 46) {
        throw '曝光、样本或未显示决策的区分不符。'
    }
    $clock.Restart()
    while ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -lt $manifest.train_before) {
        if ($clock.Elapsed.TotalSeconds -gt 3) { throw '训练截止时钟尚未到达。' }
        Start-Sleep -Milliseconds 20
    }
    $endpoint = Start-Replica 'learned' $false $model $modelReceipt.sha256
    $reply = Invoke-WebRequest "$endpoint/v1/feed" -Method Post -Headers $headers `
        -ContentType 'application/json' -Body (@{
            request_id='learned';subject='synthetic-subject';domains=@('video','article');limit=2
        } | ConvertTo-Json -Compress)
    if (($reply.Content | ConvertFrom-Json).ranker -ne 'ftrl-ranker-v1' -or
        [string]($reply.Headers['x-rank-model-sha256'] | Select-Object -First 1) -cne $modelReceipt.sha256) {
        throw '导出/训练产物未在新API中按指纹加载。'
    }
    Stop-OwnedReplicas
    $cells = @(0..2 | ForEach-Object {
        $index = $_
        $times = @($measurements | Where-Object { $_.replica -eq $index } |
            ForEach-Object { $_.elapsed_us } | Sort-Object)
        [ordered]@{replica=$index;samples=$times.Count;p50_us=$times[11];p95_us=$times[22];p99_us=$times[23]}
    })
    [ordered]@{
        schema='learning-evidence-http-v1';completed=$true;data_kind='synthetic'
        build=$BuildType;cells=$cells;measurements=$measurements
        commit_mode=$CommitMode
        decision_records=48;training_samples=2;issued_without_visibility=46
        online_replica_rpcs=0;model_sha256=$modelReceipt.sha256
        export_sha256=(Get-FileHash -LiteralPath $training).Hash.ToLowerInvariant()
        decision_log_bytes=@('replica-a.jsonl','replica-b.jsonl' | ForEach-Object {(Get-Item -LiteralPath (Join-Path $run $_)).Length})
        processes_stopped=$true
        sources=@(
            'vedioServer/Cargo.lock',
            'vedioServer/crates/vs-service/src/learning_journal.rs',
            'vedioServer/crates/vs-service/src/learning_evidence.rs',
            'vedioServer/crates/vs-core/src/learning.rs'
        ) | ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $root $_)).Hash.ToLowerInvariant()}}
        binaries=@($server,$exporter,$trainer) | ForEach-Object {
            @{path=$_;sha256=(Get-FileHash -LiteralPath $_).Hash.ToLowerInvariant()}
        }
        boundary='同机调试构建HTTP实验，曝光/反馈是合成网关声明；不证明真实曝光、生产容量或三低收益。'
    } | ConvertTo-Json -Depth 12 |
        Set-Content -LiteralPath (Join-Path $run 'receipt.json') -Encoding utf8NoBOM
    Write-Output "学习证据HTTP闭环完成：$run"
} finally {
    Stop-OwnedReplicas
}
