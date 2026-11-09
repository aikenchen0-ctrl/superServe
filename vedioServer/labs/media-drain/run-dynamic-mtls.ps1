param(
    [string]$CoordinationIp = '127.0.0.1',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$env:CARGO_BUILD_JOBS = '1'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$evidence = [IO.Path]::GetFullPath((Join-Path $workspace '..\.artifacts\media-registry-mtls'))
$expectedIp = [Net.IPAddress]::Parse($CoordinationIp).ToString()
$null = New-Item -ItemType Directory -Force -Path $evidence
Set-Location -LiteralPath $workspace
$cache = @(
    '--locked', '--offline',
    '--config', 'source.crates-io.replace-with="video-rsproxy"',
    '--config', 'source.video-rsproxy.registry="sparse+https://rsproxy.cn/index/"'
)
$runId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
if ((Get-PSDrive -Name O).Free -lt 512MB) {
    throw 'O盘低于定向验证的512MiB保护线，停止构建和测试'
}
if (!$SkipBuild) {
    & cargo build -p vs-tls -p vs-coordination -p vs-live --all-targets @cache 2>&1 |
        Tee-Object -FilePath (Join-Path $evidence "build-$runId.log")
    if ($LASTEXITCODE -ne 0) { throw '独立程序构建失败' }
}
$binary = Join-Path $env:CARGO_TARGET_DIR 'debug\vs-live.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw '缺少媒体程序，不能跳过构建' }
$previousBinary = $env:VS_TEST_LIVE_BINARY
$previousIp = $env:VS_TEST_COORDINATION_IP
$log = Join-Path $evidence "process-$runId.log"
try {
    $env:VS_TEST_LIVE_BINARY = $binary
    $env:VS_TEST_COORDINATION_IP = $expectedIp
    & cargo test -p vs-coordination --test mtls @cache `
        real_dynamic_tls_registry_joins_and_drains_without_coordinator_restart `
        -- --ignored --exact --nocapture 2>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) { throw "动态TLS登记真实进程实验失败，日志：$log" }
    $prefix = '动态TLS登记闭环验证：'
    $lines = @(Get-Content -LiteralPath $log | Where-Object { $_.StartsWith($prefix) })
    if ($lines.Count -ne 1) { throw '缺少唯一结构化回执，不能将零测试匹配当成成功' }
    $receipt = $lines[0].Substring($prefix.Length) | ConvertFrom-Json
    if ($receipt.schema -ne 'media-registry-mtls-lab-v1' `
        -or $receipt.coordination_bind -ne $expectedIp -or $receipt.drain_bind -ne $expectedIp `
        -or $receipt.coordinators -ne 3 -or $receipt.media_processes -ne 1 -or $receipt.physical_hosts -ne 1 `
        -or !$receipt.automatic_tls_release -or !$receipt.leader_failover `
        -or !$receipt.lost_media_keeps_owner -or !$receipt.unauthorized_certificates_denied `
        -or !$receipt.media_http_udp_loopback -or $receipt.rtc_sessions -ne 0 `
        -or !$receipt.process_reclaimed -or !$receipt.graceful_dual_listener_shutdown `
        -or !$receipt.online_registry_join -or !$receipt.unlisted_destinations_denied `
        -or !$receipt.maintenance_and_in_use_verified `
        -or !$receipt.directory_change_rejected_on_reopen `
        -or !$receipt.new_trust_slots_require_explicit_migration) {
        throw '动态TLS登记回执不符合控制链路验收边界'
    }
    [PSCustomObject]@{
        schema = 'media-registry-mtls-runner-v1'
        log = $log
        media_binary_sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
        receipt = $receipt
    } | ConvertTo-Json -Depth 5
}
finally {
    $env:VS_TEST_LIVE_BINARY = $previousBinary
    $env:VS_TEST_COORDINATION_IP = $previousIp
}
