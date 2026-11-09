param(
    [string]$Binary,
    [string]$Trainer
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (-not $Binary) {
    $Binary = Join-Path $root 'vedioServer/target/release/examples/rank_learning_replay.exe'
}
if (-not $Trainer) {
    $Trainer = Join-Path $root 'vedioServer/target/release/examples/train_ranker.exe'
}
$executable = (Resolve-Path -LiteralPath $Binary).Path
$trainerExecutable = (Resolve-Path -LiteralPath $Trainer).Path
$run = Join-Path $root ('.artifacts/rank-learning/' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run | Out-Null
$reports = @()
for ($repeat = 0; $repeat -lt 2; $repeat++) {
    $arguments = @()
    if ($repeat -eq 0) { $arguments += $run }
    $output = Join-Path $run "replay-$repeat.json"
    & $executable @arguments > $output 2> (Join-Path $run "replay-$repeat-error.log")
    if ($LASTEXITCODE -ne 0) { throw "第$repeat轮回放失败，请查看实验日志。" }
    $report = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
    if ($report.schema -ne 'rank-learning-evaluation-v2' -or $report.build -ne 'release' -or
        $report.data_kind -ne 'synthetic' -or $report.cells.Count -ne 12) {
        throw '回放版本、构建类型、数据类型或单元数量不符。'
    }
    $reports += $report
}
foreach ($field in @('model_sha256','catalog_sha256','training_sha256')) {
    if ($reports[0].$field -cne $reports[1].$field) { throw "重复运行的$field不一致。" }
}
foreach ($cell in $reports[0].cells) {
    $second = @($reports[1].cells | Where-Object { $_.variant -ceq $cell.variant })
    if ($second.Count -ne 1 -or
        $second[0].mean_ndcg_at_5 -ne $cell.mean_ndcg_at_5 -or
        $second[0].mean_recall_at_5 -ne $cell.mean_recall_at_5 -or
        $second[0].nonregressed_queries -ne $cell.nonregressed_queries) {
        throw '重复回放的质量结果不一致。'
    }
}
$cliModel = Join-Path $run 'model-cli.json'
& $trainerExecutable (Join-Path $run 'catalog.json') (Join-Path $run 'training.json') $cliModel `
    > (Join-Path $run 'training-receipt.json') 2> (Join-Path $run 'training-error.log')
if ($LASTEXITCODE -ne 0) { throw '独立训练命令失败。' }
$cliHash = (Get-FileHash -LiteralPath $cliModel -Algorithm SHA256).Hash.ToLowerInvariant()
if ($cliHash -cne $reports[0].model_sha256) { throw '独立训练命令的模型与回放产物不一致。' }
$sources = @(
    'vedioServer/Cargo.lock',
    'vedioServer/crates/vs-core/src/learning.rs',
    'vedioServer/crates/vs-core/src/upstream/ftrl.rs',
    'vedioServer/crates/vs-core/src/recommendation.rs',
    'vedioServer/crates/vs-service/src/rank_model.rs',
    'vedioServer/crates/vs-service/examples/rank_learning_replay.rs',
    'vedioServer/crates/vs-service/examples/train_ranker.rs'
)
$fingerprints = @($sources | ForEach-Object {
    [ordered]@{
        path = $_
        sha256 = (Get-FileHash -LiteralPath (Join-Path $root $_) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
})
$receipt = [ordered]@{
    schema = 'rank-learning-run-v1'
    completed = $true
    reports = @('replay-0.json','replay-1.json')
    deterministic_model_and_quality = $true
    cli_model_matches = $true
    replay_binary_sha256 = (Get-FileHash -LiteralPath $executable).Hash.ToLowerInvariant()
    trainer_binary_sha256 = (Get-FileHash -LiteralPath $trainerExecutable).Hash.ToLowerInvariant()
    sources = $fingerprints
    boundary = '合成机制实验；耗时不包含网络、排队、跨机分发或真实播放器；不证明生产质量。'
}
$receipt | ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath (Join-Path $run 'receipt.json') -Encoding utf8NoBOM
Write-Output "学习排序实验已完成：$run"
Write-Output '两轮模型和质量结果一致，独立训练命令产物一致；真实推荐准入仍待验证。'
