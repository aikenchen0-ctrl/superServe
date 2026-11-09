param(
    [Parameter(Mandatory)][string]$XiuBinary,
    [Parameter(Mandatory)][string]$Ffmpeg,
    [Parameter(Mandatory)][string]$InputVideo,
    [Parameter(Mandatory)][string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$XiuBinary = (Resolve-Path -LiteralPath $XiuBinary).Path
$Ffmpeg = (Resolve-Path -LiteralPath $Ffmpeg).Path
$InputVideo = (Resolve-Path -LiteralPath $InputVideo).Path
if ([IO.Path]::GetExtension($Ffmpeg) -ne '.exe') { throw '请指定原生ffmpeg.exe' }
if (Test-Path -LiteralPath $OutputRoot) { throw '实验目录必须尚不存在' }
$null = New-Item -ItemType Directory -Path $OutputRoot
$OutputRoot = (Resolve-Path -LiteralPath $OutputRoot).Path
function Get-FreePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}
$rtmpPort = Get-FreePort
do { $hlsPort = Get-FreePort } while ($hlsPort -eq $rtmpPort)
$stdout = Join-Path $OutputRoot 'xiu.stdout.log'
$stderr = Join-Path $OutputRoot 'xiu.stderr.log'
$version = & $XiuBinary --version
$server = Start-Process -FilePath $XiuBinary -ArgumentList @(
    '--rtmp', "$rtmpPort", '--hls', "$hlsPort", '--log', 'info'
) -WorkingDirectory $OutputRoot -WindowStyle Hidden -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr -PassThru
$publisher = $null
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        if ($server.HasExited) { throw 'Xiu启动失败' }
        try {
            $socket = [Net.Sockets.TcpClient]::new()
            $socket.Connect([Net.IPAddress]::Loopback, $rtmpPort)
            break
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Xiu推流端口未就绪' }
            Start-Sleep -Milliseconds 50
        } finally { if ($socket) { $socket.Dispose() } }
    } while ($true)
    $publisher = Start-Process -FilePath $Ffmpeg -ArgumentList @(
        '-hide_banner', '-loglevel', 'error', '-re', '-i', ('"' + $InputVideo + '"'),
        '-t', '8', '-c', 'copy', '-f', 'flv', "rtmp://127.0.0.1:$rtmpPort/live/lab"
    ) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $OutputRoot 'publish.stdout.log') `
        -RedirectStandardError (Join-Path $OutputRoot 'publish.stderr.log')
    $manifestFound = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        try {
            $manifest = Invoke-WebRequest "http://127.0.0.1:$hlsPort/live/lab/lab.m3u8" `
                -TimeoutSec 1 -NoProxy
            $content = if ($manifest.Content -is [byte[]]) {
                [Text.Encoding]::UTF8.GetString($manifest.Content)
            } else { [string]$manifest.Content }
            if ($content.StartsWith('#EXTM3U')) { $manifestFound = $true; break }
        } catch {}
        if ($publisher.HasExited -or [DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Milliseconds 100
    } while ($true)
    if (!$publisher.WaitForExit(10000)) { throw '推流进程未在限定时间内退出' }
} finally {
    foreach ($process in @($publisher, $server)) {
        if ($process -and !$process.HasExited) { Stop-Process -Id $process.Id }
        if ($process -and !$process.WaitForExit(5000)) { throw '实验进程未退出' }
    }
}
$errors = (Get-Content -LiteralPath $stderr -Raw) + (Get-Content -LiteralPath $stdout -Raw)
$receipt = [ordered]@{
    schema = 'xiu-rtmp-hls-admission-probe-v1'
    binary_version = ($version -join "`n")
    binary_sha256 = (Get-FileHash -LiteralPath $XiuBinary -Algorithm SHA256).Hash.ToLowerInvariant()
    publisher_exit_code = $publisher.ExitCode
    hls_manifest_found = $manifestFound
    panic_observed = [bool]($errors -match 'panicked|Option::unwrap')
    process_cleanup_completed = $true
    scope = '本机官方二进制默认RTMP转HLS有界探测；不是集群、低延迟或生产准入验证'
}
$receipt | ConvertTo-Json | Out-File (Join-Path $OutputRoot 'receipt.json') -Encoding utf8
$receipt | ConvertTo-Json
