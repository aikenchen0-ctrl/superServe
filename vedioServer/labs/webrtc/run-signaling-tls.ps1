param(
    [string]$CoordinationIp = '172.18.16.1',
    [string]$BrowserDirectory,
    [switch]$Relay,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. 'D:\CodexVideoTools\enter.ps1'
$env:CARGO_BUILD_JOBS = '1'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$evidence = [IO.Path]::GetFullPath((Join-Path $workspace '..\.artifacts\live-signaling-tls'))
$null = New-Item -ItemType Directory -Force -Path $evidence
$expectedIp = [Net.IPAddress]::Parse($CoordinationIp).ToString()
Set-Location -LiteralPath $workspace
$cache = @(
    '--locked', '--offline',
    '--config', 'source.crates-io.replace-with="video-rsproxy"',
    '--config', 'source.video-rsproxy.registry="sparse+https://rsproxy.cn/index/"'
)
if ((Get-PSDrive -Name O).Free -lt 512MB) { throw 'O盘低于定向实验保护线，停止运行' }
if (!$SkipBuild) {
    & cargo build -p vs-tls -p vs-coordination -p vs-live -p vs-turn --all-targets @cache
    if ($LASTEXITCODE -ne 0) { throw '实验程序构建失败' }
}
$binary = Join-Path $env:CARGO_TARGET_DIR 'debug\vs-live.exe'
$turnBinary = Join-Path $env:CARGO_TARGET_DIR 'debug\vs-turn.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw '缺少媒体程序，不能跳过构建' }
if ($Relay -and !(Test-Path -LiteralPath $turnBinary -PathType Leaf)) { throw '缺少独立TURN程序，不能跳过构建' }
$previousBinary = $env:VS_TEST_LIVE_BINARY
$previousTurnBinary = $env:VS_TEST_TURN_BINARY
$previousIp = $env:VS_TEST_COORDINATION_IP
$previousBrowser = $env:VS_TEST_SIGNALING_BROWSER_DIR
$previousRelay = $env:VS_TEST_TURN_RELAY
$log = Join-Path $evidence ('process-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
try {
    if ($Relay -and !$BrowserDirectory) { throw '强制中继实验须同时运行实际浏览器验证' }
    if ($Relay) {
        $env:VS_TEST_TURN_RELAY = '1'
        $env:VS_TEST_TURN_BINARY = $turnBinary
    }
    else {
        Remove-Item Env:VS_TEST_TURN_RELAY -ErrorAction SilentlyContinue
        Remove-Item Env:VS_TEST_TURN_BINARY -ErrorAction SilentlyContinue
    }
    $env:VS_TEST_LIVE_BINARY = $binary
    $env:VS_TEST_COORDINATION_IP = $expectedIp
    if ($BrowserDirectory) {
        $directory = [IO.Path]::GetFullPath($BrowserDirectory)
        if (![IO.Path]::IsPathRooted($BrowserDirectory) -or !($directory.StartsWith('O:\', [StringComparison]::OrdinalIgnoreCase))) {
            throw '浏览器证据必须位于O盘绝对目录'
        }
        if (Test-Path -LiteralPath $directory) { throw '浏览器实验须使用新的独立目录，不能复用旧成功收据' }
        $env:VS_TEST_SIGNALING_BROWSER_DIR = $directory
    }
    else { Remove-Item Env:VS_TEST_SIGNALING_BROWSER_DIR -ErrorAction SilentlyContinue }
    & cargo test -p vs-coordination --test mtls @cache `
        real_https_signaling_keeps_native_clients_separate_from_media_administration `
        -- --ignored --exact --nocapture 2>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) { throw "HTTPS信令实验失败，见：$log" }
    $lines = @(Get-Content -LiteralPath $log -Encoding utf8 |
        Where-Object { $_.Contains('"schema":"live-signaling-tls-lab-v1"') })
    if ($lines.Count -ne 1) { throw '缺少唯一结构化回执，零测试匹配不算通过' }
    $receipt = $lines[0].Substring($lines[0].IndexOf('{')) | ConvertFrom-Json
    if ($receipt.schema -ne 'live-signaling-tls-lab-v1' -or $receipt.coordination_bind -ne $expectedIp `
        -or $receipt.signaling_bind -ne $expectedIp -or $receipt.media_bind -ne $expectedIp `
        -or $receipt.coordinators -ne 3 -or $receipt.media_processes -ne 1 -or $receipt.physical_hosts -ne 1 `
        -or $receipt.client_certificate_required -or !$receipt.native_jwt_session_verified `
        -or !$receipt.private_candidate_verified -or !$receipt.admin_and_diagnostics_not_exposed `
        -or !$receipt.host_origin_and_tls_rejections -or !$receipt.process_and_udp_reclaimed `
        -or $receipt.browser_mode -ne [bool]$BrowserDirectory `
        -or $receipt.turn_relay_verified -ne [bool]$Relay `
        -or $receipt.turn_separate_process -ne [bool]$Relay `
        -or $receipt.authenticated_ice_discovery_verified -ne [bool]$Relay `
        -or $receipt.graceful_shutdown -eq [bool]$BrowserDirectory) {
        throw 'HTTPS信令实验结果不符合当前限定契约'
    }
    if ($Relay -and ($receipt.turn_process.schema -ne 'turn-process-receipt-v1' `
        -or $receipt.turn_process.exit_code -ne 0 `
        -or !$receipt.turn_process.bounded_output_verified `
        -or $receipt.turn_process.ready.pid -ne $receipt.turn_process.stopped.pid `
        -or $receipt.turn_process.stopped.reason -ne 'stdin_eof')) {
        throw '独立TURN没有完整的就绪、正常停机和退出码证据'
    }
    [PSCustomObject]@{
        schema = 'live-signaling-tls-runner-v1'
        log = $log
        media_binary_sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
        turn_binary_sha256 = $(if ($Relay) { (Get-FileHash -LiteralPath $turnBinary -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null })
        receipt = $receipt
    } | ConvertTo-Json -Depth 8
}
finally {
    $env:VS_TEST_LIVE_BINARY = $previousBinary
    $env:VS_TEST_TURN_BINARY = $previousTurnBinary
    $env:VS_TEST_COORDINATION_IP = $previousIp
    $env:VS_TEST_SIGNALING_BROWSER_DIR = $previousBrowser
    $env:VS_TEST_TURN_RELAY = $previousRelay
}
