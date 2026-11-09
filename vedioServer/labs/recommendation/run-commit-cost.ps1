param([string]$Binary)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (-not $Binary) {
    $Binary = Join-Path $root 'vedioServer/target/release/examples/learning_commit_cost.exe'
}
$executable = (Resolve-Path -LiteralPath $Binary).Path
$run = Join-Path $root ('.artifacts/learning-group-commit/' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run | Out-Null
& $executable $run > (Join-Path $run 'report.json') 2> (Join-Path $run 'error.log')
if ($LASTEXITCODE -ne 0) { throw '组提交对照失败，请查看实验日志。' }
$report = Get-Content -LiteralPath (Join-Path $run 'report.json') -Raw | ConvertFrom-Json
if ($report.schema -ne 'learning-commit-cost-v1' -or $report.build -ne 'release' -or
    -not $report.quality_gate_passed -or $report.cells.Count -ne 12) {
    throw '实验版本、release构建或完整性校验不符。'
}
$sources = @(
    'vedioServer/Cargo.lock',
    'vedioServer/crates/vs-service/src/learning_journal.rs',
    'vedioServer/crates/vs-service/src/lib.rs',
    'vedioServer/crates/vs-service/src/main.rs',
    'vedioServer/crates/vs-service/examples/learning_commit_cost.rs',
    'vedioServer/labs/recommendation/run-commit-cost.ps1'
)
$fingerprints = @($sources | ForEach-Object {
    [ordered]@{
        path=$_
        sha256=(Get-FileHash -LiteralPath (Join-Path $root $_)).Hash.ToLowerInvariant()
    }
})
foreach ($cell in $report.cells) {
    if ($cell.requests -ne 64 -or $cell.latency_samples_ns.Count -ne 64) {
        throw '测量次数不符。'
    }
    if ($cell.mode -ne 'off') {
        if ($cell.metrics.committed_records -ne 64 -or $cell.metrics.sync_calls -gt 64 -or
            $cell.metrics.sync_calls -lt 1 -or -not $cell.metrics.usable) {
            throw '持久化指标无效。'
        }
        $path = Join-Path $run "$($cell.mode)-c$($cell.concurrency)-r$($cell.repeat).jsonl"
        if ((Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() -cne $cell.journal_sha256) {
            throw '日志文件指纹与报告不一致。'
        }
    }
}
[ordered]@{
    schema='learning-commit-cost-run-v1'
    completed=$true
    report_sha256=(Get-FileHash -LiteralPath (Join-Path $run 'report.json')).Hash.ToLowerInvariant()
    binary_sha256=(Get-FileHash -LiteralPath $executable).Hash.ToLowerInvariant()
    sources=$fingerprints
    boundary='进程内指标和日志逐项核对；不把少同步次数解释成少存储字节、掉电证明或生产QoE。'
} | ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath (Join-Path $run 'receipt.json') -Encoding utf8NoBOM
Write-Output "组提交release成本对照完成：$run"
