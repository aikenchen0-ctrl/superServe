param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
Set-Location -LiteralPath 'O:\CodexWorkspaces\superServe-video-b4be'
$env:CARGO_BUILD_JOBS = '1'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$out = Join-Path $PWD ".artifacts\profile-consensus-feed-$stamp"
$null = New-Item -ItemType Directory -Path $out
$cache = @(
    '--locked','--offline',
    '--config','source.crates-io.replace-with="video-rsproxy"',
    '--config','source.video-rsproxy.registry="sparse+https://rsproxy.cn/index/"'
)
if (!$SkipBuild) {
    if ((Get-PSDrive O).Free -lt 1GB) { throw 'O盘低于跨包构建保护线，停止编译' }
    & cargo build --manifest-path vedioServer/Cargo.toml -p vs-service -p vs-coordination --bins @cache 2>&1 |
        Tee-Object -FilePath (Join-Path $out 'build.log')
    if ($LASTEXITCODE -ne 0) { throw '共识Feed服务程序构建失败' }
}
$binary = Join-Path $env:CARGO_TARGET_DIR 'debug\vs-coordination.exe'
$api = Join-Path $env:CARGO_TARGET_DIR 'debug\vs-service.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf) -or !(Test-Path -LiteralPath $api -PathType Leaf)) {
    throw '缺少独立协调或API程序，不能执行进程验收'
}
if ((Get-PSDrive O).Free -lt 512MB) { throw 'O盘低于定向测试保护线，停止实验' }
$previous = $env:VS_TEST_COORDINATION_BINARY
$log = Join-Path $out 'process.log'
try {
    $env:VS_TEST_COORDINATION_BINARY = $binary
    & cargo test --manifest-path vedioServer/Cargo.toml -p vs-service --test profile_consensus_process @cache `
        actual_consensus_profiles_feed_two_api_processes_through_failover_and_quorum_loss `
        -- --ignored --exact --nocapture --test-threads=1 2>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) { throw '共识Feed真实进程验收失败，日志保留' }
    $events = @(
        Get-Content -LiteralPath $log |
            Where-Object { $_.Contains('"schema":"profile-consensus-feed-process-v1"') } |
            ForEach-Object { $_.Substring($_.IndexOf('{')) | ConvertFrom-Json } |
            Where-Object schema -eq 'profile-consensus-feed-process-v1'
    )
    if ($events.Count -ne 1) { throw '缺少唯一实际进程回执，不把零测试匹配当成功' }
    $receipt = $events[0]
    if ($receipt.coordinators -ne 3 -or $receipt.api_processes -ne 2 -or $receipt.physical_hosts -ne 1 -or
        !$receipt.hide_and_cross_domain_feed -or !$receipt.api_restart -or !$receipt.readonly_write_denied -or
        !$receipt.quorum_loss_feed_and_readiness_unavailable -or !$receipt.old_writer_fenced -or
        !$receipt.signed_subject_and_scope_verified -or !$receipt.forged_identity_rejected -or
        !$receipt.cold_subject_isolation_verified -or !$receipt.legacy_feed_compatibility_verified -or
        !$receipt.process_and_tcp_reclaimed -or !$receipt.synthetic_issuer_only -or
        $receipt.local_fallback_or_new_event_retries -ne $false -or $receipt.production_admitted -ne $false) {
        throw '共识Feed回执范围或验证字段不符'
    }
    [ordered]@{
        schema='profile-consensus-feed-runner-v1';receipt=$receipt;log=$log
        coordination_binary_sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
        api_binary_sha256=(Get-FileHash -LiteralPath $api -Algorithm SHA256).Hash.ToLowerInvariant()
        lock_sha256=(Get-FileHash -LiteralPath 'vedioServer\Cargo.lock' -Algorithm SHA256).Hash.ToLowerInvariant()
        production_admitted=$false
    } | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8
} finally {
    $env:VS_TEST_COORDINATION_BINARY = $previous
}
Get-Content -LiteralPath (Join-Path $out 'receipt.json') -Raw
