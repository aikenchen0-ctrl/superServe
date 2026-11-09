param([string]$CoordinationIp = '172.18.16.1', [switch]$Relay)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$npx = (Get-Command npx.cmd).Source
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$directory = Join-Path $root ".artifacts\live-signaling-browser-$stamp"
$stdout = Join-Path $root ".artifacts\live-signaling-tls\browser-process-$stamp.log"
$stderr = Join-Path $root ".artifacts\live-signaling-tls\browser-process-$stamp.stderr.log"
$null = New-Item -ItemType Directory -Force -Path (Split-Path $stdout)
$runner = Join-Path $root 'vedioServer\labs\webrtc\run-signaling-tls.ps1'
$session = "vs-signal-$stamp"
$arguments = @('-NoProfile', '-File', $runner, '-CoordinationIp', $CoordinationIp,
    '-BrowserDirectory', $directory, '-SkipBuild')
if ($Relay) { $arguments += '-Relay' }
$child = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList $arguments `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$browserOpened = $false
try {
    $fixturePath = Join-Path $directory 'browser-fixture.json'
    $deadline = (Get-Date).AddSeconds(40)
    while (!(Test-Path -LiteralPath $fixturePath)) {
        if ($child.HasExited) { throw "浏览器实验服务提前退出，见：$stdout 和 $stderr" }
        if ((Get-Date) -gt $deadline) { throw '浏览器夹具未在期限内生成' }
        Start-Sleep -Milliseconds 100
    }
    node (Join-Path $PSScriptRoot 'prepare-signaling-browser.mjs') $directory
    if ($LASTEXITCODE -ne 0) { throw '浏览器夹具生成失败' }
    $fixture = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json
    $config = Join-Path $directory 'playwright.config.json'
    & $npx --offline --package @playwright/cli playwright-cli "-s=$session" open $fixture.url `
        --config $config 2>&1 |
        Tee-Object -FilePath (Join-Path $directory 'open.log')
    if ($LASTEXITCODE -ne 0) { throw '实验浏览器打开失败' }
    $browserOpened = $true
    & $npx --offline --package @playwright/cli playwright-cli "-s=$session" snapshot 2>&1 |
        Tee-Object -FilePath (Join-Path $directory 'snapshot.log')
    if ($LASTEXITCODE -ne 0) { throw '实验页面快照失败' }
    & $npx --offline --package @playwright/cli playwright-cli "-s=$session" run-code `
        --filename (Join-Path $directory 'prepare.js') --json 2>&1 |
        Tee-Object -FilePath (Join-Path $directory 'prepare-result.json')
    if ($LASTEXITCODE -ne 0) { throw '浏览器HTTPS凭据初始化失败' }
    $output = @(& $npx --offline --package @playwright/cli playwright-cli "-s=$session" run-code `
        --filename (Join-Path $directory 'verify.js') --json 2>&1)
    $exitCode = $LASTEXITCODE
    $output | Set-Content -LiteralPath (Join-Path $directory 'browser-cli-result.json') -Encoding utf8
    if ($exitCode -ne 0) { throw "实际浏览器播放未通过，见：$directory" }
    $envelope = ($output -join "`n") | ConvertFrom-Json
    if ($envelope.isError -or !$envelope.result) { throw '浏览器没有返回明确验证结果' }
    $result = $envelope.result | ConvertFrom-Json
    if ($result.schema -ne 'https-signal-browser-v1' -or !$result.actual_decoding_verified `
        -or $result.signal_origin -ne ([Uri]$fixture.signaling_root).GetLeftPart([UriPartial]::Authority)) {
        throw '浏览器回执与本次HTTPS节点不符'
    }
    if ($Relay -and !$result.forced_relay_verified) { throw '没有取得实际TURN选路证据' }
    $result | ConvertTo-Json -Depth 100 |
        Set-Content -LiteralPath (Join-Path $directory 'browser-result.json') -Encoding utf8NoBOM
    if (!$child.WaitForExit(15000) -or $child.ExitCode -ne 0) {
        throw "浏览器验证后的进程回收未通过，见：$stdout"
    }
    [PSCustomObject]@{
        schema = 'https-signal-browser-runner-v1'
        evidence = $directory
        process_log = $stdout
        signal_origin = $result.signal_origin
        actual_decoding_verified = $result.actual_decoding_verified
        forced_relay_verified = $result.forced_relay_verified
        physical_hosts = 1
        android_ios_devices_verified = $false
    } | ConvertTo-Json
}
finally {
    if ($browserOpened) {
        & $npx --offline --package @playwright/cli playwright-cli "-s=$session" close
    }
    if (!$child.HasExited) { $child.Kill($true); $child.WaitForExit() }
    $child.Dispose()
}
