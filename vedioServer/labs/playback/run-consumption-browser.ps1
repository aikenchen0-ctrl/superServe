param(
    [string]$InputVideo = 'O:\CodexWorkspaces\superServe-video-b4be\.artifacts\playback\browser-20261107\source.mp4',
    [string]$FeedbackConfig,
    [string]$EvidenceDirectory
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$directory = if ($EvidenceDirectory) { [IO.Path]::GetFullPath($EvidenceDirectory) } else {
    Join-Path $root ".artifacts\playback-consumption-$stamp"
}
if (!$directory.StartsWith("$root\.artifacts\", [StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $directory)) { throw '须使用本工作区.artifacts下的新证据目录' }
if ($FeedbackConfig) {
    $FeedbackConfig = (Resolve-Path -LiteralPath $FeedbackConfig).Path
    if (!$FeedbackConfig.StartsWith('O:\', [StringComparison]::OrdinalIgnoreCase) -or
        !$env:VS_TEST_PLAYBACK_IGGY_WRITER_TOKEN -or !$env:VS_TEST_PLAYBACK_IGGY_READER_TOKEN) {
        throw '真实消息模式需要O盘配置和分离的读写令牌'
    }
}
$logs = Join-Path $root '.artifacts\playback-consumption-20261109'
$null = New-Item -ItemType Directory -Force -Path $logs
$source = (Resolve-Path -LiteralPath $InputVideo).Path
if (!$source.StartsWith('O:\', [StringComparison]::OrdinalIgnoreCase)) { throw '素材必须位于O盘' }
if ((Get-PSDrive -Name O).Free -lt 512MB) { throw 'O盘低于实验保护线' }
$binary = Join-Path $env:CARGO_TARGET_DIR 'debug\examples\playback_lab.exe'
if (!(Test-Path -LiteralPath $binary)) { throw '须先构建playback_lab示例' }
$npx = (Get-Command npx.cmd).Source
$env:PWTEST_DAEMON_SESSION_DIR = Join-Path $env:TEMP 'playback-consumption-cli'
$null = New-Item -ItemType Directory -Force -Path $env:PWTEST_DAEMON_SESSION_DIR
$session = "playback-consumption-$stamp"
$stdout = Join-Path $logs "$stamp-process.log"
$stderr = Join-Path $logs "$stamp-process.stderr.log"
$start = [Diagnostics.ProcessStartInfo]::new((Get-Command cargo).Source)
$start.WorkingDirectory = $root
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
foreach ($argument in @(
    'test','--manifest-path','vedioServer/Cargo.toml','-p','vs-service',
    '--test','feedback_log','--locked','--offline',
    '--config','source.crates-io.replace-with="video-rsproxy"',
    '--config','source.video-rsproxy.registry="sparse+https://rsproxy.cn/index/"',
    'actual_browser_batches_snapshot_and_reconstruct_without_exposing_internal_credentials',
    '--','--ignored','--exact','--nocapture'
)) { $start.ArgumentList.Add($argument) }
$start.Environment['CARGO_BUILD_JOBS'] = '1'
$start.Environment['VS_TEST_PLAYBACK_BROWSER_DIR'] = $directory
$start.Environment['VS_TEST_PLAYBACK_LAB'] = $binary
$start.Environment['VS_TEST_PLAYBACK_SOURCE'] = $source
if ($FeedbackConfig) { $start.Environment['VS_TEST_PLAYBACK_IGGY_CONFIG'] = $FeedbackConfig }
else {
    foreach ($name in @('VS_TEST_PLAYBACK_IGGY_CONFIG','VS_TEST_PLAYBACK_IGGY_WRITER_TOKEN','VS_TEST_PLAYBACK_IGGY_READER_TOKEN')) {
        $null = $start.Environment.Remove($name)
    }
}
$child = [Diagnostics.Process]::Start($start)
$stdoutTask = $child.StandardOutput.ReadToEndAsync()
$stderrTask = $child.StandardError.ReadToEndAsync()
$privateVariables = @{}
foreach ($name in @('VS_TEST_PLAYBACK_IGGY_CONFIG','VS_TEST_PLAYBACK_IGGY_WRITER_TOKEN','VS_TEST_PLAYBACK_IGGY_READER_TOKEN','VS_FEEDBACK_IGGY_TOKEN')) {
    $privateVariables[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
$opened = $false
try {
    $fixturePath = Join-Path $directory 'browser-fixture.json'
    $deadline = (Get-Date).AddSeconds(60)
    while (!(Test-Path -LiteralPath $fixturePath)) {
        if ($child.HasExited) { throw "播放程序或协议夹具提前退出：$stdout $stderr" }
        if ((Get-Date) -gt $deadline) { throw '等待浏览器播放夹具超时' }
        Start-Sleep -Milliseconds 100
    }
    $fixture = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json
    $expectedBackend = if ($FeedbackConfig) { 'real-iggy-singleton' } else { 'deterministic-http-fixture' }
    if ($fixture.message_backend -ne $expectedBackend) { throw '消息后端与显式模式不一致，不允许静默回退' }
    $config = Join-Path $root 'vedioServer\labs\webrtc\playwright.config.json'
    & $npx --offline --package @playwright/cli playwright-cli "-s=$session" open $fixture.url --config $config 2>&1 |
        Tee-Object -FilePath (Join-Path $directory 'open.log')
    if ($LASTEXITCODE -ne 0) { throw '播放浏览器打开失败' }
    $opened = $true
    & $npx --offline --package @playwright/cli playwright-cli "-s=$session" snapshot 2>&1 |
        Tee-Object -FilePath (Join-Path $directory 'snapshot.log')
    if ($LASTEXITCODE -ne 0) { throw '播放页面快照失败' }
    $output = @(& $npx --offline --package @playwright/cli playwright-cli "-s=$session" run-code `
        --filename (Join-Path $PSScriptRoot 'verify-consumption.js') --json 2>&1)
    $code = $LASTEXITCODE
    $output | Set-Content -LiteralPath (Join-Path $directory 'browser-cli-result.json') -Encoding utf8NoBOM
    if ($code -ne 0) { throw '真实浏览器消费验收失败' }
    $envelope = ($output -join "`n") | ConvertFrom-Json
    if ($envelope.isError -or !$envelope.result) { throw '浏览器没有返回结果' }
    $result = $envelope.result | ConvertFrom-Json
    if ($result.schema -ne 'playback-consumption-browser-v1' -or !$result.real_browser_decoding_verified) {
        throw '缺少真实浏览器解码证据'
    }
    $result | Add-Member -NotePropertyName observed_message_backend -NotePropertyValue $fixture.message_backend
    $result | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $directory 'browser-result.json') -Encoding utf8NoBOM
    if (!$child.WaitForExit(20000) -or $child.ExitCode -ne 0) { throw "快照与消费重建失败：$stdout $stderr" }
    Get-Content -LiteralPath (Join-Path $directory 'integration-receipt.json') -Raw
    Write-Output "实验输出：$directory"
}
finally {
    if ($opened) { & $npx --offline --package @playwright/cli playwright-cli "-s=$session" close }
    if (!$child.HasExited) { $child.Kill($true); $child.WaitForExit() }
    $stdoutTask.GetAwaiter().GetResult() | Set-Content -LiteralPath $stdout -Encoding utf8NoBOM
    $stderrTask.GetAwaiter().GetResult() | Set-Content -LiteralPath $stderr -Encoding utf8NoBOM
    $child.Dispose()
    foreach ($name in $privateVariables.Keys) {
        [Environment]::SetEnvironmentVariable($name, $privateVariables[$name], 'Process')
    }
}
