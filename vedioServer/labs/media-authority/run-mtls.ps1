param(
    [string]$CoordinationIp = '127.0.0.1',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$evidence = [IO.Path]::GetFullPath((Join-Path $workspace '..\.artifacts\media-authority-mtls'))
$null = New-Item -ItemType Directory -Force -Path $evidence
$expectedIp = [Net.IPAddress]::Parse($CoordinationIp).ToString()
Set-Location -LiteralPath $workspace

$cache = @(
    '--locked', '--offline',
    '--config', 'source.crates-io.replace-with="video-rsproxy"',
    '--config', 'source.video-rsproxy.registry="sparse+https://rsproxy.cn/index/"'
)
$packages = @('-p', 'vs-tls', '-p', 'vs-coordination', '-p', 'vs-live', '--all-targets')
$runId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
if (!$SkipBuild) {
    if ((Get-PSDrive -Name O).Free -lt 256MB) {
        throw 'O盘低于跨包增量构建保护线，停止编译；已有二进制可显式使用SkipBuild'
    }
    & cargo build @packages @cache 2>&1 |
        Tee-Object -FilePath (Join-Path $evidence "build-$runId.log")
    if ($LASTEXITCODE -ne 0) { throw '媒体及协调程序构建失败' }
}
$binary = Join-Path $env:CARGO_TARGET_DIR 'debug\vs-live.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw '媒体程序不存在，不能跳过构建'
}
if ((Get-PSDrive -Name O).Free -lt 128MB) {
    throw 'O盘低于定向测试保护线，停止后续Cargo校验'
}
$previousBinary = $env:VS_TEST_LIVE_BINARY
$previousIp = $env:VS_TEST_COORDINATION_IP
$log = Join-Path $evidence "process-$runId.log"
try {
    $env:VS_TEST_LIVE_BINARY = $binary
    $env:VS_TEST_COORDINATION_IP = $expectedIp
    & cargo test @packages @cache `
        real_media_process_verifies_private_mtls_authority_without_operator_privileges `
        -- --ignored --exact --nocapture 2>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) { throw "真实进程实验失败，日志：$log" }
    $prefix = '媒体权威mTLS验证：'
    $lines = @(Get-Content -LiteralPath $log | Where-Object { $_.StartsWith($prefix) })
    if ($lines.Count -ne 1) { throw '未收到唯一结构化验收回执，不能将零测试匹配当成成功' }
    $receipt = $lines[0].Substring($prefix.Length) | ConvertFrom-Json
    if ($receipt.schema -ne 'media-authority-mtls-lab-v1' `
        -or $receipt.coordination_bind -ne $expectedIp `
        -or $receipt.coordinators -ne 3 -or $receipt.media_processes -ne 1 `
        -or $receipt.physical_hosts -ne 1 -or !$receipt.node_readonly_identity `
        -or !$receipt.leader_failover -or !$receipt.new_revision_gt_old `
        -or $receipt.stale_activation_status -ne 409 `
        -or $receipt.lost_quorum_activation_status -ne 503 `
        -or !$receipt.media_http_and_udp_loopback -or !$receipt.media_process_reclaimed `
        -or $receipt.automatic_media_release_connector_verified -ne $false `
        -or $receipt.rtc_sessions -ne 0) {
        throw '验收回执字段不符合当前控制链路实验契约'
    }
    [PSCustomObject]@{
        schema = 'media-authority-mtls-runner-v1'
        log = $log
        binary_sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
        receipt = $receipt
    } | ConvertTo-Json -Depth 5
}
finally {
    $env:VS_TEST_LIVE_BINARY = $previousBinary
    $env:VS_TEST_COORDINATION_IP = $previousIp
}
