param([switch]$SkipBuild, [string]$CoordinationIp = '127.0.0.1')

$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
Set-Location -LiteralPath 'O:\CodexWorkspaces\superServe-video-b4be'
$env:CARGO_BUILD_JOBS = '1'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$out = Join-Path $PWD ".artifacts\profile-read-mtls-$stamp"
$null = New-Item -ItemType Directory -Path $out
$cache = @(
    '--locked','--offline',
    '--config','source.crates-io.replace-with="video-rsproxy"',
    '--config','source.video-rsproxy.registry="sparse+https://rsproxy.cn/index/"'
)
if ((Get-PSDrive O).Free -lt 1GB) { throw 'O盘低于双向TLS实验保护线，停止运行' }
if (!$SkipBuild) {
    & cargo build --manifest-path vedioServer/Cargo.toml -p vs-service -p vs-coordination --bins @cache 2>&1 |
        Tee-Object -FilePath (Join-Path $out 'build.log')
    if ($LASTEXITCODE -ne 0) { throw '画像只读TLS实验程序构建失败' }
}
$binary = Join-Path $env:CARGO_TARGET_DIR 'debug\vs-service.exe'
$coordination = Join-Path $env:CARGO_TARGET_DIR 'debug\vs-coordination.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf) -or !(Test-Path -LiteralPath $coordination -PathType Leaf)) {
    throw '缺少API或协调程序'
}
$previous = $env:VS_TEST_SERVICE_BINARY
$previousIp = $env:VS_TEST_COORDINATION_IP
$log = Join-Path $out 'process.log'
try {
    $env:VS_TEST_SERVICE_BINARY = $binary
    $env:VS_TEST_COORDINATION_IP = [Net.IPAddress]::Parse($CoordinationIp).ToString()
    & cargo test --manifest-path vedioServer/Cargo.toml -p vs-coordination --test mtls @cache `
        profile_reader_mtls_feeds_signed_apis_and_cannot_use_control_permissions `
        -- --ignored --exact --nocapture --test-threads=1 2>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) { throw '画像只读TLS真实进程验收失败，日志保留' }
    $events = @(
        Get-Content -LiteralPath $log |
            Where-Object { $_.Contains('"schema":"profile-reader-mtls-process-v1"') } |
            ForEach-Object { $_.Substring($_.IndexOf('{')) | ConvertFrom-Json }
    )
    if ($events.Count -ne 1) { throw '缺少唯一只读TLS进程回执' }
    $receipt = $events[0]
    if ($receipt.schema -ne 'profile-reader-mtls-process-v1' -or $receipt.coordinators -ne 3 -or
        $receipt.api_processes -ne 2 -or $receipt.physical_hosts -ne 1 -or $receipt.tls_version -ne '1.3' -or
        !$receipt.signed_cross_domain_hide -or !$receipt.readonly_role_with_control_token_denied -or
        !$receipt.scoped_profile_grant_enforced -or !$receipt.missing_profile_grant_rejected -or
        !$receipt.wrong_subject_grant_rejected -or !$receipt.narrow_domain_grant_rejected -or
        !$receipt.untrusted_profile_signer_rejected -or
        !$receipt.wrong_role_token_pair_rejected -or !$receipt.minimal_readiness -or
        $receipt.tls_client_configuration_rejections -ne 7 -or
        $receipt.coordination_bind -ne $env:VS_TEST_COORDINATION_IP -or
        !$receipt.failover -or !$receipt.minority_feed_unavailable -or
        !$receipt.process_and_tcp_reclaimed -or !$receipt.synthetic_identity_only -or
        $receipt.production_admitted -ne $false) {
        throw '只读TLS进程回执与限定契约不符'
    }
    [ordered]@{
        schema='profile-reader-mtls-runner-v1';receipt=$receipt;log=$log
        api_binary_sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
        coordination_binary_sha256=(Get-FileHash -LiteralPath $coordination -Algorithm SHA256).Hash.ToLowerInvariant()
        lock_sha256=(Get-FileHash -LiteralPath 'vedioServer/Cargo.lock' -Algorithm SHA256).Hash.ToLowerInvariant()
        production_admitted=$false
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8
} finally {
    $env:VS_TEST_SERVICE_BINARY = $previous
    $env:VS_TEST_COORDINATION_IP = $previousIp
}
Get-Content -LiteralPath (Join-Path $out 'receipt.json') -Raw
